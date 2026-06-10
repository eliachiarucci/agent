import express from 'express';
import { getSessionUser } from "../../lib/agent/actor";
import { listUsers } from "../../lib/db/users";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'GET, OPTIONS');
    res.sendStatus(204);
}

// Directory for the share picker. Accounts are created through Better Auth's
// signup flow (/agent/auth/*), not here. Only safe-to-share fields are exposed.
export const GET: express.RequestHandler = async (req, res) => {
    const user = await getSessionUser(req);
    if (!user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    const users = await listUsers();
    res.json(users.map(({ id, name, username }) => ({ id, name, username })));
}
