import express from 'express';
import { z } from "zod";
import { resolveConversationViewer } from "../../../lib/agent/actor";
import { conversationFilePath, isValidFileName } from "../../../lib/agent/files";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'GET, OPTIONS');
    res.sendStatus(204);
}

const querySchema = z.object({
    conversation_id: z.uuid(),
    name: z.string().min(1),
});

export const GET: express.RequestHandler = async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }
    const { conversation_id, name } = parsed.data;

    if (!isValidFileName(name)) {
        res.status(400).json({ error: "Invalid file name" });
        return;
    }

    const access = await resolveConversationViewer(req, conversation_id);
    if (!access.ok) {
        res.status(access.status).json({ error: access.error });
        return;
    }

    // res.download sets Content-Disposition: attachment, so the browser saves
    // the file instead of rendering it (no HTML/script execution on our origin).
    res.download(conversationFilePath(conversation_id, name), name, (error) => {
        if (error && !res.headersSent) {
            res.status(404).json({ error: "File not found" });
        }
    });
}
