import { describe, expect, it } from "vitest";
import {
  OPENROUTER_BASE_URL,
  OPENROUTER_EU_BASE_URL,
  applyOpenRouterRouting,
  openRouterBaseUrl,
  providerSchemas,
  splitOpenRouterModel,
} from "../../lib/global/providers";
import { readDeviceSettings } from "../../lib/devices/settings";

describe("OpenRouter routing", () => {
  it("uses the EU endpoint when chosen", () => {
    expect(openRouterBaseUrl({ region: "eu" })).toBe(OPENROUTER_EU_BASE_URL);
    expect(openRouterBaseUrl({ region: "global" })).toBe(OPENROUTER_BASE_URL);
    expect(openRouterBaseUrl({})).toBe(OPENROUTER_BASE_URL);
  });

  it("reads the endpoint from the model id", () => {
    expect(splitOpenRouterModel("anthropic/claude-haiku-5.5@google-vertex/europe")).toEqual({
      model: "anthropic/claude-haiku-5.5",
      endpoint: "google-vertex/europe",
    });
    expect(splitOpenRouterModel("anthropic/claude-haiku-5.5")).toEqual({ model: "anthropic/claude-haiku-5.5", endpoint: null });
    expect(splitOpenRouterModel("anthropic/claude-haiku-5.5@")).toEqual({ model: "anthropic/claude-haiku-5.5", endpoint: null });
  });

  it("pins the model's endpoint without fallbacks, and adds ZDR", () => {
    const body = { model: "m", messages: [] };
    expect(applyOpenRouterRouting(body, {}, null)).toBe(body);
    expect(applyOpenRouterRouting(body, { zdr: true }, "google-vertex/europe")).toEqual({
      ...body,
      provider: { only: ["google-vertex/europe"], allow_fallbacks: false, zdr: true },
    });
    expect(applyOpenRouterRouting(body, { zdr: true }, null)).toEqual({ ...body, provider: { zdr: true } });
    // Other provider options in the body stay.
    expect(applyOpenRouterRouting({ provider: { sort: "latency" } }, {}, "anthropic").provider).toEqual({
      sort: "latency",
      only: ["anthropic"],
      allow_fallbacks: false,
    });
  });

  it("validates the stored settings", () => {
    const ok = providerSchemas.openrouter.safeParse({ apiKey: "k", region: "eu", zdr: true });
    expect(ok.success).toBe(true);
    expect(providerSchemas.openrouter.safeParse({ apiKey: "k", region: "mars" }).success).toBe(false);
  });

  it("moves a device's old route into its model id", () => {
    const settings = readDeviceSettings({
      perception: {
        provider: "openrouter",
        model: "anthropic/claude-haiku-5.5",
        route: { only: ["google-vertex/europe"], allowFallbacks: false },
      },
      agent: { provider: "anthropic", model: "claude-haiku-5-5", route: { only: ["x"], allowFallbacks: false } },
      voice: { provider: "openrouter", model: "a/b@azure/global", route: { only: ["x"], allowFallbacks: false } },
    });
    expect(settings.perception.model).toBe("anthropic/claude-haiku-5.5@google-vertex/europe");
    expect(settings.perception).not.toHaveProperty("route");
    expect(settings.agent.model).toBe("claude-haiku-5-5");
    expect(settings.voice.model).toBe("a/b@azure/global");
  });
});
