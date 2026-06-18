import { eq } from "drizzle-orm";
import { db } from "../global/db";
import { userSettings, type ProviderType } from "../global/schema";

export type UserSettings = typeof userSettings.$inferSelect;

export async function getUserSettings(userId: string): Promise<UserSettings | undefined> {
  return db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
}

// Upsert keyed on userId. Callers send the default model as a pair.
export async function upsertUserSettings(
  userId: string,
  changes: { defaultProvider?: ProviderType | null; defaultModel?: string | null }
): Promise<UserSettings> {
  const [row] = await db
    .insert(userSettings)
    .values({ userId, ...changes })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { ...changes, updatedAt: new Date() },
    })
    .returning();
  return row;
}
