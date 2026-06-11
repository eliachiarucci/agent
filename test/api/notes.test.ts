import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { serverUrl } from "../config";
import { TestClient } from "../helpers/client";
import { signUp } from "../helpers/auth";
import { closeDb, resetDb } from "../helpers/db";
import { db, agentMembers } from "../helpers/db";

const BASE = serverUrl("api");

async function userWithAgent(name: string) {
  const client = new TestClient(BASE);
  const user = await signUp(client, name);
  const agentId: string = (await client.get("/agent/agents")).body[0].id;
  return { client, user, agentId };
}

beforeEach(resetDb);
afterAll(closeDb);

describe("/agent/notes", () => {
  it("creates, lists, updates and deletes a note", async () => {
    const { client, user, agentId } = await userWithAgent("Alice");

    const created = await client.post("/agent/notes", {
      title: "Grocery list",
      content: "- milk",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      agentId,
      createdBy: user.id,
      title: "Grocery list",
      content: "- milk",
    });

    const listed = await client.get("/agent/notes");
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);

    const updated = await client.patch("/agent/notes", {
      id: created.body.id,
      title: "Groceries",
      content: "- milk\n- eggs",
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ title: "Groceries", content: "- milk\n- eggs" });

    const deleted = await client.delete(`/agent/notes?id=${created.body.id}`);
    expect(deleted.status).toBe(204);
    expect((await client.get("/agent/notes")).body).toEqual([]);
  });

  it("rejects duplicate titles on create and on rename", async () => {
    const { client } = await userWithAgent("Alice");

    await client.post("/agent/notes", { title: "Plan", content: "a" });
    const other = await client.post("/agent/notes", { title: "Other", content: "b" });

    expect((await client.post("/agent/notes", { title: "Plan", content: "c" })).status).toBe(409);
    expect(
      (await client.patch("/agent/notes", { id: other.body.id, title: "Plan" })).status
    ).toBe(409);
    // Renaming a note to its own title is not a conflict.
    expect(
      (await client.patch("/agent/notes", { id: other.body.id, title: "Other" })).status
    ).toBe(200);
  });

  it("rejects invalid titles", async () => {
    const { client } = await userWithAgent("Alice");
    expect((await client.post("/agent/notes", { title: "a\nb", content: "" })).status).toBe(400);
    expect((await client.post("/agent/notes", { title: "  padded ", content: "" })).status).toBe(
      400
    );
  });

  it("requires authentication and agent membership", async () => {
    const { agentId } = await userWithAgent("Alice");

    const anonymous = new TestClient(BASE);
    expect((await anonymous.get("/agent/notes")).status).toBe(401);

    const { client: outsider } = await userWithAgent("Outsider");
    expect((await outsider.get(`/agent/notes?agent_id=${agentId}`)).status).toBe(403);
    expect(
      (
        await outsider.post("/agent/notes", {
          agent_id: agentId,
          title: "Sneaky",
          content: "x",
        })
      ).status
    ).toBe(403);
  });

  it("shares notes with every member of the agent, and 404s across agents", async () => {
    const { client: alice, agentId } = await userWithAgent("Alice");
    const { client: bob, user: bobUser, agentId: bobAgentId } = await userWithAgent("Bob");
    await db.insert(agentMembers).values({ agentId, userId: bobUser.id });

    const note = await alice.post("/agent/notes", { title: "Shared plan", content: "v1" });

    // Bob, as a member, sees and can edit Alice's agent note.
    const seen = await bob.get(`/agent/notes?agent_id=${agentId}`);
    expect(seen.body.map((n: { title: string }) => n.title)).toEqual(["Shared plan"]);
    expect(
      (
        await bob.patch("/agent/notes", {
          id: note.body.id,
          agent_id: agentId,
          content: "v2",
        })
      ).status
    ).toBe(200);

    // The same note id doesn't resolve under Bob's own agent.
    expect(
      (
        await bob.patch("/agent/notes", {
          id: note.body.id,
          agent_id: bobAgentId,
          content: "v3",
        })
      ).status
    ).toBe(404);
    expect(
      (await bob.delete(`/agent/notes?id=${note.body.id}&agent_id=${bobAgentId}`)).status
    ).toBe(404);
  });
});
