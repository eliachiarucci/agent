import { tool } from "ai";
import { z } from "zod";
import {
  canAccessConversation,
  findMessage,
  searchConversations,
} from "../db/conversations";
import type { CompactionState, StoredMessage } from "../global/schema";

// Lets the agent recall things said in earlier conversations — and in earlier
// parts of the *current* one that auto-compaction has dropped from its context
// (the full transcript stays persisted; only the model's view is trimmed).
//
// searchChats does the FTS lookup and returns, per hit, a highlighted snippet
// plus the index of the matching *round* — one user message and the assistant's
// reply (tool calls/results stripped). readChatRound then reads that round and
// its neighbours, so the agent can follow the thread forwards ("what did we say
// after?") or backwards. Both tools are scoped to what the asker may see (their
// private chats + the agent's shared ones).
const MAX_RESULTS = 8;
// A round's user/assistant text is truncated past this, to bound context use.
const MAX_FIELD_CHARS = 10_000;

// Machine-inserted text parts that were never authored by a person; excluded from
// what we show back, mirroring isMachineTextPart in lib/agent/compaction.ts.
const MACHINE_PART_PREFIXES = ["<relevant-memories>", "<attached-files>", "<conversation-summary>"];

function isMachinePart(text: string): boolean {
  return MACHINE_PART_PREFIXES.some((prefix) => text.startsWith(prefix));
}

// The human-authored text of one message: text parts only (tool calls/results and
// machine-inserted blocks dropped). "" for tool-only / empty messages.
function messageText(message: StoredMessage): string {
  if (!("parts" in message)) return message.content.trim(); // LegacyMessage
  return message.parts
    .flatMap((p) => (p.type === "text" && !isMachinePart(p.text) ? [p.text] : []))
    .join("\n")
    .trim();
}

type Round = { round: number; user: string; assistant: string };

// Groups a conversation into rounds: each user message opens a round, and the
// assistant messages that follow (until the next user message) are its reply.
// Tool traffic collapses away — messageText keeps only authored prose.
function conversationRounds(messages: StoredMessage[]): Round[] {
  const rounds: Round[] = [];
  let user: string[] = [];
  let assistant: string[] = [];
  let open = false;
  const flush = () => {
    if (open) rounds.push({ round: rounds.length, user: user.join("\n").trim(), assistant: assistant.join("\n").trim() });
  };
  for (const message of messages) {
    const text = messageText(message);
    if (message.role === "user") {
      flush();
      user = text ? [text] : [];
      assistant = [];
      open = true;
    } else {
      if (!open) {
        // Assistant message before any user turn (rare): start a userless round.
        user = [];
        assistant = [];
        open = true;
      }
      if (text) assistant.push(text);
    }
  }
  flush();
  return rounds;
}

function clip(text: string): string {
  return text.length > MAX_FIELD_CHARS ? text.slice(0, MAX_FIELD_CHARS) + " … [truncated]" : text;
}

function queryTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
}

function textMatches(text: string, tokens: string[]): boolean {
  const lower = text.toLowerCase();
  return tokens.some((w) => lower.includes(w));
}

// First round whose text mentions a query term, so a hit points at where the
// match actually is. Falls back to the first round when stemming hides the term
// from a naive substring check (the snippet still shows the real match).
function matchingRound(rounds: Round[], tokens: string[]): number {
  const found = rounds.findIndex((r) => textMatches(`${r.user}\n${r.assistant}`, tokens));
  return found === -1 ? 0 : found;
}

// The text of the current conversation that has been compacted away — summarized
// and dropped from the model's live context (the tail it can still see is
// excluded). Returns null when nothing has been compacted yet, i.e. the whole
// conversation is still in context and searching it would just echo what's there.
function preCompactionText(messages: StoredMessage[], compaction: CompactionState | null): string | null {
  if (!compaction) return null;
  const boundary = messages.findIndex((m) => "id" in m && m.id === compaction.throughMessageId);
  if (boundary < 0) return null;
  return messages
    .slice(0, boundary + 1)
    .map(messageText)
    .filter(Boolean)
    .join("\n");
}

