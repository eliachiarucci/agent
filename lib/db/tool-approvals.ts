import { and, eq } from "drizzle-orm";
import { db } from "../global/db";
import { toolApprovals, type ConnectorType } from "../global/schema";

export type ToolApprovalRow = typeof toolApprovals.$inferSelect;

// Wildcard target: the override covers every call of the tool, used both for
// tools without a target concept and stored explicitly as "*".
export const TOOL_APPROVAL_ANY_TARGET = "*";

/** All standing approvals of one (user, agent), newest first. */
export async function listToolApprovals(
  userId: string,
  agentId: string
): Promise<ToolApprovalRow[]> {
  return db.query.toolApprovals.findMany({
    where: and(eq(toolApprovals.userId, userId), eq(toolApprovals.agentId, agentId)),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
}

/**
 * Record standing approvals for a tool. `targets` null/empty means the tool
 * has no target concept: a single wildcard row covers every future call.
 * Re-approving an existing combination is a no-op (unique index).
 */
export async function addToolApprovals(opts: {
  userId: string;
  agentId: string;
  connector: ConnectorType;
  tool: string;
  targets: string[] | null;
}): Promise<void> {
  const targets = opts.targets?.length ? opts.targets : [TOOL_APPROVAL_ANY_TARGET];
  await db
    .insert(toolApprovals)
    .values(
      targets.map((target) => ({
        userId: opts.userId,
        agentId: opts.agentId,
        connector: opts.connector,
        tool: opts.tool,
        target,
      }))
    )
    .onConflictDoNothing();
}

/** Delete one override; scoped to the owner so ids can't be guessed across users. */
export async function deleteToolApproval(id: string, userId: string): Promise<boolean> {
  const rows = await db
    .delete(toolApprovals)
    .where(and(eq(toolApprovals.id, id), eq(toolApprovals.userId, userId)))
    .returning({ id: toolApprovals.id });
  return rows.length > 0;
}

/**
 * Whether a pending call is covered by standing approvals. A wildcard row
 * always covers it; otherwise every derived target must have its own row
 * (a draft to two recipients needs both approved). `targets` null means the
 * tool has no target concept, so only the wildcard row can cover it.
 */
export async function isToolCallApproved(opts: {
  userId: string;
  agentId: string;
  connector: ConnectorType;
  tool: string;
  targets: string[] | null;
}): Promise<boolean> {
  const rows = await db.query.toolApprovals.findMany({
    where: and(
      eq(toolApprovals.userId, opts.userId),
      eq(toolApprovals.agentId, opts.agentId),
      eq(toolApprovals.connector, opts.connector),
      eq(toolApprovals.tool, opts.tool)
    ),
    columns: { target: true },
  });
  const approved = new Set(rows.map((r) => r.target));
  if (approved.has(TOOL_APPROVAL_ANY_TARGET)) return true;
  if (!opts.targets || opts.targets.length === 0) return false;
  return opts.targets.every((target) => approved.has(target));
}
