import express from 'express';
import { z } from "zod";
import { getSessionUser, resolveActor } from "../../lib/agent/actor";
import { createDevice, deleteDevice, listDevicesForUser, updateDevice } from "../../lib/db/devices";
import { deviceRole, publicDevice, resolveDeviceAccess } from "../../lib/devices/access";
import { removeDeviceFiles } from "../../lib/devices/frames";
import { CLOSE_DELETED, disconnectDevice, pushDeviceSettings } from "../../lib/devices/gateway";
import {
    DEFAULT_DEVICE_SETTINGS,
    deviceSettingsPatchSchema,
    mergeDeviceSettings,
    readDeviceSettings,
} from "../../lib/devices/settings";
import { generateDeviceToken } from "../../lib/devices/tokens";

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

const createSchema = z.object({
    name: z.string().trim().min(1).max(100),
    // The agent the device works for; defaults to the user's oldest agent.
    agent_id: z.uuid().optional(),
});

// Registers a device. The token is in this response only: store it on the
// device (the server keeps just its hash).
export const POST: express.RequestHandler = async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const actor = await resolveActor(req, parsed.data.agent_id);
    if (!actor.ok) {
        res.status(actor.status).json({ error: actor.error });
        return;
    }

    const { token, hash } = generateDeviceToken();
    const device = await createDevice({
        ownerId: actor.user.id,
        agentId: actor.agent.id,
        name: parsed.data.name,
        tokenHash: hash,
        settings: DEFAULT_DEVICE_SETTINGS,
    });
    res.status(201).json({ device: publicDevice(device, "owner"), token });
}

const updateSchema = z.object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(100).optional(),
    agent_id: z.uuid().optional(),
    settings: deviceSettingsPatchSchema.optional(),
});

export const PATCH: express.RequestHandler = async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }
    const { id, name, agent_id, settings } = parsed.data;

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
    const device = await updateDevice(id, { name, agentId: agent_id, settings: merged });
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
    res.status(204).end();
}
