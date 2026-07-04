import { and, eq, sql } from "drizzle-orm";
import { db } from "../global/db";
import { toolPermissions, type ToolPermissionsValue } from "../global/schema";

export type ToolPermissionRow = typeof toolPermissions.$inferSelect;

/** The stored per-tool levels for one (user, agent); {} when unset. */
export async function getToolPermissions(
  userId: string,
  agentId: string
): Promise<ToolPermissionsValue> {
  const row = await db.query.toolPermissions.findFirst({
    where: and(eq(toolPermissions.userId, userId), eq(toolPermissions.agentId, agentId)),
  });
  return row?.permissions ?? {};
}

/** One row per (user, agent): saving again replaces the map. */
export async function upsertToolPermissions(
  userId: string,
  agentId: string,
  permissions: ToolPermissionsValue
): Promise<ToolPermissionRow> {
  const [row] = await db
    .insert(toolPermissions)
    .values({ userId, agentId, permissions })
    .onConflictDoUpdate({
      target: [toolPermissions.userId, toolPermissions.agentId],
      set: { permissions, updatedAt: sql`now()` },
    })
    .returning();
  return row;
}
