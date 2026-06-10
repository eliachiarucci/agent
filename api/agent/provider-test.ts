import express from "express";
import { z } from "zod";
import { getSessionUser } from "../../lib/agent/actor";
import { PROVIDER_TYPES, providerSchemas, testProvider } from "../../lib/global/providers";
import { withStoredApiKey } from "../../lib/db/provider-settings";

export const config = {};

export const OPTIONS: express.RequestHandler = async (req, res) => {
  res.set("Allow", "POST, OPTIONS");
  res.sendStatus(204);
};

const testSchema = z.object({
  provider: z.enum(PROVIDER_TYPES),
  settings: z.record(z.string(), z.unknown()),
});

// Dry run of /agent/providers: verifies the connection and returns the
// provider's model list (for the model picker) without saving anything.
export const POST: express.RequestHandler = async (req, res) => {
  const parsed = testSchema.safeParse(req.body);
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
  res.json({ models: test.models });
};
