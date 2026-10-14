import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { ToolExecutionOptions, UIMessage } from "ai";
import sharp from "sharp";

vi.mock("../../lib/global/ai", async () => {
  const { fakeEmbedding } = await import("../helpers/embeddings");
  return {
    embedText: async (text: string) => fakeEmbedding(text),
    chatModelFromSettings: () => {
      throw new Error("not used in these tests");
    },
  };
});
vi.mock("../../lib/agent/context", () => ({
  getContextWindow: vi.fn(async () => ({ model: "test", contextLength: 1_000_000, supportsImages: true })),
}));

import { executeDeviceRun, type DeviceRunDeps } from "../../lib/agent/device-run";
import { latestDeviceConversation } from "../../lib/db/conversations";
import { createDeviceTrigger, listDeviceTriggers } from "../../lib/db/device-triggers";
import {
  createDevice,
  insertObservation,
  listDeviceEvents,
  updateCaption,
  updateDevice,
  type Device,
} from "../../lib/db/devices";
import { captionFrame, type Caption } from "../../lib/devices/caption";
import { writeFrame } from "../../lib/devices/frames";
import { PerceptionWorker } from "../../lib/devices/perception";
import type { RunTrigger } from "../../lib/devices/run-triggers";
import { DeviceRunner } from "../../lib/devices/runner";
import { DEFAULT_DEVICE_SETTINGS, mergeDeviceSettings, type DeviceSettingsPatch } from "../../lib/devices/settings";
import { checkSpeechPolicy } from "../../lib/devices/speech-policy";
import { zonedInstant } from "../../lib/devices/time";
import { generateDeviceToken } from "../../lib/devices/tokens";
import { buildTriggerTools } from "../../lib/devices/trigger-tools";
import { MAX_ACTIVE_TRIGGERS, REPEAT_GAP_MS, dueTriggers, watchTriggers } from "../../lib/devices/triggers";
import { fakeEmbedding } from "../helpers/embeddings";
import { closeDb, makeUserWithAgent, resetDb } from "../helpers/db";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-triggers-"));
  process.env.FILES_DIR = root;
});
beforeEach(resetDb);
afterAll(async () => {
  await closeDb();
  await rm(root, { recursive: true, force: true });
});

const TZ = "Europe/Rome";
const options = { toolCallId: "call", messages: [] } as unknown as ToolExecutionOptions;

async function makeDevice(patch: DeviceSettingsPatch = {}) {
  const { user, agent } = await makeUserWithAgent("Elia");
  const device = await createDevice({
    ownerId: user.id,
    agentId: agent.id,
    name: "Dino",
    tokenHash: generateDeviceToken().hash,
    settings: mergeDeviceSettings(DEFAULT_DEVICE_SETTINGS, { timezone: TZ, ...patch }),
  });
  return { user, agent, device };
}

function tools(device: Device, now: Date, patch: DeviceSettingsPatch = {}) {
  const settings = mergeDeviceSettings(DEFAULT_DEVICE_SETTINGS, { timezone: TZ, ...patch });
  const built = buildTriggerTools({ device, settings, agentId: device.agentId!, timeZone: TZ, source: "voice", now: () => now });
  const call = (name: keyof typeof built, input: Record<string, unknown>) =>
    (built[name].execute as (input: unknown, options: ToolExecutionOptions) => Promise<any>)(input, options);
  return call;
}

const caption = (summary: string, extra: Partial<Caption> = {}): Caption => ({
  summary,
  changes: "none",
  entities: [],
  salience: 0.1,
  wake: "none",
  reason: "quiet",
  ...extra,
});

