import { boolean, index, jsonb, pgTable, real, text, timestamp, uuid, vector } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { UIMessage } from "ai";

// Rows written before the UI message stream migration; still readable.
export type LegacyMessage = { role: "user" | "assistant"; content: string };
export type StoredMessage = UIMessage | LegacyMessage;

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  messages: jsonb("messages").notNull().$type<StoredMessage[]>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const MEMORY_CATEGORIES = [
  "person",
  "family",
  "food",
  "health",
  "work",
  "event",
  "preference",
  "place",
  "other",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    content: text("content").notNull(),
    // Dimensions must match the embedding model in lib/global/ai.ts (nomic-embed-text-v1.5 = 768).
    embedding: vector("embedding", { dimensions: 768 }).notNull(),
    // 0–1, used for retrieval ranking only; "always inject" is the pinned flag, not importance = 1.
    importance: real("importance").notNull(),
    category: text("category").$type<MemoryCategory>().notNull(),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    lastAccessedAt: timestamp("last_accessed_at").notNull().defaultNow(),
  },
  (t) => [
    index("memories_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("memories_category_idx").on(t.category),
  ]
);
