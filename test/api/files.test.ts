import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SERVER_PORTS, serverUrl, testFilesDir } from "../config";
import { TestClient } from "../helpers/client";
import { signUp, type TestUser } from "../helpers/auth";
import { closeDb, resetDb } from "../helpers/db";
import { createMessage } from "../../lib/db/conversations";
import { writeConversationFile } from "../../lib/agent/files";

const BASE = serverUrl("api");

// Point this process's storage helpers at the server's FILES_DIR so seeded
// files land where the server reads them (same cwd, same relative path).
process.env.FILES_DIR = testFilesDir(SERVER_PORTS.api);

beforeEach(resetDb);
afterAll(closeDb);

// Owner + member sharing the owner's default agent, same as sharing.test.ts.
// Conversations are seeded directly in the database (POST /agent/conversation
// would invoke the chat model) and their files directly on disk (only agent
// tools create files; there is no upload API).
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
