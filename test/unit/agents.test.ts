import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  addAgentMember,
  createAgent,
  getDefaultAgentForUser,
  isAgentMember,
  listAgentMembers,
  listAgentsForUser,
  removeAgentMember,
} from "../../lib/db/agents";
import { closeDb, makeUser, resetDb } from "../helpers/db";

beforeEach(resetDb);
afterAll(closeDb);

describe("agent ownership and membership", () => {
  it("creating an agent makes the owner a member with the owner role", async () => {
    const user = await makeUser("Alice");
    const agent = await createAgent({ name: "Assistant", ownerId: user.id });

    expect(await isAgentMember(agent.id, user.id)).toBe(true);
    expect(await listAgentMembers(agent.id)).toEqual([
      { userId: user.id, name: "Alice", role: "owner" },
    ]);
  });

  it("lists own and shared agents with the user's role", async () => {
    const alice = await makeUser("Alice");
    const bob = await makeUser("Bob");
    const aliceAgent = await createAgent({ name: "Alice's", ownerId: alice.id });
    await createAgent({ name: "Bob's", ownerId: bob.id });
    await addAgentMember(aliceAgent.id, bob.id);

    const bobsAgents = await listAgentsForUser(bob.id);
    expect(bobsAgents.map((a) => ({ name: a.name, role: a.role }))).toEqual([
      { name: "Alice's", role: "member" },
      { name: "Bob's", role: "owner" },
    ]);

    // Alice's view is unaffected by sharing her agent.
    expect(await listAgentsForUser(alice.id)).toHaveLength(1);
  });

  it("addAgentMember is idempotent and removeAgentMember reports whether a row was removed", async () => {
    const alice = await makeUser("Alice");
    const bob = await makeUser("Bob");
    const agent = await createAgent({ name: "Shared", ownerId: alice.id });

    await addAgentMember(agent.id, bob.id);
    await addAgentMember(agent.id, bob.id);
    expect(await listAgentMembers(agent.id)).toHaveLength(2);

    expect(await removeAgentMember(agent.id, bob.id)).toBe(true);
    expect(await removeAgentMember(agent.id, bob.id)).toBe(false);
    expect(await isAgentMember(agent.id, bob.id)).toBe(false);
  });

  it("defaults to the user's oldest agent", async () => {
    const alice = await makeUser("Alice");
    const first = await createAgent({ name: "First", ownerId: alice.id });
    await createAgent({ name: "Second", ownerId: alice.id });

    expect((await getDefaultAgentForUser(alice.id))?.id).toBe(first.id);
  });
});
