import type { ModelMessage } from "ai";

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
