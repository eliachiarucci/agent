import { and, asc, count, eq, exists } from "drizzle-orm";
import { db } from "../global/db";
import { agentMembers, agents, memories, memoryPools } from "../global/schema";

export type MemoryPool = typeof memoryPools.$inferSelect;

export async function createMemoryPool(data: {
  name: string;
  ownerId: string;
}): Promise<MemoryPool> {
  const [row] = await db.insert(memoryPools).values(data).returning();
  return row;
}

export async function getMemoryPool(id: string): Promise<MemoryPool | undefined> {
  return db.query.memoryPools.findFirst({ where: eq(memoryPools.id, id) });
}

/** Deleting a pool cascades to its memories and detaches any agents using it. */
export async function deleteMemoryPool(id: string): Promise<MemoryPool | undefined> {
  const [row] = await db.delete(memoryPools).where(eq(memoryPools.id, id)).returning();
  return row;
}

export type MemoryPoolWithStats = MemoryPool & {
  memoryCount: number;
  /** Agents currently attached to (reading/writing) this pool. */
  agents: Array<{ id: string; name: string }>;
};

/** The user's own pools, each with its memory count and attached agents. */
export async function listMemoryPoolsForUser(userId: string): Promise<MemoryPoolWithStats[]> {
  const pools = await db.query.memoryPools.findMany({
    where: eq(memoryPools.ownerId, userId),
    orderBy: asc(memoryPools.createdAt),
  });
  if (pools.length === 0) return [];

  const [counts, attached] = await Promise.all([
    db
      .select({ poolId: memories.poolId, count: count() })
      .from(memories)
      .groupBy(memories.poolId),
    db
      .select({ id: agents.id, name: agents.name, poolId: agents.memoryPoolId })
      .from(agents)
      .orderBy(asc(agents.createdAt)),
  ]);

  const countByPool = new Map(counts.map((c) => [c.poolId, c.count]));
  return pools.map((pool) => ({
    ...pool,
    memoryCount: countByPool.get(pool.id) ?? 0,
    agents: attached
      .filter((a) => a.poolId === pool.id)
      .map(({ id, name }) => ({ id, name })),
  }));
}

/**
 * Whether a user may read/manage a pool's memories: they own it, or they are a
 * member of an agent attached to it (sharing an agent shares its memory).
 */
export async function canAccessMemoryPool(poolId: string, userId: string): Promise<boolean> {
  const pool = await getMemoryPool(poolId);
  if (!pool) return false;
  if (pool.ownerId === userId) return true;
  const membership = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.memoryPoolId, poolId),
        exists(
          db
            .select({ userId: agentMembers.userId })
            .from(agentMembers)
            .where(and(eq(agentMembers.agentId, agents.id), eq(agentMembers.userId, userId)))
        )
      )
    )
    .limit(1);
  return membership.length > 0;
}
