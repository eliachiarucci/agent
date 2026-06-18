import { and, desc, eq, or } from "drizzle-orm";
import type { ModelMessage } from "ai";
import { db } from "../global/db";
import { conversations, memoryConversations } from "../global/schema";

export type MemoryConversation = typeof memoryConversations.$inferSelect;

/** The extractor's running history for a source conversation, or undefined if none yet. */
export async function getMemoryConversation(
  conversationId: string
): Promise<MemoryConversation | undefined> {
  return db.query.memoryConversations.findFirst({
    where: eq(memoryConversations.conversationId, conversationId),
  });
}

export async function getMemoryConversationById(
  id: string
): Promise<MemoryConversation | undefined> {
  return db.query.memoryConversations.findFirst({ where: eq(memoryConversations.id, id) });
}

export type MemoryConversationSummary = {
  id: string;
  conversationId: string;
  createdAt: Date;
  updatedAt: Date;
  exchangeCount: number;
  preview: string;
};

function previewOf(messages: ModelMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = first && typeof first.content === "string" ? first.content : "";
  return text.replace(/\s+/g, " ").trim().slice(0, 140);
}

// Memory conversations the viewer may see: access mirrors the source
// conversation (shared, or the viewer's own private one), so a private chat's
// extracted exchanges stay private. Newest first.
export async function listMemoryConversations(filter: {
  agentId: string;
  viewerId: string;
}): Promise<MemoryConversationSummary[]> {
  const rows = await db
    .select({
      id: memoryConversations.id,
      conversationId: memoryConversations.conversationId,
      createdAt: memoryConversations.createdAt,
      updatedAt: memoryConversations.updatedAt,
      messages: memoryConversations.messages,
    })
    .from(memoryConversations)
    .innerJoin(conversations, eq(conversations.id, memoryConversations.conversationId))
    .where(
      and(
        eq(conversations.agentId, filter.agentId),
        or(eq(conversations.shared, true), eq(conversations.userId, filter.viewerId))
      )
    )
    .orderBy(desc(memoryConversations.updatedAt));

  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversationId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    exchangeCount: r.messages.filter((m) => m.role === "user").length,
    preview: previewOf(r.messages),
  }));
}

/**
 * Upsert keyed on the source conversation: the first turn inserts the row,
 * later turns overwrite the accumulated messages. Exactly one memory
 * conversation per source conversation (unique index on conversation_id).
 */
export async function saveMemoryConversation(
  conversationId: string,
  agentId: string,
  messages: ModelMessage[]
): Promise<void> {
  await db
    .insert(memoryConversations)
    .values({ conversationId, agentId, messages })
    .onConflictDoUpdate({
      target: memoryConversations.conversationId,
      set: { messages, updatedAt: new Date() },
    });
}
