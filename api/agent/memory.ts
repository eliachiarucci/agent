import express from 'express';
import { z } from "zod";
import { MEMORY_CATEGORIES } from "../../lib/global/schema";
import { getSessionUser, resolveActor, type SessionUser } from "../../lib/agent/actor";
import { canAccessMemoryPool } from "../../lib/db/memory-pools";
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

type PoolResolution =
    | { ok: true; user: SessionUser; poolId: string | null }
    | { ok: false; status: number; error: string };

// Memories are scoped to a pool. Requests address one directly (pool_id —
// the Settings → Memory browser) or through an agent (agent_id / the default
// agent — the sidebar Memories dialog), which resolves to the agent's attached
// pool. poolId is null when the resolved agent has no pool attached.
async function resolvePool(
    req: express.Request,
    params: { pool_id?: string; agent_id?: string }
): Promise<PoolResolution> {
    if (params.pool_id !== undefined) {
        const user = await getSessionUser(req);
        if (!user) return { ok: false, status: 401, error: "Not authenticated" };
        // Missing and inaccessible pools are indistinguishable on purpose.
        if (!(await canAccessMemoryPool(params.pool_id, user.id))) {
            return { ok: false, status: 404, error: "Memory pool not found" };
        }
        return { ok: true, user, poolId: params.pool_id };
    }
    const actor = await resolveActor(req, params.agent_id);
    if (!actor.ok) return actor;
    return { ok: true, user: actor.user, poolId: actor.agent.memoryPoolId };
}

const querySchema = z.object({
    q: z.string().min(1).optional(),
    category: categorySchema.optional(),
    pinned: z.stringbool().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    agent_id: z.uuid().optional(),
    pool_id: z.uuid().optional(),
});

export const GET: express.RequestHandler = async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const { q, category, pinned, limit, agent_id, pool_id } = parsed.data;

    const resolved = await resolvePool(req, { pool_id, agent_id });
    if (!resolved.ok) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
    }
    // An agent without a pool has no memories — an empty browse, not an error.
    if (!resolved.poolId) {
        res.json([]);
        return;
    }

    // Substring match rather than searchMemories: semantic search ranks every
    // memory (useless as a browse filter) and bumps lastAccessedAt, which would
    // let UI typing distort the agent's recency-weighted retrieval.
    const memories = await findMemories(resolved.poolId, { contains: q, category, pinned, limit });

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
    pool_id: z.uuid().optional(),
});

export const POST: express.RequestHandler = async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const { agent_id, pool_id, subject_user_id, ...data } = parsed.data;

    const resolved = await resolvePool(req, { pool_id, agent_id });
    if (!resolved.ok) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
    }
    if (!resolved.poolId) {
        res.status(400).json({ error: "Agent has no memory pool attached" });
        return;
    }

    const memory = await createMemory({
        ...data,
        poolId: resolved.poolId,
        subjectUserId: subject_user_id === undefined ? resolved.user.id : subject_user_id,
        createdBy: resolved.user.id,
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
    pool_id: z.uuid().optional(),
});

export const PATCH: express.RequestHandler = async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const { id, agent_id, pool_id, subject_user_id, ...changes } = parsed.data;

    const resolved = await resolvePool(req, { pool_id, agent_id });
    if (!resolved.ok) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
    }

    const memory = resolved.poolId
        ? await updateMemory(resolved.poolId, id, {
              ...changes,
              ...(subject_user_id !== undefined ? { subjectUserId: subject_user_id } : {}),
          })
        : undefined;
    if (!memory) {
        res.status(404).json({ error: "Memory not found" });
        return;
    }

    res.json(toJson(memory));
}

export const DELETE: express.RequestHandler = async (req, res) => {
    const parsed = z
        .object({ id: z.uuid(), agent_id: z.uuid().optional(), pool_id: z.uuid().optional() })
        .safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const resolved = await resolvePool(req, parsed.data);
    if (!resolved.ok) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
    }

    const deleted = resolved.poolId
        ? await deleteMemory(resolved.poolId, parsed.data.id)
        : undefined;
    if (!deleted) {
        res.status(404).json({ error: "Memory not found" });
        return;
    }

    res.status(204).end();
}
