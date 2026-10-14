import { describe, expect, it } from "vitest";
import {
  OPENROUTER_BASE_URL,
  OPENROUTER_EU_BASE_URL,
  applyOpenRouterRouting,
  openRouterBaseUrl,
  providerSchemas,
} from "../../lib/global/providers";

describe("OpenRouter routing", () => {
  it("uses the EU endpoint when chosen", () => {
    expect(openRouterBaseUrl({ region: "eu" })).toBe(OPENROUTER_EU_BASE_URL);
    expect(openRouterBaseUrl({ region: "global" })).toBe(OPENROUTER_BASE_URL);
    expect(openRouterBaseUrl({})).toBe(OPENROUTER_BASE_URL);
  });

  it("pins the allowed providers, without fallbacks, and adds ZDR", () => {
    const body = { model: "m", messages: [] };
    expect(applyOpenRouterRouting(body, {})).toBe(body);
    expect(applyOpenRouterRouting(body, { allowedProviders: ["google-vertex/europe"], zdr: true })).toEqual({
      ...body,
      provider: { only: ["google-vertex/europe"], allow_fallbacks: false, zdr: true },
    });
    expect(applyOpenRouterRouting(body, { zdr: true })).toEqual({ ...body, provider: { zdr: true } });
  });

  it("keeps a request's own pin, narrowed to the allowed providers", () => {
    const pinned = { provider: { only: ["google-vertex/europe", "anthropic"], allow_fallbacks: true } };
    expect(applyOpenRouterRouting(pinned, { allowedProviders: ["google-vertex/europe", "azure/global"] }).provider).toEqual({
      only: ["google-vertex/europe"],
      allow_fallbacks: false,
    });
    // A pin entirely outside the allowed providers gives way to them.
    expect(applyOpenRouterRouting({ provider: { only: ["anthropic"] } }, { allowedProviders: ["google-vertex/europe"] }).provider.only).toEqual([
      "google-vertex/europe",
    ]);
  });

  it("validates the stored settings", () => {
    const ok = providerSchemas.openrouter.safeParse({
      apiKey: "k",
      region: "eu",
      allowedProviders: [" google-vertex/europe "],
      zdr: true,
    });
    expect(ok.success && ok.data.allowedProviders).toEqual(["google-vertex/europe"]);
    expect(providerSchemas.openrouter.safeParse({ apiKey: "k", region: "mars" }).success).toBe(false);
  });
});
