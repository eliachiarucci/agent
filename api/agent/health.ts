import express from 'express';
import { sql } from "drizzle-orm";
import { db } from "../../lib/global/db";

// Unauthenticated on purpose: used by the Docker healthcheck inside the
// container and by the CLI's readiness wait through the UI proxy. Leaks
// nothing beyond "the server can reach Postgres".
export const GET: express.RequestHandler = async (_req, res) => {
    try {
        await db.execute(sql`select 1`);
        res.json({ ok: true });
    } catch {
        res.status(503).json({ ok: false });
    }
};
