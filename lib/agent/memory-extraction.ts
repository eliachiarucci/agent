import {
  extractReasoningMiddleware,
  generateText,
  stepCountIs,
  wrapLanguageModel,
  type ModelMessage,
  type UIMessage,
} from "ai";
import { chatModelFromSettings } from "../global/ai";
import { resolveDefaultChatModelAndTarget } from "./default-model";
import { getAgent, type Agent } from "../db/agents";
import { getProviderSetting } from "../db/provider-settings";
import { buildMemoryTools, type MemoryScope } from "./memory";
import { getMemoryConversation, saveMemoryConversation } from "../db/memory-conversations";
import { ATTACHED_FILES_MARKER } from "./files";
import { compactMemoryLog, usageTokens } from "./compaction";
import type { ContextTarget } from "./context";

// A dedicated model whose only job is to mine durable facts out of chats. It
// runs in the background after every turn (the main chat model still has its
// own memory tools); the duplicate guard on `remember` absorbs any overlap.
export const MEMORY_EXTRACTION_SYSTEM_PROMPT = [
  "You maintain a person's long-term memory in the background. You are shown exchanges (a user message and the assistant's reply) taken from that person's chats with their assistant. Inspect each exchange and persist anything durable and personal about the person using the memory tools.",
  "",
  "Store things that stay true beyond the current conversation: preferences and tastes, the people in their life (family, friends, partners, colleagues) and details about them, what they do and are working on, ongoing projects and goals, places they live, frequent, or want to visit, routines and habits, health details, and important dates or events. Capture concrete specifics, not vague impressions.",
  "",
  "The user will NEVER see your replies, so do not generate any text for them. Only use the memory tools to read and store facts. Just explain why you made certain choices in case the user sees the logs.",
  "",
  "Do NOT store transient or trivial things: one-off web searches or lookups, requests for explanations or how-tos, copywriting or drafting requests, grammar or spelling checks, code the assistant produced, or anything that does not reveal a lasting fact about the person.",
  "",
  "Rules:",
  '- Phrase every memory in the third person and name the person it is about (e.g. "Elia prefers tea over coffee"), and set the subject field accordingly — never "the user", "I", or "my".',
  "- Before storing, use recallMemories to check whether the fact already exists. If it changed or was wrong, call updateMemory; if it is already stored, leave it; only call remember for genuinely new facts.",
  "- If an exchange contains nothing worth remembering, do nothing.",
  "- You run unattended and the user never sees your replies. Do not ask questions or address them; just operate the tools.",
].join("\n");

// Mirrors isMachineTextPart in the conversation route: the retrieved-memories
// and attached-files blocks are model context, not the person's words, so they
// must not feed the extractor (it would store its own injected memories back).
function isMachineTextPart(text: string): boolean {
  return text.startsWith("<relevant-memories>") || text.startsWith(ATTACHED_FILES_MARKER);
}

// The agent's configured memory model, resolved against the owner's provider
// settings exactly like a chat request (mirrors cron's resolveJobModel). Falls
// back to the owner's default model when unset — or when the provider has been
// deconfigured since it was chosen, so extraction keeps working. The model is
// null when the owner has no default model either (extraction is skipped).
// Returns the target too for the context-window lookup that drives
// auto-compaction of the running log.
async function resolveMemoryModel(
  agent: Agent
): Promise<{ model: Awaited<ReturnType<typeof resolveDefaultChatModelAndTarget>>["model"]; target?: ContextTarget }> {
  if (!agent.memoryProvider) {
    const { model, target } = await resolveDefaultChatModelAndTarget(agent.ownerId);
    return { model, target: target ?? undefined };
  }
  const setting = await getProviderSetting(agent.ownerId, agent.memoryProvider);
  const modelId = agent.memoryModel ?? setting?.settings.model;
  if (!setting || !modelId) {
    const { model, target } = await resolveDefaultChatModelAndTarget(agent.ownerId);
    return { model, target: target ?? undefined };
  }
  return {
    model: chatModelFromSettings(agent.memoryProvider, setting.settings, modelId),
    target: { provider: agent.memoryProvider, settings: setting.settings, model: modelId },
  };
}

