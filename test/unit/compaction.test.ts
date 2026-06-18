import type { ModelMessage, UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  applyCompaction,
  chatSummaryMessage,
  CONVERSATION_SUMMARY_OPEN,
  latestUsageTokens,
  memorySummaryMessage,
  MEMORY_SUMMARY_PREFIX,
  shouldCompact,
  splitForCompaction,
  usageTokens,
} from "../../lib/agent/compaction";

// Pad a message so estimateTokens (JSON length / 4) is roughly `tokens` big,
// letting tests force a deterministic cut point without exporting internals.
function big(role: ModelMessage["role"], tokens: number): ModelMessage {
  return { role, content: "x".repeat(tokens * 4) } as ModelMessage;
}

describe("shouldCompact", () => {
  it("triggers only above the default 0.8 threshold", () => {
    expect(shouldCompact(7900, 10_000)).toBe(false);
    expect(shouldCompact(8001, 10_000)).toBe(true);
  });

  it("never triggers without a usage number", () => {
    expect(shouldCompact(null, 10_000)).toBe(false);
  });
});

describe("splitForCompaction", () => {
  it("keeps the head and tail together as the original array", () => {
    const messages = [big("user", 100), big("assistant", 100), big("user", 5), big("assistant", 5)];
    const split = splitForCompaction(messages, 50);
    expect(split).not.toBeNull();
    expect([...split!.head, ...split!.tail]).toEqual(messages);
  });

  it("starts the tail on a user message so tool pairs are never orphaned", () => {
    // A tool result must stay with its assistant tool-call. A naive token cut
    // would land on the tool result; the boundary snap must move it to the user.
    const messages: ModelMessage[] = [
      big("user", 100),
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "recallMemories", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "recallMemories", output: { type: "json", value: {} } }] },
      big("user", 4),
      big("assistant", 4),
    ];
    const split = splitForCompaction(messages, 30);
    expect(split).not.toBeNull();
    expect(split!.tail[0].role).toBe("user");
    // The tool result is in the head, next to its tool-call — not split off.
    expect(split!.head.some((m) => m.role === "tool")).toBe(true);
    expect([...split!.head, ...split!.tail]).toEqual(messages);
  });

  it("returns null when the keepable tail has no user boundary", () => {
    // Only the trailing assistant turn fits, and there's no user message to
    // anchor the tail → no clean cut.
    const messages: ModelMessage[] = [
      big("user", 100),
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "t", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "t", output: { type: "json", value: {} } }] },
      big("assistant", 4),
    ];
    expect(splitForCompaction(messages, 20)).toBeNull();
  });

  it("returns null when there is nothing to summarize", () => {
    expect(splitForCompaction([big("user", 5)], 1000)).toBeNull();
    expect(splitForCompaction([], 1000)).toBeNull();
  });
});

describe("applyCompaction", () => {
  const history: UIMessage[] = [
    { id: "a", role: "user", parts: [{ type: "text", text: "one" }] },
    { id: "b", role: "assistant", parts: [{ type: "text", text: "two" }] },
    { id: "c", role: "user", parts: [{ type: "text", text: "three" }] },
    { id: "d", role: "assistant", parts: [{ type: "text", text: "four" }] },
  ];

  it("returns the full history when not compacted", () => {
    expect(applyCompaction(history, null)).toEqual(history);
  });

  it("replaces everything up to throughMessageId with the summary message", () => {
    const view = applyCompaction(history, { summary: "recap", throughMessageId: "b", tokens: 9000 });
    expect(view).toHaveLength(3);
    const first = view[0].parts[0];
    expect(first.type === "text" && first.text.startsWith(CONVERSATION_SUMMARY_OPEN)).toBe(true);
    expect(view.slice(1)).toEqual([history[2], history[3]]);
  });

  it("falls back to the full history when the pointer is stale", () => {
    expect(applyCompaction(history, { summary: "x", throughMessageId: "missing", tokens: 1 })).toEqual(
      history
    );
  });
});

describe("usage helpers", () => {
  it("usageTokens prefers totalTokens, else sums input + output", () => {
    expect(usageTokens({ totalTokens: 1234 })).toBe(1234);
    expect(usageTokens({ inputTokens: 100, outputTokens: 50 })).toBe(150);
    expect(usageTokens(null)).toBeNull();
    expect(usageTokens({ totalTokens: 0 })).toBeNull();
  });

  it("latestUsageTokens reads the newest message carrying usage", () => {
    const messages: UIMessage[] = [
      { id: "1", role: "assistant", parts: [], metadata: { usage: { totalTokens: 100 } } } as UIMessage,
      { id: "2", role: "user", parts: [] },
      { id: "3", role: "assistant", parts: [], metadata: { usage: { totalTokens: 900 } } } as UIMessage,
      { id: "4", role: "user", parts: [] },
    ];
    expect(latestUsageTokens(messages)).toBe(900);
    expect(latestUsageTokens([{ id: "x", role: "user", parts: [] }])).toBeNull();
  });
});

describe("summary messages", () => {
  it("chatSummaryMessage carries the marker so it is treated as machine context", () => {
    const msg = chatSummaryMessage("the gist");
    expect(msg.role).toBe("user");
    const part = msg.parts[0];
    expect(part.type === "text" && part.text.startsWith(CONVERSATION_SUMMARY_OPEN)).toBe(true);
    expect(part.type === "text" && part.text.includes("the gist")).toBe(true);
  });

  it("memorySummaryMessage is a prefixed user message", () => {
    const msg = memorySummaryMessage("already stored: Elia likes tea");
    expect(msg.role).toBe("user");
    expect(typeof msg.content === "string" && msg.content.startsWith(MEMORY_SUMMARY_PREFIX)).toBe(true);
  });
});
