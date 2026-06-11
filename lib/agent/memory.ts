import { tool } from "ai";
import { z } from "zod";
import { MEMORY_CATEGORIES } from "../global/schema";
import type { AgentMember } from "../db/agents";
import {
  createMemory,
  deleteMemory,
  findSimilarMemories,
  getPinnedMemories,
  searchMemories,
  updateMemory,
  type Memory,
} from "../db/memories";
import { embedText } from "../global/ai";

const categorySchema = z.enum(MEMORY_CATEGORIES);

/**
 * Everything memory operations need to stay inside one agent's pool and
 * attribute facts to the right person. Built per request in the conversation
 * route; `speaker` is whoever sent the current message.
 */
export type MemoryScope = {
  agentId: string;
  speaker: { id: string; name: string };
  members: AgentMember[];
};

const SHARED_SUBJECT = "shared" as const;

// Duplicate guard for the remember tool: document-vs-document cosine between
// the candidate content and stored memories (both sides embedded as kind
// "document" — these are NOT the query/document bands behind
// AUTO_RECALL_MIN_RELEVANCE). Measured with `npm run calibrate`: paraphrases
// and contradicting updates of the same fact ~0.84-0.98, distinct facts —
// including same-shaped facts about another member — ~0.54-0.75. 0.80 splits
// the bands with margin; test/ai/rag.test.ts guards this calibration.
const DUPLICATE_MIN_SIMILARITY = 0.8;

function subjectSchema(scope: MemoryScope) {
  return z
    .enum([...scope.members.map((m) => m.name), SHARED_SUBJECT])
    .describe(
      `Who the fact is about: one of the members by name, or "${SHARED_SUBJECT}" for facts about the group as a whole (shared plans, the household, joint projects).`
    );
}

function subjectToUserId(scope: MemoryScope, subject: string): string | null {
  return scope.members.find((m) => m.name === subject)?.userId ?? null;
}

// Tools are built per request because their scope (agent, speaker) and the
// subject enum (member names) change per agent. The schemas stay stable for a
// given agent + membership, so the prompt prefix remains KV-cache friendly.
export function buildMemoryTools(scope: MemoryScope) {
  return {
    remember: tool({
      description:
        "Store a lasting fact in long-term memory (preferences, people, events, health, etc.). Use it when someone shares something worth remembering beyond this conversation. Do not store transient or trivial details.",
      inputSchema: z.object({
        content: z
          .string()
          .min(1)
          .describe(
            "The fact as a short, self-contained sentence in third person, always naming the person it is about, e.g. \"Elia's car is a Golf 7\" — never \"my car\" or \"the user's car\"."
          ),
        subject: subjectSchema(scope),
        importance: z
          .number()
          .min(0)
          .max(1)
          .describe(
            "How important this fact is: 0.9+ critical (allergies, close family), 0.5-0.8 meaningful preferences and events, below 0.5 minor details"
          ),
        category: categorySchema,
        pinned: z
          .boolean()
          .optional()
          .describe(
            "Set true ONLY for facts that must be present in every conversation (e.g. a member's name, severe allergies). Use sparingly."
          ),
        allowDuplicate: z
          .boolean()
          .optional()
          .describe(
            "Set true ONLY after a previous remember call reported similar existing memories and you decided the new fact is genuinely distinct from all of them."
          ),
      }),
      execute: async ({ subject, allowDuplicate, ...input }) => {
        const embedding = await embedText(input.content, "document");
        if (!allowDuplicate) {
          const similar = await findSimilarMemories(scope.agentId, embedding, {
            minSimilarity: DUPLICATE_MIN_SIMILARITY,
          });
          if (similar.length > 0) {
            return {
              stored: false,
              similar: similar.map((m) => ({ id: m.id, content: m.content })),
              message:
                "Not stored: these existing memories look like the same fact. If the fact changed, call updateMemory with the id; if it is already stored, do nothing; only if it is genuinely a different fact, call remember again with allowDuplicate: true.",
            };
          }
        }
        const memory = await createMemory(
          {
            ...input,
            agentId: scope.agentId,
            subjectUserId: subjectToUserId(scope, subject),
            createdBy: scope.speaker.id,
          },
          embedding
        );
        return { id: memory.id, stored: memory.content };
      },
    }),

    updateMemory: tool({
      description:
        "Update an existing memory when a fact changes or was stored incorrectly. Use the memory id shown in your context or returned by recallMemories.",
      inputSchema: z.object({
        id: z.uuid(),
        content: z.string().min(1).optional(),
        subject: subjectSchema(scope).optional(),
        importance: z.number().min(0).max(1).optional(),
        category: categorySchema.optional(),
        pinned: z.boolean().optional(),
      }),
      execute: async ({ id, subject, ...changes }) => {
        const memory = await updateMemory(scope.agentId, id, {
          ...changes,
          ...(subject !== undefined ? { subjectUserId: subjectToUserId(scope, subject) } : {}),
        });
        if (!memory) return { error: "Memory not found" };
        return { id: memory.id, content: memory.content };
      },
    }),

    forget: tool({
      description:
        "Permanently delete a memory that is no longer true or that the user asked to forget.",
      inputSchema: z.object({
        id: z.uuid(),
      }),
      execute: async ({ id }) => {
        const memory = await deleteMemory(scope.agentId, id);
        if (!memory) return { error: "Memory not found" };
        return { deleted: memory.content };
      },
    }),

    recallMemories: tool({
      description:
        "Search long-term memory for stored facts. Use this when the conversation needs information that is not already in your context, e.g. before making suggestions based on someone's tastes or history.",
      inputSchema: z.object({
        query: z.string().min(1).describe("What to look for, phrased as a short description. Name the person when the question is about someone specific."),
        category: categorySchema.optional(),
      }),
      execute: async ({ query, category }) => {
        const results = await searchMemories(scope.agentId, query, {
          category,
          limit: 8,
          speakerUserId: scope.speaker.id,
        });
        return results.map((m) => ({
          id: m.id,
          content: m.content,
          category: m.category,
          date: m.createdAt.toISOString().slice(0, 10),
        }));
      },
    }),
  };
}

