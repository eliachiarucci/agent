import express from 'express';
import { z } from "zod";
import { completePairing, getDeviceByPairingCode } from "../../../lib/db/devices";
import { CLOSE_TOKEN_REVOKED, DEVICE_WS_PATH, disconnectDevice } from "../../../lib/devices/gateway";
import { generateDeviceToken, hashPairingCode } from "../../../lib/devices/tokens";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'POST, OPTIONS');
    res.sendStatus(204);
}

// Called by the device being set up, with the code shown on the Devices page:
// no session, the code is the credential (one use, 30 minutes, ~50 bits). It
// returns the device's new token, which replaces the old one, and the link's
// path on this server.
export const POST: express.RequestHandler = async (req, res) => {
    const parsed = z.object({ code: z.string().min(1).max(32) }).safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const codeHash = hashPairingCode(parsed.data.code);
    const device = await getDeviceByPairingCode(codeHash);
    const { token, hash } = generateDeviceToken();
    const paired = device && (await completePairing(device.id, codeHash, hash));
    if (!paired) {
        res.status(404).json({ error: "Unknown or expired pairing code" });
        return;
    }

    // Whatever ran with the old token is cut off.
    disconnectDevice(paired.id, CLOSE_TOKEN_REVOKED, "Paired again");
    res.json({ token, device: { id: paired.id, name: paired.name }, ws: DEVICE_WS_PATH });
}
