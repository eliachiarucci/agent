import express from 'express';
import { z } from "zod";
import { latestObservation } from "../../../lib/db/devices";
import { resolveDeviceAccess } from "../../../lib/devices/access";
import { deviceLinkStatus } from "../../../lib/devices/gateway";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'GET, OPTIONS');
    res.sendStatus(204);
}

// Link state, what the device last reported, and its newest observation.
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
    res.json({
        ...deviceLinkStatus(device.id),
        lastSeenAt: device.lastSeenAt,
        hello: device.hello,
        telemetry: device.telemetry,
        lastObservation: (await latestObservation(device.id)) ?? null,
    });
}