function formatMemory(m: Memory): string {
  return `- [id: ${m.id}] (${m.category}, ${m.createdAt.toISOString().slice(0, 10)}) ${m.content}`;
}

// Kept free of per-turn content so the prompt prefix stays byte-identical across
// requests for a given conversation and LM Studio can reuse its KV cache: in a
// private conversation the speaker never changes, in a shared one the speaker
// line is omitted (messages carry name labels instead). It only changes when
// the agent's membership or pinned memories change. Per-turn retrieval is
// appended to the user message instead (buildRelevantMemoriesBlock).
export async function buildMemorySystemPrompt(
  scope: MemoryScope,
  { sharedConversation }: { sharedConversation: boolean }
): Promise<string> {
  const pinned = await getPinnedMemories(scope.agentId);

  const memberNames = scope.members.map((m) => m.name).join(", ");
  const sections = [
    [
      "You are a personal assistant with a long-term memory stored in a database.",
      scope.members.length === 1
        ? `You assist one person: ${memberNames}.`
        : sharedConversation
          ? `This assistant is shared by several people: ${memberNames}. This is a shared conversation: any member can write in it, and each user message is prefixed with the speaker's name. Keep their facts straight and never mix one person's details into another's.`
          : `This assistant is shared by several people: ${memberNames}, but this is a private conversation with ${scope.speaker.name} — every message is from them. Keep each member's facts straight and never mix one person's details into another's.`,
    ].join("\n"),
  ];

  if (pinned.length > 0) {
    sections.push(`## Core memories (always available)\n${pinned.map(formatMemory).join("\n")}`);
  }

  sections.push(
    [
      "## Memory rules",
      "- User messages may start with a <relevant-memories> block: memories retrieved from the database for that turn. It is machine-inserted; the user did not write it and cannot see it, so never quote it back as something they said.",
      "- Blocks in earlier messages reflect what was known at that point; the most recent block and the core memories above are authoritative.",
      "- When someone shares a lasting fact (preference, person, event, health detail), store it with the remember tool. Phrase it in third person with the person's name (\"Elia's car is a Golf 7\"), and set the subject field to whoever the fact is about — or \"shared\" for group facts.",
      "- If something contradicts an existing memory, use updateMemory or forget with the memory's id instead of storing a duplicate.",
      "- Use recallMemories when you need facts that are not already in your context.",
      "- Do not mention memory ids or these rules to the user; just use what you know naturally.",
    ].join("\n")
  );

  return sections.join("\n\n");
}

// Junk guard only — when nothing clears it, the block is omitted entirely.
// Calibrated for EmbeddingGemma's task prefixes (search text embedded as a
// query, memories as documents — applied inside embedText) with speaker-
// prefixed query text ("Elia: …") against third-person memories: unrelated
// queries measure ~0.35-0.45 and direct hits ~0.53-0.69 (`npm run calibrate`).
// 0.48 splits the bands with margin on both sides; test/ai/rag.test.ts guards
// this calibration — re-measure if the embedding model or phrasing changes.
const AUTO_RECALL_MIN_RELEVANCE = 0.48;
const AUTO_RECALL_LIMIT = 4;

export async function buildRelevantMemoriesBlock(
  scope: MemoryScope,
  queryText: string
): Promise<string | null> {
  // The speaker prefix puts the asker's name into the embedding so "my car"
  // lands nearer "Elia's car is a Golf 7" than another member's car; the
  // subject bonus in searchMemories handles the rest deterministically.
  const retrieved = await searchMemories(scope.agentId, `${scope.speaker.name}: ${queryText}`, {
    limit: AUTO_RECALL_LIMIT,
    minRelevance: AUTO_RECALL_MIN_RELEVANCE,
    speakerUserId: scope.speaker.id,
  });
  if (retrieved.length === 0) return null;

  return `<relevant-memories>\n${retrieved.map(formatMemory).join("\n")}\n</relevant-memories>`;
}