export type ConversationSearchScope = {
  agentId: string;
  // Whoever is asking: results are limited to their own + shared conversations.
  viewerId: string;
  // The chat this search runs from, so hits in it can be flagged as "current".
  currentConversationId: string;
};

export function buildConversationSearchTools(scope: ConversationSearchScope) {
  return {
    searchChats: tool({
      description:
        "Full-text search across past conversations, plus earlier parts of the current one that have scrolled out of your context. Use it when the user refers to something discussed before that you can't see. It matches words and phrases, not meaning: search the distinctive terms you'd expect to appear, and retry with synonyms if results are thin. Supports \"quoted phrases\" and -term to exclude a word. Each result gives a highlighted snippet and a `round` index; pass that conversationId and round to readChatRound to read the full exchange and what came around it.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe("The words or phrase to look for — the specific terms likely to appear in the messages."),
        // coerce: local models often send numbers as strings.
        limit: z.coerce.number().int().min(1).max(20).optional().describe("Max results (default 8)."),
      }),
      execute: async ({ query, limit }) => {
        const hits = await searchConversations({
          agentId: scope.agentId,
          viewerId: scope.viewerId,
          query,
          limit: limit ?? MAX_RESULTS,
        });
        const tokens = queryTokens(query);
        const results = [];
        for (const h of hits) {
          if (h.conversationId === scope.currentConversationId) {
            // The model already sees the live tail of this conversation; only its
            // compacted-away part is worth surfacing. Drop the hit unless the match
            // is in that pre-compaction text.
            const pre = preCompactionText(h.messages, h.compaction);
            if (pre === null || !textMatches(pre, tokens)) continue;
          }
          results.push({
            conversationId: h.conversationId,
            current: h.conversationId === scope.currentConversationId,
            date: h.updatedAt.toISOString().slice(0, 10),
            round: matchingRound(conversationRounds(h.messages), tokens),
            snippet: h.snippet,
          });
        }
        if (results.length === 0) {
          return { results: [], note: "No matching messages. Try different or broader terms." };
        }
        return { results };
      },
    }),

    readChatRound: tool({
      description:
        "Read one full round (a user message and the assistant's reply, without tool noise) from a conversation found via searchChats. Start at the `round` from a search result, then read on by calling again with round + 1, or back with round - 1 — use this to answer follow-ups like 'what did we say after that?'.",
      inputSchema: z.object({
        conversationId: z.string().describe("A conversationId from searchChats."),
        // coerce: local models often send numbers as strings (e.g. "0").
        round: z.coerce.number().int().min(0).describe("Index of the round to read (from a search result, or ±1 to navigate)."),
      }),
      execute: async ({ conversationId, round }) => {
        const conversation = await findMessage(conversationId);
        // Same visibility rule as search; agentId match stands in for membership,
        // which resolveActor already verified for this request's agent.
        if (
          !conversation ||
          !canAccessConversation(conversation, scope.viewerId, conversation.agentId === scope.agentId)
        ) {
          return { error: "No such conversation, or you don't have access to it." };
        }

        const rounds = conversationRounds(conversation.messages);
        if (rounds.length === 0) return { error: "That conversation has no readable messages." };

        const index = Math.min(Math.max(round, 0), rounds.length - 1);
        const current = rounds[index];
        return {
          date: conversation.updatedAt.toISOString().slice(0, 10),
          current: conversation.id === scope.currentConversationId,
          roundCount: rounds.length,
          round: index,
          user: clip(current.user),
          assistant: clip(current.assistant),
          hasPrev: index > 0,
          hasNext: index < rounds.length - 1,
        };
      },
    }),
  };
}

export const conversationSearchPrompt =
  "## Past conversations\n" +
  "- Use searchChats to look up things from earlier conversations, or from earlier in this one that has scrolled out of your context. It is keyword-based, so try the exact terms you'd expect in the messages and re-query with synonyms if the first attempt comes back empty.\n" +
  "- Each result names a `round`. Open it with readChatRound to read the whole exchange; to follow up on what came next (or before), call readChatRound again with a higher (or lower) round.";
