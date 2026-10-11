import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, NoObjectGeneratedError, Output, type LanguageModelUsage } from "ai";
import { z } from "zod";

const { chatModelFromSettings } = await import("../lib/global/ai");
const { DEEPINFRA_BASE_URL, TENSORX_BASE_URL, OPENROUTER_BASE_URL, lmstudioBaseUrl } = await import(
  "../lib/global/providers"
);
const { getProviderSetting } = await import("../lib/db/provider-settings");
const { listUsers } = await import("../lib/db/users");
const { PROVIDER_TYPES } = await import("../lib/global/schema");
type ProviderType = (typeof PROVIDER_TYPES)[number];
type ProviderSettingsValue = import("../lib/global/schema").ProviderSettingsValue;

// Benchmark for a device's perception step: runs camera frames through candidate vision
// models and records, per call, whether the caption matched the schema, the latency, the
// tokens and the cost. Frames run in name order and each call gets the model's previous
// caption, the way a perception worker would chain them.
//
//   npm run vision-bench -- --user <username> \
//     --model anthropic:claude-haiku-5-5 --model google:gemini-3.1-flash-lite \
//     --model openai:gpt-6-luna frames/*.jpg
//
// Credentials come from the user's saved provider settings (Settings → Models). Without
// --user they come from env: ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY,
// OPENAI_API_KEY, OPENROUTER_API_KEY, DEEPINFRA_API_KEY, TENSORX_API_KEY, and LMSTUDIO_URL
// (default http://localhost:1234) for LM Studio. Writes the full results as JSON (--out)
// and prints a summary per model.

const captionSchema = z.object({
  summary: z.string().describe("One or two sentences about the scene"),
  changes: z
    .string()
    .describe('What changed since the previous description; "none" if nothing relevant changed'),
  entities: z.array(
    z.object({
      kind: z.enum(["person", "animal", "vehicle", "object"]),
      description: z.string(),
      isNew: z.boolean(),
    })
  ),
  salience: z.number().min(0).max(1),
  wake: z.enum(["none", "log", "agent"]),
  reason: z.string(),
});
type Caption = z.infer<typeof captionSchema>;

const INSTRUCTIONS = `You are the eyes of a small rover in a private garden. Each message brings one camera frame (a wide, lens-corrected view from close to the ground) and the description of the previous frame.

Describe what you see and what changed:
- summary: one or two sentences about the scene.
- changes: what changed since the previous description; "none" if nothing relevant changed, "first frame" if there is no previous description.
- entities: the people, animals, vehicles and notable objects in view, each with a short visual description, and isNew = true if it wasn't in the previous description.
- salience: 0 for nothing of interest (an empty garden, a change in light), up to 1 for something that needs attention now.
- wake: "none" if nothing relevant changed; "log" for a change worth a line in the day's log; "agent" when the rover's agent should decide whether to act (someone arrives or speaks to the rover, an animal is in the garden, something unusual or possibly unsafe).
- reason: one short sentence on why you chose that wake level.

Never say who a person is, even if you think you recognise them: describe people only by what is visible (clothes, posture, what they are doing). Names, when known, come from a separate face-recognition step.
Describe only what is in the frame; don't guess at what is outside it.`;

// $ per 1M tokens (input, output), checked on the providers' pricing pages on 2026-10-10.
// Matched by substring of the model id; unknown models report no cost.
const PRICES: Array<[string, number, number]> = [
  ["claude-haiku-5-5", 0.1, 0.5],
  ["claude-haiku-5.5@google-vertex/europe", 0.11, 0.55], // OpenRouter EU endpoint, checked 2026-10-11
  ["claude-haiku-5.5", 0.1, 0.5], // OpenRouter id
  ["gemini-3.1-flash-lite", 0.25, 1.5],
  ["gpt-6-luna", 0.1, 0.5],
  ["gemma-4-26b-a4b", 0.0675, 0.225], // OpenRouter, checked 2026-10-11
  ["qwen3.8-flash", 0.15, 0.47], // OpenRouter, checked 2026-10-11
  ["qwen3.8-27b", 0.04, 2.3], // OpenRouter, checked 2026-10-11
];

const ENV_KEYS: Partial<Record<ProviderType, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepinfra: "DEEPINFRA_API_KEY",
  tensorx: "TENSORX_API_KEY",
};

