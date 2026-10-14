import express from 'express';
import { z } from "zod";
import { getSessionUser, resolveActor, type SessionUser } from "../../lib/agent/actor";
import { createAgentOnPool, getDefaultAgentForUser, listAgentMembers, type Agent } from "../../lib/db/agents";
import { getMemoryPool } from "../../lib/db/memory-pools";
import { deviceRunner } from "../../lib/devices/runner";
import { createDevice, deleteDevice, listDevicesForUser, updateDevice } from "../../lib/db/devices";
import { deviceRole, publicDevice, resolveDeviceAccess } from "../../lib/devices/access";
import { removeDeviceFiles } from "../../lib/devices/frames";
import { CLOSE_DELETED, disconnectDevice, pushDeviceSettings } from "../../lib/devices/gateway";
import { publishLive } from "../../lib/devices/live";
import { perceptionWorker } from "../../lib/devices/perception";
import {
    DEFAULT_DEVICE_SETTINGS,
    deviceSettingsPatchSchema,
    deviceSettingsSchema,
    mergeDeviceSettings,
    readDeviceSettings,
} from "../../lib/devices/settings";
import { generateDeviceToken, generatePairingCode } from "../../lib/devices/tokens";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.sendStatus(204);
}

// Devices the user owns or can see through one of their agents, each with the
// user's role and whether it is connected right now.
export const GET: express.RequestHandler = async (req, res) => {
    const user = await getSessionUser(req);
    if (!user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    const rows = await listDevicesForUser(user.id);
    res.json(
        await Promise.all(rows.map(async (device) => publicDevice(device, (await deviceRole(device, user.id))!)))
    );
}

const DESCRIPTION = z.string().trim().max(1000);

const createSchema = z
    .object({
        name: z.string().trim().min(1).max(100),
        // What the device is and what it's for; agents read it.
        description: DESCRIPTION.optional(),
        // An existing agent for the device to work for. Without it, a new agent
        // named after the device is created (plan 4.6, D3).
        agent_id: z.uuid().optional(),
        // The new agent's memory pool (one the user owns); defaults to the pool
        // of the user's default agent, the Personal Assistant.
        memory_pool_id: z.uuid().optional(),
        // IANA zone for the daily log and quiet hours; the server's when omitted.
        timezone: deviceSettingsSchema.shape.timezone.optional(),
    })
    .refine((d) => !(d.agent_id && d.memory_pool_id), {
        message: "memory_pool_id only applies to a new agent; leave out agent_id",
    });

// Registers a device. The response has a pairing code to type on the device
// (POST /agent/devices/pair trades it for a token), and the token itself for
// scripts that set the device up directly; both are in this response only
// (the server keeps just their hashes).
export const POST: express.RequestHandler = async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }
    const { name, description, agent_id, memory_pool_id, timezone } = parsed.data;

    let agent: Agent;
    let user: SessionUser;
    if (agent_id) {
        const actor = await resolveActor(req, agent_id);
        if (!actor.ok) {
            res.status(actor.status).json({ error: actor.error });
            return;
        }
        ({ agent, user } = actor);
    } else {
        const sessionUser = await getSessionUser(req);
        if (!sessionUser) {
            res.status(401).json({ error: "Not authenticated" });
            return;
        }
        user = sessionUser;
        let poolId: string | null;
        let memberIds: string[] = [];
        if (memory_pool_id) {
            const pool = await getMemoryPool(memory_pool_id);
            if (!pool || pool.ownerId !== user.id) {
                res.status(404).json({ error: "Memory pool not found" });
                return;
            }
            poolId = pool.id;
        } else {
            // The Personal Assistant's pool, shared with the same people, so
            // `remember` can name them and they see what the device stores.
            const personal = await getDefaultAgentForUser(user.id);
            poolId = personal?.memoryPoolId ?? null;
            if (personal) memberIds = (await listAgentMembers(personal.id)).map((m) => m.userId);
        }
        agent = await createAgentOnPool({ name, ownerId: user.id, memoryPoolId: poolId, memberIds });
    }

    const { token, hash } = generateDeviceToken();
    const pairing = generatePairingCode();
    const device = await createDevice({
        ownerId: user.id,
        agentId: agent.id,
        name,
        description: description || null,
        tokenHash: hash,
        pairingCodeHash: pairing.hash,
        pairingExpiresAt: pairing.expiresAt,
        settings: { ...DEFAULT_DEVICE_SETTINGS, timezone: timezone ?? null },
    });
    res.status(201).json({
        device: publicDevice(device, "owner"),
        agent: { id: agent.id, name: agent.name, memoryPoolId: agent.memoryPoolId },
        token,
        pairing: { code: pairing.code, expiresAt: pairing.expiresAt },
    });
}

const updateSchema = z.object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(100).optional(),
    // null or "" clears it.
    description: DESCRIPTION.nullable().optional(),
    agent_id: z.uuid().optional(),
    settings: deviceSettingsPatchSchema.optional(),
});

export const PATCH: express.RequestHandler = async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }
    const { id, name, description, agent_id, settings } = parsed.data;

    const access = await resolveDeviceAccess(req, id, { owner: true });
    if (!access.ok) {
        res.status(access.status).json({ error: access.error });
        return;
    }

    // Moving the device to another agent needs membership there too.
    if (agent_id !== undefined) {
        const actor = await resolveActor(req, agent_id);
        if (!actor.ok) {
            res.status(actor.status).json({ error: actor.error });
            return;
        }
    }

    const merged = settings && mergeDeviceSettings(readDeviceSettings(access.device.settings), settings);
    const device = await updateDevice(id, {
        name,
        description: description === undefined ? undefined : description || null,
        agentId: agent_id,
        settings: merged,
    });
    if (!device) {
        res.status(404).json({ error: "Device not found" });
        return;
    }
    if (merged) pushDeviceSettings(id, merged);
    res.json(publicDevice(device, "owner"));
}

export const DELETE: express.RequestHandler = async (req, res) => {
    const parsed = z.object({ id: z.uuid() }).safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const access = await resolveDeviceAccess(req, parsed.data.id, { owner: true });
    if (!access.ok) {
        res.status(access.status).json({ error: access.error });
        return;
    }

    disconnectDevice(parsed.data.id, CLOSE_DELETED, "Device deleted");
    await deleteDevice(parsed.data.id);
    await removeDeviceFiles(parsed.data.id);
    perceptionWorker.forget(parsed.data.id);
    deviceRunner.forget(parsed.data.id);
    publishLive(parsed.data.id, { type: "deleted" });
    res.status(204).end();
}
