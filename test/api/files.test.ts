import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SERVER_PORTS, serverUrl, testFilesDir } from "../config";
import { TestClient } from "../helpers/client";
import { signUp, type TestUser } from "../helpers/auth";
import { closeDb, resetDb } from "../helpers/db";
import { createMessage } from "../../lib/db/conversations";
import {
  readConversationFile,
  statConversationFile,
  writeConversationFile,
  writeConversationFileBytes,
} from "../../lib/agent/files";

const BASE = serverUrl("api");

// Point this process's storage helpers at the server's FILES_DIR so seeded
// files land where the server reads them (same cwd, same relative path).
process.env.FILES_DIR = testFilesDir(SERVER_PORTS.api);

beforeEach(resetDb);
afterAll(closeDb);

// Owner + member sharing the owner's default agent, same as sharing.test.ts.
// Conversations are seeded directly in the database (POST /agent/conversation
// would invoke the chat model) and their files directly on disk; the upload API
// (POST /agent/files) is exercised in its own describe block below.
async function scenario() {
  const owner = new TestClient(BASE);
  const member = new TestClient(BASE);
  const ownerUser = await signUp(owner, "Owner");
  const memberUser = await signUp(member, "Member");

  const agentId: string = (await owner.get("/agent/agents")).body[0].id;
  const share = await owner.post("/agent/members", { agent_id: agentId, member_id: memberUser.id });
  expect(share.status).toBe(201);

  return { owner, member, ownerUser, memberUser, agentId };
}

async function seedConversationWithFile(
  agentId: string,
  user: TestUser,
  shared: boolean,
  fileName: string,
  content: string
) {
  const conversation = await createMessage({ agentId, userId: user.id, shared, messages: [] });
  await writeConversationFile(conversation.id, fileName, content);
  return conversation;
}

describe("GET /agent/files", () => {
  it("lists files flat across the conversations the viewer can see", async () => {
    const { owner, member, ownerUser, memberUser, agentId } = await scenario();
    const ownerPrivate = await seedConversationWithFile(agentId, ownerUser, false, "private.md", "p");
    const sharedConv = await seedConversationWithFile(agentId, ownerUser, true, "shared.md", "s");
    const memberPrivate = await seedConversationWithFile(agentId, memberUser, false, "member.md", "m");

    const ownerSees = await owner.get(`/agent/files?agent_id=${agentId}`);
    expect(ownerSees.status).toBe(200);
    expect(
      ownerSees.body.map((f: any) => `${f.conversationId}/${f.name}`).sort()
    ).toEqual([`${ownerPrivate.id}/private.md`, `${sharedConv.id}/shared.md`].sort());
    // Entries carry what the UI needs to render and download.
    expect(ownerSees.body[0]).toMatchObject({
      conversationId: expect.any(String),
      name: expect.any(String),
      size: 1,
      updatedAt: expect.any(String),
      source: "agent",
    });

    const memberSees = await member.get(`/agent/files?agent_id=${agentId}`);
    expect(
      memberSees.body.map((f: any) => `${f.conversationId}/${f.name}`).sort()
    ).toEqual([`${sharedConv.id}/shared.md`, `${memberPrivate.id}/member.md`].sort());
  });

  it("requires authentication and agent membership", async () => {
    const { agentId } = await scenario();

    const anonymous = new TestClient(BASE);
    expect((await anonymous.get("/agent/files")).status).toBe(401);

    const outsider = new TestClient(BASE);
    await signUp(outsider, "Outsider");
    expect((await outsider.get(`/agent/files?agent_id=${agentId}`)).status).toBe(403);
  });
});

