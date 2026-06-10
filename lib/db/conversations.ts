import { and, between, desc, eq, inArray, or } from "drizzle-orm";
import { db } from "../global/db";
import { agentMembers, conversations } from "../global/schema";

export type NewConversation = typeof conversations.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;

export type FindMessagesFilter = {
  id?: string | string[];
  from?: Date;
  to?: Date;
  agentId?: string;
  /**
   * Access scoping: only conversations in agents this user is a member of, and
   * within those, only shared conversations or their own private ones.
   */
  viewerId?: string;
};

export async function createMessage(data: NewConversation): Promise<Conversation> {
  const [row] = await db.insert(conversations).values(data).returning();
  return row;
}

export async function updateMessage(
  id: string,
  data: Partial<Omit<NewConversation, "id">>
): Promise<Conversation | undefined> {
  const [row] = await db
    .update(conversations)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(conversations.id, id))
    .returning();
  return row;
}

export async function deleteMessage(id: string): Promise<Conversation | undefined> {
  const [row] = await db
    .delete(conversations)
    .where(eq(conversations.id, id))
    .returning();
  return row;
}

export async function findMessage(id: string): Promise<Conversation | undefined> {
  return db.query.conversations.findFirst({
    where: eq(conversations.id, id),
  });
}

/** Can this user read (and chat in) this conversation? */
export function canAccessConversation(
  conversation: Conversation,
  userId: string,
  isMember: boolean
): boolean {
  return isMember && (conversation.shared || conversation.userId === userId);
}

export async function findMessages(filter: FindMessagesFilter = {}): Promise<Conversation[]> {
  const conditions = [];

  if (filter.id !== undefined) {
    conditions.push(
      Array.isArray(filter.id)
        ? inArray(conversations.id, filter.id)
        : eq(conversations.id, filter.id)
    );
  }

  if (filter.from !== undefined && filter.to !== undefined) {
    conditions.push(between(conversations.createdAt, filter.from, filter.to));
  } else if (filter.from !== undefined) {
    conditions.push(between(conversations.createdAt, filter.from, new Date()));
  } else if (filter.to !== undefined) {
    conditions.push(between(conversations.createdAt, new Date(0), filter.to));
  }

  if (filter.agentId !== undefined) {
    conditions.push(eq(conversations.agentId, filter.agentId));
  }

  if (filter.viewerId !== undefined) {
    const memberAgents = db
      .select({ agentId: agentMembers.agentId })
      .from(agentMembers)
      .where(eq(agentMembers.userId, filter.viewerId));
    conditions.push(inArray(conversations.agentId, memberAgents));
    conditions.push(
      or(eq(conversations.shared, true), eq(conversations.userId, filter.viewerId))!
    );
  }

  return db.query.conversations.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: desc(conversations.updatedAt),
  });
}
