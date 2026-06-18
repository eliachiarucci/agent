import express from 'express';
import { z } from "zod";
import { getContextWindow } from "../../lib/agent/context";
import { resolveDefaultModelTarget } from "../../lib/agent/default-model";
import { getSessionUser } from "../../lib/agent/actor";
import { getProviderSetting } from "../../lib/db/provider-settings";
import { PROVIDER_TYPES } from "../../lib/global/providers";

export const config = {}

const querySchema = z.object({
    provider: z.enum(PROVIDER_TYPES).optional(),
    model: z.string().min(1).optional(),
});

// Without params: the env-configured default model (original behavior). With
// ?provider (+ optional ?model) it reports the window of a user-configured
// provider, so it needs the session to read that user's settings.
export const GET: express.RequestHandler = async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const { provider, model } = parsed.data;
    const user = await getSessionUser(req);

    // No explicit selection → the user's configured default model (else env).
    if (!provider) {
        const target = user ? await resolveDefaultModelTarget(user.id) : null;
        res.json(await getContextWindow(target ?? undefined));
        return;
    }

    if (!user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }
    const setting = await getProviderSetting(user.id, provider);
    if (!setting) {
        res.status(404).json({ error: `Provider "${provider}" is not configured` });
        return;
    }
    const modelId = model ?? setting.settings.model;
    if (!modelId) {
        res.status(400).json({ error: `No model selected for provider "${provider}"` });
        return;
    }

    res.json(await getContextWindow({ provider, settings: setting.settings, model: modelId }));
}
