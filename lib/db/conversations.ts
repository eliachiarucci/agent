import { and, between, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../global/db";
import { agentMembers, conversations, type StoredMessage } from "../global/schema";

export type NewConversation = typeof conversations.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;

// Machine-inserted text parts that must not be indexed: the user never wrote them
// and they would pollute searchChats results. Mirrors isMachineTextPart in
// lib/agent/compaction.ts (kept in sync by hand — the db layer doesn't import the
// agent layer). The prefixes are the open tags of those blocks.
const MACHINE_PART_PREFIXES = ["<relevant-memories>", "<attached-files>", "<conversation-summary>"];

// Flattens a conversation's messages to the plaintext indexed for full-text
// search: user + assistant prose only, machine blocks and tool payloads dropped.
// Called on every write so search_text (and the generated tsvector over it) stays
// in lockstep with messages — the property that lets FTS skip an embedding-style
// sync pipeline.
export function messageSearchText(messages: StoredMessage[]): string {
  return messages
    .map((m) => {
      if (!("parts" in m)) return m.content; // LegacyMessage: { role, content }
      return m.parts
        .flatMap((p) =>
          p.type === "text" && !MACHINE_PART_PREFIXES.some((prefix) => p.text.startsWith(prefix))
            ? [p.text]
            : []
        )
        .join("\n");
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export type FindMessagesFilter = {
  id?: string | string[];
  from?: Date;
  to?: Date;
  agentId?: string;
  /** Filter by archived flag; omit to return both. */
  archived?: boolean;
  /**
   * Access scoping: only conversations in agents this user is a member of, and
   * within those, only shared conversations or their own private ones.
   */
  viewerId?: string;
};

/**
 * Recomputes search_text from the stored messages. By default only fills rows that
 * lack it (conversations written before the column existed) — idempotent and cheap
 * once done, so it can run on every deploy. Pass `all` to re-extract every row
 * (e.g. after changing the extraction logic). Returns the number of rows updated.
 */
export async function backfillSearchText(opts: { all?: boolean } = {}): Promise<number> {
  const base = db.select({ id: conversations.id, messages: conversations.messages }).from(conversations);
  const rows = opts.all ? await base : await base.where(isNull(conversations.searchText));
  for (const row of rows) {
    await db
      .update(conversations)
      .set({ searchText: messageSearchText(row.messages) })
      .where(eq(conversations.id, row.id));
  }
  return rows.length;
}

export async function createMessage(data: NewConversation): Promise<Conversation> {
  const [row] = await db
    .insert(conversations)
    .values({ ...data, searchText: messageSearchText(data.messages) })
    .returning();
  return row;
}

export async function updateMessage(
  id: string,
  data: Partial<Omit<NewConversation, "id">>
): Promise<Conversation | undefined> {
  // Recompute the search text whenever the messages change so the FTS index never
  // lags the conversation; other partial updates (e.g. just `compaction`) leave it.
  const searchText = data.messages !== undefined ? { searchText: messageSearchText(data.messages) } : {};
  const [row] = await db
    .update(conversations)
    .set({ ...data, ...searchText, updatedAt: new Date() })
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

/**
 * Ids only — for the files API and conversation-folder cleanup, where loading
 * the messages jsonb of every conversation would be wasteful. `viewerId`
 * applies the same shared-or-own rule as findMessages; agent membership is the
 * caller's job (resolveActor already checked it on the API paths).
 */
export async function findConversationIds(filter: {
  agentId: string;
  viewerId?: string;
}): Promise<string[]> {
  const conditions = [eq(conversations.agentId, filter.agentId)];
  if (filter.viewerId !== undefined) {
    conditions.push(
      or(eq(conversations.shared, true), eq(conversations.userId, filter.viewerId))!
    );
  }
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(...conditions));
  return rows.map((row) => row.id);
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

  if (filter.archived !== undefined) {
    conditions.push(eq(conversations.archived, filter.archived));
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

export type ConversationSearchHit = {
  conversationId: string;
  createdAt: Date;
  updatedAt: Date;
  /** A highlighted excerpt around the match, **bold**-delimited (ts_headline). */
  snippet: string;
  rank: number;
  /** Messages of the hit, so the caller can locate which round matched. */
  messages: StoredMessage[];
  /** Compaction pointer, so the caller can tell pre- from post-compaction matches. */
  compaction: Conversation["compaction"];
};

/**
 * Full-text search over the messages of an agent's conversations, ranked by
 * relevance. Scoped like findConversationIds: within `agentId`, only shared
 * conversations or the viewer's own private ones (membership is the caller's job,
 * already checked by resolveActor on the API paths). `query` is parsed with
 * websearch_to_tsquery, so the agent can use "quoted phrases" and -exclusions.
 * Returns the matched conversations' messages too (only `limit` rows leave the DB)
 * so the caller can pinpoint the matching round without a second query.
 */
export async function searchConversations(params: {
  agentId: string;
  viewerId: string;
  query: string;
  limit?: number;
}): Promise<ConversationSearchHit[]> {
  const tsquery = sql`websearch_to_tsquery('english', ${params.query})`;
  const rank = sql<number>`ts_rank(${conversations.searchVector}, ${tsquery})`;
  // Compact, model-friendly excerpts: a couple of short fragments with the matched
  // terms wrapped in ** so the agent (and any UI) can show what hit.
  const snippet = sql<string>`ts_headline('english', coalesce(${conversations.searchText}, ''), ${tsquery}, 'MaxFragments=2,MinWords=4,MaxWords=18,StartSel=**,StopSel=**,FragmentDelimiter= … ')`;

  return db
    .select({
      conversationId: conversations.id,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
      snippet,
      rank,
      messages: conversations.messages,
      compaction: conversations.compaction,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.agentId, params.agentId),
        or(eq(conversations.shared, true), eq(conversations.userId, params.viewerId)),
        sql`${conversations.searchVector} @@ ${tsquery}`
      )
    )
    .orderBy(desc(rank))
    .limit(params.limit ?? 8);
}
