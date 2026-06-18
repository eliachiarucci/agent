import type { ModelMessage } from "ai";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { serverUrl } from "../config";
import { TestClient } from "../helpers/client";
import { signUp } from "../helpers/auth";
import { closeDb, resetDb } from "../helpers/db";
import { createMessage } from "../../lib/db/conversations";
import { saveMemoryConversation } from "../../lib/db/memory-conversations";

const BASE = serverUrl("api");

beforeEach(resetDb);
afterAll(closeDb);

// The extractor that writes memory conversations needs a model, so seed one
// directly (api tier has no LM Studio).
const SAMPLE: ModelMessage[] = [
  { role: "user", content: "Elia: I love sushi\n\nAssistant: Noted!" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Storing that." },
      { type: "tool-call", toolCallId: "t1", toolName: "remember", input: { content: "Elia loves sushi" } },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "t1",
        toolName: "remember",
        output: { type: "json", value: { stored: "Elia loves sushi" } },
      },
    ],
  },
]

async function seed(agentId: string, userId: string, shared: boolean) {
  const conv = await createMessage({ agentId, userId, shared, messages: [] })
  await saveMemoryConversation(conv.id, agentId, SAMPLE)
  return conv
}

describe("memory conversations (read-only)", () => {
  it("lists summaries and returns flattened messages for one", async () => {
    const owner = new TestClient(BASE)
    const ownerUser = await signUp(owner, "Owner")
    const agentId: string = (await owner.get("/agent/agents")).body[0].id

    await seed(agentId, ownerUser.id, false)

    const list = await owner.get("/agent/memory-conversations")
    expect(list.status).toBe(200)
    expect(list.body).toHaveLength(1)
    expect(list.body[0].preview).toContain("I love sushi")
    expect(list.body[0].exchangeCount).toBe(1)

    const detail = await owner.get(`/agent/memory-conversations?id=${list.body[0].id}`)
    expect(detail.status).toBe(200)
    const [user, assistant, tool] = detail.body.messages
    expect(user).toMatchObject({ role: "user", text: "Elia: I love sushi\n\nAssistant: Noted!" })
    expect(assistant.role).toBe("assistant")
    expect(assistant.text).toBe("Storing that.")
    expect(assistant.toolCalls[0]).toMatchObject({
      toolName: "remember",
      input: { content: "Elia loves sushi" },
    })
    expect(tool.toolResults[0]).toMatchObject({
      toolName: "remember",
      output: { stored: "Elia loves sushi" },
    })
  })

  it("scopes by source-conversation access: private hidden from other members, shared visible", async () => {
    const owner = new TestClient(BASE)
    const member = new TestClient(BASE)
    const ownerUser = await signUp(owner, "Owner")
    const memberUser = await signUp(member, "Member")

    const agentId: string = (await owner.get("/agent/agents")).body[0].id
    await owner.post("/agent/members", { agent_id: agentId, member_id: memberUser.id })

    const privateConv = await seed(agentId, ownerUser.id, false)
    const sharedConv = await seed(agentId, ownerUser.id, true)

    // The member sees only the shared source's memory conversation.
    const memberList = await member.get(`/agent/memory-conversations?agent_id=${agentId}`)
    expect(memberList.status).toBe(200)
    expect(memberList.body.map((c: { conversationId: string }) => c.conversationId)).toEqual([
      sharedConv.id,
    ])

    // The owner sees both.
    const ownerList = await owner.get(`/agent/memory-conversations?agent_id=${agentId}`)
    expect(ownerList.body).toHaveLength(2)

    // Detail respects the same rule.
    const privateMc = ownerList.body.find(
      (c: { conversationId: string }) => c.conversationId === privateConv.id
    )
    expect((await member.get(`/agent/memory-conversations?id=${privateMc.id}`)).status).toBe(403)
    const sharedMc = ownerList.body.find(
      (c: { conversationId: string }) => c.conversationId === sharedConv.id
    )
    expect((await member.get(`/agent/memory-conversations?id=${sharedMc.id}`)).status).toBe(200)
  })

  it("requires authentication and 404s an unknown id", async () => {
    const anon = new TestClient(BASE)
    expect((await anon.get("/agent/memory-conversations")).status).toBe(401)

    const user = new TestClient(BASE)
    await signUp(user, "User")
    expect(
      (await user.get("/agent/memory-conversations?id=00000000-0000-0000-0000-000000000000"))
        .status
    ).toBe(404)
  })
})
