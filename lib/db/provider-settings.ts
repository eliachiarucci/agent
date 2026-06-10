import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../global/db";
import {
  providerSettings,
  type ProviderSettingsValue,
  type ProviderType,
} from "../global/schema";

export type ProviderSetting = typeof providerSettings.$inferSelect;

export async function listProviderSettings(userId: string): Promise<ProviderSetting[]> {
  return db.query.providerSettings.findMany({
    where: eq(providerSettings.userId, userId),
    orderBy: asc(providerSettings.provider),
  });
}

export async function getProviderSetting(
  userId: string,
  provider: ProviderType
): Promise<ProviderSetting | undefined> {
  return db.query.providerSettings.findFirst({
    where: and(eq(providerSettings.userId, userId), eq(providerSettings.provider, provider)),
  });
}

/** One row per (user, provider): inserting again replaces the settings. */
export async function upsertProviderSetting(
  userId: string,
  provider: ProviderType,
  settings: ProviderSettingsValue
): Promise<ProviderSetting> {
  const [row] = await db
    .insert(providerSettings)
    .values({ userId, provider, settings })
    .onConflictDoUpdate({
      target: [providerSettings.userId, providerSettings.provider],
      set: { settings, updatedAt: sql`now()` },
    })
    .returning();
  return row;
}

export async function deleteProviderSetting(
  userId: string,
  provider: ProviderType
): Promise<boolean> {
  const rows = await db
    .delete(providerSettings)
    .where(and(eq(providerSettings.userId, userId), eq(providerSettings.provider, provider)))
    .returning();
  return rows.length > 0;
}

/**
 * The UI never sees stored API keys (GET masks them), so edits may arrive
 * without one. Fill the gap from the stored row so "change URL, keep key" works.
 */
export async function withStoredApiKey(
  userId: string,
  provider: ProviderType,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (typeof input.apiKey === "string" && input.apiKey.trim()) return input;
  const existing = await getProviderSetting(userId, provider);
  const storedKey = existing?.settings.apiKey;
  if (!storedKey) return input;
  return { ...input, apiKey: storedKey };
}
