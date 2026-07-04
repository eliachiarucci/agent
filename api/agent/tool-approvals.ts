import express from "express";
import { z } from "zod";
import { getSessionUser } from "../../lib/agent/actor";
import { deleteToolApproval, listToolApprovals } from "../../lib/db/tool-approvals";
import { listAgentMembers } from "../../lib/db/agents";

export const config = {};

// Standing approval overrides ("always approve" decisions from the chat's
// approval prompts). Rows are created only by the conversation route when the
// user picks "always"; this route lets the settings UI list and revoke them.

const scopeSchema = z.object({ agent_id: z.uuid() });

async function requireMember(userId: string, agentId: string): Promise<boolean> {
  const members = await listAgentMembers(agentId);
  return members.some((m) => m.userId === userId);
}

export const OPTIONS: express.RequestHandler = async (req, res) => {
  res.set("Allow", "GET, DELETE, OPTIONS");
  res.sendStatus(204);
};

// The caller's overrides for one agent, newest first.
export const GET: express.RequestHandler = async (req, res) => {
  const parsed = scopeSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }

  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (!(await requireMember(user.id, parsed.data.agent_id))) {
    res.status(403).json({ error: "Not a member of this agent" });
    return;
  }

  const approvals = await listToolApprovals(user.id, parsed.data.agent_id);
  res.json({
    agent_id: parsed.data.agent_id,
    approvals: approvals.map((a) => ({
      id: a.id,
      connector: a.connector,
      tool: a.tool,
      target: a.target,
      createdAt: a.createdAt,
    })),
  });
};

export const DELETE: express.RequestHandler = async (req, res) => {
  const parsed = z.object({ id: z.uuid() }).safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }

  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  // Scoped to the caller's own rows inside the delete, so someone else's id 404s.
  const deleted = await deleteToolApproval(parsed.data.id, user.id);
  if (!deleted) {
    res.status(404).json({ error: "Approval not found" });
    return;
  }
  res.status(204).end();
};
