import express from 'express';
import { z } from "zod";
import { embedText } from "../../../lib/global/ai";
import { listObservations, searchObservations } from "../../../lib/db/devices";
import { resolveDeviceAccess } from "../../../lib/devices/access";
import { publicObservation } from "../../../lib/devices/live";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'GET, OPTIONS');
    res.sendStatus(204);
}

const querySchema = z.object({
    device_id: z.uuid(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    // Paging: observations captured strictly before this instant.
    before: z.coerce.date().optional(),
    // Only observations whose caption scored at least this salience.
    min_salience: z.coerce.number().min(0).max(1).optional(),
    // Semantic search over the captions: results come best match first, each
    // with its `relevance`, instead of newest first.
    q: z.string().trim().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
});

// The device's timeline, newest first. Each frame image is served by
// GET /agent/devices/frame?id=<observation id> while it is kept (hasFrame).
export const GET: express.RequestHandler = async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }
    const { device_id, min_salience, q, ...query } = parsed.data;

    const access = await resolveDeviceAccess(req, device_id);
    if (!access.ok) {
        res.status(access.status).json({ error: access.error });
        return;
    }

    const filter = { deviceId: device_id, minSalience: min_salience, ...query };
    if (q) {
        const rows = await searchObservations({ ...filter, vector: await embedText(q, "query") });
        res.json(rows.map(({ relevance, ...row }) => ({ ...publicObservation(row), relevance })));
        return;
    }
    res.json((await listObservations(filter)).map(publicObservation));
}
