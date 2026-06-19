// Context-window lookup. Providers report the window differently (LM Studio has
// a bespoke REST API, Anthropic and Google publish per-model limits via their
// model endpoints), so the rest of the app only depends on getContextWindow().

import { DEEPINFRA_BASE_URL, TENSORX_BASE_URL, lmstudioBaseUrl } from "../global/providers";
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

// DeepInfra has no single-model endpoint; the full listing carries each model's
// context_length in metadata. One fetch per cache TTL (see below) keeps it cheap.
async function deepinfraContextWindow(apiKey: string, model: string): Promise<number | null> {
    const res = await fetch(`${DEEPINFRA_BASE_URL}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
        data?: Array<{ id?: string; metadata?: { context_length?: number } }>;
    };
    return body.data?.find((m) => m.id === model)?.metadata?.context_length ?? null;
}

// TensorX runs on a LiteLLM proxy: its OpenAI-compatible /v1/models listing
// carries no context length, but LiteLLM's /v1/model/info does, exposing each
// model's limits under model_info. (A virtual key without info access 403s —
// caught upstream as an unknown window.)
async function tensorxContextWindow(apiKey: string, model: string): Promise<number | null> {
    const res = await fetch(`${TENSORX_BASE_URL}/model/info`, {
        headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
        data?: Array<{ model_name?: string; model_info?: { max_input_tokens?: number; max_tokens?: number } }>;
    };
    const info = body.data?.find((m) => m.model_name === model)?.model_info;
    return info?.max_input_tokens ?? info?.max_tokens ?? null;
}

async function googleContextWindow(apiKey: string, model: string): Promise<number | null> {
    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`,
        { headers: { "x-goog-api-key": apiKey } }
    );
    if (!res.ok) return null;
    const info = (await res.json()) as { inputTokenLimit?: number };
    return info.inputTokenLimit ?? null;
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
        : target?.provider === "google"
          ? googleContextWindow(target.settings.apiKey ?? "", model)
          : target?.provider === "deepinfra"
            ? deepinfraContextWindow(target.settings.apiKey ?? "", model)
            : target?.provider === "tensorx"
              ? tensorxContextWindow(target.settings.apiKey ?? "", model)
              : lmstudioContextWindow(baseUrl, model)
    ).catch(() => null);

    const value: ContextWindow = { model, contextLength };
    cache.set(key, { value, expiresAt: Date.now() + 60_000 });
    return value;
}
