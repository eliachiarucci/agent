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
} satisfies Record<ProviderType, z.ZodType>;

export type LmStudioSettings = z.infer<(typeof providerSchemas)["lmstudio"]>;
export type AnthropicSettings = z.infer<(typeof providerSchemas)["anthropic"]>;
export type GoogleSettings = z.infer<(typeof providerSchemas)["google"]>;
export type DeepInfraSettings = z.infer<(typeof providerSchemas)["deepinfra"]>;

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
  return { ok: true, models };
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
  settings: LmStudioSettings | AnthropicSettings | GoogleSettings | DeepInfraSettings
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
  }
}
