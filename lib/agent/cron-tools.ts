import { tool } from "ai";
import { z } from "zod";
import { CRON_RECURRENCES, type ProviderType } from "../global/schema";
import {
  createCronJob,
  deleteCronJob,
  getCronJob,
  listCronJobsForUser,
  updateCronJob,
  type CronJob,
} from "../db/cron";
import { nextOccurrence, wallClockInZone } from "./cron-schedule";

/**
 * Per-request context for the scheduling tools. Jobs are created for the
 * current agent as the current user; the timezone comes from the user's
 * browser (chat request body) so "tomorrow at 9" means their 9 o'clock.
 * provider/model is the chat's current model — new jobs run on it too.
 */
export type CronToolScope = {
  agentId: string;
  userId: string;
  timezone: string;
  provider?: ProviderType;
  model?: string;
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const daysOfWeekSchema = z
  .array(z.number().int().min(0).max(6))
  .min(1)
  .describe("Days the job runs on: 0 = Sunday … 6 = Saturday. One or more.");

const timeSchema = z
  .string()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/)
  .describe('Time of day as "HH:MM" (24h) in the user\'s timezone.');

const atSchema = z
  .string()
  .describe(
    'Absolute first-run datetime as ISO 8601 with timezone offset, e.g. "2026-06-12T09:00:00+02:00". Only for one-time reminders; preferred over days_of_week/time when the user names a specific date.'
  );

// What the model gets back; enough to report the schedule and reference the
// job later without leaking internals.
function describeJob(job: CronJob) {
  return {
    id: job.id,
    title: job.title,
    prompt: job.prompt,
    recurrence: job.recurrence,
    days: job.daysOfWeek.map((d) => DAY_NAMES[d]),
    time: job.time,
    timezone: job.timezone,
    next_run: job.nextRunAt.toISOString(),
  };
}

// Resolves schedule input (either absolute `at` or days+time) to the stored
// fields + first run. Throws with a model-readable message on bad input.
function resolveSchedule(
  input: { days_of_week?: number[]; time?: string; at?: string; recurrence: string },
  timezone: string
): { daysOfWeek: number[]; time: string; nextRunAt: Date } {
  if (input.at !== undefined) {
    if (input.recurrence !== "once") throw new Error('"at" is only valid for recurrence "once"');
    const at = new Date(input.at);
    if (Number.isNaN(at.getTime())) throw new Error(`Could not parse datetime "${input.at}"`);
    if (at.getTime() <= Date.now()) throw new Error(`"${input.at}" is in the past`);
    const wallClock = wallClockInZone(at, timezone);
    return { daysOfWeek: [wallClock.dayOfWeek], time: wallClock.time, nextRunAt: at };
  }
  if (input.days_of_week === undefined || input.time === undefined) {
    throw new Error("Provide either at, or days_of_week and time");
  }
  const daysOfWeek = [...new Set(input.days_of_week)].sort((a, b) => a - b);
  const nextRunAt = nextOccurrence(
    { daysOfWeek, time: input.time, recurrence: "weekly", timezone },
    new Date()
  );
  return { daysOfWeek, time: input.time, nextRunAt };
}

// Ownership gate shared by update/delete: the job must belong to this user
// and this agent (tools never reach across agents).
async function findOwnJob(scope: CronToolScope, id: string): Promise<CronJob | null> {
  const job = await getCronJob(id);
  if (!job || job.userId !== scope.userId || job.agentId !== scope.agentId) return null;
  return job;
}

