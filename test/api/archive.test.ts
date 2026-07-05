import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { serverUrl } from "../config";
import { TestClient } from "../helpers/client";
import { signUp, type TestUser } from "../helpers/auth";
import { closeDb, resetDb } from "../helpers/db";
import { createMessage } from "../../lib/db/conversations";

const BASE = serverUrl("api");

async function userWithAgent(name: string) {
  const client = new TestClient(BASE);
  const user = await signUp(client, name);
  const agentId: string = (await client.get("/agent/agents")).body[0].id;
  return { client, user, agentId };
}

// POST /agent/conversation would invoke the chat model (AI tier's job).
function seedConversation(agentId: string, user: TestUser, shared = false) {
  return createMessage({ agentId, userId: user.id, shared, messages: [] });
}

beforeEach(resetDb);
afterAll(closeDb);

describe("conversation archiving", () => {
  it("archives and unarchives; the default list hides archived, id fetches don't", async () => {
    const { client, user, agentId } = await userWithAgent("Alice");
    const kept = await seedConversation(agentId, user);
    const tucked = await seedConversation(agentId, user);

    const archived = await client.patch("/agent/conversation", {
      id: tucked.id,
      archived: true,
    });
    expect(archived.status).toBe(200);
    expect(archived.body.archived).toBe(true);

    // Default list: only unarchived. archived=true: only archived.
    const defaultList = (await client.get(`/agent/conversation?agent_id=${agentId}`)).body;
    expect(defaultList.map((c: { id: string }) => c.id)).toEqual([kept.id]);
    const archivedList = (
      await client.get(`/agent/conversation?agent_id=${agentId}&archived=true`)
    ).body;
    expect(archivedList.map((c: { id: string }) => c.id)).toEqual([tucked.id]);

    // Direct id fetch ignores the flag, so archived chats still open.
    const byId = (await client.get(`/agent/conversation?id=${tucked.id}`)).body;
    expect(byId).toHaveLength(1);

    const restored = await client.patch("/agent/conversation", {
      id: tucked.id,
      archived: false,
    });
    expect(restored.status).toBe(200);
    expect(restored.body.archived).toBe(false);
    const after = (await client.get(`/agent/conversation?agent_id=${agentId}`)).body;
    expect(after).toHaveLength(2);
  });

  it("only the creator can archive", async () => {
    const { client, user, agentId } = await userWithAgent("Alice");
    const shared = await seedConversation(agentId, user, true);

    const { client: outsider } = await userWithAgent("Bob");
    expect(
      (await outsider.patch("/agent/conversation", { id: shared.id, archived: true })).status
    ).toBe(403);
    expect(
      (await new TestClient(BASE).patch("/agent/conversation", { id: shared.id, archived: true }))
        .status
    ).toBe(401);
    expect(
      (
        await client.patch("/agent/conversation", {
          id: crypto.randomUUID(),
          archived: true,
        })
      ).status
    ).toBe(404);
  });
});
