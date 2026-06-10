// Context-window lookup. Providers report the window differently (LM Studio has
// a bespoke REST API, Anthropic publishes per-model limits via /v1/models), so
// the rest of the app only depends on getContextWindow().

import { lmstudioBaseUrl } from "../global/providers";
import type { ProviderSettingsValue, ProviderType } from "../global/schema";

export type ContextWindow = {
    model: string;
    /** Tokens the current model can hold, or null when the provider can't say. */
    contextLength: number | null;
};

/** A user-configured provider + model; omitted → the env-configured default. */
export type ContextTarget = {
    provider: ProviderType;
    settings: ProviderSettingsValue;
    model: string;
};

// LM Studio's native REST API (separate from the OpenAI-compatible /v1) exposes
// per-model context info: loaded_context_length is what the model is actually
// running with, max_context_length is the model's ceiling.
async function lmstudioContextWindow(baseUrl: string, model: string): Promise<number | null> {
    const res = await fetch(`${baseUrl}/api/v0/models/${encodeURIComponent(model)}`);
    if (!res.ok) return null;
    const info = (await res.json()) as {
        loaded_context_length?: number;
        max_context_length?: number;
    };
    return info.loaded_context_length ?? info.max_context_length ?? null;
}

async function anthropicContextWindow(apiKey: string, model: string): Promise<number | null> {
    const res = await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`, {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) return null;
    const info = (await res.json()) as { max_input_tokens?: number };
    return info.max_input_tokens ?? null;
}

// The window only changes when a model is (re)loaded; a short TTL keeps the UI
// fresh without hitting the provider on every poll.
const cache = new Map<string, { value: ContextWindow; expiresAt: number }>();

export async function getContextWindow(target?: ContextTarget): Promise<ContextWindow> {
    const model = target?.model ?? process.env.CHAT_MODEL ?? "google/gemma-4-e4b";
    const baseUrl = target
        ? lmstudioBaseUrl(target.settings.url ?? "http://localhost:1234")
        : process.env.LMSTUDIO_URL ?? "http://localhost:1234";
    const key = `${target?.provider ?? "default"}:${baseUrl}:${model}`;

    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const contextLength = await (target?.provider === "anthropic"
        ? anthropicContextWindow(target.settings.apiKey ?? "", model)
        : lmstudioContextWindow(baseUrl, model)
    ).catch(() => null);

    const value: ContextWindow = { model, contextLength };
    cache.set(key, { value, expiresAt: Date.now() + 60_000 });
    return value;
}
