import type { UIMessage } from "ai";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  backfillSearchText,
  createMessage,
  messageSearchText,
  searchConversations,
  updateMessage,
} from "../../lib/db/conversations";
import { buildConversationSearchTools } from "../../lib/agent/conversation-search";
import { closeDb, makeUserWithAgent, resetDb } from "../helpers/db";

beforeEach(resetDb);
afterAll(closeDb);

const user = (text: string): UIMessage => ({ id: text, role: "user", parts: [{ type: "text", text }] });
const assistant = (text: string): UIMessage => ({
  id: text,
  role: "assistant",
  parts: [{ type: "text", text }],
});
// An assistant turn that also called a tool — the tool part must never be indexed
// or surfaced by readChatRound.
const assistantWithTool = (text: string): UIMessage => ({
  id: text,
  role: "assistant",
  parts: [
    { type: "text", text },
    { type: "tool-webSearch", toolCallId: "1", state: "output-available", input: {}, output: { secret: "TOOLDATA" } } as never,
  ],
});

// deno-lint friendly: invoke a tool's execute without the SDK call context.
const run = (t: { execute?: (i: never, o: never) => unknown }, input: unknown) =>
  t.execute!(input as never, {} as never);

describe("messageSearchText", () => {
  it("joins authored text and drops machine blocks + tool parts", () => {
    const text = messageSearchText([
      user("real question about renovation"),
      { id: "m", role: "user", parts: [{ type: "text", text: "<relevant-memories>\ninjected\n</relevant-memories>" }] },
      assistantWithTool("real answer"),
    ]);
    expect(text).toContain("real question about renovation");
    expect(text).toContain("real answer");
    expect(text).not.toContain("injected");
    expect(text).not.toContain("TOOLDATA");
  });

  it("reads legacy { role, content } messages", () => {
    expect(messageSearchText([{ role: "user", content: "legacy text" }])).toBe("legacy text");
  });
});

describe("searchConversations", () => {
  it("finds conversations by word and maintains search_text on write", async () => {
    const { user: owner, agent } = await makeUserWithAgent("Owner");
    const hit = await createMessage({
      agentId: agent.id,
      userId: owner.id,
      shared: false,
      messages: [user("planning the kitchen renovation"), assistant("sounds good")],
    });
    await createMessage({
      agentId: agent.id,
      userId: owner.id,
      shared: false,
      messages: [user("unrelated chat about taxes")],
    });

    const found = await searchConversations({ agentId: agent.id, viewerId: owner.id, query: "renovation" });
    expect(found.map((h) => h.conversationId)).toEqual([hit.id]);
    expect(found[0].snippet).toContain("**renovation**");

    expect(await searchConversations({ agentId: agent.id, viewerId: owner.id, query: "zzzznope" })).toHaveLength(0);

    // Editing the messages updates what is searchable.
    await updateMessage(hit.id, { messages: [user("now about the garden instead")] });
    expect(await searchConversations({ agentId: agent.id, viewerId: owner.id, query: "renovation" })).toHaveLength(0);
    expect(await searchConversations({ agentId: agent.id, viewerId: owner.id, query: "garden" })).toHaveLength(1);
  });

  it("backfillSearchText fills rows whose search_text is missing", async () => {
    const { user: owner, agent } = await makeUserWithAgent("Owner");
    const convo = await createMessage({
      agentId: agent.id,
      userId: owner.id,
      shared: false,
      messages: [user("backfilltarget topic")],
    });
    // Simulate a row written before the column existed.
    await updateMessage(convo.id, { searchText: null });
    expect(await searchConversations({ agentId: agent.id, viewerId: owner.id, query: "backfilltarget" })).toHaveLength(0);

    expect(await backfillSearchText()).toBeGreaterThanOrEqual(1);
    const found = await searchConversations({ agentId: agent.id, viewerId: owner.id, query: "backfilltarget" });
    expect(found.map((h) => h.conversationId)).toEqual([convo.id]);
  });

  it("only returns the viewer's own private chats plus shared ones", async () => {
    const member = await makeUserWithAgent("Member");
    const { user: owner, agent } = await makeUserWithAgent("Owner", [member.user]);
    await createMessage({ agentId: agent.id, userId: owner.id, shared: false, messages: [user("ownersecret topic")] });
    const shared = await createMessage({ agentId: agent.id, userId: owner.id, shared: true, messages: [user("ownersecret shared topic")] });

    const asMember = await searchConversations({ agentId: agent.id, viewerId: member.user.id, query: "ownersecret" });
    expect(asMember.map((h) => h.conversationId)).toEqual([shared.id]);
  });
});

