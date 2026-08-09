import express from 'express';
import { z } from "zod";
import { resolveConversationViewer } from "../../../lib/agent/actor";
import {
    FILE_SOURCES,
    isValidFileName,
    readConversationFile,
    statConversationFile,
} from "../../../lib/agent/files";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'GET, OPTIONS');
    res.sendStatus(204);
}

const querySchema = z.object({
    conversation_id: z.uuid(),
    name: z.string().min(1),
    // Which folder the file lives in: agent-written artifacts (default) or
    // user uploads (chat images, pasted attachments).
    source: z.enum(FILE_SOURCES).default("agent"),
});

// File content as JSON, for the UI's file viewer. The viewer polls this while
// open and compares updatedAt to refresh the rendering when the agent edits
// the file; download stays on /agent/files/download (attachment headers).
export const GET: express.RequestHandler = async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }
    const { conversation_id, name, source } = parsed.data;

    if (!isValidFileName(name)) {
        res.status(400).json({ error: "Invalid file name" });
        return;
    }

    const access = await resolveConversationViewer(req, conversation_id);
    if (!access.ok) {
        res.status(access.status).json({ error: access.error });
        return;
    }

    // Stat first, then read: updatedAt must not be newer than the content it
    // describes, or the viewer would skip the next change.
    const file = await statConversationFile(conversation_id, name, source);
    const content = file && (await readConversationFile(conversation_id, name, source));
    if (!file || content === null) {
        res.status(404).json({ error: "File not found" });
        return;
    }

    res.json({ name, content, size: file.size, updatedAt: file.updatedAt });
}