describe("POST /agent/files", () => {
  const upload = (
    client: TestClient,
    conversationId: string,
    name: string,
    content: string
  ) =>
    client.request(
      `/agent/files?conversation_id=${conversationId}&name=${encodeURIComponent(name)}`,
      { method: "POST", headers: { "content-type": "text/plain" }, body: content }
    );

  it("stores an attachment for a brand-new conversation and an existing accessible one", async () => {
    const { owner, ownerUser, agentId } = await scenario();

    // No row yet: the client generated the id and the message that follows
    // creates it — an authenticated user may seed its folder.
    const newId = randomUUID();
    const newRes = await upload(owner, newId, "pasted-content-1.txt", "hello");
    expect(newRes.status).toBe(201);
    expect(await newRes.json()).toMatchObject({
      conversationId: newId,
      name: "pasted-content-1.txt",
      size: 5,
      source: "upload",
    });
    expect(await readConversationFile(newId, "pasted-content-1.txt", "upload")).toBe("hello");

    const conv = await createMessage({ agentId, userId: ownerUser.id, shared: false, messages: [] });
    const existRes = await upload(owner, conv.id, "note.txt", "world");
    expect(existRes.status).toBe(201);
    expect(await readConversationFile(conv.id, "note.txt", "upload")).toBe("world");
  });

  it("enforces auth and conversation access, and validates the request", async () => {
    const { owner, member, ownerUser, agentId } = await scenario();
    const ownerPrivate = await createMessage({
      agentId,
      userId: ownerUser.id,
      shared: false,
      messages: [],
    });

    // A member of the agent still can't write to someone else's private chat.
    expect((await upload(member, ownerPrivate.id, "x.txt", "x")).status).toBe(403);

    // Anonymous is rejected even for a not-yet-created conversation.
    const anonymous = new TestClient(BASE);
    expect((await upload(anonymous, randomUUID(), "x.txt", "x")).status).toBe(401);

    // Traversal names and empty bodies are 400.
    expect((await upload(owner, ownerPrivate.id, "../escape.txt", "x")).status).toBe(400);
    expect((await upload(owner, ownerPrivate.id, "ok.txt", "")).status).toBe(400);
  });
});

