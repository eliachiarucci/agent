import express from 'express';
import {
    consumeStream,
    convertToModelMessages,
    extractReasoningMiddleware,
    stepCountIs,
    streamText,
    wrapLanguageModel,
    type UIMessage,
} from "ai";
import { z } from "zod";
import { lmstudioChat } from "../../lib/global/ai";
import {
    canAccessConversation,
    createMessage,
    deleteMessage,
    findMessage,
    findMessages,
    updateMessage,
} from "../../lib/db/conversations";
import { getSessionUser } from "../../lib/agent/actor";
import { getDefaultAgentForUser, listAgentMembers } from "../../lib/db/agents";
import {
    buildMemorySystemPrompt,
    buildMemoryTools,
    buildRelevantMemoriesBlock,
    type MemoryScope,
} from "../../lib/agent/memory";
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

// User messages carry who sent them; in shared conversations the model needs that
// to attribute statements ("my car") to the right member.
type UserMessageMetadata = { userId?: string; userName?: string };

// Stored messages stay clean (the UI renders them as written); speaker labels are
// added only on the copy sent to the model, and deterministically, so the prompt
// prefix for a given conversation is stable across requests (KV-cache reuse).
function withSpeakerLabels(history: UIMessage[]): UIMessage[] {
    return history.map((m) => {
        if (m.role !== "user") return m;
        const name = (m.metadata as UserMessageMetadata | undefined)?.userName;
        if (!name) return m;
        return {
            ...m,
            parts: m.parts.map((p) =>
                p.type === "text" && !p.text.startsWith("<relevant-memories>")
                    ? { ...p, text: `${name}: ${p.text}` }
                    : p
            ),
        };
    });
}

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'GET, POST, DELETE, OPTIONS');
    res.sendStatus(204);
}

// The user comes from the session cookie; agent_id defaults to their oldest agent.
const bodySchema = z.object({
    message: z.string().min(1),
    conversation_id: z.uuid().optional(),
    agent_id: z.uuid().optional(),
    // Only honored when the conversation is created; existing ones keep their flag.
    shared: z.boolean().optional(),
});

export const POST: express.RequestHandler = async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const { message, conversation_id, agent_id, shared } = parsed.data;

    const user = await getSessionUser(req);
    if (!user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    // Create-if-missing: the client generates the UUID for new conversations so it
    // can keep streaming to the same id before the row exists.
    const existing = conversation_id !== undefined ? await findMessage(conversation_id) : undefined;

    // Existing conversations pin the agent; the body's agent_id only matters for new ones.
    let agentId: string;
    if (existing) {
        agentId = existing.agentId;
    } else if (agent_id !== undefined) {
        agentId = agent_id;
    } else {
        const defaultAgent = await getDefaultAgentForUser(user.id);
        if (!defaultAgent) {
            res.status(403).json({ error: "User has no agents" });
            return;
        }
        agentId = defaultAgent.id;
    }

    const members = await listAgentMembers(agentId);
    const isMember = members.some((m) => m.userId === user.id);
    if (!isMember || (existing && !canAccessConversation(existing, user.id, isMember))) {
        res.status(403).json({ error: "Not allowed to access this conversation" });
        return;
    }

    const conversationShared = existing ? existing.shared : shared ?? false;
    const scope: MemoryScope = {
        agentId,
        speaker: { id: user.id, name: user.name },
        members,
    };

    const history: UIMessage[] = existing ? toUIMessages(existing.messages ?? []) : [];

    // Retrieved memories ride along with the user message instead of the system
    // prompt: everything before this point in the prompt is then byte-identical to
    // the previous request, so the server's KV cache stays valid across turns.
    const [basePrompt, memoriesBlock, memorySystemPrompt] = await Promise.all([
        loadSystemPrompt(),
        buildRelevantMemoriesBlock(scope, buildRetrievalQuery(history, message)),
        buildMemorySystemPrompt(scope, { sharedConversation: conversationShared }),
    ]);

    history.push({
        id: crypto.randomUUID(),
        role: "user",
        metadata: { userId: user.id, userName: user.name } satisfies UserMessageMetadata,
        parts: [
            ...(memoriesBlock ? [{ type: "text" as const, text: memoriesBlock }] : []),
            { type: "text", text: message },
        ],
    });

    // Persist before streaming so the conversation (with the user's message)
    // survives a reload or chat switch mid-stream; onFinish then overwrites
    // messages with the completed turn.
    let conversationId: string;
    if (existing) {
        await updateMessage(existing.id, { messages: history });
        conversationId = existing.id;
    } else {
        const created = await createMessage({
            id: conversation_id,
            agentId,
            userId: user.id,
            shared: conversationShared,
            messages: history,
        });
        conversationId = created.id;
    }

    const system = [basePrompt, memorySystemPrompt, webSearchPrompt]
        .filter(Boolean)
        .join("\n\n");
    const tools = { ...buildMemoryTools(scope), ...searchTools };

    // Speaker labels only matter (and only stay stable) when several people can
    // write to the conversation; private chats keep the prompt unchanged.
    const modelHistory = conversationShared ? withSpeakerLabels(history) : history;

    const result = streamText({
        model: wrapLanguageModel({
            model: lmstudioChat.chatModel(process.env.CHAT_MODEL ?? "google/gemma-4-e4b"),
            // Catches models that emit reasoning inline as <think> tags instead of reasoning_content.
            middleware: extractReasoningMiddleware({ tagName: "think" }),
        }),
        system,
        messages: await convertToModelMessages(modelHistory, { tools, ignoreIncompleteToolCalls: true }),
        tools,
        // Search → read → answer flows need more steps than memory-only turns.
        stopWhen: stepCountIs(8),
    });

    result.pipeUIMessageStreamToResponse(res, {
        // Tees the SSE stream to an independent consumer, so the turn runs to
        // completion (and onFinish persists it) even if the client disconnects
        // mid-stream. result.consumeStream() is not enough: it drains the base
        // stream, but onFinish fires from the UI-message branch, which stalls
        // when the response socket closes.
        consumeSseStream: consumeStream,
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
            await updateMessage(conversationId, { messages });
        },
    });
}

const querySchema = z.object({
    id: z.union([z.uuid(), z.array(z.uuid())]).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    agent_id: z.uuid().optional(),
});

export const GET: express.RequestHandler = async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const viewer = await getSessionUser(req);
    if (!viewer) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    const { agent_id, ...filter } = parsed.data;
    const conversations = await findMessages({ ...filter, agentId: agent_id, viewerId: viewer.id });
    res.json(conversations);
}

export const DELETE: express.RequestHandler = async (req, res) => {
    const parsed = z.object({ id: z.uuid() }).safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const viewer = await getSessionUser(req);
    if (!viewer) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    const conversation = await findMessage(parsed.data.id);
    if (!conversation) {
        res.status(404).json({ error: "Conversation not found" });
        return;
    }
    // Only the creator can delete — shared conversations included.
    if (conversation.userId !== viewer.id) {
        res.status(403).json({ error: "Only the creator can delete a conversation" });
        return;
    }

    await deleteMessage(conversation.id);
    res.status(204).end();
}
