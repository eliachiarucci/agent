// Request-level identity resolution, shared by the API routes. The user always
// comes from the Better Auth session cookie; agent_id stays an optional request
// param, defaulting to the user's oldest agent.
import type express from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../global/auth";
import { getAgent, getDefaultAgentForUser, isAgentMember, type Agent } from "../db/agents";
import { canAccessConversation, findMessage, type Conversation } from "../db/conversations";

export type SessionUser = { id: string; name: string };

export type ActorResolution =
  | { ok: true; user: SessionUser; agent: Agent }
  | { ok: false; status: number; error: string };

export async function getSessionUser(req: express.Request): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) return null;
  return { id: session.user.id, name: session.user.name };
}

export async function resolveActor(
  req: express.Request,
  agentId?: string
): Promise<ActorResolution> {
  const user = await getSessionUser(req);
  if (!user) {
    return { ok: false, status: 401, error: "Not authenticated" };
  }

  const agent =
    agentId !== undefined ? await getAgent(agentId) : await getDefaultAgentForUser(user.id);
  if (!agent) {
    return agentId !== undefined
      ? { ok: false, status: 404, error: "Agent not found" }
      : { ok: false, status: 403, error: "User has no agents" };
  }

  if (!(await isAgentMember(agent.id, user.id))) {
    return { ok: false, status: 403, error: "Not a member of this agent" };
  }

  return { ok: true, user, agent };
}

export type ConversationViewerResolution =
  | { ok: true; user: SessionUser; conversation: Conversation }
  | { ok: false; status: number; error: string };

/**
 * Viewer access to a single conversation — the same rule as reading it in the
 * chat: member of its agent, and the conversation is shared or the viewer's
 * own. Used by the per-file routes (download, content).
 */
export async function resolveConversationViewer(
  req: express.Request,
  conversationId: string
): Promise<ConversationViewerResolution> {
  const user = await getSessionUser(req);
  if (!user) {
    return { ok: false, status: 401, error: "Not authenticated" };
  }

  const conversation = await findMessage(conversationId);
  if (!conversation) {
    return { ok: false, status: 404, error: "Conversation not found" };
  }

  const isMember = await isAgentMember(conversation.agentId, user.id);
  if (!canAccessConversation(conversation, user.id, isMember)) {
    return { ok: false, status: 403, error: "Not allowed to access this conversation" };
  }

  return { ok: true, user, conversation };
}
