import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import {
  mergeProviderOptions,
  promptCacheProviderOptions,
  withPromptCache,
} from "../../lib/agent/prompt-cache";
import { perceptionProviderOptions } from "../../lib/devices/perception-model";

describe("prompt caching", () => {
  it("marks the system block and the newest message for Anthropic's own API", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "again" },
    ];
    const out = withPromptCache("sys", messages, true);
    expect(out.system).toBeUndefined();
    expect(out.messages.map((m) => !!m.providerOptions)).toEqual([true, false, false, true]);
    expect(withPromptCache("sys", messages, false)).toEqual({ system: "sys", messages });
  });

  it("asks OpenRouter to cache Anthropic models only", () => {
    expect(promptCacheProviderOptions("openrouter", "anthropic/claude-haiku-5.5")).toEqual({
      openrouter: { cache_control: { type: "ephemeral" } },
    });
    expect(promptCacheProviderOptions("openrouter", "google/gemini-3.1-flash-lite")).toBeUndefined();
    expect(promptCacheProviderOptions("anthropic", "claude-haiku-5-5")).toBeUndefined();
    expect(promptCacheProviderOptions(undefined, undefined)).toBeUndefined();
  });

  it("merges a device run's options: no reasoning and the cache, for a pinned model too", () => {
    const model = "anthropic/claude-haiku-5.5@google-vertex/europe";
    expect(
      mergeProviderOptions(
        perceptionProviderOptions("openrouter", model),
        promptCacheProviderOptions("openrouter", model)
      )
    ).toEqual({
      openrouter: {
        reasoning: { enabled: false },
        cache_control: { type: "ephemeral" },
      },
    });
    expect(mergeProviderOptions(undefined, undefined)).toBeUndefined();
  });
});