export function buildCronTools(scope: CronToolScope) {
  return {
    scheduleJob: tool({
      description:
        'Schedule a prompt to run later: recurring jobs (weekly/biweekly/monthly) or one-time reminders (recurrence "once", deleted after they run). At the scheduled time the prompt is executed by an assistant like you — with the same memory and tools — and the result is saved as a new conversation for the user. Phrase the prompt as an instruction to that future assistant, e.g. "Remind Elia to call his mother" or "Search the web for this week\'s F1 results and summarize them".',
      inputSchema: z.object({
        title: z
          .string()
          .min(1)
          .describe("Short display name for the job (3-6 words), shown in the user's job list."),
        prompt: z.string().min(1).describe("The instruction the future run executes."),
        recurrence: z.enum(CRON_RECURRENCES),
        days_of_week: daysOfWeekSchema.optional(),
        time: timeSchema.optional(),
        at: atSchema.optional(),
      }),
      execute: async ({ title, prompt, recurrence, ...schedule }) => {
        try {
          const resolved = resolveSchedule({ ...schedule, recurrence }, scope.timezone);
          const job = await createCronJob({
            agentId: scope.agentId,
            userId: scope.userId,
            title,
            prompt,
            recurrence,
            timezone: scope.timezone,
            provider: scope.provider ?? null,
            model: scope.model ?? null,
            ...resolved,
          });
          return { scheduled: describeJob(job) };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      },
    }),

    listScheduledJobs: tool({
      description:
        "List the user's scheduled jobs and reminders on this assistant, with their ids and next run times. Use it before updating or canceling, or when the user asks what is scheduled.",
      inputSchema: z.object({}),
      execute: async () => {
        const jobs = await listCronJobsForUser(scope.userId);
        return jobs.filter((j) => j.agentId === scope.agentId).map(describeJob);
      },
    }),

    updateScheduledJob: tool({
      description:
        "Change an existing scheduled job or reminder (prompt, schedule, or recurrence). Use the id from listScheduledJobs. Omitted fields keep their current value; pass days_of_week/time or at to move the schedule.",
      inputSchema: z.object({
        id: z.uuid(),
        title: z.string().min(1).optional(),
        prompt: z.string().min(1).optional(),
        recurrence: z.enum(CRON_RECURRENCES).optional(),
        days_of_week: daysOfWeekSchema.optional(),
        time: timeSchema.optional(),
        at: atSchema.optional(),
      }),
      execute: async ({ id, title, prompt, recurrence, ...schedule }) => {
        const job = await findOwnJob(scope, id);
        if (!job) return { error: "Job not found" };
        try {
          const rescheduled =
            schedule.at !== undefined ||
            schedule.days_of_week !== undefined ||
            schedule.time !== undefined;
          const resolved = rescheduled
            ? resolveSchedule(
                {
                  days_of_week: schedule.days_of_week ?? job.daysOfWeek,
                  time: schedule.time ?? job.time,
                  at: schedule.at,
                  recurrence: recurrence ?? job.recurrence,
                },
                job.timezone
              )
            : {};
          const updated = await updateCronJob(job.id, {
            ...(title !== undefined && { title }),
            ...(prompt !== undefined && { prompt }),
            ...(recurrence !== undefined && { recurrence }),
            ...resolved,
          });
          return { updated: describeJob(updated!) };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      },
    }),

    cancelScheduledJob: tool({
      description:
        "Delete a scheduled job or reminder the user no longer wants. Use the id from listScheduledJobs.",
      inputSchema: z.object({ id: z.uuid() }),
      execute: async ({ id }) => {
        const job = await findOwnJob(scope, id);
        if (!job) return { error: "Job not found" };
        await deleteCronJob(job.id);
        return { canceled: job.prompt };
      },
    }),
  };
}

// Stable per session (the browser sends the same timezone on every request),
// so the prompt prefix stays KV-cache friendly.
export function buildCronToolsPrompt(timezone: string): string {
  return [
    "## Scheduled jobs and reminders",
    `You can schedule prompts to run later with the scheduleJob tool — recurring jobs or one-time reminders (recurrence "once"). The user's timezone is ${timezone}; all times you pass are interpreted in it. When the user asks to be reminded of something or wants a task done on a schedule, use the tools rather than saying you cannot. The scheduled prompt runs with your memory and tools and its result appears as a new conversation; phrase prompts as instructions to that future run. Use listScheduledJobs to look up ids before updating or canceling.`,
  ].join("\n");
}
