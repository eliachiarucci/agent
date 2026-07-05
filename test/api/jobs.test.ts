import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { serverUrl } from "../config";
import { TestClient } from "../helpers/client";
import { signUp } from "../helpers/auth";
import { closeDb, resetDb } from "../helpers/db";
import { createCronJobRun, findDueCronJobs, getCronJob } from "../../lib/db/cron";
import { removeAgentMember } from "../../lib/db/agents";

const BASE = serverUrl("api");

const validJob = (agentId: string) => ({
  agent_id: agentId,
  prompt: "Summarize my week",
  days_of_week: [1, 4],
  time: "09:00",
  recurrence: "weekly",
  timezone: "UTC",
});

async function userWithAgent(name: string) {
  const client = new TestClient(BASE);
  const user = await signUp(client, name);
  const agentId: string = (await client.get("/agent/agents")).body[0].id;
  return { client, user, agentId };
}

beforeEach(resetDb);
afterAll(closeDb);

describe("POST /agent/jobs", () => {

  it("creates a job with a future nextRunAt", async () => {
    const { client, user, agentId } = await userWithAgent("Alice");

    const res = await client.post("/agent/jobs", validJob(agentId));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      agentId,
      userId: user.id,
      prompt: "Summarize my week",
      daysOfWeek: [1, 4],
      time: "09:00",
      recurrence: "weekly",
      timezone: "UTC",
      provider: null,
      model: null,
    });
    const nextRunAt = new Date(res.body.nextRunAt);
    expect(nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect([1, 4]).toContain(nextRunAt.getUTCDay());
    expect(await getCronJob(res.body.id)).toBeDefined();
  });

  it("creates one-time jobs from an absolute datetime", async () => {
    const { client, agentId } = await userWithAgent("Alice");
    const at = new Date(Date.now() + 60 * 60 * 1000); // in one hour
    const res = await client.post("/agent/jobs", {
      agent_id: agentId,
      prompt: "Remind Alice to stretch",
      recurrence: "once",
      at: at.toISOString(),
      timezone: "UTC",
    });
    expect(res.status).toBe(201);
    expect(new Date(res.body.nextRunAt)).toEqual(at);
    // Schedule fields are derived from the instant (in the job's timezone).
    expect(res.body.daysOfWeek).toEqual([at.getUTCDay()]);

    // `at` must be in the future and is only valid for one-time jobs.
    const past = await client.post("/agent/jobs", {
      agent_id: agentId,
      prompt: "p",
      recurrence: "once",
      at: new Date(Date.now() - 1000).toISOString(),
      timezone: "UTC",
    });
    expect(past.status).toBe(400);
    const weeklyAt = await client.post("/agent/jobs", {
      agent_id: agentId,
      prompt: "p",
      recurrence: "weekly",
      at: at.toISOString(),
      timezone: "UTC",
    });
    expect(weeklyAt.status).toBe(400);
  });

  it("stores the ask-tool policy, defaulting to deny", async () => {
    const { client, agentId } = await userWithAgent("Alice");

    const defaulted = await client.post("/agent/jobs", validJob(agentId));
    expect(defaulted.status).toBe(201);
    expect(defaulted.body.askPolicy).toBe("deny");

    const allowed = await client.post("/agent/jobs", {
      ...validJob(agentId),
      ask_policy: "allow",
    });
    expect(allowed.status).toBe(201);
    expect(allowed.body.askPolicy).toBe("allow");

    const invalid = await client.post("/agent/jobs", {
      ...validJob(agentId),
      ask_policy: "sometimes",
    });
    expect(invalid.status).toBe(400);
  });

  it("rejects a model provider the user has not configured", async () => {
    const { client, agentId } = await userWithAgent("Alice");
    const res = await client.post("/agent/jobs", {
      ...validJob(agentId),
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
    });
    expect(res.status).toBe(400);
  });

  it("requires authentication, agent membership, and a real timezone", async () => {
    const { agentId } = await userWithAgent("Alice");

    const anonymous = new TestClient(BASE);
    expect((await anonymous.post("/agent/jobs", validJob(agentId))).status).toBe(401);

    const { client: outsider } = await userWithAgent("Outsider");
    expect((await outsider.post("/agent/jobs", validJob(agentId))).status).toBe(403);

    const { client, agentId: ownAgent } = await userWithAgent("Bob");
    const badTz = await client.post("/agent/jobs", {
      ...validJob(ownAgent),
      timezone: "Mars/Olympus_Mons",
    });
    expect(badTz.status).toBe(400);
    const badTime = await client.post("/agent/jobs", { ...validJob(ownAgent), time: "25:00" });
    expect(badTime.status).toBe(400);
  });
});