describe("uploads (source=upload)", () => {
  it("lists uploads next to agent files, download/content address them by source", async () => {
    const { owner, ownerUser, agentId } = await scenario();
    const conv = await seedConversationWithFile(agentId, ownerUser, false, "notes.md", "agent");
    await writeConversationFileBytes(conv.id, "photo.png", Buffer.from("img"), 1024, "upload");

    const list = await owner.get(`/agent/files?agent_id=${agentId}`);
    expect(list.body.map((f: any) => `${f.source}/${f.name}`).sort()).toEqual([
      "agent/notes.md",
      "upload/photo.png",
    ]);

    const download = await owner.request(
      `/agent/files/download?conversation_id=${conv.id}&name=photo.png&source=upload`
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("img");
    // Without the source param the lookup misses: uploads are not agent files.
    expect(
      (await owner.get(`/agent/files/download?conversation_id=${conv.id}&name=photo.png`)).status
    ).toBe(404);

    const content = await owner.get(
      `/agent/files/content?conversation_id=${conv.id}&name=photo.png&source=upload`
    );
    expect(content.status).toBe(200);
    expect(content.body).toMatchObject({ name: "photo.png", content: "img" });
  });

  it("DELETE removes one upload for anyone with conversation access", async () => {
    const { owner, member, ownerUser, agentId } = await scenario();
    const conv = await createMessage({
      agentId,
      userId: ownerUser.id,
      shared: false,
      messages: [],
    });
    await writeConversationFileBytes(conv.id, "photo.png", Buffer.from("img"), 1024, "upload");

    // A member of the agent can't touch someone else's private chat; anonymous
    // users can't touch anything.
    expect(
      (await member.delete(`/agent/files?conversation_id=${conv.id}&name=photo.png`)).status
    ).toBe(403);
    const anonymous = new TestClient(BASE);
    expect(
      (await anonymous.delete(`/agent/files?conversation_id=${conv.id}&name=photo.png`)).status
    ).toBe(401);

    const res = await owner.delete(`/agent/files?conversation_id=${conv.id}&name=photo.png`);
    expect(res.status).toBe(204);
    expect(await statConversationFile(conv.id, "photo.png", "upload")).toBeNull();

    // Gone now — and agent-written artifacts are never deletable through here.
    expect(
      (await owner.delete(`/agent/files?conversation_id=${conv.id}&name=photo.png`)).status
    ).toBe(404);
    await writeConversationFile(conv.id, "artifact.md", "keep");
    expect(
      (await owner.delete(`/agent/files?conversation_id=${conv.id}&name=artifact.md`)).status
    ).toBe(404);
    expect(await readConversationFile(conv.id, "artifact.md")).toBe("keep");
  });
});

describe("GET /agent/files/download", () => {
  const downloadPath = (conversationId: string, name: string) =>
    `/agent/files/download?conversation_id=${conversationId}&name=${encodeURIComponent(name)}`;

  it("streams the file as an attachment to anyone who can see the conversation", async () => {
    const { owner, member, ownerUser, agentId } = await scenario();
    const sharedConv = await seedConversationWithFile(agentId, ownerUser, true, "plan.md", "# Plan");

    const res = await member.request(downloadPath(sharedConv.id, "plan.md"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain("plan.md");
    expect(await res.text()).toBe("# Plan");
  });

  it("forbids private conversations of others and any non-member", async () => {
    const { member, ownerUser, agentId } = await scenario();
    const ownerPrivate = await seedConversationWithFile(agentId, ownerUser, false, "p.md", "p");

    expect((await member.get(downloadPath(ownerPrivate.id, "p.md"))).status).toBe(403);

    const outsider = new TestClient(BASE);
    await signUp(outsider, "Outsider");
    expect((await outsider.get(downloadPath(ownerPrivate.id, "p.md"))).status).toBe(403);

    const anonymous = new TestClient(BASE);
    expect((await anonymous.get(downloadPath(ownerPrivate.id, "p.md"))).status).toBe(401);
  });

  it("rejects traversal names and 404s on missing files", async () => {
    const { owner, ownerUser, agentId } = await scenario();
    const conv = await seedConversationWithFile(agentId, ownerUser, false, "a.md", "a");

    expect((await owner.get(downloadPath(conv.id, "../../secrets.txt"))).status).toBe(400);
    expect((await owner.get(downloadPath(conv.id, "missing.md"))).status).toBe(404);
  });
});

describe("GET /agent/files/content", () => {
  const contentPath = (conversationId: string, name: string) =>
    `/agent/files/content?conversation_id=${conversationId}&name=${encodeURIComponent(name)}`;

  it("returns content and metadata the viewer needs to render and refresh", async () => {
    const { owner, ownerUser, agentId } = await scenario();
    const conv = await seedConversationWithFile(agentId, ownerUser, false, "doc.md", "# Doc");

    const res = await owner.get(contentPath(conv.id, "doc.md"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "doc.md", content: "# Doc", size: 5 });
    expect(res.body.updatedAt).toEqual(expect.any(String));
  });

  it("applies the same access rules as download", async () => {
    const { member, ownerUser, agentId } = await scenario();
    const ownerPrivate = await seedConversationWithFile(agentId, ownerUser, false, "p.md", "p");

    expect((await member.get(contentPath(ownerPrivate.id, "p.md"))).status).toBe(403);

    const anonymous = new TestClient(BASE);
    expect((await anonymous.get(contentPath(ownerPrivate.id, "p.md"))).status).toBe(401);
  });

  it("rejects bad names and 404s on missing files", async () => {
    const { owner, ownerUser, agentId } = await scenario();
    const conv = await seedConversationWithFile(agentId, ownerUser, false, "a.md", "a");

    expect((await owner.get(contentPath(conv.id, "../../etc/hosts"))).status).toBe(400);
    expect((await owner.get(contentPath(conv.id, "missing.md"))).status).toBe(404);
  });
});