let seq = 0;
async function captioned(device: Device, value: Caption, capturedAt = new Date()) {
  const bytes = await sharp({ create: { width: 32, height: 18, channels: 3, background: "#4a6" } }).jpeg().toBuffer();
  const row = await insertObservation({
    deviceId: device.id,
    seq: seq++,
    trigger: "change",
    capturedAt,
    frame: await writeFrame(device.id, bytes),
    width: 32,
    height: 18,
    bytes: bytes.length,
  });
  return (await updateCaption(row.id, { captionStatus: "captioned", caption: value, captionedAt: new Date(), salience: value.salience }))!;
}

const watch = (device: Device, what: string, extra: Partial<Parameters<typeof createDeviceTrigger>[0]> = {}) =>
  createDeviceTrigger({
    deviceId: device.id,
    agentId: device.agentId!,
    kind: "seen",
    note: `Elia asked to be told when ${what} is in view. Tell them.`,
    what,
    expiresAt: new Date(Date.now() + 3600_000),
    source: "voice",
    ...extra,
  });

describe("trigger tools", () => {
  it("set reminders in the device's time zone, at least a minute ahead", async () => {
    const { device } = await makeDevice();
    // 17:30 in Rome.
    const now = zonedInstant("2026-10-14", "17:30", TZ);
    const call = tools(device, now);

    expect((await call("remindAt", { note: "Remind Elia to call Marco.", in_minutes: 10 })).set).toMatch(
      /: reminder at 17:40\. Note: Remind Elia to call Marco\.$/
    );
    // "HH:MM" is the next one: later today, or tomorrow when it has passed.
    expect((await call("remindAt", { note: "Dinner.", at: "19:00" })).set).toMatch(/reminder at 19:00\./);
    expect((await call("remindAt", { note: "Wake up.", at: "07:30" })).set).toMatch(/reminder at Thu, 15 Oct 2026 07:30\./);
    expect((await call("remindAt", { note: "Now.", in_minutes: 0 })).error).toBeDefined();
    expect((await call("remindAt", { note: "Soon.", at: "17:30" })).set).toMatch(/Thu, 15 Oct 2026 17:30/);
    expect((await call("remindAt", { note: "Past.", at: "2026-10-14 09:00" })).error).toBe(
      "A reminder must be at least a minute from now."
    );
    expect((await call("remindAt", { note: "Huh.", at: "soon" })).error).toMatch(/Couldn't read "soon"/);

    const active = await listDeviceTriggers(device.id, device.agentId!);
    expect(active.map((t) => t.note)).toEqual(["Remind Elia to call Marco.", "Dinner.", "Wake up.", "Soon."]);
    // A reminder that couldn't fire on time still has an hour.
    expect(active[0].expiresAt.getTime() - active[0].at!.getTime()).toBe(3600_000);
    const events = await listDeviceEvents({ deviceId: device.id, kind: "trigger", limit: 10 });
    expect(events.map((e) => e.detail?.status)).toEqual(["set", "set", "set", "set"]);
  });

  it("set watches for an hour by default, list and cancel them, and cap how many there are", async () => {
    const { device } = await makeDevice();
    const now = new Date();
    const call = tools(device, now);
    const set = await call("watchFor", { what: "a computer mouse", note: "Elia asked at 18:02 to be told when a mouse is in view." });
    expect(set.set).toMatch(/watch for "a computer mouse", once, until \d\d:\d\d\./);
    expect(set.note).toMatch(/up to 300 an hour/);
    const [t] = await listDeviceTriggers(device.id, device.agentId!);
    expect(t.expiresAt.getTime() - now.getTime()).toBe(3600_000);
    expect(t).toMatchObject({ kind: "seen", repeat: false, armed: true, source: "voice" });

    expect((await call("listTriggers", {})).triggers).toHaveLength(1);
    expect((await call("cancelTrigger", { id: "nope" })).error).toBeDefined();
    expect((await call("cancelTrigger", { id: t.id })).cancelled).toContain("a computer mouse");
    expect((await call("listTriggers", {})).triggers).toEqual([]);

    for (let i = 0; i < MAX_ACTIVE_TRIGGERS; i++) await call("remindAt", { note: `r${i}`, in_minutes: 5 + i });
    expect((await call("watchFor", { what: "a cat", note: "n" })).error).toMatch(/already 20 triggers/);
  });

  it("refuse a watch when nothing in view is checked", async () => {
    const { device } = await makeDevice();
    expect((await tools(device, new Date(), { perception: { enabled: false } })("watchFor", { what: "a cat", note: "n" })).error).toMatch(
      /Captioning is off/
    );
    const blind = { ...device, hello: { version: "x", capabilities: { audio: ["wav"] } } } as Device;
    expect((await tools(blind, new Date())("watchFor", { what: "a cat", note: "n" })).error).toBe("Dino has no camera.");
  });
});

describe("firing", () => {
  it("fire due reminders once, drop the ones too late, and end another agent's", async () => {
    const { device } = await makeDevice();
    const now = new Date();
    const base = { deviceId: device.id, agentId: device.agentId!, kind: "at" as const, source: "voice" as const };
    const due = await createDeviceTrigger({ ...base, note: "Tell Elia to call Marco.", at: new Date(now.getTime() - 5_000), expiresAt: new Date(now.getTime() + 3600_000) });
    await createDeviceTrigger({ ...base, note: "Later.", at: new Date(now.getTime() + 60_000), expiresAt: new Date(now.getTime() + 3660_000) });
    await createDeviceTrigger({ ...base, note: "Too late.", at: new Date(now.getTime() - 2 * 3600_000), expiresAt: new Date(now.getTime() - 3600_000) });

    const fired = await dueTriggers(now);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ deviceId: device.id, trigger: { kind: "trigger", triggerId: due.id } });
    expect(fired[0].trigger.detail).toMatch(/^reminder for \d\d:\d\d \(set \d\d:\d\d\)\. Your note: Tell Elia to call Marco\.$/);
    expect(await dueTriggers(now)).toEqual([]);
    expect((await listDeviceTriggers(device.id, device.agentId!)).map((t) => t.note)).toEqual(["Later."]);
    const events = await listDeviceEvents({ deviceId: device.id, kind: "trigger", limit: 10 });
    expect(events.map((e) => [e.detail?.status, e.detail?.note])).toEqual(
      expect.arrayContaining([["fired", "Tell Elia to call Marco."], ["expired", "Too late."]])
    );

    // The device moved to another agent: the old agent's reminder doesn't fire.
    const { agent: other } = await makeUserWithAgent("Otto");
    await createDeviceTrigger({ ...base, note: "Old agent.", at: new Date(now.getTime() - 1_000), expiresAt: new Date(now.getTime() + 3600_000) });
    await updateDevice(device.id, { agentId: other.id });
    expect(await dueTriggers(now)).toEqual([]);
    const [cancelled] = await listDeviceEvents({ deviceId: device.id, kind: "trigger", limit: 1 });
    expect(cancelled.detail).toMatchObject({ status: "cancelled", note: "Old agent." });
  });

  it("fire a watch when a caption shows it: once, or again after it was out of view", async () => {
    const { device } = await makeDevice();
    const once = await watch(device, "a computer mouse");
    const every = await watch(device, "a grey cat", { repeat: true });
    let now = new Date();

    const both = await captioned(device, caption("A mouse and a cat.", { watchHits: [once.id, every.id] }));
    const fired = await watchTriggers(device, both, now);
    expect(fired.map((t) => t.triggerId)).toEqual([once.id, every.id]);
    expect(fired[0]).toMatchObject({ kind: "trigger", observationId: both.id });
    expect(fired[0].detail).toMatch(/^watch for "a computer mouse" seen at \d\d:\d\d:\d\d \(set \d\d:\d\d; a one-time watch, now done\)\. Your note: /);
    expect(fired[1].detail).toMatch(/keeps watching until \d\d:\d\d/);
    // The one-time watch is gone; the repeating one waits until the cat is out of view.
    expect((await listDeviceTriggers(device.id, device.agentId!)).map((t) => [t.id, t.armed])).toEqual([[every.id, false]]);

    now = new Date(now.getTime() + REPEAT_GAP_MS + 1000);
    expect(await watchTriggers(device, await captioned(device, caption("The cat.", { watchHits: [every.id] })), now)).toEqual([]);
    expect(await watchTriggers(device, await captioned(device, caption("Empty.", { watchHits: [] })), now)).toEqual([]);
    const back = await watchTriggers(device, await captioned(device, caption("The cat again.", { watchHits: [every.id] })), now);
    expect(back.map((t) => t.triggerId)).toEqual([every.id]);

    // Back again too soon after firing: not yet.
    await watchTriggers(device, await captioned(device, caption("Empty.")), now);
    expect(await watchTriggers(device, await captioned(device, caption("Cat.", { watchHits: [every.id] })), new Date(now.getTime() + 1000))).toEqual([]);
    expect((await listDeviceTriggers(device.id, device.agentId!))[0].fired).toBe(2);
  });

  it("give the captioner the watches as short ids, and store its hits as the triggers' ids", async () => {
    const { device } = await makeDevice();
    const mouse = await watch(device, "a computer mouse");
    await watch(device, "a grey cat");
    let prompt = "";
    const model = new MockLanguageModelV3({
      provider: "mock",
      modelId: "mock-vision",
      doGenerate: async (opts) => {
        prompt = JSON.stringify(opts.prompt);
        return {
          content: [{ type: "text", text: JSON.stringify(caption("A mouse on the desk.", { watchHits: ["w1", "w9"] })) }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          warnings: [],
        };
      },
    });
    const worker = new PerceptionWorker({
      resolveTarget: async () => ({ provider: "lmstudio", modelId: "mock-vision", model }),
      caption: captionFrame,
      embed: async (text) => fakeEmbedding(text),
      now: () => new Date(),
    });
    const bytes = await sharp({ create: { width: 32, height: 18, channels: 3, background: "#456" } }).jpeg().toBuffer();
    const row = await insertObservation({
      deviceId: device.id,
      seq: seq++,
      trigger: "change",
      capturedAt: new Date(),
      frame: await writeFrame(device.id, bytes),
      width: 32,
      height: 18,
      bytes: bytes.length,
    });
    const settled = new Promise<Caption | null>((resolve) => worker.onSettled((_d, o) => resolve(o.caption)));
    worker.enqueue(device.id, row.id);
    const result = await settled;
    expect(prompt).toContain("Watches:\\nw1: a computer mouse\\nw2: a grey cat");
    expect(result?.watchHits).toEqual([mouse.id]);
  });
});

