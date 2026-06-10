import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { AutoModel, AutoTokenizer, env as transformersEnv, type PreTrainedModel, type PreTrainedTokenizer } from "@huggingface/transformers";
import { streamText } from "ai";

// Default cache lives inside node_modules — ephemeral in a container, so the
// model would re-download on every recreation. Deployments point this at a
// mounted volume.
if (process.env.TRANSFORMERS_CACHE) transformersEnv.cacheDir = process.env.TRANSFORMERS_CACHE;
import { lmstudioBaseUrl } from "./providers";
import type { ProviderSettingsValue, ProviderType } from "./schema";

export const lmstudio = createOpenAI({
    baseURL: "http://localhost:1234/v1",
    apiKey: "lm-studio",
});

// Chat goes through the openai-compatible provider because it parses LM Studio's
// separate `reasoning_content` field into reasoning parts; @ai-sdk/openai drops it.
export const lmstudioChat = createOpenAICompatible({
    name: "lmstudio",
    baseURL: "http://localhost:1234/v1",
    apiKey: "lm-studio",
    // Ask for stream_options.include_usage so streamed steps carry token usage
    // (the conversation route forwards it to the UI's context bar as metadata).
    includeUsage: true,
});

/** The env-configured LM Studio model — used when no provider is selected in the UI. */
export function defaultChatModel() {
    return lmstudioChat.chatModel(process.env.CHAT_MODEL ?? "google/gemma-4-e4b");
}

/**
 * Builds a chat model from a user's saved provider settings (provider_settings
 * table, validated shapes in lib/global/providers.ts).
 */
export function chatModelFromSettings(
    provider: ProviderType,
    settings: ProviderSettingsValue,
    modelId: string
) {
    if (provider === "anthropic") {
        return createAnthropic({ apiKey: settings.apiKey })(modelId);
    }
    // Same openai-compatible setup as the default provider (reasoning_content
    // parsing + streamed usage), pointed at the user's LM Studio URL.
    return createOpenAICompatible({
        name: "lmstudio",
        baseURL: `${lmstudioBaseUrl(settings.url ?? "http://localhost:1234")}/v1`,
        apiKey: settings.apiKey ?? "lm-studio",
        includeUsage: true,
    }).chatModel(modelId);
}

// Embeddings run in-process (ONNX on CPU via transformers.js) so memory works
// without LM Studio. Output dimensions must match the vector column in
// lib/global/schema.ts (768). EmbeddingGemma does not support fp16; q8 keeps
// the model under ~350MB resident for ~0.3-1.0 MTEB points vs fp32.
const EMBEDDING_MODEL_ID =
    process.env.EMBEDDING_MODEL ?? "onnx-community/embeddinggemma-300m-ONNX";
const EMBEDDING_DTYPE = (process.env.EMBEDDING_DTYPE ?? "q8") as "fp32" | "q8" | "q4";

// EmbeddingGemma is trained with task prompts: stored facts must be embedded as
// documents and search text as queries, or retrieval quality degrades. The
// prefixes are applied here so call sites only declare which side they are.
const EMBEDDING_PREFIXES = {
    query: "task: search result | query: ",
    document: "title: none | text: ",
} as const;
export type EmbeddingKind = keyof typeof EMBEDDING_PREFIXES;

type Embedder = { tokenizer: PreTrainedTokenizer; model: PreTrainedModel };
let embedder: Promise<Embedder> | undefined;

// Lazy singleton: the first call downloads (once) and loads the model. A failed
// load is not cached so a transient network error doesn't wedge the server.
function loadEmbedder(): Promise<Embedder> {
    embedder ??= Promise.all([
        AutoTokenizer.from_pretrained(EMBEDDING_MODEL_ID),
        AutoModel.from_pretrained(EMBEDDING_MODEL_ID, { dtype: EMBEDDING_DTYPE }),
    ]).then(
        ([tokenizer, model]) => ({ tokenizer, model }),
        (error) => {
            embedder = undefined;
            throw error;
        }
    );
    return embedder;
}

/**
 * Fire-and-forget warm-up so the first conversation turn doesn't pay the model
 * load (and, on first run, the ~300MB download). Failure is non-fatal: routes
 * that don't embed keep working, and the next embedText retries the load.
 */
export function preloadEmbedder(): void {
    loadEmbedder().catch((error) => {
        console.warn(`[ai] embedding model preload failed (will retry on use): ${error}`);
    });
}

export async function embedText(value: string, kind: EmbeddingKind): Promise<number[]> {
    const { tokenizer, model } = await loadEmbedder();
    const inputs = tokenizer([EMBEDDING_PREFIXES[kind] + value], { padding: true });
    // The ONNX export pools and normalizes internally (sentence_embedding head).
    const { sentence_embedding } = await model(inputs);
    return sentence_embedding.tolist()[0];
}

const prompt = (prompt: string) => streamText({
    model: lmstudio("your-model-id"),
    prompt: prompt as string,
});