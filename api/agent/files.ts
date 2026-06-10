import express from 'express';
import { z } from "zod";
import { resolveActor } from "../../lib/agent/actor";
import { listConversationFiles } from "../../lib/agent/files";
import { findConversationIds } from "../../lib/db/conversations";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'GET, OPTIONS');
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
