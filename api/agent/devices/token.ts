import express from 'express';
import { z } from "zod";
import { updateDevice } from "../../../lib/db/devices";
import { resolveDeviceAccess } from "../../../lib/devices/access";
import { CLOSE_TOKEN_REVOKED, disconnectDevice } from "../../../lib/devices/gateway";
import { generateDeviceToken } from "../../../lib/devices/tokens";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'POST, OPTIONS');
    res.sendStatus(204);
}

// Rotates the device's token: the old one stops working at once (including the
// live connection) and the new one is in this response only.
export const POST: express.RequestHandler = async (req, res) => {
    const parsed = z.object({ id: z.uuid() }).safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const access = await resolveDeviceAccess(req, parsed.data.id, { owner: true });
    if (!access.ok) {
        res.status(access.status).json({ error: access.error });
        return;
    }

    const { token, hash } = generateDeviceToken();
    await updateDevice(parsed.data.id, { tokenHash: hash, tokenCreatedAt: new Date() });
    disconnectDevice(parsed.data.id, CLOSE_TOKEN_REVOKED, "Token rotated");
    res.json({ token });
}