describe("PATCH /agent/jobs", () => {
  it("updates fields, reschedules on schedule changes, and clears the title", async () => {
    const alice = await userWithAgent("Alice");
    const { body: job } = await alice.client.post("/agent/jobs", {
      ...validJob(alice.agentId),
      title: "Weekly summary",
    });
    expect(job.title).toBe("Weekly summary");

    // Prompt-only update: schedule (and nextRunAt) untouched.
    const promptOnly = await alice.client.patch("/agent/jobs", {
      id: job.id,
      prompt: "Summarize my month",
    });
    expect(promptOnly.status).toBe(200);
    expect(promptOnly.body).toMatchObject({
      prompt: "Summarize my month",
      title: "Weekly summary",
      nextRunAt: job.nextRunAt,
    });

    // Schedule change recomputes nextRunAt; clearing the title (null) lets the
    // runner regenerate it.
    const rescheduled = await alice.client.patch("/agent/jobs", {
      id: job.id,
      title: null,
      days_of_week: [2],
      time: "18:30",
    });
    expect(rescheduled.status).toBe(200);
    expect(rescheduled.body).toMatchObject({ title: null, daysOfWeek: [2], time: "18:30" });
    const nextRunAt = new Date(rescheduled.body.nextRunAt);
    expect(nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(nextRunAt.getUTCDay()).toBe(2);
  });

  it("pauses and resumes a job; the scheduler skips it while paused", async () => {
    const alice = await userWithAgent("Alice");
    const { body: job } = await alice.client.post("/agent/jobs", validJob(alice.agentId));
    expect(job.paused).toBe(false);

    const paused = await alice.client.patch("/agent/jobs", { id: job.id, paused: true });
    expect(paused.status).toBe(200);
    expect(paused.body.paused).toBe(true);
    // Even well past its nextRunAt, a paused job is invisible to the scheduler.
    const dueWhilePaused = await findDueCronJobs(new Date(Date.now() + 8 * 24 * 3600_000));
    expect(dueWhilePaused.some((j) => j.id === job.id)).toBe(false);

    const resumed = await alice.client.patch("/agent/jobs", { id: job.id, paused: false });
    expect(resumed.status).toBe(200);
    expect(resumed.body.paused).toBe(false);
    // Resuming pushes nextRunAt back into the future — no backlog run fires.
    expect(new Date(resumed.body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect((await findDueCronJobs(new Date())).some((j) => j.id === job.id)).toBe(false);
  });

  it("updates the ask-tool policy", async () => {
    const alice = await userWithAgent("Alice");
    const { body: job } = await alice.client.post("/agent/jobs", validJob(alice.agentId));
    expect(job.askPolicy).toBe("deny");

    const updated = await alice.client.patch("/agent/jobs", { id: job.id, ask_policy: "allow" });
    expect(updated.status).toBe(200);
    expect(updated.body.askPolicy).toBe("allow");
  });

  it("moves a job to another agent the creator is a member of", async () => {
    const alice = await userWithAgent("Alice");
    const { body: second } = await alice.client.post("/agent/agents", { name: "Second" });
    const { body: job } = await alice.client.post("/agent/jobs", validJob(alice.agentId));

    const moved = await alice.client.patch("/agent/jobs", { id: job.id, agent_id: second.id });
    expect(moved.status).toBe(200);
    expect(moved.body.agentId).toBe(second.id);

    // Not to an agent the creator has no membership in.
    const bob = await userWithAgent("Bob");
    const denied = await alice.client.patch("/agent/jobs", { id: job.id, agent_id: bob.agentId });
    expect(denied.status).toBe(403);
    expect((await getCronJob(job.id))?.agentId).toBe(second.id);
  });

  it("only the creator can update", async () => {
    const alice = await userWithAgent("Alice");
    const bob = await userWithAgent("Bob");
    const { body: job } = await alice.client.post("/agent/jobs", validJob(alice.agentId));

    expect((await bob.client.patch("/agent/jobs", { id: job.id, prompt: "x" })).status).toBe(403);
    expect(
      (await new TestClient(BASE).patch("/agent/jobs", { id: job.id, prompt: "x" })).status
    ).toBe(401);
    expect(
      (await alice.client.patch("/agent/jobs", { id: crypto.randomUUID(), prompt: "x" })).status
    ).toBe(404);
  });
});

describe("GET /agent/jobs and DELETE", () => {
  it("lists only the caller's jobs, newest first, with agent names", async () => {
    const alice = await userWithAgent("Alice");
    const bob = await userWithAgent("Bob");
    await alice.client.post("/agent/jobs", validJob(alice.agentId));

    const aliceList = await alice.client.get("/agent/jobs");
    expect(aliceList.status).toBe(200);
    expect(aliceList.body).toHaveLength(1);
    expect(aliceList.body[0]).toMatchObject({
      prompt: "Summarize my week",
      agentName: "Personal Assistant",
    });

    expect((await bob.client.get("/agent/jobs")).body).toEqual([]);
    expect((await new TestClient(BASE).get("/agent/jobs")).status).toBe(401);
  });

  it("only the creator can delete a job", async () => {
    const alice = await userWithAgent("Alice");
    const bob = await userWithAgent("Bob");
    const { body: job } = await alice.client.post("/agent/jobs", validJob(alice.agentId));

    expect((await bob.client.delete(`/agent/jobs?id=${job.id}`)).status).toBe(403);
    expect((await alice.client.delete(`/agent/jobs?id=${job.id}`)).status).toBe(204);
    expect((await alice.client.get("/agent/jobs")).body).toEqual([]);
    expect((await alice.client.delete(`/agent/jobs?id=${job.id}`)).status).toBe(404);
  });
});

describe("GET /agent/jobs/runs", () => {
  it("returns the caller's run history with job context", async () => {
    const alice = await userWithAgent("Alice");
    const bob = await userWithAgent("Bob");
    const { body: job } = await alice.client.post("/agent/jobs", validJob(alice.agentId));
    // Runs are produced by the scheduler; seed one directly.
    await createCronJobRun({
      jobId: job.id,
      userId: alice.user.id,
      agentId: alice.agentId,
      prompt: job.prompt,
      status: "success",
      startedAt: new Date(),
      finishedAt: new Date(),
    });

    const runs = await alice.client.get("/agent/jobs/runs");
    expect(runs.status).toBe(200);
    expect(runs.body).toHaveLength(1);
    expect(runs.body[0]).toMatchObject({
      jobId: job.id,
      status: "success",
      prompt: "Summarize my week",
      agentName: "Personal Assistant",
    });

    expect((await bob.client.get("/agent/jobs/runs")).body).toEqual([]);
    expect((await new TestClient(BASE).get("/agent/jobs/runs")).status).toBe(401);
  });
});

describe("POST /agent/jobs/trigger", () => {
  it("requires authentication and only the creator may trigger", async () => {
    const alice = await userWithAgent("Alice");
    const bob = await userWithAgent("Bob");
    const { body: job } = await alice.client.post("/agent/jobs", validJob(alice.agentId));

    const anonymous = new TestClient(BASE);
    expect((await anonymous.post("/agent/jobs/trigger", { id: job.id })).status).toBe(401);
    expect((await bob.client.post("/agent/jobs/trigger", { id: job.id })).status).toBe(403);
    expect(
      (await alice.client.post("/agent/jobs/trigger", { id: crypto.randomUUID() })).status
    ).toBe(404);
  });

  it("runs in the background and records the outcome as a run", async () => {
    const alice = await userWithAgent("Alice");
    const { body: job } = await alice.client.post("/agent/jobs", validJob(alice.agentId));
    // Sabotage the membership check so the run fails before reaching the model
    // (the api tier has no chat model); what's under test is the async
    // trigger → run-recorded pipeline, not generation.
    await removeAgentMember(alice.agentId, alice.user.id);

    const res = await alice.client.post("/agent/jobs/trigger", { id: job.id });
    expect(res.status).toBe(202);

    // The run is recorded asynchronously; poll briefly.
    let runs: any[] = [];
    for (let i = 0; i < 50 && runs.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      runs = (await alice.client.get("/agent/jobs/runs")).body;
    }
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      jobId: job.id,
      status: "error",
      error: expect.stringContaining("no longer a member"),
    });
    // A manual run never reschedules the job.
    expect((await getCronJob(job.id))?.nextRunAt).toEqual(new Date(job.nextRunAt));
  });
});
