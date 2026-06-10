import express from 'express';
import { z } from "zod";
import { resolveActor } from "../../lib/agent/actor";
import { getUser } from "../../lib/db/users";
import {
    addAgentMember,
    listAgentMembers,
    removeAgentMember,
} from "../../lib/db/agents";

// Agent sharing. Granting membership means the new member can chat with the
// agent, read and contribute to its entire memory pool, and see its shared
// conversations (but not other members' private ones) — the UI should spell
// this out before the owner confirms.

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'GET, POST, DELETE, OPTIONS');
    res.sendStatus(204);
}

export const GET: express.RequestHandler = async (req, res) => {
    const parsed = z
        .object({ agent_id: z.uuid().optional() })
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

    res.json(await listAgentMembers(actor.agent.id));
}

// member_id is the user being granted access; the acting user comes from the session.
const addSchema = z.object({
    member_id: z.uuid(),
    agent_id: z.uuid().optional(),
});

export const POST: express.RequestHandler = async (req, res) => {
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const actor = await resolveActor(req, parsed.data.agent_id);
    if (!actor.ok) {
        res.status(actor.status).json({ error: actor.error });
        return;
    }
    if (actor.agent.ownerId !== actor.user.id) {
        res.status(403).json({ error: "Only the owner can share an agent" });
        return;
    }

    const member = await getUser(parsed.data.member_id);
    if (!member) {
        res.status(404).json({ error: "User to add not found" });
        return;
    }

    await addAgentMember(actor.agent.id, member.id);
    res.status(201).json(await listAgentMembers(actor.agent.id));
}

export const DELETE: express.RequestHandler = async (req, res) => {
    const parsed = z
        .object({
            member_id: z.uuid(),
            agent_id: z.uuid().optional(),
        })
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
    // Owners can remove anyone but themselves; members can remove themselves (leave).
    const removingSelf = parsed.data.member_id === actor.user.id;
    const isOwner = actor.agent.ownerId === actor.user.id;
    if (parsed.data.member_id === actor.agent.ownerId) {
        res.status(403).json({ error: "The owner cannot be removed from their agent" });
        return;
    }
    if (!isOwner && !removingSelf) {
        res.status(403).json({ error: "Only the owner can remove other members" });
        return;
    }

    const removed = await removeAgentMember(actor.agent.id, parsed.data.member_id);
    if (!removed) {
        res.status(404).json({ error: "Member not found" });
        return;
    }

    res.status(204).end();
}
