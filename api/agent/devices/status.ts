import express from 'express';
import { z } from "zod";
import { countCaptionCalls, latestCaptioned, latestObservation } from "../../../lib/db/devices";
import { resolveDeviceAccess } from "../../../lib/devices/access";
import { deviceLinkStatus } from "../../../lib/devices/gateway";
import { publicObservation } from "../../../lib/devices/live";
import { resolvePerceptionTarget } from "../../../lib/devices/perception-model";
import { readDeviceSettings } from "../../../lib/devices/settings";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'GET, OPTIONS');
    res.sendStatus(204);
}

const HOUR_MS = 60 * 60 * 1000;

// Link state, what the device last reported, its newest observation and
// caption, and where captioning stands (model, budget use).
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
    const { perception } = readDeviceSettings(device.settings);
    const [lastObservation, lastCaptioned, callsLastHour, target] = await Promise.all([
        latestObservation(device.id),
        latestCaptioned(device.id),
        countCaptionCalls(device.id, new Date(Date.now() - HOUR_MS)),
        resolvePerceptionTarget(device.ownerId, perception),
    ]);
    res.json({
        ...deviceLinkStatus(device.id),
        lastSeenAt: device.lastSeenAt,
        hello: device.hello,
        telemetry: device.telemetry,
        lastObservation: lastObservation ? publicObservation(lastObservation) : null,
        lastCaptioned: lastCaptioned ? publicObservation(lastCaptioned) : null,
        perception: {
            enabled: perception.enabled,
            model: target ? { provider: target.provider, model: target.modelId } : null,
            framesPerHour: perception.framesPerHour,
            callsLastHour,
            overBudget: callsLastHour >= perception.framesPerHour,
        },
    });
}
