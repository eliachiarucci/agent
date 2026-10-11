import express from 'express';
import { z } from "zod";
import { resolveDeviceAccess } from "../../../lib/devices/access";
import { MAX_SPEECH_CHARS, speak } from "../../../lib/devices/speech";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'POST, OPTIONS');
    res.sendStatus(204);
}

const bodySchema = z.object({
    id: z.uuid(),
    text: z.string().trim().min(1).max(MAX_SPEECH_CHARS),
    // BCP-47; the device's default language when omitted.
    language: z.string().min(2).max(35).optional(),
});

// Says something through the device now. A person pressing a button isn't held
// to the agent's limits (mute, quiet hours, cooldown, hourly cap); the device
// only has to be online. Anyone who can see the device can use it, like its
// agent's members can make the agent speak. 409 when nothing was played.
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
    const result = await speak({
        device: access.device,
        text: parsed.data.text,
        language: parsed.data.language,
        source: "user",
        userId: access.user.id,
    });
    res.status(result.spoken ? 200 : 409).json(result);
}