describe("searchChats / readChatRound tools", () => {
  it("points searches at the matching round and navigates rounds", async () => {
    const { user: owner, agent } = await makeUserWithAgent("Owner");
    const convo = await createMessage({
      agentId: agent.id,
      userId: owner.id,
      shared: false,
      messages: [
        user("do you remember the house renovation?"),
        assistant("Yes — we discussed paint and floors."),
        user("what did we decide on the budget?"),
        assistantWithTool("The budget is around 10k."),
      ],
    });
    // Search from a different conversation, so this one is a past chat.
    const tools = buildConversationSearchTools({
      agentId: agent.id,
      viewerId: owner.id,
      currentConversationId: "some-other-conversation",
    });

    const search = (await run(tools.searchChats, { query: "budget" })) as { results: { conversationId: string; round: number; current: boolean }[] };
    expect(search.results[0].conversationId).toBe(convo.id);
    expect(search.results[0].current).toBe(false);
    expect(search.results[0].round).toBe(1); // the budget exchange is the 2nd round

    const round1 = (await run(tools.readChatRound, { conversationId: convo.id, round: 1 })) as Record<string, unknown>;
    expect(round1.user).toBe("what did we decide on the budget?");
    expect(round1.assistant).toBe("The budget is around 10k.");
    expect(round1.assistant).not.toContain("TOOLDATA"); // tool part stripped
    expect(round1).toMatchObject({ roundCount: 2, hasPrev: true, hasNext: false });

    const round0 = (await run(tools.readChatRound, { conversationId: convo.id, round: 0 })) as Record<string, unknown>;
    expect(round0).toMatchObject({ hasPrev: false, hasNext: true });
    expect(round0.assistant).toBe("Yes — we discussed paint and floors.");
  });

  it("only surfaces the current chat's pre-compaction messages", async () => {
    const { user: owner, agent } = await makeUserWithAgent("Owner");
    const convo = await createMessage({
      agentId: agent.id,
      userId: owner.id,
      shared: false,
      messages: [
        user("early on we discussed renovation"),
        assistant("right, the renovation plan"),
        user("now let's cover the budget"),
        assistant("the budget is 10k"),
      ],
    });
    const current = buildConversationSearchTools({
      agentId: agent.id,
      viewerId: owner.id,
      currentConversationId: convo.id,
    });

    // Not compacted yet: the whole chat is in context, so searching it returns nothing.
    expect((await run(current.searchChats, { query: "renovation" })) as { results: unknown[] }).toMatchObject({
      results: [],
    });

    // Compact away the first round; its text is now out of context and searchable,
    // while the live tail ("budget") still is not.
    await updateMessage(convo.id, {
      compaction: { summary: "talked about renovation", throughMessageId: "right, the renovation plan", tokens: 50 },
    });

    const preHit = (await run(current.searchChats, { query: "renovation" })) as { results: { conversationId: string; current: boolean }[] };
    expect(preHit.results.map((r) => r.conversationId)).toEqual([convo.id]);
    expect(preHit.results[0].current).toBe(true);

    // "budget" lives only in the still-visible tail → excluded.
    expect((await run(current.searchChats, { query: "budget" })) as { results: unknown[] }).toMatchObject({ results: [] });
  });

  it("coerces stringified numbers from models (round, limit)", () => {
    const tools = buildConversationSearchTools({ agentId: "a", viewerId: "v", currentConversationId: "c" });
    // Local models frequently emit numeric args as strings; the schema must accept them.
    expect(tools.readChatRound.inputSchema.parse({ conversationId: "x", round: "0" })).toMatchObject({ round: 0 });
    expect(tools.searchChats.inputSchema.parse({ query: "mats", limit: "5" })).toMatchObject({ limit: 5 });
  });

  it("refuses to read a conversation the viewer can't access", async () => {
    const outsider = await makeUserWithAgent("Outsider");
    const { user: owner, agent } = await makeUserWithAgent("Owner", [outsider.user]);
    const priv = await createMessage({ agentId: agent.id, userId: owner.id, shared: false, messages: [user("private stuff")] });

    const tools = buildConversationSearchTools({
      agentId: agent.id,
      viewerId: outsider.user.id,
      currentConversationId: priv.id,
    });
    const res = (await run(tools.readChatRound, { conversationId: priv.id, round: 0 })) as { error?: string };
    expect(res.error).toBeTruthy();
  });
});
