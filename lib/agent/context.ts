// Context-window lookup. Providers report the window differently (LM Studio has
// a bespoke REST API, hosted providers publish static limits), so the rest of
// the app only depends on getContextWindow(); add new providers by writing
// another ContextWindowProvider and switching on the configured provider.

export type ContextWindow = {
    model: string;
    /** Tokens the current model can hold, or null when the provider can't say. */
    contextLength: number | null;
};

type ContextWindowProvider = (model: string) => Promise<number | null>;

// LM Studio's native REST API (separate from the OpenAI-compatible /v1) exposes
// per-model context info: loaded_context_length is what the model is actually
// running with, max_context_length is the model's ceiling.
const lmstudioContextWindow: ContextWindowProvider = async (model) => {
    const baseURL = process.env.LMSTUDIO_URL ?? "http://localhost:1234";
    const res = await fetch(`${baseURL}/api/v0/models/${encodeURIComponent(model)}`);
    if (!res.ok) return null;
    const info = (await res.json()) as {
        loaded_context_length?: number;
        max_context_length?: number;
    };
    return info.loaded_context_length ?? info.max_context_length ?? null;
};

const provider: ContextWindowProvider = lmstudioContextWindow;

// The window only changes when a model is (re)loaded; a short TTL keeps the UI
// fresh without hitting LM Studio on every poll.
let cached: { model: string; value: ContextWindow; expiresAt: number } | undefined;

export async function getContextWindow(): Promise<ContextWindow> {
    const model = process.env.CHAT_MODEL ?? "google/gemma-4-e4b";
    if (cached && cached.model === model && cached.expiresAt > Date.now()) {
        return cached.value;
    }

    const contextLength = await provider(model).catch(() => null);
    const value: ContextWindow = { model, contextLength };
    cached = { model, value, expiresAt: Date.now() + 60_000 };
    return value;
}
