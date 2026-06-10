import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { embed, streamText } from "ai";

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

// Output dimensions must match the vector column in lib/global/schema.ts (768).
const embeddingModel = lmstudio.embeddingModel(
    process.env.EMBEDDING_MODEL ?? "text-embedding-nomic-embed-text-v1.5"
);

export async function embedText(value: string): Promise<number[]> {
    const { embedding } = await embed({ model: embeddingModel, value });
    return embedding;
}

const prompt = (prompt: string) => streamText({
    model: lmstudio("your-model-id"),
    prompt: prompt as string,
});