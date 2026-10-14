import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import type { LanguageModelUsage } from "ai";

const { captionFrame } = await import("../lib/devices/caption");
type Caption = import("../lib/devices/caption").Caption;
const { buildPerceptionModel, perceptionProviderOptions } = await import("../lib/devices/perception-model");
const { getProviderSetting } = await import("../lib/db/provider-settings");
const { listUsers } = await import("../lib/db/users");
const { PROVIDER_TYPES } = await import("../lib/global/schema");
type ProviderType = (typeof PROVIDER_TYPES)[number];
type ProviderSettingsValue = import("../lib/global/schema").ProviderSettingsValue;

// Benchmark for a device's perception step: runs camera frames through candidate vision
// models and records, per call, whether the caption matched the schema, the latency, the
// tokens and the cost. Frames run in name order and each call gets the model's previous
// caption, the way the perception worker chains them. The prompt, schema and model setup
// are the worker's own (lib/devices/caption.ts, lib/devices/perception-model.ts).
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
  if (endpoint && type !== "openrouter") throw new Error(`@endpoint only works with openrouter: ${spec}`);
  return {
    spec,
    provider: type,
    modelId,
    // The endpoint pin travels in the model id, as in the device settings.
    model: buildPerceptionModel(type, settings, endpoint ? `${modelId}@${endpoint}` : modelId),
    providerOptions: providerOptions(type, modelId),
  };
}

// The worker's options, plus the bench's own Gemini media-resolution switch.
function providerOptions(type: ProviderType, modelId: string) {
  const options = perceptionProviderOptions(type, modelId);
  const media = args["gemini-media"];
  if (type !== "google" || !media) return options;
  return { google: { ...options?.google, mediaResolution: `MEDIA_RESOLUTION_${media.toUpperCase()}` } };
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
    const result = await captionFrame({ target, image, previous: previous ?? null, timeoutMs: 120_000 });
    usage = result.usage;
    if (result.ok) {
      call.responseId = result.responseId;
      call.caption = result.caption;
      call.ok = true;
      previous = result.caption;
    } else {
      call.error = result.error;
      call.rawText = result.rawText;
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
