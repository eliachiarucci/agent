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
    imageMediaTypeFor,
    isValidFileName,
    removeConversationFiles,
    statConversationFile,
} from "../../lib/agent/files";
import { buildImageFileParts, inlineImageFileParts } from "../../lib/agent/image-parts";
import { buildNoteTools, notesPrompt } from "../../lib/agent/notes";
import {
    buildConversationSearchTools,
    conversationSearchPrompt,
} from "../../lib/agent/conversation-search";
import {
    buildConnectorTools,
    connectorApprovalTargets,
    connectorForTool,
} from "../../lib/agent/connectors";
import {
    applyApprovalResponses,
    denyUnansweredApprovals,
    pendingApprovalParts,
} from "../../lib/agent/tool-approval";
import { addToolApprovals } from "../../lib/db/tool-approvals";
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
    res.set('Allow', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.sendStatus(204);
}

// Files the user attached to this turn, already uploaded to the conversation's
// workspace (POST /agent/files). `name` is the stored file name the agent reads
// with readFile; `label` is the chip text the UI shows on the message.
const attachmentSchema = z.object({
    name: z.string().refine(isValidFileName, "Invalid file name"),
    label: z.string().min(1).max(200),
});

// Images the user attached to this turn, already uploaded to the conversation's
// uploads folder (POST /agent/files). Unlike text attachments they don't ride
// as an <attached-files> marker: they become real file parts on the user
// message, so vision models see the pixels.
const imageSchema = z.object({
    name: z
        .string()
        .refine(isValidFileName, "Invalid file name")
        .refine((name) => imageMediaTypeFor(name) !== null, "Unsupported image type"),
});

// The user's decision on one pending approval prompt ("ask"-level tool call).
// `always` additionally stores a standing (tool, target) approval override.
const approvalResponseSchema = z.object({
    approval_id: z.string().min(1).max(200),
    approved: z.boolean(),
    always: z.boolean().optional(),
});

// The user comes from the session cookie; agent_id defaults to their oldest agent.
// A turn either carries text/attachments (a normal message) or tool_approvals
// (decisions on pending approval prompts, which resume the paused turn) — never
// both: approvals resume the model mid-turn, so a new user message can't ride along.
const bodySchema = z
    .object({
        message: z.string().default(""),
        conversation_id: z.uuid().optional(),
        agent_id: z.uuid().optional(),
        // Only honored when the conversation is created; existing ones keep their flag.
        shared: z.boolean().optional(),
        // Like `shared`: whether memory applies to this conversation (recall,
        // memory tools, background extraction). Only honored at creation.
        memory: z.boolean().optional(),
        attachments: z.array(attachmentSchema).max(20).optional(),
        images: z.array(imageSchema).max(20).optional(),
        tool_approvals: z.array(approvalResponseSchema).min(1).max(20).optional(),
        // The model selected in the UI. Resolved against the *sender's* provider
        // settings; omitted → the env-configured default model.
        provider: z.enum(PROVIDER_TYPES).optional(),
        model: z.string().min(1).optional(),
        // The sender's IANA timezone; scheduling tools interpret times in it.
        // Omitted → the server's timezone.
        timezone: z.string().min(1).optional(),
    })
    .refine(
        (d) =>
            d.tool_approvals
                ? d.message.trim().length === 0 &&
                  (d.attachments?.length ?? 0) === 0 &&
                  (d.images?.length ?? 0) === 0
                : d.message.trim().length > 0 ||
                  (d.attachments?.length ?? 0) > 0 ||
                  (d.images?.length ?? 0) > 0,
        { message: "message/attachments/images or tool_approvals required (not both)" }
    );

