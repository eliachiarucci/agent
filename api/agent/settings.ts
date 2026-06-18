import express from "express";
import { z } from "zod";
import { getSessionUser } from "../../lib/agent/actor";
import { PROVIDER_TYPES } from "../../lib/global/providers";
import { getUserSettings, upsertUserSettings } from "../../lib/db/user-settings";

export const config = {};

export const OPTIONS: express.RequestHandler = async (req, res) => {
  res.set("Allow", "GET, PATCH, OPTIONS");
  res.sendStatus(204);
};

export const GET: express.RequestHandler = async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const settings = await getUserSettings(user.id);
  res.json({
    defaultProvider: settings?.defaultProvider ?? null,
    defaultModel: settings?.defaultModel ?? null,
  });
};

// The default model is set as a pair (both null resets to the env default).
const patchSchema = z
  .object({
    default_provider: z.enum(PROVIDER_TYPES).nullable().optional(),
    default_model: z.string().min(1).nullable().optional(),
  })
  .refine((d) => d.default_provider !== undefined || d.default_model !== undefined, {
    message: "Nothing to update",
  });

export const PATCH: express.RequestHandler = async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }

  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const { default_provider, default_model } = parsed.data;
  const updated = await upsertUserSettings(user.id, {
    ...(default_provider !== undefined && { defaultProvider: default_provider }),
    ...(default_model !== undefined && { defaultModel: default_model }),
  });
  res.json({ defaultProvider: updated.defaultProvider, defaultModel: updated.defaultModel });
};
