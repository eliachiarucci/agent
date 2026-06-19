import { z } from "zod";
import type { ProviderType } from "./schema";

export { PROVIDER_TYPES, type ProviderType } from "./schema";

// Per-provider settings shapes. Stored as JSONB (lib/global/schema.ts) and
// validated here at the API boundary, so each provider can carry exactly the
// fields it needs.
export const providerSchemas = {
  lmstudio: z.object({
    url: z.url({ protocol: /^https?$/ }),
    // LM Studio only checks the key when the server is started with auth enabled.
    apiKey: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  }),
  anthropic: z.object({
    // A Console API key (sk-ant-api...). Claude Code "setup tokens" are OAuth
    // credentials and are rejected by the API for x-api-key auth.
    apiKey: z.string().min(1),
    model: z.string().min(1).optional(),
  }),
  google: z.object({
    // A Gemini API key (AIza...) from Google AI Studio (aistudio.google.com).
    apiKey: z.string().min(1),
    model: z.string().min(1).optional(),
  }),
  deepinfra: z.object({
    // An API key from the DeepInfra dashboard (deepinfra.com/dash/api_keys).
    apiKey: z.string().min(1),
    model: z.string().min(1).optional(),
  }),
  tensorx: z.object({
    // An API key from the TensorX dashboard (tensorx.ai).
    apiKey: z.string().min(1),
    model: z.string().min(1).optional(),
  }),
  openrouter: z.object({
    // An API key from the OpenRouter dashboard (openrouter.ai/keys).
    apiKey: z.string().min(1),
    model: z.string().min(1).optional(),
  }),
  openai: z.object({
    // A secret API key (sk-...) from platform.openai.com/api-keys.
    apiKey: z.string().min(1),
    model: z.string().min(1).optional(),
  }),
} satisfies Record<ProviderType, z.ZodType>;

export type LmStudioSettings = z.infer<(typeof providerSchemas)["lmstudio"]>;
export type AnthropicSettings = z.infer<(typeof providerSchemas)["anthropic"]>;
export type GoogleSettings = z.infer<(typeof providerSchemas)["google"]>;
export type DeepInfraSettings = z.infer<(typeof providerSchemas)["deepinfra"]>;
export type TensorXSettings = z.infer<(typeof providerSchemas)["tensorx"]>;
export type OpenRouterSettings = z.infer<(typeof providerSchemas)["openrouter"]>;
export type OpenAISettings = z.infer<(typeof providerSchemas)["openai"]>;

export type ProviderTestResult =
  | { ok: true; models: string[] }
  | { ok: false; error: string };

const TEST_TIMEOUT_MS = 8000;

// Accepts the base URL with or without a trailing slash or `/v1`.
export function lmstudioBaseUrl(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

async function testLmStudio(settings: LmStudioSettings): Promise<ProviderTestResult> {
  const endpoint = `${lmstudioBaseUrl(settings.url)}/v1/models`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      headers: settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : undefined,
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch {
    return {
      ok: false,
      error: `Could not reach LM Studio at ${endpoint}. Is the server running?`,
    };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: "LM Studio rejected the API key." };
  }
  if (!res.ok) {
    return { ok: false, error: `LM Studio responded with HTTP ${res.status}.` };
  }
  const models = await parseModelIds(res);
  if (!models) {
    return { ok: false, error: "Unexpected response from LM Studio — is this a /v1 OpenAI-compatible endpoint?" };
  }
  return { ok: true, models };
}

async function testAnthropic(settings: AnthropicSettings): Promise<ProviderTestResult> {
  if (settings.apiKey.startsWith("sk-ant-oat")) {
    return {
      ok: false,
      error:
        "This looks like an OAuth/setup token. Create an API key (sk-ant-api...) in the Anthropic Console instead.",
    };
  }
  let res: Response;
  try {
    // Listing models authenticates the key without spending any tokens.
    res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "Could not reach the Anthropic API. Check your network connection." };
  }
  if (res.status === 401) {
    return { ok: false, error: "Anthropic rejected the API key. Check it in the Anthropic Console." };
  }
  if (!res.ok) {
    return { ok: false, error: `Anthropic API responded with HTTP ${res.status}.` };
  }
  const models = await parseModelIds(res);
  if (!models) {
    return { ok: false, error: "Unexpected response from the Anthropic API." };
  }
  return { ok: true, models };
}

async function testGoogle(settings: GoogleSettings): Promise<ProviderTestResult> {
  let res: Response;
  try {
    // Listing models authenticates the key without spending any tokens.
    res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
      headers: { "x-goog-api-key": settings.apiKey },
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "Could not reach the Gemini API. Check your network connection." };
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    return { ok: false, error: "Google rejected the API key. Create one in Google AI Studio (aistudio.google.com)." };
  }
  if (!res.ok) {
    return { ok: false, error: `Gemini API responded with HTTP ${res.status}.` };
  }
  const models = await parseGoogleModelIds(res);
  if (!models) {
    return { ok: false, error: "Unexpected response from the Gemini API." };
  }
  return { ok: true, models };
}

