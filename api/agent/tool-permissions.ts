import express from "express";
import { z } from "zod";
import { getSessionUser } from "../../lib/agent/actor";
import { getToolPermissions, upsertToolPermissions } from "../../lib/db/tool-permissions";
import { listAgentMembers } from "../../lib/db/agents";
import { CONNECTOR_TYPES, TOOL_PERMISSION_LEVELS } from "../../lib/global/schema";

export const config = {};

const scopeSchema = z.object({ agent_id: z.uuid() });

// { [connector]: { [toolName]: "deny" | "ask" | "allow" } } — missing keys mean
// the tool's catalog default ("allow" for read tools, "ask" for write tools),
// so the UI only persists tools the user actually changed.
const saveSchema = scopeSchema.extend({
  permissions: z.record(
    z.enum(CONNECTOR_TYPES),
    z.record(z.string(), z.enum(TOOL_PERMISSION_LEVELS))
  ),
});

async function requireMember(userId: string, agentId: string): Promise<boolean> {
  const members = await listAgentMembers(agentId);
  return members.some((m) => m.userId === userId);
}

export const OPTIONS: express.RequestHandler = async (req, res) => {
  res.set("Allow", "GET, POST, OPTIONS");
  res.sendStatus(204);
};

// The caller's per-tool levels for one agent (the agent picked at the top of
// Settings → Tools). {} when nothing was ever saved.
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

  const permissions = await getToolPermissions(user.id, parsed.data.agent_id);
  res.json({ agent_id: parsed.data.agent_id, permissions });
};

export const POST: express.RequestHandler = async (req, res) => {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }

  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const { agent_id, permissions } = parsed.data;
  if (!(await requireMember(user.id, agent_id))) {
    res.status(403).json({ error: "Not a member of this agent" });
    return;
  }

  const row = await upsertToolPermissions(user.id, agent_id, permissions);
  res.json({ agent_id, permissions: row.permissions });
};
