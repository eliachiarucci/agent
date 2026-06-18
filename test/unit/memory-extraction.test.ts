import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage, UIMessage } from "ai";

// Gate every extractor model call so the test controls exactly when each one
// finishes — that's what lets us observe whether extractions overlap. The real
// queue logic and the real database stay in play; only the model is faked.
const h = vi.hoisted(() => {
  const gates: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  const generateText = vi.fn(
    (): Promise<unknown> =>
      new Promise((resolve, reject) => {
        gates.push({
          resolve: () =>
            resolve({
              response: { messages: [{ role: "assistant", content: "ok" }] },
              totalUsage: { totalTokens: 5 },
            }),
          reject,
        });
      })
  );
  return { gates, generateText };
});

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: h.generateText };
});

// Keep compaction's window lookup off the network (it would otherwise hit LM
// Studio); a large window means our tiny fixtures never trip compaction.
vi.mock("../../lib/agent/context", () => ({
  getContextWindow: vi.fn(async () => ({ model: "test", contextLength: 32768 })),
}));

import { runMemoryExtraction } from "../../lib/agent/memory-extraction";
import { getMemoryConversation } from "../../lib/db/memory-conversations";
import { createMessage } from "../../lib/db/conversations";
import type { MemoryScope } from "../../lib/agent/memory";
import { closeDb, makeUserWithAgent, resetDb } from "../helpers/db";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const releaseNext = () => h.gates.shift()?.resolve();
const failNext = () => h.gates.shift()?.reject(new Error("boom"));

beforeEach(async () => {
  await resetDb();
  h.generateText.mockClear();
  h.gates.length = 0;
});
afterAll(closeDb);

// One chat turn: the user message + the assistant reply, as onFinish would hand it over.
function turn(text: string): UIMessage[] {
  return [
    { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] },
    { id: crypto.randomUUID(), role: "assistant", parts: [{ type: "text", text: `re:${text}` }] },
  ];
}

async function setupConversation(userName = "Elia") {
  const { user, agent } = await makeUserWithAgent(userName);
  const conv = await createMessage({
    agentId: agent.id,
    userId: user.id,
    shared: false,
    messages: [],
  });
  const scope: MemoryScope = {
    agentId: agent.id,
    speaker: { id: user.id, name: user.name },
    members: [{ userId: user.id, name: user.name, role: "owner" }],
  };
  return { user, agent, conv, scope };
}

const exchangesOf = (messages: ModelMessage[]) =>
  messages.filter((m) => m.role === "user").map((m) => m.content as string);

describe("memory extraction serialization", () => {
  it("serializes extractions for one conversation, keeping every exchange in order", async () => {
    const { conv, scope } = await setupConversation();

    // Three turns fired "at once", as fast typing would.
    const p1 = runMemoryExtraction({ conversationId: conv.id, scope, messages: turn("one") });
    const p2 = runMemoryExtraction({ conversationId: conv.id, scope, messages: turn("two") });
    const p3 = runMemoryExtraction({ conversationId: conv.id, scope, messages: turn("three") });

    // Only the first runs; the others are queued behind it (the bug was that they
    // all read the log up front and clobbered each other).
    await vi.waitFor(() => expect(h.generateText).toHaveBeenCalledTimes(1));
    await sleep(20);
    expect(h.generateText).toHaveBeenCalledTimes(1);

    releaseNext();
    await vi.waitFor(() => expect(h.generateText).toHaveBeenCalledTimes(2));
    releaseNext();
    await vi.waitFor(() => expect(h.generateText).toHaveBeenCalledTimes(3));
    releaseNext();
    await Promise.all([p1, p2, p3]);

    const stored = await getMemoryConversation(conv.id);
    expect(exchangesOf(stored!.messages)).toEqual([
      "Elia: one\n\nAssistant: re:one",
      "Elia: two\n\nAssistant: re:two",
      "Elia: three\n\nAssistant: re:three",
    ]);
  });

  it("runs extractions for different conversations in parallel", async () => {
    const a = await setupConversation("Alice");
    const b = await setupConversation("Bob");

    const pa = runMemoryExtraction({ conversationId: a.conv.id, scope: a.scope, messages: turn("a") });
    const pb = runMemoryExtraction({ conversationId: b.conv.id, scope: b.scope, messages: turn("b") });

    // Both start without waiting for each other — only same-conversation calls serialize.
    await vi.waitFor(() => expect(h.generateText).toHaveBeenCalledTimes(2));
    releaseNext();
    releaseNext();
    await Promise.all([pa, pb]);

    expect((await getMemoryConversation(a.conv.id))!.messages).toHaveLength(2);
    expect((await getMemoryConversation(b.conv.id))!.messages).toHaveLength(2);
  });

  it("keeps draining the queue after a turn fails", async () => {
    const { conv, scope } = await setupConversation();

    const p1 = runMemoryExtraction({
      conversationId: conv.id,
      scope,
      messages: turn("one"),
    }).catch(() => {});
    const p2 = runMemoryExtraction({ conversationId: conv.id, scope, messages: turn("two") });

    await vi.waitFor(() => expect(h.generateText).toHaveBeenCalledTimes(1));
    failNext(); // the first turn errors before it can save
    await vi.waitFor(() => expect(h.generateText).toHaveBeenCalledTimes(2));
    releaseNext();
    await Promise.all([p1, p2]);

    // The failed turn stored nothing; the next turn still ran and saved.
    const stored = await getMemoryConversation(conv.id);
    expect(exchangesOf(stored!.messages)).toEqual(["Elia: two\n\nAssistant: re:two"]);
  });
});