// OpenAI-compatible endpoint; chat (lib/global/ai.ts) and the model listing both
// hang off this base.
export const DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai";

// The OpenAI-compatible /models listing still includes recently-deprecated
// models (e.g. google/gemini-1.5-flash). DeepInfra's native catalog carries a
// `deprecated` timestamp per model, keyed by the same id, so we use it to drop
// dead models from the picker.
const DEEPINFRA_MODELS_LIST_URL = "https://api.deepinfra.com/models/list";

async function testDeepInfra(settings: DeepInfraSettings): Promise<ProviderTestResult> {
  let res: Response;
  try {
    // The listing is public, but DeepInfra still 401s on an *invalid* Bearer
    // token — so sending the key both lists models and verifies it, free.
    res = await fetch(`${DEEPINFRA_BASE_URL}/models`, {
      headers: { authorization: `Bearer ${settings.apiKey}` },
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "Could not reach the DeepInfra API. Check your network connection." };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: "DeepInfra rejected the API key. Create one at deepinfra.com/dash/api_keys." };
  }
  if (!res.ok) {
    return { ok: false, error: `DeepInfra API responded with HTTP ${res.status}.` };
  }
  const models = await parseDeepInfraModelIds(res);
  if (!models) {
    return { ok: false, error: "Unexpected response from the DeepInfra API." };
  }
  // Drop models DeepInfra has deprecated but still surfaces on the OpenAI listing.
  const deprecated = await deepinfraDeprecatedModels();
  return { ok: true, models: models.filter((id) => !deprecated.has(id)) };
}

