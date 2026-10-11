import express from 'express';
import { z } from "zod";
import { resolveDeviceAccess } from "../../../lib/devices/access";
import { deviceLinkStatus } from "../../../lib/devices/gateway";
import { subscribeLive, type LiveEvent } from "../../../lib/devices/live";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'GET, OPTIONS');
    res.sendStatus(204);
}

// Keeps proxies and the browser from timing out an idle stream.
const KEEPALIVE_MS = 25_000;

// Server-sent events for one device: `status` (online or not; sent first),
// `observation` (a frame arrived), `caption` (its caption settled), `deleted`.
// Each event's data is the JSON of the event.
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

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    const send = (event: LiveEvent) => {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        if (event.type === "deleted") res.end();
    };
    send({ type: "status", online: deviceLinkStatus(parsed.data.id).online });

    const unsubscribe = subscribeLive(parsed.data.id, send);
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
    res.on("close", () => {
        unsubscribe();
        clearInterval(keepalive);
    });
}
