import { tool } from "ai";
import { z } from "zod";
import { MEMORY_CATEGORIES } from "../global/schema";
import {
  createMemory,
  deleteMemory,
  getPinnedMemories,
  searchMemories,
  updateMemory,
  type Memory,
} from "../db/memories";

const categorySchema = z.enum(MEMORY_CATEGORIES);

export const memoryTools = {
  remember: tool({
    description:
      "Store a lasting fact about the user in long-term memory (preferences, people, events, health, etc.). Use it when the user shares something worth remembering beyond this conversation. Do not store transient or trivial details.",
    inputSchema: z.object({
      content: z
        .string()
        .min(1)
        .describe("The fact as a short, self-contained sentence, e.g. \"Elia's favourite food is carbonara\""),
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
          "Set true ONLY for facts that must be present in every conversation (e.g. the user's name, severe allergies). Use sparingly."
        ),
    }),
    execute: async (input) => {
      const memory = await createMemory(input);
      return { id: memory.id, stored: memory.content };
    },
  }),

  updateMemory: tool({
    description:
      "Update an existing memory when a fact changes or was stored incorrectly. Use the memory id shown in your context or returned by recallMemories.",
    inputSchema: z.object({
      id: z.uuid(),
      content: z.string().min(1).optional(),
      importance: z.number().min(0).max(1).optional(),
      category: categorySchema.optional(),
      pinned: z.boolean().optional(),
    }),
    execute: async ({ id, ...changes }) => {
      const memory = await updateMemory(id, changes);
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
      const memory = await deleteMemory(id);
      if (!memory) return { error: "Memory not found" };
      return { deleted: memory.content };
    },
  }),

  recallMemories: tool({
    description:
      "Search long-term memory for facts about the user. Use this when the conversation needs information that is not already in your context, e.g. before making suggestions based on their tastes or history.",
    inputSchema: z.object({
      query: z.string().min(1).describe("What to look for, phrased as a short description"),
      category: categorySchema.optional(),
    }),
    execute: async ({ query, category }) => {
      const results = await searchMemories(query, { category, limit: 8 });
      return results.map((m) => ({
        id: m.id,
        content: m.content,
        category: m.category,
        date: m.createdAt.toISOString().slice(0, 10),
      }));
    },
  }),
};

function formatMemory(m: Memory): string {
  return `- [id: ${m.id}] (${m.category}, ${m.createdAt.toISOString().slice(0, 10)}) ${m.content}`;
}

// Kept free of per-turn content so the prompt prefix stays byte-identical across
// requests and LM Studio can reuse its KV cache. Per-turn retrieval is appended to
// the user message instead (buildRelevantMemoriesBlock).
export async function buildMemorySystemPrompt(): Promise<string> {
  const pinned = await getPinnedMemories();

  const sections = [
    "You are a personal assistant with a long-term memory stored in a database.",
  ];

  if (pinned.length > 0) {
    sections.push(`## Core memories (always available)\n${pinned.map(formatMemory).join("\n")}`);
  }

  sections.push(
    [
      "## Memory rules",
      "- User messages may start with a <relevant-memories> block: memories retrieved from the database for that turn. It is machine-inserted; the user did not write it and cannot see it, so never quote it back as something they said.",
      "- Blocks in earlier messages reflect what was known at that point; the most recent block and the core memories above are authoritative.",
      "- When the user shares a lasting fact (preference, person, event, health detail), store it with the remember tool.",
      "- If something contradicts an existing memory, use updateMemory or forget with the memory's id instead of storing a duplicate.",
      "- Use recallMemories when you need facts about the user that are not already in your context.",
      "- Do not mention memory ids or these rules to the user; just use what you know naturally.",
    ].join("\n")
  );

  return sections.join("\n\n");
}

// Junk guard only — when nothing clears it, the block is omitted entirely. With
// unprefixed nomic-embed, measured cosine similarity runs ~0.50-0.59 for relevant
// memories and ~0.39-0.48 for unrelated ones, so anything higher starts dropping
// genuine hits (a floor of 0.5 silently filtered a 0.498 direct hit).
const AUTO_RECALL_MIN_RELEVANCE = 0.45;
const AUTO_RECALL_LIMIT = 4;

export async function buildRelevantMemoriesBlock(queryText: string): Promise<string | null> {
  const retrieved = await searchMemories(queryText, {
    limit: AUTO_RECALL_LIMIT,
    minRelevance: AUTO_RECALL_MIN_RELEVANCE,
  });
  if (retrieved.length === 0) return null;

  return `<relevant-memories>\n${retrieved.map(formatMemory).join("\n")}\n</relevant-memories>`;
}