export const POST: express.RequestHandler = async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const {
        message,
        conversation_id,
        agent_id,
        shared,
        memory,
        attachments,
        images,
        tool_approvals,
        provider,
        model,
        timezone,
    } = parsed.data;

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

    const history: UIMessage[] = existing ? toUIMessages(existing.messages ?? []) : [];

    // Approval decisions are validated before model resolution (a decision on a
    // gone conversation is a 404 even with no model configured) but applied
    // after it, so a bad model selection never persists a half-resumed turn.
    if (tool_approvals) {
        // No new user message — the paused turn resumes instead. The pending
        // call runs with the original sender's connector credentials, so only
        // they may decide.
        if (!existing) {
            res.status(404).json({ error: "Conversation not found" });
            return;
        }
        const turnSender = [...history].reverse().find((m) => m.role === "user");
        const senderId =
            (turnSender?.metadata as UserMessageMetadata | undefined)?.userId ?? existing.userId;
        if (senderId !== user.id) {
            res.status(403).json({ error: "Only the sender of this turn can respond" });
            return;
        }
        // All prompts of the paused turn must be decided at once: a partial
        // response would leave dangling tool calls the model can't resume over.
        const pending = pendingApprovalParts(history.at(-1));
        const responded = new Set(tool_approvals.map((a) => a.approval_id));
        if (
            pending.length === 0 ||
            !pending.every(
                (p) => p.state === "approval-requested" && responded.has(p.approval.id)
            )
        ) {
            res.status(400).json({ error: "tool_approvals must answer every pending approval" });
            return;
        }

        // Every decision is a denial: record it and stop — no model turn. The
        // denied results stay in the conversation (the model sees them on the
        // next turn), but the agent doesn't get to reply to a plain "no". The
        // response stream only flips the client's pending parts to their final
        // state; it needs no model, so this runs before model resolution.
        if (tool_approvals.every((a) => !a.approved)) {
            denyUnansweredApprovals(history, "The user declined.");
            await updateMessage(existing.id, { messages: history });
            const stream = createUIMessageStream<UIMessage>({
                originalMessages: history,
                generateId: () => crypto.randomUUID(),
                execute: async ({ writer }) => {
                    for (const part of pending) {
                        writer.write({
                            type: "tool-output-denied",
                            toolCallId: part.toolCallId,
                        } as Parameters<typeof writer.write>[0]);
                    }
                },
            });
            pipeUIMessageStreamToResponse({ response: res, stream, consumeSseStream: consumeStream });
            return;
        }
    }

    // Attached images must already sit in the conversation's uploads folder
    // (the composer uploads them on selection); checked before model resolution
    // so a stale reference is a clear 400 rather than a mid-stream failure.
    if (images && images.length > 0) {
        if (conversation_id === undefined) {
            res.status(400).json({ error: "images require a conversation_id" });
            return;
        }
        const imageConversationId = existing?.id ?? conversation_id;
        for (const image of images) {
            const file = await statConversationFile(imageConversationId, image.name, "upload");
            if (!file) {
                res.status(400).json({
                    error: `Image "${image.name}" was not uploaded to this conversation`,
                });
                return;
            }
        }
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
    // Per-conversation memory opt-out on top of the agent-level switches: off →
    // no recalled memories, no memory prompt/tools for the chat model, and the
    // background extractor skips the conversation (checked in extractTurn).
    const conversationMemory = existing ? existing.memory : memory ?? true;
    // Memory needs a pool: an agent with none attached (Settings → Memory)
    // behaves like one with chat memory switched off, extraction included.
    const scope: MemoryScope | null = agent.memoryPoolId
        ? {
              agentId,
              poolId: agent.memoryPoolId,
              speaker: { id: user.id, name: user.name },
              members,
          }
        : null;
    const memoryScope = agent.chatMemoryEnabled && conversationMemory ? scope : null;

    // Retrieved memories ride along with the user message instead of the system
    // prompt: everything before this point in the prompt is then byte-identical to
    // the previous request, so the server's KV cache stays valid across turns.
    // Owners can switch the chat model's whole memory surface off per agent
    // (Settings → Memories): no memory prompt, no recalled memories, no memory
    // tools. Background extraction is governed separately (memoryExtractionEnabled).
    // Approval turns append no user message, so they retrieve nothing.
    const [basePrompt, memoriesBlock, memorySystemPrompt] = await Promise.all([
        loadSystemPrompt(),
        memoryScope && !tool_approvals
            ? buildRelevantMemoriesBlock(memoryScope, buildRetrievalQuery(history, message))
            : null,
        memoryScope
            ? buildMemorySystemPrompt(memoryScope, {
                  sharedConversation: conversationShared,
                  customPrompt: agent.chatMemoryPrompt,
              })
            : "",
    ]);

    let conversationId: string;
    if (tool_approvals && existing) {
        const outcome = applyApprovalResponses(
            history,
            tool_approvals.map((a) => ({
                approvalId: a.approval_id,
                approved: a.approved,
                always: a.always,
            }))
        );
        if ("error" in outcome) {
            res.status(400).json({ error: outcome.error });
            return;
        }
        // "Always approve": store the standing (tool, target) overrides. The
        // target comes from the pending call's input, derived server-side.
        for (const { toolName, input, response } of outcome.applied) {
            if (!response.approved || !response.always) continue;
            const connector = connectorForTool(toolName);
            if (!connector) continue;
            await addToolApprovals({
                userId: user.id,
                agentId,
                connector,
                tool: toolName,
                targets: connectorApprovalTargets(connector, toolName, input),
            });
        }
        await updateMessage(existing.id, { messages: history });
        conversationId = existing.id;
    } else {
        // A user message while approval prompts are still pending denies them:
        // the dangling calls become denied tool results so the model's view of
        // the turn stays coherent.
        denyUnansweredApprovals(history, "The user sent a new message instead of responding.");

        // Attached files ride along as a machine text part (parsed by the UI into
        // chips, read by the model via readFile) — stored so reloads and later turns
        // see the same attachments. The literal must match the UI's ATTACHMENTS_MARKER.
        const attachmentsBlock =
            attachments && attachments.length > 0
                ? ATTACHED_FILES_MARKER + JSON.stringify(attachments)
                : "";

        // Image parts reference the upload by download URL (what the UI renders);
        // the copy sent to the model swaps them for data: URLs (inlineImageFileParts).
        const imageParts =
            images && images.length > 0 && conversation_id !== undefined
                ? buildImageFileParts(
                      existing?.id ?? conversation_id,
                      images.map((i) => i.name)
                  )
                : [];

        history.push({
            id: crypto.randomUUID(),
            role: "user",
            metadata: { userId: user.id, userName: user.name } satisfies UserMessageMetadata,
            parts: [
                ...(memoriesBlock ? [{ type: "text" as const, text: memoriesBlock }] : []),
                ...(message.trim() ? [{ type: "text" as const, text: message }] : []),
                ...imageParts,
                ...(attachmentsBlock ? [{ type: "text" as const, text: attachmentsBlock }] : []),
            ],
        });

        // Persist before streaming so the conversation (with the user's message)
        // survives a reload or chat switch mid-stream; onFinish then overwrites
        // messages with the completed turn.
        if (existing) {
            await updateMessage(existing.id, { messages: history });
            conversationId = existing.id;
        } else {
            const created = await createMessage({
                id: conversation_id,
                agentId,
                userId: user.id,
                shared: conversationShared,
                memory: conversationMemory,
                messages: history,
            });
            conversationId = created.id;
        }
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

    // Connector tools (Settings → Tools) are per sender and per agent: only
    // connected connectors, filtered by the agent-scoped permission levels.
    // Interactive: "ask"-level tools pause the stream for approval when no
    // standing override covers the call.
    // Stable for a given user+agent, so the prompt prefix stays KV-cache friendly.
    const connectorToolset = await buildConnectorTools({
        userId: user.id,
        agentId,
        interactive: true,
    });

    const system = [
        basePrompt,
        agentPrompt,
        memorySystemPrompt,
        webSearchPrompt,
        dateToolPrompt,
        filesPrompt,
        notesPrompt,
        conversationSearchPrompt,
        connectorToolset.prompt,
        buildCronToolsPrompt(cronScope.timezone),
    ]
        .filter(Boolean)
        .join("\n\n");
    // File tools are pinned to this conversation's folder (one folder per
    // conversation); note tools to the agent's shared notes.
    const tools = {
        ...(memoryScope ? buildMemoryTools(memoryScope) : {}),
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
        ...connectorToolset.tools,
    };

    // If the conversation was previously compacted, the model sees the stored
    // summary plus everything after the summarized point (the full history stays
    // persisted for scrollback). Speaker labels only matter (and only stay
    // stable) when several people can write; private chats keep the prompt
    // unchanged.
    // Image parts are stored with app-internal download URLs; the model gets
    // data: URLs read from disk instead (providers can't fetch our routes).
    const modelView = await inlineImageFileParts(
        applyCompaction(history, existing?.compaction ?? null),
        conversationId
    );
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
            // turn, so errors are logged and swallowed. No pool → no extraction.
            if (scope) {
                void runMemoryExtraction({ conversationId, scope, messages }).catch((error) =>
                    console.warn(`[memory] extraction failed: ${error}`)
                );
            }
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
    // "true" → only archived, "false" → only unarchived. Omitted: list requests
    // exclude archived (the sidebar default); id fetches return either.
    archived: z.enum(["true", "false"]).optional(),
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

    const { agent_id, archived, ...filter } = parsed.data;
    const conversations = await findMessages({
        ...filter,
        agentId: agent_id,
        archived:
            archived !== undefined ? archived === "true" : filter.id !== undefined ? undefined : false,
        viewerId: viewer.id,
    });
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

// Archive / unarchive: hides the conversation from the default sidebar list
// without touching its contents. Creator-only, like DELETE.
export const PATCH: express.RequestHandler = async (req, res) => {
    const parsed = z.object({ id: z.uuid(), archived: z.boolean() }).safeParse(req.body);
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
    if (conversation.userId !== viewer.id) {
        res.status(403).json({ error: "Only the creator can archive a conversation" });
        return;
    }

    const updated = await updateMessage(conversation.id, { archived: parsed.data.archived });
    res.json(updated);
}
