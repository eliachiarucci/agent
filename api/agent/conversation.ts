import express from 'express';
import {
    consumeStream,
    convertToModelMessages,
    createUIMessageStream,
    extractReasoningMiddleware,
    pipeUIMessageStreamToResponse,
    stepCountIs,
    streamText,
    wrapLanguageModel,
    type UIMessage,
} from "ai";
import { z } from "zod";
import { chatModelFromSettings } from "../../lib/global/ai";
import { resolveDefaultChatModelAndTarget } from "../../lib/agent/default-model";
import {
    applyCompaction,
    CONVERSATION_SUMMARY_OPEN,
    planChatCompaction,
    usageTokens,
} from "../../lib/agent/compaction";
import { PROVIDER_TYPES } from "../../lib/global/providers";
import { getProviderSetting } from "../../lib/db/provider-settings";
import {
    canAccessConversation,
    createMessage,
    deleteMessage,
    findMessage,
    findMessages,
    updateMessage,
} from "../../lib/db/conversations";
import { getSessionUser } from "../../lib/agent/actor";
import { getAgent, getDefaultAgentForUser, listAgentMembers } from "../../lib/db/agents";
import {
    buildMemorySystemPrompt,
    buildMemoryTools,
    buildRelevantMemoriesBlock,
    type MemoryScope,
} from "../../lib/agent/memory";
import { searchTools, webSearchPrompt } from "../../lib/agent/search";
import { buildCronTools, buildCronToolsPrompt } from "../../lib/agent/cron-tools";
import { buildDateTools, dateToolPrompt } from "../../lib/agent/date-tool";
import {
    ATTACHED_FILES_MARKER,
    buildFileTools,
    filesPrompt,
    isValidFileName,
    removeConversationFiles,
} from "../../lib/agent/files";
import { buildNoteTools, notesPrompt } from "../../lib/agent/notes";
import {
    buildConversationSearchTools,
    conversationSearchPrompt,
} from "../../lib/agent/conversation-search";
import { runMemoryExtraction } from "../../lib/agent/memory-extraction";
import { loadSystemPrompt } from "../../lib/agent/system-prompt";
import type { StoredMessage } from "../../lib/global/schema";

function toUIMessages(stored: StoredMessage[]): UIMessage[] {
    return stored.map((m, i) =>
        "parts" in m
            ? m
            : { id: `legacy-${i}`, role: m.role, parts: [{ type: "text", text: m.content }] }
    );
}

// Machine-inserted text parts on a user message — the retrieved memories block
// and the attached-files list — are model context, not something the user typed.
// Anywhere we treat a text part as user words (retrieval, speaker labels) we
// must skip these so their markup never feeds retrieval or gets a name prefix.
function isMachineTextPart(text: string): boolean {
    return (
        text.startsWith("<relevant-memories>") ||
        text.startsWith(ATTACHED_FILES_MARKER) ||
        text.startsWith(CONVERSATION_SUMMARY_OPEN)
    );
}

