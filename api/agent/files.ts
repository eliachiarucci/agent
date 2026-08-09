import express from 'express';
import { z } from "zod";
import { getSessionUser, resolveActor } from "../../lib/agent/actor";
import {
    MAX_UPLOAD_BYTES,
    isValidFileName,
    listConversationFiles,
    removeConversationUpload,
    writeConversationFileBytes,
} from "../../lib/agent/files";
import {
    canAccessConversation,
    findConversationIds,
    findMessage,
} from "../../lib/db/conversations";
import { isAgentMember } from "../../lib/db/agents";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'GET, POST, DELETE, OPTIONS');
    res.sendStatus(204);
}

const querySchema = z.object({
    agent_id: z.uuid().optional(),
});

// Flat list of every file the viewer can see in this agent: files live in
// per-conversation folders on disk, and a file is visible exactly when its
// conversation is (shared, or the viewer's own). Download is a separate route
// (/agent/files/download).
export const GET: express.RequestHandler = async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const actor = await resolveActor(req, parsed.data.agent_id);
    if (!actor.ok) {
        res.status(actor.status).json({ error: actor.error });
        return;
    }

    const conversationIds = await findConversationIds({
        agentId: actor.agent.id,
        viewerId: actor.user.id,
    });
    const perConversation = await Promise.all(
        conversationIds.map(async (conversationId) =>
            (await listConversationFiles(conversationId)).map((file) => ({
                conversationId,
                ...file,
            }))
        )
    );
    const files = perConversation
        .flat()
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    res.json(files);
}

const uploadSchema = z.object({
    conversation_id: z.uuid(),
    name: z.string().min(1),
});

// Collects the raw request body into a Buffer, aborting once it passes the cap.
// The body is the file's bytes verbatim: callers send a non-JSON content type
// so the global express.json() leaves the stream untouched for us to read here.
function readRequestBody(req: express.Request, maxBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        req.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) {
                req.destroy();
                reject(new Error("too large"));
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

// Shared by POST and DELETE: uploads mirror reading the conversation — for an
// existing one the user must be able to see it; a not-yet-created conversation
// (the client generated its id and the first message creates the row tied to
// this user) may be touched by any authenticated user.
async function checkUploadAccess(
    req: express.Request,
    res: express.Response,
    conversationId: string,
    name: string
): Promise<boolean> {
    if (!isValidFileName(name)) {
        res.status(400).json({ error: "Invalid file name" });
        return false;
    }

    const user = await getSessionUser(req);
    if (!user) {
        res.status(401).json({ error: "Not authenticated" });
        return false;
    }

    const conversation = await findMessage(conversationId);
    if (conversation) {
        const isMember = await isAgentMember(conversation.agentId, user.id);
        if (!canAccessConversation(conversation, user.id, isMember)) {
            res.status(403).json({ error: "Not allowed to access this conversation" });
            return false;
        }
    }
    return true;
}

// Upload a file into a conversation's uploads folder (pasted-content
// attachments and chat images). The name and conversation ride in the query
// string; the body is the raw file bytes (any non-JSON content type). Orphaned
// uploads — uploaded but never sent — are bounded by the per-conversation cap.
export const POST: express.RequestHandler = async (req, res) => {
    const parsed = uploadSchema.safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }
    const { conversation_id, name } = parsed.data;
    if (!(await checkUploadAccess(req, res, conversation_id, name))) return;

    let data: Buffer;
    try {
        data = await readRequestBody(req, MAX_UPLOAD_BYTES);
    } catch {
        res.status(413).json({ error: `File too large; the limit is ${MAX_UPLOAD_BYTES} bytes` });
        return;
    }
    if (data.byteLength === 0) {
        res.status(400).json({ error: "Empty file" });
        return;
    }

    try {
        const file = await writeConversationFileBytes(
            conversation_id,
            name,
            data,
            MAX_UPLOAD_BYTES,
            "upload"
        );
        res.status(201).json({
            conversationId: conversation_id,
            name: file.name,
            size: file.size,
            updatedAt: file.updatedAt,
            source: file.source,
        });
    } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Upload failed" });
    }
}

// Remove one upload (e.g. an image detached in the composer before sending).
// Only uploads are deletable this way: agent-written artifacts are managed by
// the agent's own tools and disappear with the conversation.
export const DELETE: express.RequestHandler = async (req, res) => {
    const parsed = uploadSchema.safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }
    const { conversation_id, name } = parsed.data;
    if (!(await checkUploadAccess(req, res, conversation_id, name))) return;

    const removed = await removeConversationUpload(conversation_id, name);
    if (!removed) {
        res.status(404).json({ error: "File not found" });
        return;
    }
    res.sendStatus(204);
}
