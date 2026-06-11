import express from 'express';
import { getSessionUser } from "../../../lib/agent/actor";
import { listCronRunsForUser } from "../../../lib/db/cron";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'GET, OPTIONS');
    res.sendStatus(204);
}

// Run history across all of the user's jobs, newest first; each run carries
// its job's prompt and agent name so the list reads on its own.
export const GET: express.RequestHandler = async (req, res) => {
    const user = await getSessionUser(req);
    if (!user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    res.json(await listCronRunsForUser(user.id));
}
