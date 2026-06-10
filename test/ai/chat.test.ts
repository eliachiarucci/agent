import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { lmStudioUp, serverUrl } from "../config";
import { TestClient } from "../helpers/client";
import { signUp } from "../helpers/auth";
import { readChatStream } from "../helpers/sse";
import { closeDb, resetDb } from "../helpers/db";

// Full chat turns through the real server and the real chat model. Output is
// non-deterministic: assertions are deliberately loose (substrings, stored
// side effects) and occasional flakes are the price of the tier — these run
// via `npm run test:ai` only.
const BASE = serverUrl("ai");
const lmUp = await lmStudioUp();

describe.skipIf(!lmUp)("chat end to end", () => {
  beforeEach(resetDb);
  afterAll(closeDb);

  async function chat(client: TestClient, message: string, conversationId?: string) {
    const res = await client.request("/agent/conversation", {
      method: "POST",
      body: JSON.stringify({
        message,
        ...(conversationId ? { conversation_id: conversationId } : {}),
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    return readChatStream(res);
  }

  it("answers from injected memories", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Elia");

    // Stored via the API (embeds with the real model), then retrieved through
    // the <relevant-memories> block on the next turn.
    const stored = await client.post("/agent/memory", {
      content: "Elia's car is a Golf 7",
      importance: 0.7,
      category: "other",
    });
    expect(stored.status).toBe(201);

    const turn = await chat(client, "What car do I drive? Answer in one short sentence.");
    expect(turn.text).toMatch(/golf/i);
  });

  it("stores lasting facts through the remember tool", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Elia");

    const turn = await chat(
      client,
      "Please remember that my favourite drink is a double espresso."
    );
    expect(turn.toolCalls).toContain("remember");

    const memories = (await client.get("/agent/memory")).body;
    expect(memories.some((m: any) => /espresso/i.test(m.content))).toBe(true);
  });

  it("keeps a conversation going with history", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Elia");
    const conversationId = crypto.randomUUID();

    await chat(client, "My lucky number is 42. Just acknowledge briefly.", conversationId);
    const turn = await chat(
      client,
      "What is my lucky number? Answer with just the number.",
      conversationId
    );
    expect(turn.text).toContain("42");
  });
});

describe.runIf(!lmUp)("LM Studio offline", () => {
  it.skip("chat suite skipped — start LM Studio on localhost:1234 to run it", () => {});
});
