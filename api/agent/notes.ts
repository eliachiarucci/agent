import express from 'express';
import { z } from "zod";
import { resolveActor } from "../../lib/agent/actor";
import { isValidNoteTitle } from "../../lib/agent/notes";
import {
    createNote,
    deleteNote,
    getNoteByTitle,
    listNotes,
    updateNote,
} from "../../lib/db/notes";

export const config = {}

const titleSchema = z
    .string()
    .refine(isValidNoteTitle, "Title must be a short single-line text (max 200 characters)");

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.sendStatus(204);
}

// Notes are agent-wide: every member of the agent sees and can edit the same
// list, mirroring what the in-chat note tools operate on.
export const GET: express.RequestHandler = async (req, res) => {
    const parsed = z.object({ agent_id: z.uuid().optional() }).safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const actor = await resolveActor(req, parsed.data.agent_id);
    if (!actor.ok) {
        res.status(actor.status).json({ error: actor.error });
        return;
    }

    res.json(await listNotes(actor.agent.id));
}

const createSchema = z.object({
    title: titleSchema,
    content: z.string(),
    agent_id: z.uuid().optional(),
});

export const POST: express.RequestHandler = async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const { agent_id, title, content } = parsed.data;

    const actor = await resolveActor(req, agent_id);
    if (!actor.ok) {
        res.status(actor.status).json({ error: actor.error });
        return;
    }

    // Titles are the agent-facing handle, so creation refuses duplicates
    // instead of silently making an ambiguous second note.
    if (await getNoteByTitle(actor.agent.id, title)) {
        res.status(409).json({ error: `A note titled "${title}" already exists` });
        return;
    }

    const note = await createNote({
        agentId: actor.agent.id,
        createdBy: actor.user.id,
        title,
        content,
    });
    res.status(201).json(note);
}

const updateSchema = z.object({
    id: z.uuid(),
    title: titleSchema.optional(),
    content: z.string().optional(),
    agent_id: z.uuid().optional(),
});

export const PATCH: express.RequestHandler = async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const { id, agent_id, ...changes } = parsed.data;

    const actor = await resolveActor(req, agent_id);
    if (!actor.ok) {
        res.status(actor.status).json({ error: actor.error });
        return;
    }

    if (changes.title !== undefined) {
        const existing = await getNoteByTitle(actor.agent.id, changes.title);
        if (existing && existing.id !== id) {
            res.status(409).json({ error: `A note titled "${changes.title}" already exists` });
            return;
        }
    }

    const note = await updateNote(actor.agent.id, id, changes);
    if (!note) {
        res.status(404).json({ error: "Note not found" });
        return;
    }

    res.json(note);
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

    const deleted = await deleteNote(actor.agent.id, parsed.data.id);
    if (!deleted) {
        res.status(404).json({ error: "Note not found" });
        return;
    }

    res.status(204).end();
}
