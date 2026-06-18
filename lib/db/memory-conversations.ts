import { eq } from "drizzle-orm";
import type { ModelMessage } from "ai";
import { db } from "../global/db";
import { memoryConversations } from "../global/schema";

export type MemoryConversation = typeof memoryConversations.$inferSelect;

/** The extractor's running history for a source conversation, or undefined if none yet. */
export async function getMemoryConversation(
  conversationId: string
): Promise<MemoryConversation | undefined> {
  return db.query.memoryConversations.findFirst({
    where: eq(memoryConversations.conversationId, conversationId),
  });
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
