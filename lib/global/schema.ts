import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { ModelMessage, UIMessage } from "ai";

// Rows written before the UI message stream migration; still readable.
export type LegacyMessage = { role: "user" | "assistant"; content: string };
export type StoredMessage = UIMessage | LegacyMessage;

// UUIDv4 (not v7): user ids may end up in URLs/tokens and shouldn't leak creation order.
// Doubles as Better Auth's `user` model (mapped in lib/global/auth.ts); the
// camelCase property names must match Better Auth field names exactly.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  username: text("username").unique(),
  displayUsername: text("display_username"),
  twoFactorEnabled: boolean("two_factor_enabled"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ── Better Auth tables ──────────────────────────────────────────────────────
// Shapes come from `getAuthTables(auth.options)`; regenerate that dump after
// adding/removing auth plugins and keep these in sync.

export const session = pgTable(
  "session",
  {
    id: uuid("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("session_user_idx").on(t.userId)]
);

export const account = pgTable(
  "account",
  {
    id: uuid("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("account_user_idx").on(t.userId)]
);

export const verification = pgTable("verification", {
  id: uuid("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const twoFactor = pgTable("two_factor", {
  id: uuid("id").primaryKey(),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  verified: boolean("verified"),
});

export const passkey = pgTable("passkey", {
  id: uuid("id").primaryKey(),
  name: text("name"),
  publicKey: text("public_key").notNull(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  credentialID: text("credential_id").notNull(),
  counter: integer("counter").notNull(),
  deviceType: text("device_type").notNull(),
  backedUp: boolean("backed_up").notNull(),
  transports: text("transports"),
  aaguid: text("aaguid"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  // Owner-written instructions appended to the built-in system prompt on every
  // turn. Session-stable, so it doesn't break KV-cache reuse (docs/memory.md).
  systemPrompt: text("system_prompt"),
  // Model the background memory extractor runs on for this agent
  // (lib/agent/memory-extraction.ts), resolved against the owner's provider
  // settings like a chat request. NULL → the env-configured default model.
  memoryProvider: text("memory_provider").$type<ProviderType>(),
  memoryModel: text("memory_model"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const AGENT_MEMBER_ROLES = ["owner", "member"] as const;
export type AgentMemberRole = (typeof AGENT_MEMBER_ROLES)[number];

// Who can talk to an agent. The owner also gets a row so access checks are one lookup.
export const agentMembers = pgTable(
  "agent_members",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<AgentMemberRole>().notNull().default("member"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.userId] }),
    index("agent_members_user_idx").on(t.userId),
  ]
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // Creator. Private conversations are visible only to them; shared ones to all agent members.
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    shared: boolean("shared").notNull().default(false),
    messages: jsonb("messages").notNull().$type<StoredMessage[]>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("conversations_agent_idx").on(t.agentId)]
);

// One row per source conversation: the running message history of the
// background memory-extraction model (lib/agent/memory-extraction.ts). After
// each turn of the source conversation, the latest exchange (last user message
// + complete assistant response) is appended here as a user message and the
// extractor's reply — including its memory tool calls — is stored, so it keeps
// context of what it has already saved across turns. Stored as ModelMessages
// (the extractor runs headless via generateText and is never rendered in the
// UI), unlike conversations which keep UIMessages. Deleting the source
// conversation cascades here.
export const memoryConversations = pgTable(
  "memory_conversations",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    messages: jsonb("messages").notNull().$type<ModelMessage[]>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("memory_conversations_conversation_idx").on(t.conversationId)]
);

export const PROVIDER_TYPES = ["lmstudio", "anthropic", "google", "deepinfra"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

// Connection settings per provider. Shapes are heterogeneous (LM Studio needs a
// URL with an optional key, Anthropic and Google only a key), so they live in one JSONB
// blob validated per provider by zod at the API boundary (lib/global/providers.ts)
// instead of a sparse set of nullable columns. `provider` stays a real column as
// the discriminator/lookup key.
export type ProviderSettingsValue = {
  url?: string;
  apiKey?: string;
  // Default chat model id for this provider, picked from its /models listing.
  model?: string;
};

export const providerSettings = pgTable(
  "provider_settings",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<ProviderType>().notNull(),
    settings: jsonb("settings").notNull().$type<ProviderSettingsValue>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("provider_settings_user_provider_idx").on(t.userId, t.provider)]
);

// Per-user prefs. defaultProvider/defaultModel = the chat model used when none
// is picked for a turn, and the fallback for cron/memory work; NULL → env CHAT_MODEL.
export const userSettings = pgTable("user_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  defaultProvider: text("default_provider").$type<ProviderType>(),
  defaultModel: text("default_model"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// "once" jobs (reminders) are deleted after their first successful run.
export const CRON_RECURRENCES = ["once", "weekly", "biweekly", "monthly"] as const;
export type CronRecurrence = (typeof CRON_RECURRENCES)[number];

// A recurring prompt: at each scheduled occurrence the runner executes `prompt`
// against the agent as the creating user and saves the result as a new private
// conversation. The schedule is wall-clock (`dayOfWeek` + `time` in `timezone`,
// as picked in the UI); `nextRunAt` is the precomputed absolute instant the
// scheduler polls on (lib/agent/cron.ts).
export const cronJobs = pgTable(
  "cron_jobs",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // Creator: runs execute with their identity and memory scope.
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Display name. NULL → the runner generates one on the job's next run.
    title: text("title"),
    prompt: text("prompt").notNull(),
    // 0 = Sunday … 6 = Saturday, matching JS Date#getDay(). At least one day.
    daysOfWeek: integer("days_of_week").array().notNull(),
    // "HH:MM", wall clock in `timezone`.
    time: text("time").notNull(),
    recurrence: text("recurrence").$type<CronRecurrence>().notNull(),
    // Chat model the runs use, resolved against the creator's provider
    // settings like a chat request; NULL → the env-configured default model.
    provider: text("provider").$type<ProviderType>(),
    model: text("model"),
    // IANA name (e.g. "Europe/Rome") captured from the creator's browser.
    timezone: text("timezone").notNull(),
    nextRunAt: timestamp("next_run_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("cron_jobs_next_run_idx").on(t.nextRunAt),
    index("cron_jobs_user_idx").on(t.userId),
  ]
);

export const CRON_RUN_STATUSES = ["success", "error"] as const;
export type CronRunStatus = (typeof CRON_RUN_STATUSES)[number];

// Run history is self-contained (own user/agent/prompt copies): deleting a
// job — which "once" jobs do automatically after succeeding — must not erase
// the record that it ran.
export const cronJobRuns = pgTable(
  "cron_job_runs",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    jobId: uuid("job_id").references(() => cronJobs.id, { onDelete: "set null" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // Job title at run time (may have just been generated); display falls
    // back to the prompt when NULL.
    title: text("title"),
    prompt: text("prompt").notNull(),
    // The conversation holding the run's prompt + response. Kept when the
    // conversation is deleted (the run record stays meaningful on its own).
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    status: text("status").$type<CronRunStatus>().notNull(),
    error: text("error"),
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at").notNull(),
  },
  (t) => [
    index("cron_job_runs_job_idx").on(t.jobId),
    index("cron_job_runs_user_idx").on(t.userId),
  ]
);

// Free-form notes shared across every conversation of an agent: any member can
// read and edit them (in chat via the note tools, or manually in the UI), so
// they hold living documents — lists, plans, reference info — rather than the
// per-conversation artifacts files cover. Titles are the agent-facing handle,
// hence unique per agent.
export const notes = pgTable(
  "notes",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("notes_agent_title_idx").on(t.agentId, t.title)]
);

export const MEMORY_CATEGORIES = [
  "person",
  "family",
  "food",
  "health",
  "love",
  "entertainment",
  "sport",
  "work",
  "event",
  "preference",
  "language",
  "school",
  "culture",
  "funny",
  "place",
  "other",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    // Memories never cross agents: each agent has its own pool.
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // Who the fact is about. NULL = shared/group fact (e.g. "the kitchen budget is 10k").
    // Retrieval boosts subject == speaker (and NULL) instead of hard-filtering, so
    // "what's my wife's shoe size" can still surface another member's facts.
    subjectUserId: uuid("subject_user_id").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
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
    index("memories_agent_idx").on(t.agentId),
  ]
);
