import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { serverUrl } from "../config";
import { TestClient } from "../helpers/client";
import { signUp } from "../helpers/auth";
import { readChatStream } from "../helpers/sse";
import { closeDb, resetDb } from "../helpers/db";
import { addToolApprovals, listToolApprovals } from "../../lib/db/tool-approvals";
import { createMessage, findMessage } from "../../lib/db/conversations";

const BASE = serverUrl("api");

beforeEach(resetDb);
afterAll(closeDb);

async function defaultAgentId(client: TestClient): Promise<string> {
  const { body } = await client.get("/agent/agents");
  return body[0].id;
}

async function seedApproval(userId: string, agentId: string, target = "john@doe.com") {
  await addToolApprovals({
    userId,
    agentId,
    connector: "gmail",
    tool: "create_draft",
    targets: [target],
  });
  const [row] = await listToolApprovals(userId, agentId);
  return row;
}

describe("tool approvals API", () => {
  it("requires authentication", async () => {
    const client = new TestClient(BASE);
    expect(
      (
        await client.get(
          "/agent/tool-approvals?agent_id=00000000-0000-4000-8000-000000000000"
        )
      ).status
    ).toBe(401);
    expect(
      (
        await client.delete("/agent/tool-approvals?id=00000000-0000-4000-8000-000000000000")
      ).status
    ).toBe(401);
  });

  it("lists the caller's overrides and deletes them", async () => {
    const client = new TestClient(BASE);
    const user = await signUp(client, "Pat");
    const agentId = await defaultAgentId(client);

    const empty = await client.get(`/agent/tool-approvals?agent_id=${agentId}`);
    expect(empty.status).toBe(200);
    expect(empty.body.approvals).toEqual([]);

    const row = await seedApproval(user.id, agentId);
    const listed = await client.get(`/agent/tool-approvals?agent_id=${agentId}`);
    expect(listed.body.approvals).toHaveLength(1);
    expect(listed.body.approvals[0]).toMatchObject({
      id: row.id,
      connector: "gmail",
      tool: "create_draft",
      target: "john@doe.com",
    });

    expect((await client.delete(`/agent/tool-approvals?id=${row.id}`)).status).toBe(204);
    const after = await client.get(`/agent/tool-approvals?agent_id=${agentId}`);
    expect(after.body.approvals).toEqual([]);
  });

  it("is scoped: no cross-agent reads, no cross-user deletes", async () => {
    const pat = new TestClient(BASE);
    const patUser = await signUp(pat, "Pat");
    const patAgent = await defaultAgentId(pat);
    const row = await seedApproval(patUser.id, patAgent);

    const sam = new TestClient(BASE);
    await signUp(sam, "Sam");
    expect((await sam.get(`/agent/tool-approvals?agent_id=${patAgent}`)).status).toBe(403);
    // Deleting someone else's row 404s and leaves it in place.
    expect((await sam.delete(`/agent/tool-approvals?id=${row.id}`)).status).toBe(404);
    expect(await listToolApprovals(patUser.id, patAgent)).toHaveLength(1);
  });

  it("validates input", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Pat");
    expect((await client.get("/agent/tool-approvals")).status).toBe(400);
    expect((await client.delete("/agent/tool-approvals?id=not-a-uuid")).status).toBe(400);
  });
});

describe("conversation tool_approvals validation", () => {
  // A conversation paused on an approval prompt, seeded directly in the DB.
  async function pausedConversation(userId: string, agentId: string) {
    const messages: UIMessage[] = [
      {
        id: "u1",
        role: "user",
        metadata: { userId, userName: "Pat" },
        parts: [{ type: "text", text: "email john" }],
      },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-create_draft",
            toolCallId: "call-1",
            state: "approval-requested",
            input: { to: ["john@doe.com"], subject: "hi", body: "hello" },
            approval: { id: "appr-1" },
          } as unknown as UIMessage["parts"][number],
        ],
      },
    ];
    return createMessage({ agentId, userId, shared: false, messages });
  }

  it("rejects a body mixing a message with tool_approvals", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Pat");
    const { status } = await client.post("/agent/conversation", {
      message: "hello",
      tool_approvals: [{ approval_id: "appr-1", approved: true }],
    });
    expect(status).toBe(400);
  });

  it("404s decisions on a conversation that does not exist", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Pat");
    const { status } = await client.post("/agent/conversation", {
      conversation_id: "00000000-0000-4000-8000-000000000000",
      tool_approvals: [{ approval_id: "appr-1", approved: true }],
    });
    expect(status).toBe(404);
  });

  it("rejects decisions when nothing is pending or coverage is partial", async () => {
    const client = new TestClient(BASE);
    const user = await signUp(client, "Pat");
    const agentId = await defaultAgentId(client);

    // Nothing pending: plain conversation without approval prompts.
    const plain = await createMessage({
      agentId,
      userId: user.id,
      shared: false,
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
        { id: "a1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
      ] satisfies UIMessage[],
    });
    expect(
      (
        await client.post("/agent/conversation", {
          conversation_id: plain.id,
          tool_approvals: [{ approval_id: "appr-1", approved: true }],
        })
      ).status
    ).toBe(400);

    // Pending, but the response references a different prompt.
    const paused = await pausedConversation(user.id, agentId);
    expect(
      (
        await client.post("/agent/conversation", {
          conversation_id: paused.id,
          tool_approvals: [{ approval_id: "wrong-id", approved: true }],
        })
      ).status
    ).toBe(400);
  });

  it("records denials without a model turn (agent does not reply)", async () => {
    const client = new TestClient(BASE);
    const user = await signUp(client, "Pat");
    const agentId = await defaultAgentId(client);
    const paused = await pausedConversation(user.id, agentId);

    // No provider/model is configured for Pat: a deny-only decision must still
    // succeed, because it never invokes a model.
    const res = await client.request("/agent/conversation", {
      method: "POST",
      body: JSON.stringify({
        conversation_id: paused.id,
        tool_approvals: [{ approval_id: "appr-1", approved: false }],
      }),
    });
    expect(res.status).toBe(200);
    const turn = await readChatStream(res);
    // The stream only flips the pending part to its final state: no text, no
    // new tool calls.
    expect(turn.text).toBe("");
    expect(turn.toolCalls).toEqual([]);
    expect(turn.events.some((e) => e.type === "tool-output-denied" && e.toolCallId === "call-1")).toBe(
      true
    );

    // The denial is persisted on the conversation; no assistant reply was added.
    const stored = await findMessage(paused.id);
    const messages = (stored?.messages ?? []) as UIMessage[];
    expect(messages).toHaveLength(2);
    const part = messages[1].parts[0] as { state: string; approval?: { approved: boolean } };
    expect(part.state).toBe("output-denied");
    expect(part.approval?.approved).toBe(false);
  });

  it("only lets the turn's sender respond", async () => {
    const owner = new TestClient(BASE);
    const ownerUser = await signUp(owner, "Pat");
    const agentId = await defaultAgentId(owner);
    const paused = await pausedConversation(ownerUser.id, agentId);

    const other = new TestClient(BASE);
    await signUp(other, "Sam");
    // Sam is not a member of Pat's agent at all → 403 on access.
    const { status } = await other.post("/agent/conversation", {
      conversation_id: paused.id,
      tool_approvals: [{ approval_id: "appr-1", approved: true }],
    });
    expect(status).toBe(403);
  });
});
