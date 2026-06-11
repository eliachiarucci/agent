import express from 'express';
import { z } from "zod";
import { getSessionUser } from "../../../lib/agent/actor";
import { runCronJob } from "../../../lib/agent/cron";
import { getCronJob } from "../../../lib/db/cron";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'POST, OPTIONS');
    res.sendStatus(204);
}

// Runs the job immediately, off-schedule: nextRunAt is untouched. The run
// happens in the background (model calls can outlive proxy timeouts), so this
// returns 202 right away; the run lands in the history when it finishes.
export const POST: express.RequestHandler = async (req, res) => {
    const parsed = z.object({ id: z.uuid() }).safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const user = await getSessionUser(req);
    if (!user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    const job = await getCronJob(parsed.data.id);
    if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
    }
    if (job.userId !== user.id) {
        res.status(403).json({ error: "Only the creator can trigger a job" });
        return;
    }

    // runCronJob records the outcome (success or error) as a run itself; only
    // a failure to even write that run row would surface here.
    runCronJob(job).catch((error) => console.error(`Manual run of job ${job.id} failed:`, error));
    res.status(202).json({ started: true });
}
