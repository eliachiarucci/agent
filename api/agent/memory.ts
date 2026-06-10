import express from 'express';
import { z } from "zod";
import { MEMORY_CATEGORIES } from "../../lib/global/schema";
import { resolveActor } from "../../lib/agent/actor";
import {
    createMemory,
    deleteMemory,
    findMemories,
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
    agent_id: z.uuid().optional(),
});

export const GET: express.RequestHandler = async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const { q, category, pinned, limit, agent_id } = parsed.data;

    const actor = await resolveActor(req, agent_id);
    if (!actor.ok) {
        res.status(actor.status).json({ error: actor.error });
        return;
    }

    // Substring match rather than searchMemories: semantic search ranks every
    // memory (useless as a browse filter) and bumps lastAccessedAt, which would
    // let UI typing distort the agent's recency-weighted retrieval.
    const memories = await findMemories(actor.agent.id, { contains: q, category, pinned, limit });

    res.json(memories.map(toJson));
}

const createSchema = z.object({
    content: z.string().min(1),
    importance: z.number().min(0).max(1),
    category: categorySchema,
    pinned: z.boolean().optional(),
    // null = shared fact about the group; defaults to the acting user.
    subject_user_id: z.uuid().nullable().optional(),
    agent_id: z.uuid().optional(),
});

export const POST: express.RequestHandler = async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const { agent_id, subject_user_id, ...data } = parsed.data;

    const actor = await resolveActor(req, agent_id);
    if (!actor.ok) {
        res.status(actor.status).json({ error: actor.error });
        return;
    }

    const memory = await createMemory({
        ...data,
        agentId: actor.agent.id,
        subjectUserId: subject_user_id === undefined ? actor.user.id : subject_user_id,
        createdBy: actor.user.id,
    });
    res.status(201).json(toJson(memory));
}

const updateSchema = z.object({
    id: z.uuid(),
    content: z.string().min(1).optional(),
    importance: z.number().min(0).max(1).optional(),
    category: categorySchema.optional(),
    pinned: z.boolean().optional(),
    subject_user_id: z.uuid().nullable().optional(),
    agent_id: z.uuid().optional(),
});

export const PATCH: express.RequestHandler = async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const { id, agent_id, subject_user_id, ...changes } = parsed.data;

    const actor = await resolveActor(req, agent_id);
    if (!actor.ok) {
        res.status(actor.status).json({ error: actor.error });
        return;
    }

    const memory = await updateMemory(actor.agent.id, id, {
        ...changes,
        ...(subject_user_id !== undefined ? { subjectUserId: subject_user_id } : {}),
    });
    if (!memory) {
        res.status(404).json({ error: "Memory not found" });
        return;
    }

    res.json(toJson(memory));
}

export const DELETE: express.RequestHandler = async (req, res) => {
    const parsed = z
        .object({ id: z.uuid(), agent_id: z.uuid().optional() })
        .safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const actor = await resolveActor(req, parsed.data.agent_id);
    if (!actor.ok) {
        res.status(actor.status).json({ error: actor.error });
        return;
    }

    const deleted = await deleteMemory(actor.agent.id, parsed.data.id);
    if (!deleted) {
        res.status(404).json({ error: "Memory not found" });
        return;
    }

    res.status(204).end();
}
