// Auto-compaction: keep growing conversations under the model's context window
// by summarizing the older messages once a usage threshold is crossed. Used by
// both the chat route (non-destructive: full history is kept, only a summary
// pointer is stored) and background memory extraction (destructive: the running
// ModelMessage history is rewritten to [summary, ...recent tail]).
//
// Compaction is a discrete, occasional event — not a per-turn re-trim — so the
// prompt prefix stays byte-stable between events and KV-cache reuse survives
// (see docs/memory.md).

import {
  extractReasoningMiddleware,
  generateText,
  stepCountIs,
  wrapLanguageModel,
  type ModelMessage,
  type UIMessage,
} from "ai";
import { getContextWindow, type ContextTarget } from "./context";
import { ATTACHED_FILES_MARKER } from "./files";
import type { CompactionState } from "../global/schema";

// Trigger compaction when the model's input crosses this fraction of its window.
const COMPACT_THRESHOLD = Number(process.env.COMPACT_THRESHOLD ?? 0.8);
// Tokens of recent history kept verbatim (the tail), as a fraction of the
// window. The summary + tail then sits comfortably under the threshold.
const COMPACT_KEEP_RATIO = Number(process.env.COMPACT_KEEP_RATIO ?? 0.3);
// Fallback window when a provider can't report its context length.
const DEFAULT_CONTEXT_TOKENS = Number(process.env.DEFAULT_CONTEXT_TOKENS ?? 32768);

// The user message that carries the summary into the model's view. Tagged so
// the conversation route's isMachineTextPart skips it (no name prefix, never
// feeds retrieval) — mirrors the <relevant-memories> / attached-files markers.
export const CONVERSATION_SUMMARY_OPEN = "<conversation-summary>";
const CONVERSATION_SUMMARY_CLOSE = "</conversation-summary>";
// Prefix of the memory-extractor's summary message, so it reads naturally in
// the read-only memory dialog and is recognizable as a compaction artifact.
export const MEMORY_SUMMARY_PREFIX =
  "Summary of earlier exchanges already processed and facts already stored:";

const CHAT_COMPACTION_PROMPT = [
  "You compress a long conversation between a person and their personal assistant so it can continue without exceeding the model's context window.",
  "Write a dense summary that preserves everything needed to continue seamlessly: the person's goals and intent, decisions and conclusions reached, durable facts established, tasks still open or in progress, and any files or notes created and what they are for.",
  "Prefer tight bullet points. Do not invent details, do not add commentary, and do not address the reader. If a prior summary is provided, fold it in — your output fully replaces it.",
].join("\n");

const MEMORY_COMPACTION_PROMPT = [
  "You maintain the running log of a background memory extractor. Compress the older part of the log so it can keep running without exceeding the context window.",
  "The durable facts are already saved in the memory store; this log only exists so the extractor remembers which exchanges it already processed and which facts it already stored or updated, to avoid re-storing them.",
  "Produce a terse summary of the exchanges handled so far and the facts already captured. Prefer bullet points. Do not invent details. If a prior summary is provided, fold it in — your output fully replaces it.",
].join("\n");

// The model instance callers already hold (chat/memory model) — exactly what
// wrapLanguageModel takes. Not generateText's looser type, which also allows a
// bare string id we never pass and can't wrap.
type LanguageModelArg = Parameters<typeof wrapLanguageModel>[0]["model"];
type Usage = { inputTokens?: number; outputTokens?: number; totalTokens?: number };

function totalOf(usage: Usage | undefined | null): number | null {
  if (!usage) return null;
  const total = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  return total > 0 ? total : null;
}

/** Token count of a provider usage object, or null when unavailable. */
export function usageTokens(usage: Usage | undefined | null): number | null {
  return totalOf(usage);
}

/**
 * The latest input size the model actually processed, read from stored message
 * metadata (each finish-step records usage; see the conversation route). This
 * reflects the *compacted* view the model saw, not the full stored history.
 */
export function latestUsageTokens(messages: UIMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const total = totalOf((messages[i].metadata as { usage?: Usage } | undefined)?.usage);
    if (total != null) return total;
  }
  return null;
}

