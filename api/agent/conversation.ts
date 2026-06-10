import express from 'express';
import {
    convertToModelMessages,
    extractReasoningMiddleware,
    stepCountIs,
    streamText,
    wrapLanguageModel,
    type UIMessage,
} from "ai";
import { z } from "zod";
import { lmstudioChat } from "../../lib/global/ai";
import { createMessage, deleteMessage, findMessage, findMessages, updateMessage } from "../../lib/db/conversations";
import { buildMemorySystemPrompt, buildRelevantMemoriesBlock, memoryTools } from "../../lib/agent/memory";
import { searchTools, webSearchPrompt } from "../../lib/agent/search";
import { loadSystemPrompt } from "../../lib/agent/system-prompt";
import type { StoredMessage } from "../../lib/global/schema";

function toUIMessages(stored: StoredMessage[]): UIMessage[] {
    return stored.map((m, i) =>
        "parts" in m
            ? m
            : { id: `legacy-${i}`, role: m.role, parts: [{ type: "text", text: m.content }] }
    );
}

// Recent turns plus the new message, so follow-ups like "what about her birthday?"
// embed with enough context to retrieve anything. Injected <relevant-memories>
// blocks are excluded to avoid retrieval feeding on its own previous output.
function buildRetrievalQuery(history: UIMessage[], message: string): string {
    const recent = history.slice(-4).flatMap((m) =>
        m.parts.flatMap((p) =>
            p.type === "text" && !p.text.startsWith("<relevant-memories>") ? [p.text] : []
        )
    );
    return [...recent, message].join("\n").slice(-2000);
}

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'POST, OPTIONS');
    res.sendStatus(204);
}

const bodySchema = z.object({
    message: z.string().min(1),
    conversation_id: z.uuid().optional(),
});

export const POST: express.RequestHandler = async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const { message, conversation_id } = parsed.data;

    // Create-if-missing: the client generates the UUID for new conversations so it
    // can keep streaming to the same id before the row exists.
    const existing = conversation_id !== undefined ? await findMessage(conversation_id) : undefined;
    const history: UIMessage[] = existing ? toUIMessages(existing.messages ?? []) : [];

    // Retrieved memories ride along with the user message instead of the system
    // prompt: everything before this point in the prompt is then byte-identical to
    // the previous request, so the server's KV cache stays valid across turns.
    const [basePrompt, memoriesBlock, memorySystemPrompt] = await Promise.all([
        loadSystemPrompt(),
        buildRelevantMemoriesBlock(buildRetrievalQuery(history, message)),
        buildMemorySystemPrompt(),
    ]);

    history.push({
        id: crypto.randomUUID(),
        role: "user",
        parts: [
            ...(memoriesBlock ? [{ type: "text" as const, text: memoriesBlock }] : []),
            { type: "text", text: message },
        ],
    });

    const system = [basePrompt, memorySystemPrompt, webSearchPrompt]
        .filter(Boolean)
        .join("\n\n");
    const tools = { ...memoryTools, ...searchTools };

    const result = streamText({
        model: wrapLanguageModel({
            model: lmstudioChat.chatModel(process.env.CHAT_MODEL ?? "google/gemma-4-e4b"),
            // Catches models that emit reasoning inline as <think> tags instead of reasoning_content.
            middleware: extractReasoningMiddleware({ tagName: "think" }),
        }),
        system,
        messages: await convertToModelMessages(history, { tools, ignoreIncompleteToolCalls: true }),
        tools,
        // Search → read → answer flows need more steps than memory-only turns.
        stopWhen: stepCountIs(8),
    });

    result.pipeUIMessageStreamToResponse(res, {
        originalMessages: history,
        sendReasoning: true,
        generateMessageId: () => crypto.randomUUID(),
        // Each step's usage covers the full prompt (system + history + tools) of
        // that request, so the last finish-step is the current context size. The
        // UI reads it live from message metadata and it persists via onFinish.
        messageMetadata: ({ part }) =>
            part.type === "finish-step"
                ? {
                      usage: {
                          inputTokens: part.usage.inputTokens,
                          outputTokens: part.usage.outputTokens,
                          totalTokens: part.usage.totalTokens,
                      },
                  }
                : undefined,
        onError: (error) => (error instanceof Error ? error.message : "An error occurred."),
        onFinish: async ({ messages }) => {
            if (existing) {
                await updateMessage(existing.id, { messages });
            } else {
                await createMessage({ id: conversation_id, messages });
            }
        },
    });
}

const querySchema = z.object({
    id: z.union([z.uuid(), z.array(z.uuid())]).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
});

export const GET: express.RequestHandler = async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const conversations = await findMessages(parsed.data);
    res.json(conversations);
}

export const DELETE: express.RequestHandler = async (req, res) => {
    const parsed = z.object({ id: z.uuid() }).safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const deleted = await deleteMessage(parsed.data.id);
    if (!deleted) {
        res.status(404).json({ error: "Conversation not found" });
        return;
    }

    res.status(204).end();
}
