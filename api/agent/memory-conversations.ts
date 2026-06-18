import express from "express";
import { z } from "zod";
import type { ModelMessage } from "ai";
import { resolveActor, resolveConversationViewer } from "../../lib/agent/actor";
import {
  getMemoryConversationById,
  listMemoryConversations,
} from "../../lib/db/memory-conversations";

export const config = {};

export const OPTIONS: express.RequestHandler = async (req, res) => {
  res.set("Allow", "GET, OPTIONS");
  res.sendStatus(204);
};

// A memory conversation's messages flattened for read-only display: the model's
// raw ModelMessages carry tool-call/tool-result parts the UI shouldn't have to
// parse, so reduce each to text plus any memory tool calls/results.
type ViewMessage = {
  role: "user" | "assistant" | "tool";
  text?: string;
  toolCalls?: { toolName: string; input: unknown }[];
  toolResults?: { toolName: string; output: unknown }[];
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && typeof p === "object" && (p as { type?: string }).type === "text")
    .map((p) => (p as { text?: string }).text ?? "")
    .join("\n")
    .trim();
}

function partsOfType(content: unknown, type: string): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (p): p is Record<string, unknown> =>
      !!p && typeof p === "object" && (p as { type?: string }).type === type
  );
}

function toView(messages: ModelMessage[]): ViewMessage[] {
  return messages.map((m) => {
    if (m.role === "user") return { role: "user", text: textOf(m.content) };
    if (m.role === "tool") {
      return {
        role: "tool",
        toolResults: partsOfType(m.content, "tool-result").map((p) => ({
          toolName: String(p.toolName ?? ""),
          // The output is shaped { type, value }; surface the value when present.
          output: (p.output as { value?: unknown })?.value ?? p.output,
        })),
      };
    }
    // assistant
    const text = textOf(m.content);
    const toolCalls = partsOfType(m.content, "tool-call").map((p) => ({
      toolName: String(p.toolName ?? ""),
      input: p.input,
    }));
    return {
      role: "assistant",
      ...(text ? { text } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  });
}

const querySchema = z.object({
  id: z.uuid().optional(),
  agent_id: z.uuid().optional(),
});

export const GET: express.RequestHandler = async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }
  const { id, agent_id } = parsed.data;

  // Detail: a single memory conversation's messages. Access mirrors its source
  // conversation (resolveConversationViewer applies the shared-or-own rule).
  if (id) {
    const memoryConversation = await getMemoryConversationById(id);
    if (!memoryConversation) {
      res.status(404).json({ error: "Memory conversation not found" });
      return;
    }
    const viewer = await resolveConversationViewer(req, memoryConversation.conversationId);
    if (!viewer.ok) {
      res.status(viewer.status).json({ error: viewer.error });
      return;
    }
    res.json({
      id: memoryConversation.id,
      conversationId: memoryConversation.conversationId,
      createdAt: memoryConversation.createdAt,
      updatedAt: memoryConversation.updatedAt,
      messages: toView(memoryConversation.messages),
    });
    return;
  }

  // List: every memory conversation of the agent the viewer may see.
  const actor = await resolveActor(req, agent_id);
  if (!actor.ok) {
    res.status(actor.status).json({ error: actor.error });
    return;
  }
  res.json(await listMemoryConversations({ agentId: actor.agent.id, viewerId: actor.user.id }));
};
