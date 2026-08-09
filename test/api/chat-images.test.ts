import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { SERVER_PORTS, serverUrl, testFilesDir } from "../config";
import { TestClient } from "../helpers/client";
import { signUp } from "../helpers/auth";
import { closeDb, resetDb } from "../helpers/db";
import { readChatStream } from "../helpers/sse";
import { findMessage } from "../../lib/db/conversations";
import { imagePartUrl } from "../../lib/agent/image-parts";

const BASE = serverUrl("api");

// Stand-in for LM Studio serving only /v1/models: enough for the provider to
// be saved and resolved. The chat completion itself 404s — fine here, because
// the route persists the user message before it streams.
function fakeLmStudio() {
  const server = createServer((req, res) => {
    if (req.url !== "/v1/models") {
      res.writeHead(404).end();
      return;
    }
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ data: [{ id: "test-model-a" }] }));
  });
  return new Promise<{ url: string; server: Server }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

// Point this process's storage helpers at the server's FILES_DIR so uploads
// land where the server reads them (same cwd, same relative path).
process.env.FILES_DIR = testFilesDir(SERVER_PORTS.api);

beforeEach(resetDb);
afterAll(closeDb);

// The chat route validates and *persists* the user message before it streams
// (persist-then-stream), so image handling is assertable without a live model:
// the model call itself just fails into the stream's error part.
const uploadImage = (client: TestClient, conversationId: string, name: string) =>
  client.request(`/agent/files?conversation_id=${conversationId}&name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  });

const sendChat = (client: TestClient, body: Record<string, unknown>) =>
  client.request("/agent/conversation", { method: "POST", body: JSON.stringify(body) });

describe("POST /agent/conversation with images", () => {
  let mock: { url: string; server: Server } | undefined;

  afterEach(() => {
    mock?.server.close();
    mock = undefined;
  });

  it("stores uploaded images as file parts on the user message", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Imager");
    mock = await fakeLmStudio();
    expect(
      (
        await client.post("/agent/providers", {
          provider: "lmstudio",
          settings: { url: mock.url },
        })
      ).status
    ).toBe(200);

    const conversationId = randomUUID();
    expect((await uploadImage(client, conversationId, "photo.png")).status).toBe(201);

    const res = await sendChat(client, {
      message: "what is in this picture?",
      conversation_id: conversationId,
      images: [{ name: "photo.png" }],
      provider: "lmstudio",
      model: "test-model-a",
      // Memory off keeps the turn free of retrieval (no embeddings in this tier).
      memory: false,
    });
    expect(res.status).toBe(200);
    await readChatStream(res); // drain: the turn errors on the absent model, persistence already happened

    const conversation = await findMessage(conversationId);
    const userMessage = conversation?.messages?.find(
      (m) => "parts" in m && m.role === "user"
    ) as { parts: Array<Record<string, unknown>> };
    expect(userMessage.parts).toContainEqual({
      type: "file",
      mediaType: "image/png",
      filename: "photo.png",
      url: imagePartUrl(conversationId, "photo.png"),
    });
    expect(userMessage.parts).toContainEqual({
      type: "text",
      text: "what is in this picture?",
    });
  });

  it("rejects images that were never uploaded, without creating the conversation", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Imager");

    const conversationId = randomUUID();
    const res = await sendChat(client, {
      message: "look",
      conversation_id: conversationId,
      images: [{ name: "ghost.png" }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("ghost.png");
    expect(await findMessage(conversationId)).toBeUndefined();
  });

  it("rejects unsupported types, missing conversation ids, and images on approval turns", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Imager");

    // Not an image extension → schema-level 400.
    const badType = await sendChat(client, {
      message: "look",
      conversation_id: randomUUID(),
      images: [{ name: "notes.txt" }],
    });
    expect(badType.status).toBe(400);

    // Images can't ride without the conversation they were uploaded to.
    const noConversation = await sendChat(client, {
      message: "look",
      images: [{ name: "photo.png" }],
    });
    expect(noConversation.status).toBe(400);

    // Approval turns resume a paused stream; a new message (or images) can't ride along.
    const withApprovals = await sendChat(client, {
      conversation_id: randomUUID(),
      images: [{ name: "photo.png" }],
      tool_approvals: [{ approval_id: "x", approved: true }],
    });
    expect(withApprovals.status).toBe(400);
  });
});
