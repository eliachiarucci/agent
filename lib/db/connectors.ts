import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../global/db";
import {
  connectorSettings,
  type ConnectorSettingsValue,
  type ConnectorStatus,
  type ConnectorTokens,
  type ConnectorType,
} from "../global/schema";

export type ConnectorSetting = typeof connectorSettings.$inferSelect;

export async function listConnectorSettings(userId: string): Promise<ConnectorSetting[]> {
  return db.query.connectorSettings.findMany({
    where: eq(connectorSettings.userId, userId),
    orderBy: asc(connectorSettings.connector),
  });
}

export async function getConnectorSetting(
  userId: string,
  connector: ConnectorType
): Promise<ConnectorSetting | undefined> {
  return db.query.connectorSettings.findFirst({
    where: and(eq(connectorSettings.userId, userId), eq(connectorSettings.connector, connector)),
  });
}

/**
 * One row per (user, connector). Saving new client credentials keeps existing
 * tokens only when the clientId is unchanged — tokens are bound to the OAuth
 * client that issued them, so a different client invalidates them.
 */
export async function upsertConnectorSetting(
  userId: string,
  connector: ConnectorType,
  settings: ConnectorSettingsValue
): Promise<ConnectorSetting> {
  const existing = await getConnectorSetting(userId, connector);
  const keepTokens = existing?.settings.clientId === settings.clientId;
  const [row] = await db
    .insert(connectorSettings)
    .values({ userId, connector, settings, tokens: null, status: "disconnected" })
    .onConflictDoUpdate({
      target: [connectorSettings.userId, connectorSettings.connector],
      set: {
        settings,
        ...(keepTokens ? {} : { tokens: null, status: "disconnected" as ConnectorStatus }),
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return row;
}

export async function setConnectorTokens(
  userId: string,
  connector: ConnectorType,
  tokens: ConnectorTokens | null,
  status: ConnectorStatus
): Promise<void> {
  await db
    .update(connectorSettings)
    .set({ tokens, status, updatedAt: sql`now()` })
    .where(and(eq(connectorSettings.userId, userId), eq(connectorSettings.connector, connector)));
}

export async function setConnectorStatus(
  userId: string,
  connector: ConnectorType,
  status: ConnectorStatus
): Promise<void> {
  await db
    .update(connectorSettings)
    .set({ status, updatedAt: sql`now()` })
    .where(and(eq(connectorSettings.userId, userId), eq(connectorSettings.connector, connector)));
}

export async function deleteConnectorSetting(
  userId: string,
  connector: ConnectorType
): Promise<ConnectorSetting | undefined> {
  const rows = await db
    .delete(connectorSettings)
    .where(and(eq(connectorSettings.userId, userId), eq(connectorSettings.connector, connector)))
    .returning();
  return rows[0];
}

/**
 * The UI never sees the stored client secret (GET masks it), so edits may
 * arrive without one. Fill the gap from the stored row so "change client id,
 * keep secret" works — mirroring withStoredApiKey for providers.
 */
export async function withStoredClientSecret(
  userId: string,
  connector: ConnectorType,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (typeof input.clientSecret === "string" && input.clientSecret.trim()) return input;
  const existing = await getConnectorSetting(userId, connector);
  const stored = existing?.settings.clientSecret;
  if (!stored) return input;
  return { ...input, clientSecret: stored };
}