// The plain text the person (or assistant) actually wrote — reasoning and
// tool-call parts are dropped, only real text survives.
function messageText(message: UIMessage): string {
  return message.parts
    .flatMap((p) => (p.type === "text" && !isMachineTextPart(p.text) ? [p.text] : []))
    .join("\n")
    .trim();
}

type ExtractionParams = {
  conversationId: string;
  scope: MemoryScope;
  messages: UIMessage[];
};

// Serialize extractions per source conversation. Each call read-modify-writes
// the single memory_conversations row (read the log → run the model → overwrite)
// and the model run is slow, so fast successive turns would otherwise overlap
// and clobber each other's writes, dropping whole exchanges from the log.
// Chaining per conversation makes each extraction read the latest log only after
// the previous one saved. In-process is enough — the app runs as one process.
const queues = new Map<string, Promise<void>>();

/**
 * Feed the just-finished turn (last user message + complete assistant response)
 * to the background memory model and let it create/update memories. Appends to
 * this conversation's running memory conversation so the extractor keeps the
 * context of what it has already stored across turns. Calls for the same
 * conversation are serialized (see `queues`) so fast turns can't clobber the log.
 *
 * Best-effort: callers invoke it fire-and-forget from onFinish, so it must
 * never throw into the request path — failures are logged and swallowed.
 */
export function runMemoryExtraction(params: ExtractionParams): Promise<void> {
  const { conversationId } = params;
  const prev = queues.get(conversationId) ?? Promise.resolve();
  // A prior turn's failure must not break the chain for later turns.
  const next = prev.catch(() => {}).then(() => extractTurn(params));
  queues.set(conversationId, next);
  // Drop the entry once the chain drains so the map can't grow unbounded.
  void next.catch(() => {}).finally(() => {
    if (queues.get(conversationId) === next) queues.delete(conversationId);
  });
  return next;
}

async function extractTurn(params: ExtractionParams): Promise<void> {
  const { conversationId, scope, messages } = params;

  const reversed = [...messages].reverse();
  const lastUser = reversed.find((m) => m.role === "user");
  const lastAssistant = reversed.find((m) => m.role === "assistant");
  if (!lastUser) return;

  const userText = messageText(lastUser);
  const assistantText = lastAssistant ? messageText(lastAssistant) : "";
  if (!userText && !assistantText) return;

  // The latest exchange framed as one user turn for the extractor. The person's
  // own words carry the facts; the assistant's reply is context.
  const exchange = [
    `${scope.speaker.name}: ${userText}`,
    assistantText ? `Assistant: ${assistantText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  // The extractor runs on the agent's configured memory model (owner-picked in
  // settings), independent of whatever provider/model the turn itself used.
  const agent = await getAgent(scope.agentId);
  if (!agent) return;

  const prior = (await getMemoryConversation(conversationId))?.messages ?? [];
  const history: ModelMessage[] = [...prior, { role: "user", content: exchange }];

  const { model: memoryModel, target: memoryTarget } = await resolveMemoryModel(agent);
  // No model configured anywhere — nothing to extract with; skip this turn.
  if (!memoryModel) return;
  const result = await generateText({
    model: wrapLanguageModel({
      model: memoryModel,
      middleware: extractReasoningMiddleware({ tagName: "think" }),
    }),
    system: MEMORY_EXTRACTION_SYSTEM_PROMPT,
    messages: history,
    // Only the memory tools — the extractor reads and writes memory, nothing else.
    tools: buildMemoryTools(scope),
    stopWhen: stepCountIs(8),
  });

  // The appended exchange plus the extractor's reply (its tool calls and results
  // included), so the next turn resumes with full context.
  const full: ModelMessage[] = [...history, ...result.response.messages];

  // Auto-compaction: this log grows for the whole lifetime of the source
  // conversation and is re-sent in full each turn, so it must be bounded.
  // Destructive — the durable facts already live in the memory store, so once
  // the threshold is crossed the older log is collapsed to [summary, ...tail].
  const compacted = await compactMemoryLog({
    model: memoryModel,
    target: memoryTarget,
    messages: full,
    usedTokens: usageTokens(result.totalUsage),
  });

  await saveMemoryConversation(conversationId, scope.agentId, compacted);
}