// Recent turns plus the new message, so follow-ups like "what about her birthday?"
// embed with enough context to retrieve anything. Injected <relevant-memories>
// blocks are excluded to avoid retrieval feeding on its own previous output.
function buildRetrievalQuery(history: UIMessage[], message: string): string {
    const recent = history.slice(-4).flatMap((m) =>
        m.parts.flatMap((p) =>
            p.type === "text" && !isMachineTextPart(p.text) ? [p.text] : []
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
                p.type === "text" && !isMachineTextPart(p.text)
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

// Files the user attached to this turn, already uploaded to the conversation's
// workspace (POST /agent/files). `name` is the stored file name the agent reads
// with readFile; `label` is the chip text the UI shows on the message.
const attachmentSchema = z.object({
    name: z.string().refine(isValidFileName, "Invalid file name"),
    label: z.string().min(1).max(200),
});

// The user comes from the session cookie; agent_id defaults to their oldest agent.
// A turn must carry text or at least one attachment (message may be empty when
// the user only attaches files).
const bodySchema = z
    .object({
        message: z.string().default(""),
        conversation_id: z.uuid().optional(),
        agent_id: z.uuid().optional(),
        // Only honored when the conversation is created; existing ones keep their flag.
        shared: z.boolean().optional(),
        attachments: z.array(attachmentSchema).max(20).optional(),
        // The model selected in the UI. Resolved against the *sender's* provider
        // settings; omitted → the env-configured default model.
        provider: z.enum(PROVIDER_TYPES).optional(),
        model: z.string().min(1).optional(),
        // The sender's IANA timezone; scheduling tools interpret times in it.
        // Omitted → the server's timezone.
        timezone: z.string().min(1).optional(),
    })
    .refine((d) => d.message.trim().length > 0 || (d.attachments?.length ?? 0) > 0, {
        message: "message or attachments required",
    });

export const POST: express.RequestHandler = async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const { message, conversation_id, agent_id, shared, attachments, provider, model, timezone } =
        parsed.data;

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

    const [agent, members] = await Promise.all([getAgent(agentId), listAgentMembers(agentId)]);
    if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
    const isMember = members.some((m) => m.userId === user.id);
    if (!isMember || (existing && !canAccessConversation(existing, user.id, isMember))) {
        res.status(403).json({ error: "Not allowed to access this conversation" });
        return;
    }

    // Resolve the model only after access is granted (so a forbidden request is a
    // 403, not a model-config 400) but before any rows are written, so a bad
    // selection is still a clean 4xx. No selection in the request → the user's
    // configured default. There is no server default: with neither, the turn is
    // rejected (the UI blocks sending in this state). The target is captured for
    // the post-turn context-window lookup that drives auto-compaction.
    let { model: chatModel, target: contextTarget } = await resolveDefaultChatModelAndTarget(
        user.id
    );
    if (provider) {
        const setting = await getProviderSetting(user.id, provider);
        if (!setting) {
            res.status(400).json({ error: `Provider "${provider}" is not configured` });
            return;
        }
        const modelId = model ?? setting.settings.model;
        if (!modelId) {
            res.status(400).json({ error: `No model selected for provider "${provider}"` });
            return;
        }
        chatModel = chatModelFromSettings(provider, setting.settings, modelId);
        contextTarget = { provider, settings: setting.settings, model: modelId };
    }
    if (!chatModel) {
        res.status(400).json({
            error: "No model selected. Choose a default model in Settings → Models.",
        });
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

    // Attached files ride along as a machine text part (parsed by the UI into
    // chips, read by the model via readFile) — stored so reloads and later turns
    // see the same attachments. The literal must match the UI's ATTACHMENTS_MARKER.
    const attachmentsBlock =
        attachments && attachments.length > 0
            ? ATTACHED_FILES_MARKER + JSON.stringify(attachments)
            : "";

    history.push({
        id: crypto.randomUUID(),
        role: "user",
        metadata: { userId: user.id, userName: user.name } satisfies UserMessageMetadata,
        parts: [
            ...(memoriesBlock ? [{ type: "text" as const, text: memoriesBlock }] : []),
            ...(message.trim() ? [{ type: "text" as const, text: message }] : []),
            ...(attachmentsBlock ? [{ type: "text" as const, text: attachmentsBlock }] : []),
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

    // The owner's per-agent prompt rides after the base prompt. Like the rest of
    // the system prompt it only changes when the owner edits it, so the prompt
    // prefix stays stable across turns (KV-cache reuse, see docs/memory.md).
    const agentPrompt = agent.systemPrompt?.trim()
        ? `Instructions from this agent's owner:\n${agent.systemPrompt.trim()}`
        : "";

    // Scheduling tools work in the sender's timezone and pin new jobs to the
    // model this chat runs on. Stable per session (the client sends the same
    // timezone every turn), so the prompt prefix stays KV-cache friendly.
    const cronScope = {
        agentId,
        userId: user.id,
        timezone: timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        provider,
        model,
    };

    const system = [
        basePrompt,
        agentPrompt,
        memorySystemPrompt,
        webSearchPrompt,
        dateToolPrompt,
        filesPrompt,
        notesPrompt,
        conversationSearchPrompt,
        buildCronToolsPrompt(cronScope.timezone),
    ]
        .filter(Boolean)
        .join("\n\n");
    // File tools are pinned to this conversation's folder (one folder per
    // conversation); note tools to the agent's shared notes.
    const tools = {
        ...buildMemoryTools(scope),
        ...searchTools,
        ...buildDateTools(cronScope.timezone),
        ...buildFileTools(conversationId),
        ...buildNoteTools(agentId, user.id),
        ...buildCronTools(cronScope),
        ...buildConversationSearchTools({
            agentId,
            viewerId: user.id,
            currentConversationId: conversationId,
        }),
    };

    // If the conversation was previously compacted, the model sees the stored
    // summary plus everything after the summarized point (the full history stays
    // persisted for scrollback). Speaker labels only matter (and only stay
    // stable) when several people can write; private chats keep the prompt
    // unchanged.
    const modelView = applyCompaction(history, existing?.compaction ?? null);
    const modelHistory = conversationShared ? withSpeakerLabels(modelView) : modelView;
    const modelMessages = await convertToModelMessages(modelHistory, {
        tools,
        ignoreIncompleteToolCalls: true,
    });

    // Anthropic prompt caching is opt-in per request (unlike LM Studio's and
    // Gemini's implicit prefix caching): two ephemeral breakpoints — one on the system block (tools render
    // before system, so it caches both) and one on the newest message, so each
    // turn reads the whole prior conversation from cache (writes 1.25x, reads
    // 0.1x, 5-min TTL). The prompt prefix is already byte-stable across turns
    // (see docs/memory.md), which is exactly what the cache keys on.
    const cacheBreakpoint = { anthropic: { cacheControl: { type: "ephemeral" as const } } };
    const cached = provider === "anthropic";

    const result = streamText({
        model: wrapLanguageModel({
            model: chatModel,
            // Catches models that emit reasoning inline as <think> tags instead of
            // reasoning_content. A no-op for providers with native reasoning parts.
            middleware: extractReasoningMiddleware({ tagName: "think" }),
        }),
        system: cached ? undefined : system,
        messages: cached
            ? [
                  { role: "system" as const, content: system, providerOptions: cacheBreakpoint },
                  ...modelMessages.slice(0, -1),
                  ...modelMessages.slice(-1).map((m) => ({ ...m, providerOptions: cacheBreakpoint })),
              ]
            : modelMessages,
        tools,
        // Search → read → answer flows need more steps than memory-only turns.
        stopWhen: stepCountIs(8),
    });

    // The model turn and the auto-compaction step share one UI-message stream so
    // compaction is visible: it runs *after* the answer but *before* the stream
    // closes, so the client stays busy (composer blocked) and shows a
    // "compacting" indicator from the transient data parts below.
    const stream = createUIMessageStream<UIMessage>({
        originalMessages: history,
        generateId: () => crypto.randomUUID(),
        onError: (error) => (error instanceof Error ? error.message : "An error occurred."),
        onFinish: async ({ messages }) => {
            await updateMessage(conversationId, { messages });
            // Background memory extraction: a dedicated model inspects the just-
            // finished exchange and stores durable facts (lib/agent/memory-
            // extraction.ts). Fire-and-forget — it must never block or fail the
            // turn, so errors are logged and swallowed.
            void runMemoryExtraction({ conversationId, scope, messages }).catch((error) =>
                console.warn(`[memory] extraction failed: ${error}`)
            );
        },
        execute: async ({ writer }) => {
            // Stream the model's reply to the client.
            writer.merge(
                result.toUIMessageStream({
                    sendReasoning: true,
                    // Each step's usage covers the full prompt (system + history +
                    // tools) of that request, so the last finish-step is the
                    // current context size. The UI reads it live from message
                    // metadata and it persists via onFinish.
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
                })
            );

            // Auto-compaction: if this turn pushed the model's input past the
            // context threshold, summarize the head so the next turn loads small.
            // Non-destructive — the full history is persisted in onFinish; only
            // the summary pointer is written here. `await result.totalUsage` is
            // this turn's real input size (the history above lacks it yet); a
            // transient data part shows the user it's happening. Errors never
            // fail the turn.
            try {
                const compaction = await planChatCompaction({
                    model: chatModel,
                    target: contextTarget ?? undefined,
                    messages: history,
                    prior: existing?.compaction ?? null,
                    usedTokens: usageTokens(await result.totalUsage),
                    onCompacting: () =>
                        writer.write({
                            type: "data-compaction",
                            data: { status: "running" },
                            transient: true,
                        } as Parameters<typeof writer.write>[0]),
                });
                if (compaction) {
                    await updateMessage(conversationId, { compaction });
                    writer.write({
                        type: "data-compaction",
                        data: { status: "done" },
                        transient: true,
                    } as Parameters<typeof writer.write>[0]);
                }
            } catch (error) {
                console.warn(`[compaction] failed: ${error}`);
            }
        },
    });

    pipeUIMessageStreamToResponse({
        response: res,
        stream,
        // Tees the SSE stream to an independent consumer, so the turn — and the
        // in-band compaction — runs to completion (and onFinish persists it) even
        // if the client disconnects mid-stream.
        consumeSseStream: consumeStream,
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
    // The conversation's file folder goes with it (no DB rows track files).
    await removeConversationFiles(conversation.id);
    res.status(204).end();
}
