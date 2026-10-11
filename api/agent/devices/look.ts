import express from 'express';
import { z } from "zod";
import { resolveDeviceAccess } from "../../../lib/devices/access";
import { DeviceOfflineError, requestCapture } from "../../../lib/devices/gateway";
import { publicObservation } from "../../../lib/devices/live";
import { perceptionWorker } from "../../../lib/devices/perception";
import { deviceRunner } from "../../../lib/devices/runner";
import { readDeviceSettings } from "../../../lib/devices/settings";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'POST, OPTIONS');
    res.sendStatus(204);
}

const CAPTION_WAIT_MS = 30_000;

const bodySchema = z.object({
    id: z.uuid(),
    // Also wake the device's agent on this frame (a "look" trigger, plan 4.5).
    agent: z.boolean().default(true),
});

// A fresh frame and its caption now: asks the device for a frame, which is
// stored and captioned ahead of change frames, and waits for the caption.
// 409 when the device is offline, 504 when it doesn't answer in time.
export const POST: express.RequestHandler = async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
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

    let captured;
    try {
        captured = await requestCapture(device.id);
    } catch (error) {
        if (error instanceof DeviceOfflineError) {
            res.status(409).json({ error: error.message });
            return;
        }
        res.status(504).json({ error: error instanceof Error ? error.message : String(error) });
        return;
    }
    if (captured.kind !== "overview") {
        res.status(502).json({ error: "The device answered with a crop" });
        return;
    }

    const observation =
        (await perceptionWorker.waitFor(captured.observation.id, CAPTION_WAIT_MS)) ?? captured.observation;

    const { agent } = readDeviceSettings(device.settings);
    if (parsed.data.agent && agent.enabled && device.agentId) {
        deviceRunner.trigger(
            device.id,
            [{ kind: "look", at: new Date(), detail: `asked by ${access.user.name}`, observationId: observation.id }],
            agent.minGapSec * 1000
        );
    }
    res.json({ observation: publicObservation(observation) });
}
