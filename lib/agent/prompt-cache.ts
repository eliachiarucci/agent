import type { ModelMessage } from "ai";
import type { ProviderType } from "../global/schema";

type ProviderOptions = Record<string, Record<string, any>>;

// Anthropic prompt caching is opt-in per request (unlike LM Studio's and
// Gemini's implicit prefix caching): two ephemeral breakpoints — one on the
// system block (tools render before system, so it caches both) and one on the
// newest message, so each turn reads the whole prior conversation from cache
// (writes 1.25x, reads 0.1x, 5-min TTL). The prompt prefix is already
// byte-stable across turns (see docs/memory.md), which is exactly what the
// cache keys on. Shared by the chat route and device runs.
const cacheBreakpoint = { anthropic: { cacheControl: { type: "ephemeral" as const } } };

/** The system prompt and messages for one call, with cache breakpoints when `enabled`. */
export function withPromptCache(
  system: string,
  messages: ModelMessage[],
  enabled: boolean
): { system?: string; messages: ModelMessage[] } {
  if (!enabled) return { system, messages };
  return {
    system: undefined,
    messages: [
      { role: "system", content: system, providerOptions: cacheBreakpoint },
      ...messages.slice(0, -1),
      ...messages.slice(-1).map((m) => ({ ...m, providerOptions: cacheBreakpoint })),
    ],
  };
}

// Anthropic models through OpenRouter: the OpenAI-compatible provider has no
// message-level breakpoints of its own, but OpenRouter takes a top-level
// `cache_control`, which caches the whole prompt up to the newest message —
// measured 2026-10-13 on Haiku 5.5 (google-vertex/europe): 21.6k of 21.6k
// prompt tokens read from cache on the second call. Gemini and OpenAI models
// on OpenRouter cache implicitly.
export function promptCacheProviderOptions(
  provider: ProviderType | undefined,
  modelId: string | undefined
): ProviderOptions | undefined {
  if (provider === "openrouter" && modelId?.startsWith("anthropic/")) {
    return { openrouter: { cache_control: { type: "ephemeral" } } };
  }
  return undefined;
}

/** Shallow-merges provider options per provider key. */
export function mergeProviderOptions(
  ...parts: (ProviderOptions | undefined)[]
): ProviderOptions | undefined {
  const out: ProviderOptions = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part ?? {})) out[key] = { ...out[key], ...value };
  }
  return Object.keys(out).length ? out : undefined;
}
