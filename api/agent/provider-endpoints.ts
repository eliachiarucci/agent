import express from "express";
import { z } from "zod";
import { getSessionUser } from "../../lib/agent/actor";
import { getProviderSetting } from "../../lib/db/provider-settings";
import { listOpenRouterEndpoints, providerSchemas } from "../../lib/global/providers";

export const config = {};

export const OPTIONS: express.RequestHandler = async (req, res) => {
  res.set("Allow", "GET, OPTIONS");
  res.sendStatus(204);
};

// An OpenRouter model id, optionally with its "@endpoint"; it becomes part of
// the upstream URL, so only the characters OpenRouter ids use, and each
// segment starts with a letter or digit (no ".."), after the "~" of aliases.
const SEGMENT = "[A-Za-z0-9][\\w.:~-]*";
const MODEL_ID = new RegExp(`^~?${SEGMENT}/${SEGMENT}(@${SEGMENT}(/${SEGMENT})*)?$`);
const querySchema = z.object({
  provider: z.literal("openrouter"),
  model: z.string().max(200).regex(MODEL_ID, "Not an OpenRouter model id"),
});

// The endpoints that can serve a model (OpenRouter only), for the model
// picker's provider choice. Listed through the user's API endpoint, so the EU
// endpoint offers only EU ones.
export const GET: express.RequestHandler = async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }

  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const stored = await getProviderSetting(user.id, "openrouter");
  const settings = providerSchemas.openrouter.safeParse(stored?.settings);
  if (!settings.success) {
    res.status(404).json({ error: "OpenRouter is not configured" });
    return;
  }

  try {
    const endpoints = await listOpenRouterEndpoints(settings.data, parsed.data.model);
    if (!endpoints) {
      res.status(404).json({ error: "OpenRouter doesn't know this model" });
      return;
    }
    res.json({ endpoints });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "OpenRouter is unreachable" });
  }
};
