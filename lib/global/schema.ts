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
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { UIMessage } from "ai";

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

export const MEMORY_CATEGORIES = [
  "person",
  "family",
  "food",
  "health",
  "work",
  "event",
  "preference",
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
