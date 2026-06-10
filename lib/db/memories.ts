import { and, cosineDistance, desc, eq, ilike, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "../global/db";
import { memories, type MemoryCategory } from "../global/schema";
import { embedText } from "../global/ai";

export type Memory = typeof memories.$inferSelect;

export type NewMemory = {
  content: string;
  importance: number;
  category: MemoryCategory;
  pinned?: boolean;
};

export type MemoryChanges = Partial<NewMemory>;

export type FindMemoriesFilter = {
  category?: MemoryCategory;
  pinned?: boolean;
  limit?: number;
  /** Case-insensitive substring match on content (for browsing UIs; the agent uses searchMemories). */
  contains?: string;
};

export type SearchMemoriesOptions = {
  category?: MemoryCategory;
  limit?: number;
  /** Floor on the cosine-similarity component alone, before recency/importance blending. */
  minRelevance?: number;
};

// Retrieval score weights: relevance to the query, recency of last access, stored importance.
const WEIGHTS = { relevance: 0.6, recency: 0.2, importance: 0.2 };
const RECENCY_HALF_LIFE_SECONDS = 7 * 24 * 60 * 60;

export async function createMemory(data: NewMemory): Promise<Memory> {
  const embedding = await embedText(data.content);
  const [row] = await db
    .insert(memories)
    .values({ ...data, embedding })
    .returning();
  return row;
}

export async function updateMemory(
  id: string,
  changes: MemoryChanges
): Promise<Memory | undefined> {
  const embedding =
    changes.content !== undefined ? await embedText(changes.content) : undefined;
  const [row] = await db
    .update(memories)
    .set({ ...changes, ...(embedding ? { embedding } : {}) })
    .where(eq(memories.id, id))
    .returning();
  return row;
}

export async function deleteMemory(id: string): Promise<Memory | undefined> {
  const [row] = await db
    .delete(memories)
    .where(eq(memories.id, id))
    .returning();
  return row;
}

export async function getPinnedMemories(): Promise<Memory[]> {
  return db.query.memories.findMany({
    where: eq(memories.pinned, true),
    orderBy: memories.createdAt,
  });
}

export async function findMemories(filter: FindMemoriesFilter = {}): Promise<Memory[]> {
  const conditions = [];
  if (filter.category !== undefined) conditions.push(eq(memories.category, filter.category));
  if (filter.pinned !== undefined) conditions.push(eq(memories.pinned, filter.pinned));
  if (filter.contains !== undefined)
    conditions.push(ilike(memories.content, `%${filter.contains.replaceAll(/[%_\\]/g, "\\$&")}%`));

  return db.query.memories.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: desc(memories.createdAt),
    limit: filter.limit ?? 50,
  });
}

/**
 * Semantic search blended with recency and importance.
 * Pinned memories are excluded: they are always injected into the prompt anyway.
 */
export async function searchMemories(
  query: string,
  options: SearchMemoriesOptions = {}
): Promise<Array<Memory & { score: number }>> {
  const embedding = await embedText(query);

  const relevance = sql<number>`1 - (${cosineDistance(memories.embedding, embedding)})`;
  const recency = sql<number>`exp(-ln(2.0) * extract(epoch from (now() - ${memories.lastAccessedAt})) / ${RECENCY_HALF_LIFE_SECONDS})`;
  const score = sql<number>`${WEIGHTS.relevance} * (${relevance}) + ${WEIGHTS.recency} * (${recency}) + ${WEIGHTS.importance} * ${memories.importance}`;

  const conditions: SQL[] = [eq(memories.pinned, false)];
  if (options.category !== undefined) conditions.push(eq(memories.category, options.category));
  if (options.minRelevance !== undefined) conditions.push(sql`${relevance} >= ${options.minRelevance}`);

  const rows = await db
    .select({ memory: memories, score })
    .from(memories)
    .where(and(...conditions))
    .orderBy(desc(score))
    .limit(options.limit ?? 8);

  if (rows.length > 0) {
    await db
      .update(memories)
      .set({ lastAccessedAt: new Date() })
      .where(inArray(memories.id, rows.map((r) => r.memory.id)));
  }

  return rows.map((r) => ({ ...r.memory, score: Number(r.score) }));
}
