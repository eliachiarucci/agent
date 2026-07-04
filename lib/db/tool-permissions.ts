import { and, eq, sql } from "drizzle-orm";
import { db } from "../global/db";
import {
  toolPermissions,
  type ProviderType,
  type ToolPermissionsValue,
} from "../global/schema";

export type ToolPermissionRow = typeof toolPermissions.$inferSelect;

/** The stored per-tool switches for one (user, provider, model); {} when unset. */
export async function getToolPermissions(
  userId: string,
  provider: ProviderType,
  model: string
): Promise<ToolPermissionsValue> {
  const row = await db.query.toolPermissions.findFirst({
    where: and(
      eq(toolPermissions.userId, userId),
      eq(toolPermissions.provider, provider),
      eq(toolPermissions.model, model)
    ),
  });
  return row?.permissions ?? {};
}

/** One row per (user, provider, model): saving again replaces the map. */
export async function upsertToolPermissions(
  userId: string,
  provider: ProviderType,
  model: string,
  permissions: ToolPermissionsValue
): Promise<ToolPermissionRow> {
  const [row] = await db
    .insert(toolPermissions)
    .values({ userId, provider, model, permissions })
    .onConflictDoUpdate({
      target: [toolPermissions.userId, toolPermissions.provider, toolPermissions.model],
      set: { permissions, updatedAt: sql`now()` },
    })
    .returning();
  return row;
}
