import express from 'express';
import { z } from "zod";
import {
    countCaptionCalls,
    countDeviceEvents,
    latestCaptioned,
    latestObservation,
    listDeviceEvents,
} from "../../../lib/db/devices";
import { resolveRunModel } from "../../../lib/agent/device-run";
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
// caption, where captioning and agent runs stand (model, budget use), and
// the last thing said.
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
    const { perception, agent, speech } = readDeviceSettings(device.settings);
    const hourAgo = new Date(Date.now() - HOUR_MS);
    const [
        lastObservation,
        lastCaptioned,
        callsLastHour,
        target,
        runModel,
        runsLastHour,
        [lastRun],
        spokenLastHour,
        [lastSpeech],
    ] = await Promise.all([
        latestObservation(device.id),
        latestCaptioned(device.id),
        countCaptionCalls(device.id, hourAgo),
        resolvePerceptionTarget(device.ownerId, perception),
        resolveRunModel(device.ownerId, agent),
        countDeviceEvents(device.id, "run", hourAgo, ["done", "failed"]),
        listDeviceEvents({ deviceId: device.id, kind: "run", limit: 1 }),
        countDeviceEvents(device.id, "speech", hourAgo, ["spoken"]),
        listDeviceEvents({ deviceId: device.id, kind: "speech", limit: 1 }),
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
        agent: {
            enabled: agent.enabled,
            model: runModel ? { provider: runModel.provider, model: runModel.modelId } : null,
            runsPerHour: agent.runsPerHour,
            runsLastHour,
            lastRun: lastRun ?? null,
        },
        speech: {
            muted: speech.muted,
            provider: speech.provider,
            maxPerHour: speech.maxPerHour,
            spokenLastHour,
            lastSpeech: lastSpeech ?? null,
        },
    });
}
