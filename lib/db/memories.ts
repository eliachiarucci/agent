import { and, cosineDistance, desc, eq, ilike, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "../global/db";
import { memories, type MemoryCategory } from "../global/schema";
import { embedText } from "../global/ai";

export type Memory = typeof memories.$inferSelect;

export type NewMemory = {
  agentId: string;
  content: string;
  importance: number;
  category: MemoryCategory;
  pinned?: boolean;
  /** Who the fact is about; null/undefined = shared fact about the group. */
  subjectUserId?: string | null;
  createdBy?: string | null;
};

export type MemoryChanges = Partial<Omit<NewMemory, "agentId" | "createdBy">>;

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
  /**
   * Who is asking. Memories about the speaker (or shared, subject = null) get a
   * score bonus so "my car" resolves to their car — but facts about other members
   * stay retrievable, just ranked lower on ambiguous queries.
   */
  speakerUserId?: string;
};

// Retrieval score weights: relevance to the query, recency of last access, stored importance.
// The subject bonus is additive on top when a speaker is known (max score 1 + subject).
const WEIGHTS = { relevance: 0.6, recency: 0.2, importance: 0.2, subject: 0.1 };
const RECENCY_HALF_LIFE_SECONDS = 7 * 24 * 60 * 60;

export async function createMemory(data: NewMemory, embedding?: number[]): Promise<Memory> {
  const vector = embedding ?? (await embedText(data.content, "document"));
  const [row] = await db
    .insert(memories)
    .values({ ...data, embedding: vector })
    .returning();
  return row;
}

/**
 * Nearest stored memories by plain cosine similarity against a precomputed
 * document embedding — the duplicate check behind the remember tool. No
 * recency/importance blending, no lastAccessedAt touch, and pinned memories
 * are included: a duplicate of a pinned fact is still a duplicate.
 */
export async function findSimilarMemories(
  agentId: string,
  embedding: number[],
  options: { minSimilarity: number; limit?: number }
): Promise<Array<Memory & { similarity: number }>> {
  const similarity = sql<number>`1 - (${cosineDistance(memories.embedding, embedding)})`;
  const rows = await db
    .select({ memory: memories, similarity })
    .from(memories)
    .where(and(eq(memories.agentId, agentId), sql`${similarity} >= ${options.minSimilarity}`))
    .orderBy(desc(similarity))
    .limit(options.limit ?? 3);
  return rows.map((r) => ({ ...r.memory, similarity: Number(r.similarity) }));
}

export async function updateMemory(
  agentId: string,
  id: string,
  changes: MemoryChanges
): Promise<Memory | undefined> {
  const embedding =
    changes.content !== undefined ? await embedText(changes.content, "document") : undefined;
  const [row] = await db
    .update(memories)
    .set({ ...changes, ...(embedding ? { embedding } : {}) })
    .where(and(eq(memories.id, id), eq(memories.agentId, agentId)))
    .returning();
  return row;
}

export async function deleteMemory(agentId: string, id: string): Promise<Memory | undefined> {
  const [row] = await db
    .delete(memories)
    .where(and(eq(memories.id, id), eq(memories.agentId, agentId)))
    .returning();
  return row;
}

export async function getPinnedMemories(agentId: string): Promise<Memory[]> {
  return db.query.memories.findMany({
    where: and(eq(memories.agentId, agentId), eq(memories.pinned, true)),
    orderBy: memories.createdAt,
  });
}

export async function findMemories(
  agentId: string,
  filter: FindMemoriesFilter = {}
): Promise<Memory[]> {
  const conditions = [eq(memories.agentId, agentId)];
  if (filter.category !== undefined) conditions.push(eq(memories.category, filter.category));
  if (filter.pinned !== undefined) conditions.push(eq(memories.pinned, filter.pinned));
  if (filter.contains !== undefined)
    conditions.push(ilike(memories.content, `%${filter.contains.replaceAll(/[%_\\]/g, "\\$&")}%`));

  return db.query.memories.findMany({
    where: and(...conditions),
    orderBy: desc(memories.createdAt),
    limit: filter.limit ?? 50,
  });
}

/**
 * Semantic search blended with recency, importance, and (when a speaker is known)
 * a subject-match bonus. Pinned memories are excluded: they are always injected
 * into the prompt anyway.
 */
export async function searchMemories(
  agentId: string,
  query: string,
  options: SearchMemoriesOptions = {}
): Promise<Array<Memory & { score: number }>> {
  const embedding = await embedText(query, "query");

  const relevance = sql<number>`1 - (${cosineDistance(memories.embedding, embedding)})`;
  const recency = sql<number>`exp(-ln(2.0) * extract(epoch from (now() - ${memories.lastAccessedAt})) / ${RECENCY_HALF_LIFE_SECONDS})`;
  let score = sql<number>`${WEIGHTS.relevance} * (${relevance}) + ${WEIGHTS.recency} * (${recency}) + ${WEIGHTS.importance} * ${memories.importance}`;
  if (options.speakerUserId !== undefined) {
    // 1.0/0.0 keeps the case expression float so the weight param isn't inferred as integer.
    score = sql<number>`${score} + ${WEIGHTS.subject} * (case when ${memories.subjectUserId} is null or ${memories.subjectUserId} = ${options.speakerUserId} then 1.0 else 0.0 end)`;
  }

  const conditions: SQL[] = [eq(memories.agentId, agentId), eq(memories.pinned, false)];
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
