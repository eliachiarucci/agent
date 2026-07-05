import express from 'express';
import { z } from "zod";
import { getSessionUser } from "../../lib/agent/actor";
import {
    createMemoryPool,
    deleteMemoryPool,
    getMemoryPool,
    listMemoryPoolsForUser,
} from "../../lib/db/memory-pools";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.sendStatus(204);
}

// The user's own pools, each with its memory count and the agents attached to
// it (feeds the Settings → Memory tab).
export const GET: express.RequestHandler = async (req, res) => {
    const user = await getSessionUser(req);
    if (!user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    res.json(await listMemoryPoolsForUser(user.id));
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

    const pool = await createMemoryPool({ name: parsed.data.name.trim(), ownerId: user.id });
    res.status(201).json({ ...pool, memoryCount: 0, agents: [] });
}

// Deleting a pool permanently deletes every memory in it and detaches any
// agents using it (their memory turns off until another pool is attached).
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

    const pool = await getMemoryPool(parsed.data.id);
    if (!pool) {
        res.status(404).json({ error: "Memory pool not found" });
        return;
    }
    if (pool.ownerId !== user.id) {
        res.status(403).json({ error: "Only the owner can delete a memory pool" });
        return;
    }

    await deleteMemoryPool(pool.id);
    res.status(204).end();
}