describe("trigger runs", () => {
  function runModel(text: string, calls: Array<{ toolName: string; input: unknown }> = []) {
    let call = 0;
    return new MockLanguageModelV3({
      provider: "mock",
      modelId: "mock-run",
      doGenerate: async () => {
        const first = call++ === 0;
        const stepCalls = first ? calls : [];
        return {
          content: [
            ...(stepCalls.length ? [] : [{ type: "text" as const, text }]),
            ...stepCalls.map((c, i) => ({ type: "tool-call" as const, toolCallId: `c${i}`, toolName: c.toolName, input: JSON.stringify(c.input) })),
          ],
          finishReason: stepCalls.length ? { unified: "tool-calls" as const, raw: "tool_calls" } : { unified: "stop" as const, raw: "stop" },
          usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
          warnings: [],
        };
      },
    });
  }
  function deps(model: MockLanguageModelV3, speech: Array<{ text: string; requested?: boolean }>): DeviceRunDeps {
    return {
      now: () => new Date(),
      resolveModel: async () => ({ model, provider: "lmstudio", modelId: "mock-run", target: { provider: "lmstudio", settings: {}, model: "mock-run" } }),
      speak: async ({ text, requested }) => {
        speech.push({ text, requested });
        return { spoken: true, durationMs: 1000, language: "en", voice: "v" };
      },
      capture: async () => {
        throw new Error("not used");
      },
    };
  }

  it("run on a trigger past the run budget, with the note, the list and speech they asked for", async () => {
    const { device } = await makeDevice({ agent: { runsPerHour: 1 } });
    const observation = await captioned(device, caption("Someone holds up a computer mouse.", { watchHits: [] }));
    await watch(device, "a grey cat");
    const look: RunTrigger[] = [{ kind: "look", at: new Date(), detail: "asked" }];
    const speech: Array<{ text: string; requested?: boolean }> = [];
    expect(await executeDeviceRun(device.id, look, deps(runModel("Looked."), speech))).toBe("done");
    expect(await executeDeviceRun(device.id, look, deps(runModel("Looked."), speech))).toBe("over_budget");

    const trigger: RunTrigger = {
      kind: "trigger",
      at: new Date(),
      detail: 'watch for "a computer mouse" seen at 18:02:11 (set 18:01; a one-time watch, now done). Your note: Elia asked to be told. Tell them.',
      observationId: observation.id,
      triggerId: "t1",
    };
    const model = runModel("Told Elia the mouse is in view.", [{ toolName: "speak", input: { text: "There's the mouse." } }]);
    expect(await executeDeviceRun(device.id, [trigger], deps(model, speech))).toBe("done");
    expect(speech).toEqual([{ text: "There's the mouse.", requested: true }]);

    const log = (await latestDeviceConversation(device.id))!;
    const context = (log.messages as UIMessage[]).filter((m) => m.role === "user").at(-1)!.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
    expect(context).toContain("- a trigger you set (");
    expect(context).toContain("Your note: Elia asked to be told. Tell them.");
    expect(context).toMatch(/<triggers>\nWhat you set aside \(cancelTrigger removes one\):\n- .+: watch for "a grey cat", once, until/);
    const system = JSON.stringify(model.doGenerateCalls[0].prompt[0]);
    expect(system).toContain("set it aside with remindAt or watchFor");
    expect(model.doGenerateCalls[0].tools?.map((t) => t.name)).toEqual(
      expect.arrayContaining(["remindAt", "watchFor", "listTriggers", "cancelTrigger"])
    );
  });

  it("let asked-for speech skip the cooldown and the hourly cap, not mute or quiet hours", () => {
    const speech = mergeDeviceSettings(DEFAULT_DEVICE_SETTINGS, { speech: { quietHours: { start: "22:00", end: "08:00" } } }).speech;
    const base = { speech, timeZone: "UTC", now: new Date("2026-10-14T12:00:00Z"), online: true, urgent: false, lastSpokenAt: new Date("2026-10-14T11:59:50Z"), spokenLastHour: 99 };
    expect(checkSpeechPolicy(base).ok).toBe(false);
    expect(checkSpeechPolicy({ ...base, requested: true }).ok).toBe(true);
    expect(checkSpeechPolicy({ ...base, requested: true, now: new Date("2026-10-14T23:00:00Z") }).ok).toBe(false);
    expect(checkSpeechPolicy({ ...base, requested: true, speech: { ...speech, muted: true } }).ok).toBe(false);
  });

  it("start a trigger run without waiting out the gap between runs", async () => {
    const runs: number[] = [];
    const runner = new DeviceRunner({
      execute: async () => void runs.push(Date.now()),
      now: () => Date.now(),
      listDevices: async () => [],
      countNotable: async () => 0,
    });
    runner.trigger("d", [{ kind: "wake", at: new Date(), detail: "a" }], 10_000);
    await runner.idle("d");
    runner.trigger("d", [{ kind: "trigger", at: new Date(), detail: "b" }], 0);
    await runner.idle("d");
    expect(runs).toHaveLength(2);
    expect(runs[1] - runs[0]).toBeLessThan(1000);
  });
});
