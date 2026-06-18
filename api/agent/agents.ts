import express from 'express';
import { z } from "zod";
import { PROVIDER_TYPES } from "../../lib/global/providers";
import { getSessionUser } from "../../lib/agent/actor";
import { removeConversationFiles } from "../../lib/agent/files";
import { findConversationIds } from "../../lib/db/conversations";
import {
    createAgent,
    deleteAgent,
    getAgent,
    listAgentsForUser,
    updateAgent,
} from "../../lib/db/agents";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.sendStatus(204);
}

// Lists the agents the user can talk to (their own and ones shared with them),
// each with the user's role.
export const GET: express.RequestHandler = async (req, res) => {
    const user = await getSessionUser(req);
    if (!user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    res.json(await listAgentsForUser(user.id));
}

const createSchema = z.object({
    name: z.string().min(1),
});

export const POST: express.RequestHandler = async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const user = await getSessionUser(req);
    if (!user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    const agent = await createAgent({ name: parsed.data.name, ownerId: user.id });
    res.status(201).json(agent);
}

const updateSchema = z
    .object({
        id: z.uuid(),
        name: z.string().min(1).optional(),
        // null/empty clears the prompt back to "no custom instructions".
        system_prompt: z.string().nullable().optional(),
        // The background memory extractor's model. Set as a pair (null on both
        // resets to the env-configured default model).
        memory_provider: z.enum(PROVIDER_TYPES).nullable().optional(),
        memory_model: z.string().min(1).nullable().optional(),
    })
    .refine(
        (d) =>
            d.name !== undefined ||
            d.system_prompt !== undefined ||
            d.memory_provider !== undefined ||
            d.memory_model !== undefined,
        { message: "Nothing to update" }
    );

export const PATCH: express.RequestHandler = async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const user = await getSessionUser(req);
    if (!user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    const agent = await getAgent(parsed.data.id);
    if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
    if (agent.ownerId !== user.id) {
        res.status(403).json({ error: "Only the owner can update an agent" });
        return;
    }

    const { name, system_prompt, memory_provider, memory_model } = parsed.data;
    res.json(
        await updateAgent(agent.id, {
            ...(name !== undefined && { name }),
            ...(system_prompt !== undefined && { systemPrompt: system_prompt?.trim() || null }),
            ...(memory_provider !== undefined && { memoryProvider: memory_provider }),
            ...(memory_model !== undefined && { memoryModel: memory_model }),
        })
    );
}

// Deleting an agent cascades to its memories, conversations, and memberships.
export const DELETE: express.RequestHandler = async (req, res) => {
    const parsed = z.object({ id: z.uuid() }).safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const user = await getSessionUser(req);
    if (!user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    const agent = await getAgent(parsed.data.id);
    if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
    if (agent.ownerId !== user.id) {
        res.status(403).json({ error: "Only the owner can delete an agent" });
        return;
    }

    // Conversation ids must be collected before the cascade wipes the rows;
    // their file folders are not tracked in the database.
    const conversationIds = await findConversationIds({ agentId: agent.id });
    await deleteAgent(agent.id);
    await Promise.all(conversationIds.map(removeConversationFiles));
    res.status(204).end();
}
