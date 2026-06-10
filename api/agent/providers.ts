import express from "express";
import { z } from "zod";
import { getSessionUser } from "../../lib/agent/actor";
import { PROVIDER_TYPES, providerSchemas, testProvider } from "../../lib/global/providers";
import {
  deleteProviderSetting,
  listProviderSettings,
  upsertProviderSetting,
  withStoredApiKey,
  type ProviderSetting,
} from "../../lib/db/provider-settings";

export const config = {};

// API keys never leave the server; the UI only learns whether one is stored.
export function maskProviderSetting(row: ProviderSetting) {
  const { apiKey, ...settings } = row.settings;
  return {
    id: row.id,
    provider: row.provider,
    settings: { ...settings, hasApiKey: Boolean(apiKey) },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const OPTIONS: express.RequestHandler = async (req, res) => {
  res.set("Allow", "GET, POST, DELETE, OPTIONS");
  res.sendStatus(204);
};

export const GET: express.RequestHandler = async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const rows = await listProviderSettings(user.id);
  res.json(rows.map(maskProviderSetting));
};

const saveSchema = z.object({
  provider: z.enum(PROVIDER_TYPES),
  settings: z.record(z.string(), z.unknown()),
});

// Verifies the settings against the provider first; nothing is saved unless the
// test call succeeds.
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

  const { provider } = parsed.data;
  // The UI omits the key when it's already stored — restore it before validating.
  const input = await withStoredApiKey(user.id, provider, parsed.data.settings);
  const settings = providerSchemas[provider].safeParse(input);
  if (!settings.success) {
    res.status(400).json({ error: settings.error.issues });
    return;
  }

  const test = await testProvider(provider, settings.data);
  if (!test.ok) {
    res.status(422).json({ error: test.error });
    return;
  }

  const row = await upsertProviderSetting(user.id, provider, settings.data);
  res.json({ provider: maskProviderSetting(row), models: test.models });
};

export const DELETE: express.RequestHandler = async (req, res) => {
  const parsed = z.object({ provider: z.enum(PROVIDER_TYPES) }).safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }

  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const removed = await deleteProviderSetting(user.id, parsed.data.provider);
  if (!removed) {
    res.status(404).json({ error: "Provider not configured" });
    return;
  }
  res.status(204).end();
};
