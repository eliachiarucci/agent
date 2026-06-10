import express from 'express';
import { z } from "zod";
import { getSessionUser } from "../../lib/agent/actor";
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

const updateSchema = z.object({
    id: z.uuid(),
    name: z.string().min(1),
});

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
        res.status(403).json({ error: "Only the owner can rename an agent" });
        return;
    }

    res.json(await updateAgent(agent.id, { name: parsed.data.name }));
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

    await deleteAgent(agent.id);
    res.status(204).end();
}
