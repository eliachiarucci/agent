import { and, desc, eq, lte } from "drizzle-orm";
import { db } from "../global/db";
import { agents, cronJobRuns, cronJobs } from "../global/schema";

export type CronJob = typeof cronJobs.$inferSelect;
export type NewCronJob = typeof cronJobs.$inferInsert;
export type CronJobRun = typeof cronJobRuns.$inferSelect;
export type NewCronJobRun = typeof cronJobRuns.$inferInsert;

export async function createCronJob(data: NewCronJob): Promise<CronJob> {
  const [row] = await db.insert(cronJobs).values(data).returning();
  return row;
}

export async function getCronJob(id: string): Promise<CronJob | undefined> {
  return db.query.cronJobs.findFirst({ where: eq(cronJobs.id, id) });
}

export async function updateCronJob(
  id: string,
  changes: Partial<
    Pick<
      CronJob,
      | "title"
      | "prompt"
      | "daysOfWeek"
      | "time"
      | "recurrence"
      | "timezone"
      | "nextRunAt"
      | "provider"
      | "model"
    >
  >
): Promise<CronJob | undefined> {
  const [row] = await db.update(cronJobs).set(changes).where(eq(cronJobs.id, id)).returning();
  return row;
}

export async function deleteCronJob(id: string): Promise<CronJob | undefined> {
  const [row] = await db.delete(cronJobs).where(eq(cronJobs.id, id)).returning();
  return row;
}

/** The user's jobs with the agent name the UI lists them under. */
export async function listCronJobsForUser(
  userId: string
): Promise<Array<CronJob & { agentName: string }>> {
  const rows = await db
    .select({ job: cronJobs, agentName: agents.name })
    .from(cronJobs)
    .innerJoin(agents, eq(agents.id, cronJobs.agentId))
    .where(eq(cronJobs.userId, userId))
    .orderBy(desc(cronJobs.createdAt));
  return rows.map((r) => ({ ...r.job, agentName: r.agentName }));
}

export async function findDueCronJobs(now: Date): Promise<CronJob[]> {
  return db.query.cronJobs.findMany({ where: lte(cronJobs.nextRunAt, now) });
}

/**
 * Moves the job's nextRunAt forward, but only if it still holds the value this
 * scheduler tick saw — the run is skipped when another tick already claimed it.
 */
export async function claimCronJob(
  id: string,
  expectedNextRunAt: Date,
  nextRunAt: Date
): Promise<boolean> {
  const rows = await db
    .update(cronJobs)
    .set({ nextRunAt })
    .where(and(eq(cronJobs.id, id), eq(cronJobs.nextRunAt, expectedNextRunAt)))
    .returning();
  return rows.length > 0;
}

export async function createCronJobRun(data: NewCronJobRun): Promise<CronJobRun> {
  const [row] = await db.insert(cronJobRuns).values(data).returning();
  return row;
}

// What the popup's run history shows. Runs carry their own user/agent/prompt
// (they outlive their job — "once" jobs delete themselves after succeeding),
// so only the agent name needs joining in.
export type CronRunListItem = CronJobRun & { agentName: string };

export async function listCronRunsForUser(
  userId: string,
  limit = 100
): Promise<CronRunListItem[]> {
  const rows = await db
    .select({ run: cronJobRuns, agentName: agents.name })
    .from(cronJobRuns)
    .innerJoin(agents, eq(agents.id, cronJobRuns.agentId))
    .where(eq(cronJobRuns.userId, userId))
    .orderBy(desc(cronJobRuns.startedAt))
    .limit(limit);
  return rows.map((r) => ({ ...r.run, agentName: r.agentName }));
}
