import express from 'express';
import { z } from "zod";
import { updateDevice } from "../../../lib/db/devices";
import { resolveDeviceAccess } from "../../../lib/devices/access";
import { generatePairingCode } from "../../../lib/devices/tokens";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'POST, DELETE, OPTIONS');
    res.sendStatus(204);
}

// A new pairing code for the device (setting it up again, or on another
// machine); any earlier code stops working. The device's current token keeps
// working until the code is used.
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

    const pairing = generatePairingCode();
    await updateDevice(parsed.data.id, { pairingCodeHash: pairing.hash, pairingExpiresAt: pairing.expiresAt });
    res.json({ code: pairing.code, expiresAt: pairing.expiresAt });
}

// Withdraws an unused pairing code.
export const DELETE: express.RequestHandler = async (req, res) => {
    const parsed = z.object({ id: z.uuid() }).safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const access = await resolveDeviceAccess(req, parsed.data.id, { owner: true });
    if (!access.ok) {
        res.status(access.status).json({ error: access.error });
        return;
    }

    await updateDevice(parsed.data.id, { pairingCodeHash: null, pairingExpiresAt: null });
    res.status(204).end();
}
