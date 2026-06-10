import { and, asc, eq } from "drizzle-orm";
import { db } from "../global/db";
import { agentMembers, agents, users, type AgentMemberRole } from "../global/schema";

export type Agent = typeof agents.$inferSelect;

export type AgentMember = {
  userId: string;
  name: string;
  role: AgentMemberRole;
};

/** Creates the agent and the owner's membership row in one transaction. */
export async function createAgent(data: { name: string; ownerId: string }): Promise<Agent> {
  return db.transaction(async (tx) => {
    const [agent] = await tx.insert(agents).values(data).returning();
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
  changes: { name?: string; systemPrompt?: string | null }
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
