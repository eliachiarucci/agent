// Context-window lookup. Providers report the window differently (LM Studio has
// a bespoke REST API, Anthropic and Google publish per-model limits via their
// model endpoints), so the rest of the app only depends on getContextWindow().
// The same per-model lookups also report whether the model accepts image input
// (supportsImages), which drives the composer's attachment button.

import { DEEPINFRA_BASE_URL, TENSORX_BASE_URL, OPENROUTER_BASE_URL, lmstudioBaseUrl } from "../global/providers";
import type { ProviderSettingsValue, ProviderType } from "../global/schema";

export type ContextWindow = {
    model: string;
    /** Tokens the current model can hold, or null when the provider can't say. */
    contextLength: number | null;
    /** Whether the model accepts image input; null when the provider can't say. */
    supportsImages: boolean | null;
};

type ModelInfo = Pick<ContextWindow, "contextLength" | "supportsImages">;

/** A user-configured provider + model; omitted → the env-configured default. */
export type ContextTarget = {
    provider: ProviderType;
    settings: ProviderSettingsValue;
    model: string;
};

// LM Studio's native REST API (separate from the OpenAI-compatible /v1) exposes
// per-model context info: loaded_context_length is what the model is actually
// running with, max_context_length is the model's ceiling. The same response
// carries the model type ("vlm" = vision language model) and, on newer
// versions, a capabilities list.
async function lmstudioModelInfo(baseUrl: string, model: string): Promise<ModelInfo> {
    const res = await fetch(`${baseUrl}/api/v0/models/${encodeURIComponent(model)}`);
    if (!res.ok) return { contextLength: null, supportsImages: null };
    const info = (await res.json()) as {
        loaded_context_length?: number;
        max_context_length?: number;
        type?: string;
        capabilities?: string[];
    };
    const supportsImages =
        info.capabilities?.includes("vision") || info.type === "vlm"
            ? true
            : info.type === "llm"
              ? false
              : null;
    return {
        contextLength: info.loaded_context_length ?? info.max_context_length ?? null,
        supportsImages,
    };
}

// Every current Claude chat model accepts image input, and the models endpoint
// carries no capability flag — so vision is asserted rather than detected.
async function anthropicModelInfo(apiKey: string, model: string): Promise<ModelInfo> {
    const res = await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`, {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) return { contextLength: null, supportsImages: true };
    const info = (await res.json()) as { max_input_tokens?: number };
    return { contextLength: info.max_input_tokens ?? null, supportsImages: true };
}

// DeepInfra has no single-model endpoint; the full listing carries each model's
// context_length (and capability tags) in metadata. One fetch per cache TTL
// (see below) keeps it cheap.
async function deepinfraModelInfo(apiKey: string, model: string): Promise<ModelInfo> {
    const res = await fetch(`${DEEPINFRA_BASE_URL}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return { contextLength: null, supportsImages: null };
    const body = (await res.json()) as {
        data?: Array<{ id?: string; metadata?: { context_length?: number; tags?: string[] } }>;
    };
    const metadata = body.data?.find((m) => m.id === model)?.metadata;
    return {
        contextLength: metadata?.context_length ?? null,
        // Vision models are tagged; an untagged listing stays unknown rather
        // than false, so the UI keeps the attach button available.
        supportsImages: metadata?.tags?.includes("vision") ? true : null,
    };
}

// TensorX runs on a LiteLLM proxy: its OpenAI-compatible /v1/models listing
// carries no context length, but LiteLLM's /v1/model/info does, exposing each
// model's limits — and a supports_vision flag — under model_info. (A virtual
// key without info access 403s — caught upstream as an unknown window.)
async function tensorxModelInfo(apiKey: string, model: string): Promise<ModelInfo> {
    const res = await fetch(`${TENSORX_BASE_URL}/model/info`, {
        headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return { contextLength: null, supportsImages: null };
    const body = (await res.json()) as {
        data?: Array<{
            model_name?: string;
            model_info?: {
                max_input_tokens?: number;
                max_tokens?: number;
                supports_vision?: boolean;
            };
        }>;
    };
    const info = body.data?.find((m) => m.model_name === model)?.model_info;
    return {
        contextLength: info?.max_input_tokens ?? info?.max_tokens ?? null,
        supportsImages: typeof info?.supports_vision === "boolean" ? info.supports_vision : null,
    };
}

// OpenRouter's public /models listing carries each model's context_length;
// top_provider.context_length is what the default route actually serves, so we
// prefer it (conservative for compaction) and fall back to the headline max.
// architecture.input_modalities says whether the model takes image input.
// The listing needs no key.
async function openrouterModelInfo(model: string): Promise<ModelInfo> {
    const res = await fetch(`${OPENROUTER_BASE_URL}/models`);
    if (!res.ok) return { contextLength: null, supportsImages: null };
    const body = (await res.json()) as {
        data?: Array<{
            id?: string;
            context_length?: number;
            top_provider?: { context_length?: number };
            architecture?: { input_modalities?: string[] };
        }>;
    };
    const m = body.data?.find((x) => x.id === model);
    const modalities = m?.architecture?.input_modalities;
    return {
        contextLength: m?.top_provider?.context_length ?? m?.context_length ?? null,
        supportsImages: modalities ? modalities.includes("image") : null,
    };
}

// Gemini chat models are natively multimodal, and the models endpoint exposes
// no capability flag — so vision is asserted rather than detected.
async function googleModelInfo(apiKey: string, model: string): Promise<ModelInfo> {
    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`,
        { headers: { "x-goog-api-key": apiKey } }
    );
    if (!res.ok) return { contextLength: null, supportsImages: true };
    const info = (await res.json()) as { inputTokenLimit?: number };
    return { contextLength: info.inputTokenLimit ?? null, supportsImages: true };
}

// The window only changes when a model is (re)loaded; a short TTL keeps the UI
// fresh without hitting the provider on every poll.
const cache = new Map<string, { value: ContextWindow; expiresAt: number }>();

export async function getContextWindow(target?: ContextTarget): Promise<ContextWindow> {
    // No target → no default model configured. There is no server fallback, so
    // the window is simply unknown (the UI shows "select a model").
    if (!target?.model) return { model: "", contextLength: null, supportsImages: null };
    const { model } = target;
    const baseUrl = lmstudioBaseUrl(target.settings.url ?? "http://localhost:1234");
    const key = `${target.provider}:${baseUrl}:${model}`;

    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const info = await (target?.provider === "anthropic"
        ? anthropicModelInfo(target.settings.apiKey ?? "", model)
        : target?.provider === "google"
          ? googleModelInfo(target.settings.apiKey ?? "", model)
          : target?.provider === "deepinfra"
            ? deepinfraModelInfo(target.settings.apiKey ?? "", model)
            : target?.provider === "tensorx"
              ? tensorxModelInfo(target.settings.apiKey ?? "", model)
              : target?.provider === "openrouter"
                ? openrouterModelInfo(model)
                : // OpenAI's API exposes no per-model context length or
                  // capability info, so both stay unknown (compaction falls
                  // back to its default; the attach button stays available).
                  target?.provider === "openai"
                  ? Promise.resolve<ModelInfo>({ contextLength: null, supportsImages: null })
                  : lmstudioModelInfo(baseUrl, model)
    ).catch((): ModelInfo => ({ contextLength: null, supportsImages: null }));

    const value: ContextWindow = { model, ...info };
    cache.set(key, { value, expiresAt: Date.now() + 60_000 });
    return value;
}
