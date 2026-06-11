import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { nextOccurrence, nextRunAfter } from "../../lib/agent/cron-schedule";
import {
  claimCronJob,
  createCronJob,
  createCronJobRun,
  deleteCronJob,
  findDueCronJobs,
  getCronJob,
  listCronJobsForUser,
  listCronRunsForUser,
} from "../../lib/db/cron";
import { closeDb, makeUserWithAgent, resetDb } from "../helpers/db";

describe("cron schedule math", () => {
  // Wednesday, June 10 2026, 12:00 UTC.
  const wednesday = new Date("2026-06-10T12:00:00Z");
  const monday9 = {
    daysOfWeek: [1],
    time: "09:00",
    recurrence: "weekly" as const,
    timezone: "UTC",
  };

  it("finds the next weekday occurrence after a given instant", () => {
    expect(nextOccurrence(monday9, wednesday)).toEqual(new Date("2026-06-15T09:00:00Z"));
  });

  it("with several days, picks whichever comes first", () => {
    // Monday + Thursday from a Wednesday → Thursday June 11 first.
    const monThu = { ...monday9, daysOfWeek: [1, 4] };
    expect(nextOccurrence(monThu, wednesday)).toEqual(new Date("2026-06-11T09:00:00Z"));
  });

  it("rolls to next week when today's slot has already passed", () => {
    const wednesday9 = { ...monday9, daysOfWeek: [3] };
    // 12:00 on Wednesday is past the 09:00 slot.
    expect(nextOccurrence(wednesday9, wednesday)).toEqual(new Date("2026-06-17T09:00:00Z"));
    // 08:00 on Wednesday is before it — runs today.
    expect(nextOccurrence(wednesday9, new Date("2026-06-10T08:00:00Z"))).toEqual(
      new Date("2026-06-10T09:00:00Z")
    );
  });

  it("advances by recurrence: weekly, biweekly, and first-weekday-of-next-month", () => {
    const run = new Date("2026-06-15T09:00:00Z"); // a Monday
    expect(nextRunAfter(monday9, run)).toEqual(new Date("2026-06-22T09:00:00Z"));
    expect(nextRunAfter({ ...monday9, recurrence: "biweekly" }, run)).toEqual(
      new Date("2026-06-29T09:00:00Z")
    );
    // First Monday of July 2026 is the 6th.
    expect(nextRunAfter({ ...monday9, recurrence: "monthly" }, run)).toEqual(
      new Date("2026-07-06T09:00:00Z")
    );
  });

  it("biweekly with several days finishes the current week, then skips one", () => {
    const monThuBiweekly = {
      ...monday9,
      daysOfWeek: [1, 4],
      recurrence: "biweekly" as const,
    };
    // Monday June 15 ran → Thursday the 18th is the same week, still on.
    const monday = new Date("2026-06-15T09:00:00Z");
    expect(nextRunAfter(monThuBiweekly, monday)).toEqual(new Date("2026-06-18T09:00:00Z"));
    // Thursday June 18 ran (week exhausted) → skip a week → Monday the 29th.
    const thursday = new Date("2026-06-18T09:00:00Z");
    expect(nextRunAfter(monThuBiweekly, thursday)).toEqual(new Date("2026-06-29T09:00:00Z"));
  });

  it("keeps the wall-clock time across a DST change", () => {
    // EU DST ends Sunday Oct 25 2026: Rome goes from UTC+2 to UTC+1 at 03:00.
    const sunday9Rome = {
      daysOfWeek: [0],
      time: "09:00",
      recurrence: "weekly" as const,
      timezone: "Europe/Rome",
    };
    const beforeSwitch = new Date("2026-10-18T08:00:00Z"); // Sun Oct 18, 10:00 Rome (slot passed)
    // Next Sunday 09:00 Rome is after the switch → 08:00 UTC, not 07:00.
    expect(nextOccurrence(sunday9Rome, beforeSwitch)).toEqual(new Date("2026-10-25T08:00:00Z"));
  });

  it("rejects malformed times and empty day sets", () => {
    expect(() => nextOccurrence({ ...monday9, time: "9am" }, wednesday)).toThrow(/HH:MM/);
    expect(() => nextOccurrence({ ...monday9, daysOfWeek: [] }, wednesday)).toThrow(/empty/);
  });
});

describe("cron job storage", () => {
  beforeEach(resetDb);
  afterAll(closeDb);

  const schedule = {
    prompt: "Summarize the week",
    daysOfWeek: [1],
    time: "09:00",
    recurrence: "weekly" as const,
    timezone: "UTC",
  };

  it("lists a user's jobs with the agent name, and only theirs", async () => {
    const alice = await makeUserWithAgent("Alice");
    const bob = await makeUserWithAgent("Bob");
    await createCronJob({
      ...schedule,
      agentId: alice.agent.id,
      userId: alice.user.id,
      nextRunAt: new Date("2026-06-15T09:00:00Z"),
    });

    const aliceJobs = await listCronJobsForUser(alice.user.id);
    expect(aliceJobs).toHaveLength(1);
    expect(aliceJobs[0]).toMatchObject({
      prompt: "Summarize the week",
      agentName: "Alice's agent",
    });
    expect(await listCronJobsForUser(bob.user.id)).toEqual([]);
  });

  it("finds due jobs and the claim is a one-winner compare-and-swap", async () => {
    const { user, agent } = await makeUserWithAgent("Alice");
    const due = new Date("2026-06-15T09:00:00Z");
    const job = await createCronJob({
      ...schedule,
      agentId: agent.id,
      userId: user.id,
      nextRunAt: due,
    });

    expect(await findDueCronJobs(new Date("2026-06-15T09:01:00Z"))).toHaveLength(1);
    expect(await findDueCronJobs(new Date("2026-06-15T08:59:00Z"))).toHaveLength(0);

    const next = new Date("2026-06-22T09:00:00Z");
    expect(await claimCronJob(job.id, due, next)).toBe(true);
    // A second tick that saw the same nextRunAt loses the claim.
    expect(await claimCronJob(job.id, due, next)).toBe(false);
    expect((await getCronJob(job.id))?.nextRunAt).toEqual(next);
  });

  it("run history carries prompt and agent name, scoped to the owner, and survives job deletion", async () => {
    const alice = await makeUserWithAgent("Alice");
    const bob = await makeUserWithAgent("Bob");
    const job = await createCronJob({
      ...schedule,
      agentId: alice.agent.id,
      userId: alice.user.id,
      nextRunAt: new Date("2026-06-15T09:00:00Z"),
    });
    await createCronJobRun({
      jobId: job.id,
      userId: alice.user.id,
      agentId: alice.agent.id,
      prompt: job.prompt,
      status: "error",
      error: "model unavailable",
      startedAt: new Date("2026-06-15T09:00:05Z"),
      finishedAt: new Date("2026-06-15T09:00:06Z"),
    });

    const runs = await listCronRunsForUser(alice.user.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "error",
      error: "model unavailable",
      prompt: "Summarize the week",
      agentName: "Alice's agent",
      conversationId: null,
    });
    expect(await listCronRunsForUser(bob.user.id)).toEqual([]);

    // Runs are self-contained history: deleting the job (which "once" jobs do
    // automatically after succeeding) keeps the run, detached from the job.
    await deleteCronJob(job.id);
    const after = await listCronRunsForUser(alice.user.id);
    expect(after).toHaveLength(1);
    expect(after[0].jobId).toBeNull();
  });
});
