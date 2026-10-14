import express from 'express';
import { z } from "zod";
import { deleteDeviceTrigger, listDeviceTriggers } from "../../../lib/db/device-triggers";
import { resolveDeviceAccess } from "../../../lib/devices/access";
import { logTrigger } from "../../../lib/devices/triggers";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'GET, DELETE, OPTIONS');
    res.sendStatus(204);
}

// What the device's agent set aside (plan 4.12): reminders and watches, the
// soonest first. Anyone who can see the device can list them.
export const GET: express.RequestHandler = async (req, res) => {
    const parsed = z.object({ id: z.uuid() }).safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }
    const access = await resolveDeviceAccess(req, parsed.data.id);
    if (!access.ok) {
        res.status(access.status).json({ error: access.error });
        return;
    }
    const { device } = access;
    res.json(device.agentId ? await listDeviceTriggers(device.id, device.agentId) : []);
}

// The owner removes one.
export const DELETE: express.RequestHandler = async (req, res) => {
    const parsed = z.object({ id: z.uuid(), trigger: z.uuid() }).safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }
    const access = await resolveDeviceAccess(req, parsed.data.id, { owner: true });
    if (!access.ok) {
        res.status(access.status).json({ error: access.error });
        return;
    }
    const { device } = access;
    const active = device.agentId ? await listDeviceTriggers(device.id, device.agentId) : [];
    const trigger = active.find((t) => t.id === parsed.data.trigger);
    const removed = trigger && (await deleteDeviceTrigger(trigger.id));
    if (!removed) {
        res.status(404).json({ error: "Trigger not found" });
        return;
    }
    await logTrigger(device.id, "cancelled", removed, { by: access.user.id });
    res.status(204).end();
}
