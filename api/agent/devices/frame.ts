import express from 'express';
import { z } from "zod";
import { getObservation } from "../../../lib/db/devices";
import { resolveDeviceAccess } from "../../../lib/devices/access";
import { frameFilePath } from "../../../lib/devices/frames";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'GET, OPTIONS');
    res.sendStatus(204);
}

// One observation's frame, as image/jpeg. Frames were checked to be JPEGs on
// arrival and never change, so they can be cached.
export const GET: express.RequestHandler = async (req, res) => {
    const parsed = z.object({ id: z.uuid() }).safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const observation = await getObservation(parsed.data.id);
    if (!observation) {
        res.status(404).json({ error: "Frame not found" });
        return;
    }
    const access = await resolveDeviceAccess(req, observation.deviceId);
    if (!access.ok) {
        // Someone who can't see the device can't learn the frame exists either.
        if (access.status === 401) res.status(401).json({ error: access.error });
        else res.status(404).json({ error: "Frame not found" });
        return;
    }
    if (!observation.frame) {
        res.status(404).json({ error: "Frame no longer kept" });
        return;
    }

    res.set({
        'Content-Type': 'image/jpeg',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=31536000, immutable',
    });
    res.sendFile(frameFilePath(observation.deviceId, observation.frame), (error) => {
        if (error && !res.headersSent) {
            res.removeHeader('Cache-Control');
            res.status(404).json({ error: "Frame not found" });
        }
    });
}
