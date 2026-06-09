import express from 'express';
import { z } from "zod";
import { MEMORY_CATEGORIES } from "../../lib/global/schema";
import {
    createMemory,
    deleteMemory,
    findMemories,
    searchMemories,
    updateMemory,
    type Memory,
} from "../../lib/db/memories";

export const config = {}

// The raw embedding vector is an implementation detail; keep it out of API responses.
const toJson = ({ embedding, ...rest }: Memory & { score?: number }) => rest;

const categorySchema = z.enum(MEMORY_CATEGORIES);

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.sendStatus(204);
}

const querySchema = z.object({
    q: z.string().min(1).optional(),
    category: categorySchema.optional(),
    pinned: z.stringbool().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const GET: express.RequestHandler = async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const { q, category, pinned, limit } = parsed.data;

    const memories = q !== undefined
        ? await searchMemories(q, { category, limit })
        : await findMemories({ category, pinned, limit });

    res.json(memories.map(toJson));
}

const createSchema = z.object({
    content: z.string().min(1),
    importance: z.number().min(0).max(1),
    category: categorySchema,
    pinned: z.boolean().optional(),
});

export const POST: express.RequestHandler = async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const memory = await createMemory(parsed.data);
    res.status(201).json(toJson(memory));
}

const updateSchema = z.object({
    id: z.uuid(),
    content: z.string().min(1).optional(),
    importance: z.number().min(0).max(1).optional(),
    category: categorySchema.optional(),
    pinned: z.boolean().optional(),
});

export const PATCH: express.RequestHandler = async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const { id, ...changes } = parsed.data;
    const memory = await updateMemory(id, changes);
    if (!memory) {
        res.status(404).json({ error: "Memory not found" });
        return;
    }

    res.json(toJson(memory));
}

export const DELETE: express.RequestHandler = async (req, res) => {
    const parsed = z.object({ id: z.uuid() }).safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const deleted = await deleteMemory(parsed.data.id);
    if (!deleted) {
        res.status(404).json({ error: "Memory not found" });
        return;
    }

    res.status(204).end();
}