// Ids DeepInfra has marked deprecated (non-null `deprecated` epoch) in its
// native catalog. Public endpoint, no key needed; on any failure we fail open
// (empty set) so the picker still lists everything rather than breaking.
async function deepinfraDeprecatedModels(): Promise<Set<string>> {
  try {
    const res = await fetch(DEEPINFRA_MODELS_LIST_URL, {
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    if (!res.ok) return new Set();
    const body = (await res.json()) as Array<{ model_name?: unknown; deprecated?: unknown }>;
    if (!Array.isArray(body)) return new Set();
    return new Set(
      body
        .filter((m) => m.deprecated != null)
        .map((m) => m.model_name)
        .filter((name): name is string => typeof name === "string")
    );
  } catch {
    return new Set();
  }
}

// OpenAI-compatible endpoint; chat (lib/global/ai.ts) and the model listing both
// hang off this base.
export const TENSORX_BASE_URL = "https://api.tensorx.ai/v1";

async function testTensorX(settings: TensorXSettings): Promise<ProviderTestResult> {
  let res: Response;
  try {
    // Listing models authenticates the key without spending any tokens.
    res = await fetch(`${TENSORX_BASE_URL}/models`, {
      headers: { authorization: `Bearer ${settings.apiKey}` },
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "Could not reach the TensorX API. Check your network connection." };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: "TensorX rejected the API key. Create one in the TensorX dashboard (tensorx.ai)." };
  }
  if (!res.ok) {
    return { ok: false, error: `TensorX API responded with HTTP ${res.status}.` };
  }
  // TensorX's listing is the standard OpenAI shape ({ data: [{ id }] }).
  const models = await parseModelIds(res);
  if (!models) {
    return { ok: false, error: "Unexpected response from the TensorX API." };
  }
  return { ok: true, models };
}

// First-party OpenAI API. Chat goes through @ai-sdk/openai (lib/global/ai.ts);
// this base is only used here to verify the key and list models.
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

async function testOpenAI(settings: OpenAISettings): Promise<ProviderTestResult> {
  let res: Response;
  try {
    // Listing models requires the key, so it both verifies and lists, free.
    res = await fetch(`${OPENAI_BASE_URL}/models`, {
      headers: { authorization: `Bearer ${settings.apiKey}` },
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "Could not reach the OpenAI API. Check your network connection." };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: "OpenAI rejected the API key. Create one at platform.openai.com/api-keys." };
  }
  if (!res.ok) {
    return { ok: false, error: `OpenAI API responded with HTTP ${res.status}.` };
  }
  const models = await parseOpenAIModelIds(res);
  if (!models) {
    return { ok: false, error: "Unexpected response from the OpenAI API." };
  }
  return { ok: true, models };
}

// OpenAI's /models listing is the standard OpenAI shape ({ data: [{ id }] }) but
// carries no capability metadata and mixes in non-chat models (embeddings,
// image, audio, moderation, legacy completions). With no tag to filter on, we
// exclude those families by id so the picker only offers chat-capable models.
const OPENAI_NON_CHAT = /embedding|tts|whisper|dall-e|moderation|image|audio|realtime|transcribe|^(?:davinci|babbage)/i;

async function parseOpenAIModelIds(res: Response): Promise<string[] | undefined> {
  try {
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(body.data)) return undefined;
    return body.data
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string")
      .filter((id) => !OPENAI_NON_CHAT.test(id));
  } catch {
    return undefined;
  }
}

// OpenAI-compatible aggregator; chat (lib/global/ai.ts), the model listing, and
// the context-window lookup all hang off this base.
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

async function testOpenRouter(settings: OpenRouterSettings): Promise<ProviderTestResult> {
  let keyRes: Response;
  try {
    // /models is public and ignores the key, so verify the key against /key
    // (which 401s on a bad token) before listing.
    keyRes = await fetch(`${OPENROUTER_BASE_URL}/key`, {
      headers: { authorization: `Bearer ${settings.apiKey}` },
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "Could not reach the OpenRouter API. Check your network connection." };
  }
  if (keyRes.status === 401 || keyRes.status === 403) {
    return { ok: false, error: "OpenRouter rejected the API key. Create one at openrouter.ai/keys." };
  }
  if (!keyRes.ok) {
    return { ok: false, error: `OpenRouter API responded with HTTP ${keyRes.status}.` };
  }

  let modelsRes: Response;
  try {
    modelsRes = await fetch(`${OPENROUTER_BASE_URL}/models`, {
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "Could not reach the OpenRouter API. Check your network connection." };
  }
  if (!modelsRes.ok) {
    return { ok: false, error: `OpenRouter API responded with HTTP ${modelsRes.status}.` };
  }
  const models = await parseOpenRouterModelIds(modelsRes);
  if (!models) {
    return { ok: false, error: "Unexpected response from the OpenRouter API." };
  }
  return { ok: true, models };
}

// OpenRouter lists its full catalog at /models; architecture.output_modalities
// says what each model emits, so we keep only text-producing (chat/VLM) models
// and drop pure image/audio/video generators.
async function parseOpenRouterModelIds(res: Response): Promise<string[] | undefined> {
  try {
    const body = (await res.json()) as {
      data?: Array<{ id?: unknown; architecture?: { output_modalities?: unknown } }>;
    };
    if (!Array.isArray(body.data)) return undefined;
    return body.data
      .filter((m) => {
        const out = m.architecture?.output_modalities;
        return !Array.isArray(out) || out.includes("text");
      })
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
  } catch {
    return undefined;
  }
}

// DeepInfra's listing is OpenAI-shaped but spans every modality it hosts
// (embeddings, TTS, image-gen, ...); metadata.tags marks the chat models.
async function parseDeepInfraModelIds(res: Response): Promise<string[] | undefined> {
  try {
    const body = (await res.json()) as {
      data?: Array<{ id?: unknown; metadata?: { tags?: unknown } }>;
    };
    if (!Array.isArray(body.data)) return undefined;
    return body.data
      .filter((m) => !Array.isArray(m.metadata?.tags) || m.metadata.tags.includes("chat"))
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
  } catch {
    return undefined;
  }
}

// Gemini lists models as { models: [{ name: "models/<id>", ... }] } and mixes in
// embedding/TTS models — only chat-capable ones belong in the model picker.
async function parseGoogleModelIds(res: Response): Promise<string[] | undefined> {
  try {
    const body = (await res.json()) as {
      models?: Array<{ name?: unknown; supportedGenerationMethods?: unknown }>;
    };
    if (!Array.isArray(body.models)) return undefined;
    return body.models
      .filter(
        (m) =>
          !Array.isArray(m.supportedGenerationMethods) ||
          m.supportedGenerationMethods.includes("generateContent")
      )
      .map((m) => m.name)
      .filter((name): name is string => typeof name === "string")
      .map((name) => name.replace(/^models\//, ""));
  } catch {
    return undefined;
  }
}

// LM Studio and Anthropic both list models as { data: [{ id }] }.
async function parseModelIds(res: Response): Promise<string[] | undefined> {
  try {
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(body.data)) return undefined;
    return body.data
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
  } catch {
    return undefined;
  }
}

/** Runs a cheap authenticated request against the provider to verify the settings. */
export async function testProvider(
  provider: ProviderType,
  settings:
    | LmStudioSettings
    | AnthropicSettings
    | GoogleSettings
    | DeepInfraSettings
    | TensorXSettings
    | OpenRouterSettings
    | OpenAISettings
): Promise<ProviderTestResult> {
  switch (provider) {
    case "lmstudio":
      return testLmStudio(settings as LmStudioSettings);
    case "anthropic":
      return testAnthropic(settings as AnthropicSettings);
    case "google":
      return testGoogle(settings as GoogleSettings);
    case "deepinfra":
      return testDeepInfra(settings as DeepInfraSettings);
    case "tensorx":
      return testTensorX(settings as TensorXSettings);
    case "openrouter":
      return testOpenRouter(settings as OpenRouterSettings);
    case "openai":
      return testOpenAI(settings as OpenAISettings);
  }
}
