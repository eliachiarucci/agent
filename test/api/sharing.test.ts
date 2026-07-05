import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { serverUrl } from "../config";
import { TestClient } from "../helpers/client";
import { signUp } from "../helpers/auth";
import { closeDb, db, resetDb } from "../helpers/db";
import { createMessage } from "../../lib/db/conversations";
import { memories } from "../../lib/global/schema";
import { fakeEmbedding } from "../helpers/embeddings";
import type { TestUser } from "../helpers/auth";

const BASE = serverUrl("api");

beforeEach(resetDb);
afterAll(closeDb);

// Two real accounts; the owner shares their default agent with the member.
async function sharedAgentScenario() {
  const owner = new TestClient(BASE);
  const member = new TestClient(BASE);
  const ownerUser = await signUp(owner, "Owner");
  const memberUser = await signUp(member, "Member");

  const agentRow = (await owner.get("/agent/agents")).body[0];
  const agentId: string = agentRow.id;
  // The pool auto-created with the agent — where its memories live.
  const poolId: string = agentRow.memoryPoolId;
  const share = await owner.post("/agent/members", { agent_id: agentId, member_id: memberUser.id });
  expect(share.status).toBe(201);

  return { owner, member, ownerUser, memberUser, agentId, poolId };
}

describe("agent sharing", () => {
  it("grants the member access to the agent with the member role", async () => {
    const { member, agentId } = await sharedAgentScenario();

    const agents = (await member.get("/agent/agents")).body;
    expect(agents).toHaveLength(2); // their own + the shared one
    expect(agents.find((a: any) => a.id === agentId)?.role).toBe("member");
  });

  it("only the owner can share; members can leave but the owner cannot be removed", async () => {
    const { owner, member, ownerUser, memberUser, agentId } = await sharedAgentScenario();

    const outsider = new TestClient(BASE);
    const outsiderUser = await signUp(outsider, "Outsider");

    // Member tries to share onward → forbidden.
    const onward = await member.post("/agent/members", {
      agent_id: agentId,
      member_id: outsiderUser.id,
    });
    expect(onward.status).toBe(403);

    // Nobody can remove the owner, not even the owner.
    const removeOwner = await owner.delete(
      `/agent/members?agent_id=${agentId}&member_id=${ownerUser.id}`
    );
    expect(removeOwner.status).toBe(403);

    // The member can leave on their own.
    const leave = await member.delete(
      `/agent/members?agent_id=${agentId}&member_id=${memberUser.id}`
    );
    expect(leave.status).toBe(204);
    expect((await member.get("/agent/agents")).body).toHaveLength(1);
  });

  it("non-members cannot read the agent's members or memories", async () => {
    const { agentId } = await sharedAgentScenario();
    const outsider = new TestClient(BASE);
    await signUp(outsider, "Outsider");

    expect((await outsider.get(`/agent/members?agent_id=${agentId}`)).status).toBe(403);
    expect((await outsider.get(`/agent/memory?agent_id=${agentId}`)).status).toBe(403);
  });
});

describe("conversation visibility over HTTP", () => {
  // Conversations are seeded directly in the database: creating them through
  // POST /agent/conversation would invoke the chat model (AI tier's job).
  async function seedConversation(agentId: string, user: TestUser, shared: boolean) {
    return createMessage({ agentId, userId: user.id, shared, messages: [] });
  }

  it("members see shared conversations and their own private ones only", async () => {
    const { owner, member, ownerUser, memberUser, agentId } = await sharedAgentScenario();
    const ownerPrivate = await seedConversation(agentId, ownerUser, false);
    const ownerShared = await seedConversation(agentId, ownerUser, true);
    const memberPrivate = await seedConversation(agentId, memberUser, false);

    const ownerSees = (await owner.get(`/agent/conversation?agent_id=${agentId}`)).body;
    expect(ownerSees.map((c: any) => c.id).sort()).toEqual(
      [ownerPrivate.id, ownerShared.id].sort()
    );

    const memberSees = (await member.get(`/agent/conversation?agent_id=${agentId}`)).body;
    expect(memberSees.map((c: any) => c.id).sort()).toEqual(
      [ownerShared.id, memberPrivate.id].sort()
    );
  });

  it("carries the per-conversation memory flag (default on)", async () => {
    const { owner, ownerUser, agentId } = await sharedAgentScenario();
    const withMemory = await seedConversation(agentId, ownerUser, false);
    const withoutMemory = await createMessage({
      agentId,
      userId: ownerUser.id,
      shared: false,
      memory: false,
      messages: [],
    });

    const list = (await owner.get(`/agent/conversation?agent_id=${agentId}`)).body;
    expect(list.find((c: any) => c.id === withMemory.id)?.memory).toBe(true);
    expect(list.find((c: any) => c.id === withoutMemory.id)?.memory).toBe(false);
  });

  it("chatting in someone else's private conversation is forbidden", async () => {
    const { member, ownerUser, agentId } = await sharedAgentScenario();
    const ownerPrivate = await seedConversation(agentId, ownerUser, false);

    // The access check fires before any model call, so this stays LM-free.
    const { status } = await member.post("/agent/conversation", {
      message: "hi",
      conversation_id: ownerPrivate.id,
    });
    expect(status).toBe(403);
  });

  it("only the creator can delete a conversation, shared or not", async () => {
    const { owner, member, ownerUser, agentId } = await sharedAgentScenario();
    const ownerShared = await seedConversation(agentId, ownerUser, true);

    expect((await member.delete(`/agent/conversation?id=${ownerShared.id}`)).status).toBe(403);
    expect((await owner.delete(`/agent/conversation?id=${ownerShared.id}`)).status).toBe(204);
  });
});

describe("memory API scoping", () => {
  it("memories are listed per agent and PATCH/DELETE stay inside its pool", async () => {
    const { owner, member, memberUser, agentId, poolId } = await sharedAgentScenario();

    // Seeded directly (embedding included) so no embedding model is needed.
    const [row] = await db
      .insert(memories)
      .values({
        poolId,
        content: "Owner's car is a Golf 7",
        embedding: fakeEmbedding("golf"),
        importance: 0.5,
        category: "other",
      })
      .returning();

    // Both members of the shared agent can browse it.
    expect((await owner.get(`/agent/memory?agent_id=${agentId}`)).body).toHaveLength(1);
    expect((await member.get(`/agent/memory?agent_id=${agentId}`)).body).toHaveLength(1);

    // The member's own personal agent has a separate, empty pool.
    const memberOwnAgent = (await member.get("/agent/agents")).body.find(
      (a: any) => a.ownerId === memberUser.id
    );
    expect((await member.get(`/agent/memory?agent_id=${memberOwnAgent.id}`)).body).toHaveLength(0);

    // PATCH scoped to the wrong agent does not leak across pools.
    const crossPatch = await member.patch("/agent/memory", {
      id: row.id,
      agent_id: memberOwnAgent.id,
      importance: 0.9,
    });
    expect(crossPatch.status).toBe(404);

    // Importance-only PATCH within the right agent works without re-embedding.
    const patch = await member.patch("/agent/memory", {
      id: row.id,
      agent_id: agentId,
      importance: 0.9,
    });
    expect(patch.status).toBe(200);
    expect(patch.body.importance).toBe(0.9);

    expect((await owner.delete(`/agent/memory?id=${row.id}&agent_id=${agentId}`)).status).toBe(204);
  });
});