const { values: args, positionals: frames } = parseArgs({
  allowPositionals: true,
  options: {
    user: { type: "string" },
    model: { type: "string", multiple: true, default: [] },
    out: { type: "string", default: `vision-bench-${new Date().toISOString().replace(/[:.]/g, "-")}.json` },
    "gemini-media": { type: "string" }, // low | medium | high; the provider default when omitted
  },
});

if (frames.length === 0 || args.model.length === 0) {
  console.error("usage: npm run vision-bench -- [--user <username>] --model <provider>:<model> ... <frame.jpg> ...");
  process.exit(1);
}
frames.sort((a, b) => basename(a).localeCompare(basename(b)));

const userId = args.user
  ? (await listUsers()).find((u) => u.username === args.user)?.id
  : undefined;
if (args.user && !userId) {
  console.error(`No user named ${args.user}.`);
  process.exit(1);
}

async function resolveModel(spec: string) {
  const [provider, ...rest] = spec.split(":");
  // OpenRouter only: "<model>@<endpoint>" pins one endpoint (e.g. google-vertex/europe), no fallbacks.
  const [modelId, endpoint] = rest.join(":").split("@");
  if (!PROVIDER_TYPES.includes(provider as ProviderType) || !modelId) {
    throw new Error(`Bad --model ${spec}: expected <provider>:<model>, provider one of ${PROVIDER_TYPES.join(", ")}`);
  }
  const type = provider as ProviderType;
  let settings: ProviderSettingsValue | undefined;
  if (userId) {
    settings = (await getProviderSetting(userId, type))?.settings;
    if (!settings) throw new Error(`${args.user} has no ${type} provider configured`);
  } else if (type === "lmstudio") {
    settings = { url: process.env.LMSTUDIO_URL ?? "http://localhost:1234" };
  } else {
    const apiKey = process.env[ENV_KEYS[type]!];
    if (!apiKey) throw new Error(`${ENV_KEYS[type]} is not set`);
    settings = { apiKey };
  }
  let options = providerOptions(type, modelId);
  if (endpoint) {
    if (type !== "openrouter") throw new Error(`@endpoint only works with openrouter: ${spec}`);
    options = { openrouter: { ...options?.openrouter, provider: { only: [endpoint], allow_fallbacks: false } } };
  }
  return { spec, modelId, model: buildModel(type, settings, modelId), providerOptions: options };
}

// The OpenAI-compatible providers only send a JSON schema when the model is created with
// supportsStructuredOutputs; chatModelFromSettings doesn't set it (chat needs no schema), so
// without it the model would see "JSON mode" and no schema. Same setup as
// chatModelFromSettings otherwise.
const COMPATIBLE_BASE_URLS: Partial<Record<ProviderType, (s: ProviderSettingsValue) => string>> = {
  lmstudio: (s) => `${lmstudioBaseUrl(s.url ?? "http://localhost:1234")}/v1`,
  openrouter: () => OPENROUTER_BASE_URL,
  deepinfra: () => DEEPINFRA_BASE_URL,
  tensorx: () => TENSORX_BASE_URL,
};

function buildModel(type: ProviderType, settings: ProviderSettingsValue, modelId: string) {
  const baseURL = COMPATIBLE_BASE_URLS[type]?.(settings);
  if (!baseURL) return chatModelFromSettings(type, settings, modelId);
  return createOpenAICompatible({
    name: type,
    baseURL,
    apiKey: settings.apiKey ?? "lm-studio",
    includeUsage: true,
    supportsStructuredOutputs: true,
  }).chatModel(modelId);
}

