import express from "express";
import { z } from "zod";
import { getSessionUser } from "../../lib/agent/actor";
import { getToolPermissions, upsertToolPermissions } from "../../lib/db/tool-permissions";
import { PROVIDER_TYPES } from "../../lib/global/providers";
import { CONNECTOR_TYPES } from "../../lib/global/schema";

export const config = {};

const scopeSchema = z.object({
  provider: z.enum(PROVIDER_TYPES),
  model: z.string().min(1),
});

// { [connector]: { [toolName]: enabled } } — missing keys mean enabled, so the
// UI only needs to persist the toggles the user actually flipped off (or back on).
const saveSchema = scopeSchema.extend({
  permissions: z.record(z.enum(CONNECTOR_TYPES), z.record(z.string(), z.boolean())),
});

export const OPTIONS: express.RequestHandler = async (req, res) => {
  res.set("Allow", "GET, POST, OPTIONS");
  res.sendStatus(204);
};

// The per-tool switches for one chat model (the model picked at the top of
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

  const permissions = await getToolPermissions(user.id, parsed.data.provider, parsed.data.model);
  res.json({ ...parsed.data, permissions });
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

  const { provider, model, permissions } = parsed.data;
  const row = await upsertToolPermissions(user.id, provider, model, permissions);
  res.json({ provider, model, permissions: row.permissions });
};
