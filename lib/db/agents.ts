import { and, asc, eq } from "drizzle-orm";
import { db } from "../global/db";
import {
  agentMembers,
  agents,
  memoryPools,
  users,
  type AgentMemberRole,
  type ProviderType,
} from "../global/schema";

export type Agent = typeof agents.$inferSelect;

export type AgentMember = {
  userId: string;
  name: string;
  role: AgentMemberRole;
};

/**
 * Creates the agent, the owner's membership row, and — so memory works out of
 * the box — a memory pool named after the agent, attached to it. One transaction.
 */
export async function createAgent(data: { name: string; ownerId: string }): Promise<Agent> {
  return db.transaction(async (tx) => {
    const [pool] = await tx
      .insert(memoryPools)
      .values({ name: data.name, ownerId: data.ownerId })
      .returning();
    const [agent] = await tx
      .insert(agents)
      .values({ ...data, memoryPoolId: pool.id })
      .returning();
    await tx
      .insert(agentMembers)
      .values({ agentId: agent.id, userId: data.ownerId, role: "owner" });
    return agent;
  });
}

export async function getAgent(id: string): Promise<Agent | undefined> {
  return db.query.agents.findFirst({ where: eq(agents.id, id) });
}

export async function updateAgent(
  id: string,
  changes: {
    name?: string;
    systemPrompt?: string | null;
    // The memory pool the agent reads/writes; null detaches it (memory off).
    memoryPoolId?: string | null;
    // Set together (or both null to reset to the env default).
    memoryProvider?: ProviderType | null;
    memoryModel?: string | null;
    chatMemoryEnabled?: boolean;
    // null → the built-in memory instructions.
    chatMemoryPrompt?: string | null;
    memoryExtractionEnabled?: boolean;
    // null → the built-in extraction prompt.
    memoryExtractionPrompt?: string | null;
  }
): Promise<Agent | undefined> {
  const [row] = await db.update(agents).set(changes).where(eq(agents.id, id)).returning();
  return row;
}

export async function deleteAgent(id: string): Promise<Agent | undefined> {
  const [row] = await db.delete(agents).where(eq(agents.id, id)).returning();
  return row;
}

export async function listAgentsForUser(
  userId: string
): Promise<Array<Agent & { role: AgentMemberRole }>> {
  const rows = await db
    .select({ agent: agents, role: agentMembers.role })
    .from(agentMembers)
    .innerJoin(agents, eq(agents.id, agentMembers.agentId))
    .where(eq(agentMembers.userId, userId))
    .orderBy(asc(agents.createdAt));
  return rows.map((r) => ({ ...r.agent, role: r.role }));
}

/** Until the UI grows an agent picker, requests without an agent id use the user's oldest agent. */
export async function getDefaultAgentForUser(userId: string): Promise<Agent | undefined> {
  const [first] = await listAgentsForUser(userId);
  return first;
}

export async function listAgentMembers(agentId: string): Promise<AgentMember[]> {
  const rows = await db
    .select({ userId: agentMembers.userId, name: users.name, role: agentMembers.role })
    .from(agentMembers)
    .innerJoin(users, eq(users.id, agentMembers.userId))
    .where(eq(agentMembers.agentId, agentId))
    .orderBy(asc(agentMembers.createdAt));
  return rows;
}

export async function isAgentMember(agentId: string, userId: string): Promise<boolean> {
  const row = await db.query.agentMembers.findFirst({
    where: and(eq(agentMembers.agentId, agentId), eq(agentMembers.userId, userId)),
  });
  return row !== undefined;
}

export async function addAgentMember(
  agentId: string,
  userId: string,
  role: AgentMemberRole = "member"
): Promise<void> {
  await db.insert(agentMembers).values({ agentId, userId, role }).onConflictDoNothing();
}

export async function removeAgentMember(agentId: string, userId: string): Promise<boolean> {
  const rows = await db
    .delete(agentMembers)
    .where(and(eq(agentMembers.agentId, agentId), eq(agentMembers.userId, userId)))
    .returning();
  return rows.length > 0;
}