// Captions want no reasoning: it adds latency and output tokens for no gain here.
function providerOptions(provider: ProviderType, modelId: string) {
  if (provider === "openai" && /^gpt-[56]/.test(modelId)) {
    // @ai-sdk/openai 3.0.68 doesn't recognise gpt-6 ids as reasoning models;
    // forceReasoning gets it the developer role and reasoning_effort.
    return { openai: { forceReasoning: true, reasoningEffort: "none" } };
  }
  if (provider === "openrouter") {
    // OpenRouter's unified switch; openai-compatible passes unknown options into the body.
    // Claude doesn't reason unless asked; Gemini 3 maps effort to its thinking level.
    if (/gemini-3/.test(modelId)) return { openrouter: { reasoning: { effort: "minimal" } } };
    if (/gpt-[56]|gemma|qwen/.test(modelId)) return { openrouter: { reasoning: { effort: "none" } } };
    return undefined;
  }
  if (provider === "google") {
    const media = args["gemini-media"];
    return {
      google: {
        ...(/gemini-3/.test(modelId) && { thinkingConfig: { thinkingLevel: "minimal" } }),
        ...(media && { mediaResolution: `MEDIA_RESOLUTION_${media.toUpperCase()}` }),
      },
    };
  }
  return undefined;
}

type Call = {
  model: string;
  frame: string;
  ok: boolean;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cost?: number;
  responseId?: string;
  caption?: Caption;
  error?: string;
  rawText?: string;
};

function cost(modelId: string, usage: LanguageModelUsage | undefined) {
  const price = PRICES.find(([id]) => modelId.includes(id));
  if (!price || usage?.inputTokens == null || usage.outputTokens == null) return undefined;
  return (usage.inputTokens * price[1] + usage.outputTokens * price[2]) / 1e6;
}

async function runModel(target: Awaited<ReturnType<typeof resolveModel>>): Promise<Call[]> {
  const calls: Call[] = [];
  let previous: Caption | undefined;
  for (const frame of frames) {
    const image = await readFile(frame);
    const started = performance.now();
    const call: Call = { model: target.spec, frame: basename(frame), ok: false, ms: 0 };
    let usage: LanguageModelUsage | undefined;
    try {
      const result = await generateText({
        model: target.model,
        system: INSTRUCTIONS,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: previous
                  ? `Previous description:\n${JSON.stringify(previous)}`
                  : "No previous description: this is the first frame.",
              },
              { type: "image", image, mediaType: "image/jpeg" },
            ],
          },
        ],
        output: Output.object({ schema: captionSchema }),
        providerOptions: target.providerOptions,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(120_000),
      });
      usage = result.usage;
      call.responseId = result.response.id;
      call.caption = result.output;
      call.ok = true;
      previous = result.output;
    } catch (error) {
      if (NoObjectGeneratedError.isInstance(error)) {
        usage = error.usage;
        call.rawText = error.text;
      }
      call.error = error instanceof Error ? error.message : String(error);
    }
    call.ms = Math.round(performance.now() - started);
    call.inputTokens = usage?.inputTokens;
    call.outputTokens = usage?.outputTokens;
    call.reasoningTokens = usage?.outputTokenDetails?.reasoningTokens;
    call.cost = cost(target.spec, usage); // the spec carries an @endpoint, which can change the price
    calls.push(call);
    const what = call.ok ? `${call.caption!.wake.padEnd(5)} ${call.caption!.summary}` : `FAILED ${call.error}`;
    console.log(
      `${target.spec}  ${call.frame}  ${call.ms} ms  ${call.inputTokens ?? "?"}/${call.outputTokens ?? "?"} tok  ${what}`
    );
  }
  return calls;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

const targets = await Promise.all(args.model.map(resolveModel));
const results = (await Promise.all(targets.map(runModel))).flat();
await writeFile(args.out, JSON.stringify({ frames, results }, null, 2));

console.log(`\n| Model | Schema OK | Median latency | Input tokens (mean) | Output tokens (mean) | $ per 1,000 frames |`);
console.log(`|---|---|---|---|---|---|`);
for (const target of targets) {
  const calls = results.filter((c) => c.model === target.spec);
  const ok = calls.filter((c) => c.ok);
  const num = (key: "inputTokens" | "outputTokens" | "cost") =>
    calls.map((c) => c[key]).filter((v): v is number => v != null);
  const costs = num("cost");
  console.log(
    `| ${target.spec} | ${ok.length}/${calls.length} | ${(median(calls.map((c) => c.ms)) / 1000).toFixed(1)} s | ` +
      `${Math.round(mean(num("inputTokens")))} | ${Math.round(mean(num("outputTokens")))} | ` +
      `${costs.length ? (mean(costs) * 1000).toFixed(2) : "n/a"} |`
  );
}
console.log(`\nFull results: ${args.out}`);
process.exit(0);
