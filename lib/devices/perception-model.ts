import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { chatModelFromSettings } from "../global/ai";
import { DEEPINFRA_BASE_URL, OPENROUTER_BASE_URL, TENSORX_BASE_URL, lmstudioBaseUrl } from "../global/providers";
import type { ProviderSettingsValue, ProviderType } from "../global/schema";
import { getProviderSetting } from "../db/provider-settings";
import { resolveDefaultModelTarget } from "../agent/default-model";
import type { DeviceSettings } from "./settings";

// The model a device's captions run on: the device's perception setting,
// resolved against the owner's provider credentials like the memory model, and
// the owner's default model when that isn't set (plan 4.4).

type ProviderOptions = Record<string, Record<string, any>>;

export type PerceptionTarget = {
  provider: ProviderType;
  modelId: string;
  model: LanguageModel;
  providerOptions?: ProviderOptions;
};

export type OpenRouterRoute = { only: string[]; allowFallbacks: boolean };

// The OpenAI-compatible providers send the caption's JSON schema only when the
// model is built with supportsStructuredOutputs (plan D19); chatModelFromSettings
// doesn't set it (chat needs no schema), so these are built here, otherwise the
// same way.
const COMPATIBLE_BASE_URLS: Partial<Record<ProviderType, (s: ProviderSettingsValue) => string>> = {
  lmstudio: (s) => `${lmstudioBaseUrl(s.url ?? "http://localhost:1234")}/v1`,
  openrouter: () => OPENROUTER_BASE_URL,
  deepinfra: () => DEEPINFRA_BASE_URL,
  tensorx: () => TENSORX_BASE_URL,
};

export function buildPerceptionModel(
  provider: ProviderType,
  settings: ProviderSettingsValue,
  modelId: string
): LanguageModel {
  const baseURL = COMPATIBLE_BASE_URLS[provider]?.(settings);
  if (!baseURL) return chatModelFromSettings(provider, settings, modelId);
  return createOpenAICompatible({
    name: provider,
    baseURL,
    apiKey: settings.apiKey ?? "lm-studio",
    includeUsage: true,
    supportsStructuredOutputs: true,
  }).chatModel(modelId);
}

// Captions want no reasoning: it adds latency and output tokens for no gain
// (P0: 0 reasoning tokens with these settings on every model tried). An
// OpenRouter route pins the endpoints that may serve the call (plan D20).
export function perceptionProviderOptions(
  provider: ProviderType,
  modelId: string,
  route?: OpenRouterRoute | null
): ProviderOptions | undefined {
  if (provider === "openai" && /^gpt-[56]/.test(modelId)) {
    // @ai-sdk/openai 3.0.68 doesn't recognise gpt-6 ids as reasoning models;
    // forceReasoning gets it the developer role and reasoning_effort.
    return { openai: { forceReasoning: true, reasoningEffort: "none" } };
  }
  if (provider === "openrouter") {
    // OpenRouter's unified switch; openai-compatible passes unknown options into
    // the body. Claude doesn't reason unless asked; Gemini 3 maps effort to its
    // thinking level.
    const options: Record<string, unknown> = {};
    if (/gemini-3/.test(modelId)) options.reasoning = { effort: "minimal" };
    else if (/gpt-[56]|gemma|qwen/.test(modelId)) options.reasoning = { effort: "none" };
    if (route) options.provider = { only: route.only, allow_fallbacks: route.allowFallbacks };
    return Object.keys(options).length ? { openrouter: options } : undefined;
  }
  if (provider === "google" && /gemini-3/.test(modelId)) {
    return { google: { thinkingConfig: { thinkingLevel: "minimal" } } };
  }
  return undefined;
}

export async function resolvePerceptionTarget(
  ownerId: string,
  perception: DeviceSettings["perception"]
): Promise<PerceptionTarget | null> {
  let target: { provider: ProviderType; settings: ProviderSettingsValue; model: string } | null = null;
  if (perception.provider) {
    const setting = await getProviderSetting(ownerId, perception.provider);
    const modelId = perception.model ?? setting?.settings.model;
    if (setting && modelId) target = { provider: perception.provider, settings: setting.settings, model: modelId };
  }
  target ??= await resolveDefaultModelTarget(ownerId);
  if (!target) return null;
  // The route belongs to the configured provider; a fallback to the default model doesn't inherit it.
  const route = target.provider === perception.provider ? perception.route : null;
  return {
    provider: target.provider,
    modelId: target.model,
    model: buildPerceptionModel(target.provider, target.settings, target.model),
    providerOptions: perceptionProviderOptions(target.provider, target.model, route),
  };
}
