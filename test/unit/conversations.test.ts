import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  canAccessConversation,
  createMessage,
  findMessages,
  type Conversation,
} from "../../lib/db/conversations";
import { addAgentMember } from "../../lib/db/agents";
import { closeDb, makeUser, makeUserWithAgent, resetDb } from "../helpers/db";

beforeEach(resetDb);
afterAll(closeDb);

describe("canAccessConversation", () => {
  const conversation = (overrides: Partial<Conversation>): Conversation =>
    ({
      id: "c",
      agentId: "a",
      userId: "creator",
      shared: false,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as Conversation;

  it("requires agent membership regardless of the conversation", () => {
    expect(canAccessConversation(conversation({ shared: true }), "creator", false)).toBe(false);
  });

  it("private conversations are visible only to their creator", () => {
    expect(canAccessConversation(conversation({}), "creator", true)).toBe(true);
    expect(canAccessConversation(conversation({}), "other", true)).toBe(false);
  });

  it("shared conversations are visible to any member", () => {
    expect(canAccessConversation(conversation({ shared: true }), "other", true)).toBe(true);
  });
});

describe("findMessages viewer scoping", () => {
  it("each member sees shared conversations plus only their own private ones", async () => {
    const member = await makeUser("Member");
    const outsider = await makeUser("Outsider");
    const { user: owner, agent } = await makeUserWithAgent("Owner", [member]);

    const seed = (userId: string, shared: boolean) =>
      createMessage({ agentId: agent.id, userId, shared, messages: [] });
    const ownerPrivate = await seed(owner.id, false);
    const ownerShared = await seed(owner.id, true);
    const memberPrivate = await seed(member.id, false);

    const idsFor = async (viewerId: string) =>
      (await findMessages({ viewerId })).map((c) => c.id).sort();

    expect(await idsFor(owner.id)).toEqual([ownerPrivate.id, ownerShared.id].sort());
    expect(await idsFor(member.id)).toEqual([ownerShared.id, memberPrivate.id].sort());
    expect(await idsFor(outsider.id)).toEqual([]);
  });

  it("scopes to one agent when agentId is given", async () => {
    const { user: owner, agent: agentA } = await makeUserWithAgent("Owner");
    const { agent: agentB } = await makeUserWithAgent("Owner2", [owner]);

    const inA = await createMessage({ agentId: agentA.id, userId: owner.id, shared: false, messages: [] });
    await createMessage({ agentId: agentB.id, userId: owner.id, shared: false, messages: [] });

    const results = await findMessages({ viewerId: owner.id, agentId: agentA.id });
    expect(results.map((c) => c.id)).toEqual([inA.id]);
  });

  it("excludes conversations from agents the viewer was removed from", async () => {
    const member = await makeUser("Member");
    const { user: owner, agent } = await makeUserWithAgent("Owner", [member]);
    await createMessage({ agentId: agent.id, userId: owner.id, shared: true, messages: [] });

    expect(await findMessages({ viewerId: member.id })).toHaveLength(1);

    const { removeAgentMember } = await import("../../lib/db/agents");
    await removeAgentMember(agent.id, member.id);
    expect(await findMessages({ viewerId: member.id })).toHaveLength(0);
  });
});

describe("membership growth", () => {
  it("a newly added member gains access to existing shared conversations", async () => {
    const { user: owner, agent } = await makeUserWithAgent("Owner");
    const shared = await createMessage({ agentId: agent.id, userId: owner.id, shared: true, messages: [] });
    const late = await makeUser("Latecomer");

    expect(await findMessages({ viewerId: late.id })).toHaveLength(0);
    await addAgentMember(agent.id, late.id);
    expect((await findMessages({ viewerId: late.id })).map((c) => c.id)).toEqual([shared.id]);
  });
});