/** The model's window in tokens, falling back to the env default when unknown. */
export async function resolveWindowTokens(target?: ContextTarget): Promise<number> {
  const window = await getContextWindow(target);
  return window.contextLength ?? DEFAULT_CONTEXT_TOKENS;
}

export function shouldCompact(usedTokens: number | null, windowTokens: number): boolean {
  if (usedTokens == null) return false;
  return usedTokens > windowTokens * COMPACT_THRESHOLD;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

/**
 * Split a message array into a head (to summarize) and a recent tail (kept
 * verbatim). The cut lands on a user-message boundary so an assistant tool-call
 * is never separated from its tool result — which would make the provider
 * reject the request. Returns null when no clean cut leaves a non-empty head
 * and tail (e.g. a single oversized trailing turn).
 */
export function splitForCompaction<T extends { role: string }>(
  messages: T[],
  keepTokens: number
): { head: T[]; tail: T[] } | null {
  let acc = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateTokens(messages[i]);
    // Always keep the last message; otherwise stop once the tail would overflow.
    if (acc + t > keepTokens && start !== messages.length) break;
    acc += t;
    start = i;
  }
  // Snap forward to the next user message so the tail begins a clean turn.
  while (start < messages.length && messages[start].role !== "user") start++;
  if (start <= 0 || start >= messages.length) return null;
  return { head: messages.slice(0, start), tail: messages.slice(start) };
}

function isMachineTextPart(text: string): boolean {
  return (
    text.startsWith("<relevant-memories>") ||
    text.startsWith(ATTACHED_FILES_MARKER) ||
    text.startsWith(CONVERSATION_SUMMARY_OPEN)
  );
}

// Flatten a UIMessage to a transcript line: the real text plus a note of any
// tools the assistant used (their outputs are elided — the summary needs that an
// action happened, not its full payload).
function transcriptFromUI(messages: UIMessage[]): string {
  return messages
    .map((m) => {
      const text = m.parts
        .flatMap((p) => (p.type === "text" && !isMachineTextPart(p.text) ? [p.text] : []))
        .join("\n")
        .trim();
      const tools = m.parts
        .filter((p) => typeof p.type === "string" && p.type.startsWith("tool-"))
        .map((p) => `[used ${(p.type as string).slice(5)}]`);
      // Image attachments can't ride into a text summary; keep a trace of them.
      const files = m.parts
        .filter((p) => p.type === "file")
        .map((p) => `[attached image: ${p.filename ?? "image"}]`);
      const body = [text, ...files, ...tools].filter(Boolean).join(" ");
      if (!body) return "";
      return `${m.role === "user" ? "User" : "Assistant"}: ${body}`;
    })
    .filter(Boolean)
    .join("\n");
}

function modelText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && typeof p === "object" && (p as { type?: string }).type === "text")
    .map((p) => (p as { text?: string }).text ?? "")
    .join("\n")
    .trim();
}

function modelToolNames(content: unknown, type: string): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((p) => p && typeof p === "object" && (p as { type?: string }).type === type)
    .map((p) => String((p as { toolName?: string }).toolName ?? ""));
}

