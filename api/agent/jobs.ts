import express from 'express';
import { z } from "zod";
import { getSessionUser } from "../../lib/agent/actor";
import { nextOccurrence, wallClockInZone } from "../../lib/agent/cron-schedule";
import { isAgentMember } from "../../lib/db/agents";
import {
    createCronJob,
    deleteCronJob,
    getCronJob,
    listCronJobsForUser,
    updateCronJob,
} from "../../lib/db/cron";
import { getProviderSetting } from "../../lib/db/provider-settings";
import { CRON_RECURRENCES, PROVIDER_TYPES } from "../../lib/global/schema";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.sendStatus(204);
}

// The user's recurring jobs (with agent names), newest first.
export const GET: express.RequestHandler = async (req, res) => {
    const user = await getSessionUser(req);
    if (!user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    res.json(await listCronJobsForUser(user.id));
}

const createSchema = z
    .object({
        agent_id: z.uuid(),
        // Display name; omitted/empty → the runner generates one on the next run.
        title: z.string().optional(),
        prompt: z.string().min(1),
        // 0 = Sunday … 6 = Saturday.
        days_of_week: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
        time: z
            .string()
            .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Expected HH:MM")
            .optional(),
        recurrence: z.enum(CRON_RECURRENCES),
        // Absolute first-run instant — alternative to days_of_week + time,
        // only for one-time jobs (reminders like "tomorrow at 9").
        at: z.coerce.date().optional(),
        // IANA name from the creator's browser; verified against Intl below.
        timezone: z.string().min(1),
        // Model for the runs; omitted → the env-configured default (like a chat
        // request without a selection).
        provider: z.enum(PROVIDER_TYPES).optional(),
        model: z.string().min(1).optional(),
    })
    .refine((d) => d.at !== undefined || (d.days_of_week !== undefined && d.time !== undefined), {
        message: "Provide either at, or days_of_week and time",
    })
    .refine((d) => d.at === undefined || d.recurrence === "once", {
        message: "at is only valid for one-time jobs",
    });

export const POST: express.RequestHandler = async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }

    const user = await getSessionUser(req);
    if (!user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    const {
        agent_id,
        title,
        prompt,
        days_of_week,
        time,
        recurrence,
        at,
        timezone,
        provider,
        model,
    } = parsed.data;
    if (!(await isAgentMember(agent_id, user.id))) {
        res.status(403).json({ error: "Not a member of this agent" });
        return;
    }

    // Same checks as a chat request: the provider must be configured and a
    // model resolvable (explicit or the provider's stored default).
    if (provider) {
        const setting = await getProviderSetting(user.id, provider);
        if (!setting) {
            res.status(400).json({ error: `Provider "${provider}" is not configured` });
            return;
        }
        if (!model && !setting.settings.model) {
            res.status(400).json({ error: `No model selected for provider "${provider}"` });
            return;
        }
    }

    // An absolute `at` pins the run instant; its weekday/time (in the job's
    // timezone) become the stored schedule fields. Otherwise the first run is
    // the next occurrence of the selected days + time.
    let daysOfWeek: number[];
    let jobTime: string;
    let nextRunAt: Date;
    try {
        if (at) {
            if (at.getTime() <= Date.now()) {
                res.status(400).json({ error: "at must be in the future" });
                return;
            }
            const wallClock = wallClockInZone(at, timezone);
            daysOfWeek = [wallClock.dayOfWeek];
            jobTime = wallClock.time;
            nextRunAt = at;
        } else {
            daysOfWeek = [...new Set(days_of_week!)].sort((a, b) => a - b);
            jobTime = time!;
            nextRunAt = nextOccurrence({ daysOfWeek, time: jobTime, recurrence, timezone }, new Date());
        }
    } catch {
        // Intl throws on unknown timezone names.
        res.status(400).json({ error: `Unknown timezone "${timezone}"` });
        return;
    }

    const job = await createCronJob({
        agentId: agent_id,
        userId: user.id,
        title: title?.trim() || null,
        prompt,
        daysOfWeek,
        time: jobTime,
        recurrence,
        timezone,
        provider: provider ?? null,
        model: model ?? null,
        nextRunAt,
    });
    res.status(201).json(job);
}

const updateSchema = z.object({
    id: z.uuid(),
    // null or empty clears the title → the runner regenerates it on the next run.
    title: z.string().nullable().optional(),
    prompt: z.string().min(1).optional(),
    days_of_week: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    time: z
        .string()
        .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Expected HH:MM")
        .optional(),
    recurrence: z.enum(CRON_RECURRENCES).optional(),
    timezone: z.string().min(1).optional(),
    // null clears both back to the env default model.
    provider: z.enum(PROVIDER_TYPES).nullable().optional(),
    model: z.string().min(1).nullable().optional(),
});

export const PATCH: express.RequestHandler = async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
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
        res.status(403).json({ error: "Only the creator can update a job" });
        return;
    }

    const { title, prompt, days_of_week, time, recurrence, timezone, provider, model } =
        parsed.data;

    if (provider) {
        const setting = await getProviderSetting(user.id, provider);
        if (!setting) {
            res.status(400).json({ error: `Provider "${provider}" is not configured` });
            return;
        }
        if (!model && !setting.settings.model) {
            res.status(400).json({ error: `No model selected for provider "${provider}"` });
            return;
        }
    }

    // Any schedule field change reschedules the job from now.
    const rescheduled =
        days_of_week !== undefined ||
        time !== undefined ||
        recurrence !== undefined ||
        timezone !== undefined;
    const schedule = {
        daysOfWeek: days_of_week ? [...new Set(days_of_week)].sort((a, b) => a - b) : job.daysOfWeek,
        time: time ?? job.time,
        recurrence: recurrence ?? job.recurrence,
        timezone: timezone ?? job.timezone,
    };
    let nextRunAt: Date | undefined;
    if (rescheduled) {
        try {
            nextRunAt = nextOccurrence(schedule, new Date());
        } catch {
            res.status(400).json({ error: `Unknown timezone "${schedule.timezone}"` });
            return;
        }
    }

    const updated = await updateCronJob(job.id, {
        ...(title !== undefined && { title: title?.trim() || null }),
        ...(prompt !== undefined && { prompt }),
        ...(rescheduled && {
            daysOfWeek: schedule.daysOfWeek,
            time: schedule.time,
            recurrence: schedule.recurrence,
            timezone: schedule.timezone,
            nextRunAt,
        }),
        // provider: null clears the pair; provider set updates both.
        ...(provider !== undefined && { provider, model: provider === null ? null : model ?? null }),
    });
    res.json(updated);
}

export const DELETE: express.RequestHandler = async (req, res) => {
    const parsed = z.object({ id: z.uuid() }).safeParse(req.query);
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
        res.status(403).json({ error: "Only the creator can delete a job" });
        return;
    }

    await deleteCronJob(job.id);
    res.status(204).end();
}