function transcriptFromModel(messages: ModelMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === "user") return `User: ${modelText(m.content)}`;
      if (m.role === "tool") {
        const names = modelToolNames(m.content, "tool-result");
        return names.length ? `Tool results: ${names.join(", ")}` : "";
      }
      const text = modelText(m.content);
      const calls = modelToolNames(m.content, "tool-call").map((n) => `[used ${n}]`);
      const body = [text, ...calls].filter(Boolean).join(" ");
      return body ? `Assistant: ${body}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

async function summarize(
  model: LanguageModelArg,
  params: { priorSummary?: string; transcript: string; instructions: string }
): Promise<string> {
  const input = params.priorSummary
    ? `Summary so far:\n${params.priorSummary}\n\nConversation since then:\n${params.transcript}`
    : params.transcript;
  const result = await generateText({
    // Strip inline <think> reasoning so it never leaks into the stored summary.
    model: wrapLanguageModel({ model, middleware: extractReasoningMiddleware({ tagName: "think" }) }),
    system: params.instructions,
    prompt: input,
    stopWhen: stepCountIs(1),
  });
  return result.text.trim();
}

/** The synthetic user message that carries a chat summary into the model view. */
export function chatSummaryMessage(summary: string): UIMessage {
  return {
    id: "conversation-summary",
    role: "user",
    parts: [{ type: "text", text: `${CONVERSATION_SUMMARY_OPEN}\n${summary}\n${CONVERSATION_SUMMARY_CLOSE}` }],
  };
}

/**
 * The model's view of a chat: when compacted, the summary message followed by
 * every message after the summarized point; otherwise the full history. The
 * full stored history is never touched — scrollback is preserved.
 */
export function applyCompaction(history: UIMessage[], state: CompactionState | null): UIMessage[] {
  if (!state) return history;
  const idx = history.findIndex((m) => m.id === state.throughMessageId);
  // Stale pointer (shouldn't happen) → fall back to the full history.
  if (idx === -1) return history;
  return [chatSummaryMessage(state.summary), ...history.slice(idx + 1)];
}

/**
 * Decide whether the just-finished chat turn needs compaction and, if so,
 * produce the new state. Non-destructive: the caller keeps the full history and
 * only persists the returned pointer. Returns null when no compaction is needed
 * or no clean cut exists.
 */
export async function planChatCompaction(params: {
  model: LanguageModelArg;
  target?: ContextTarget;
  messages: UIMessage[];
  prior: CompactionState | null;
  // The model's input size for the turn that just ran. Compaction now runs
  // in-band (while the stream is still open), where `messages` is the history up
  // to the new user message and doesn't yet carry this turn's usage metadata —
  // so the caller passes the fresh count from `result.totalUsage`. Falls back to
  // the usage stored in the messages' metadata when omitted.
  usedTokens?: number | null;
  // Fired once, immediately before the (potentially slow) summary model call —
  // lets the caller surface a "compacting" indicator before it starts.
  onCompacting?: () => void;
}): Promise<CompactionState | null> {
  const { model, target, messages, prior, onCompacting } = params;
  const used = params.usedTokens ?? latestUsageTokens(messages);
  const windowTokens = await resolveWindowTokens(target);
  if (!shouldCompact(used, windowTokens)) return null;

  // Summarize only what the model currently sees beyond the prior summary.
  const priorIdx = prior ? messages.findIndex((m) => m.id === prior.throughMessageId) : -1;
  const viewTail = priorIdx === -1 ? messages : messages.slice(priorIdx + 1);
  const split = splitForCompaction(viewTail, windowTokens * COMPACT_KEEP_RATIO);
  if (!split) return null;

  onCompacting?.();
  const summary = await summarize(model, {
    priorSummary: prior?.summary,
    transcript: transcriptFromUI(split.head),
    instructions: CHAT_COMPACTION_PROMPT,
  });
  if (!summary) return null;
  return {
    summary,
    throughMessageId: split.head[split.head.length - 1].id,
    tokens: used ?? 0,
  };
}

/** The synthetic user message that opens a compacted memory-extraction log. */
export function memorySummaryMessage(summary: string): ModelMessage {
  return { role: "user", content: `${MEMORY_SUMMARY_PREFIX}\n${summary}` };
}

/**
 * Compact the background memory-extraction log if it crossed the threshold.
 * Destructive: the durable facts live in the memory store, so the log itself is
 * rewritten to [summary, ...recent tail]. Returns the messages to persist —
 * either compacted or the input unchanged.
 */
export async function compactMemoryLog(params: {
  model: LanguageModelArg;
  target?: ContextTarget;
  messages: ModelMessage[];
  usedTokens: number | null;
}): Promise<ModelMessage[]> {
  const { model, target, messages, usedTokens } = params;
  const windowTokens = await resolveWindowTokens(target);
  const used = usedTokens ?? estimateTokens(messages);
  if (!shouldCompact(used, windowTokens)) return messages;

  const split = splitForCompaction(messages, windowTokens * COMPACT_KEEP_RATIO);
  if (!split) return messages;

  const summary = await summarize(model, {
    transcript: transcriptFromModel(split.head),
    instructions: MEMORY_COMPACTION_PROMPT,
  });
  if (!summary) return messages;
  return [memorySummaryMessage(summary), ...split.tail];
}
