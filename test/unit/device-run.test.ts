import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { UIMessage } from "ai";
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
// Keep compaction's window lookup off the network; a large window never trips it.
vi.mock("../../lib/agent/context", () => ({
  getContextWindow: vi.fn(async () => ({ model: "test", contextLength: 1_000_000, supportsImages: true })),
}));

import { executeDeviceRun, type DeviceRunDeps } from "../../lib/agent/device-run";
import { windowImageParts } from "../../lib/agent/image-parts";
import { latestDeviceConversation } from "../../lib/db/conversations";
import {
  createDevice,
  insertObservation,
  listDeviceEvents,
  updateCaption,
  type Device,
  type DeviceObservation,
} from "../../lib/db/devices";
import { findMemories } from "../../lib/db/memories";
import type { Caption } from "../../lib/devices/caption";
import { writeFrame } from "../../lib/devices/frames";
import { captionTriggers, type RunTrigger } from "../../lib/devices/run-triggers";
import { DeviceRunner } from "../../lib/devices/runner";
import { DEFAULT_DEVICE_SETTINGS, mergeDeviceSettings, type DeviceSettingsPatch } from "../../lib/devices/settings";
import { generateDeviceToken } from "../../lib/devices/tokens";
import { closeDb, makeUserWithAgent, resetDb } from "../helpers/db";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-device-run-"));
  process.env.FILES_DIR = root;
});
beforeEach(resetDb);
afterAll(async () => {
  await closeDb();
  await rm(root, { recursive: true, force: true });
});

const caption = (summary: string, extra: Partial<Caption> = {}): Caption => ({
  summary,
  changes: "none",
  entities: [],
  salience: 0.1,
  wake: "none",
  reason: "quiet",
  ...extra,
});

const arrival = caption("A person in a green sweater walks onto the lawn.", {
  changes: "A person entered from the left.",
  entities: [{ kind: "person", description: "adult in a green sweater", isNew: true }],
  salience: 0.7,
  wake: "agent",
  reason: "Someone arrived in the garden.",
});

async function makeDevice(patch: DeviceSettingsPatch = {}) {
  const { user, agent } = await makeUserWithAgent("Elia");
  const device = await createDevice({
    ownerId: user.id,
    agentId: agent.id,
    name: "Rover",
    tokenHash: generateDeviceToken().hash,
    settings: mergeDeviceSettings(DEFAULT_DEVICE_SETTINGS, { timezone: "Europe/Rome", ...patch }),
  });
  return { user, agent, device };
}

let seq = 0;
async function captioned(device: Device, value: Caption, capturedAt = new Date()): Promise<DeviceObservation> {
  const bytes = await sharp({ create: { width: 32, height: 18, channels: 3, background: "#4a6" } })
    .jpeg()
    .toBuffer();
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
  return (await updateCaption(row.id, {
    captionStatus: "captioned",
    caption: value,
    captionedAt: new Date(),
    salience: value.salience,
  }))!;
}

type Step = { text?: string; calls?: Array<{ toolName: string; input: unknown }> };

// A run model that plays a script, one step per call.
function scriptedModel(steps: Step[]) {
  let call = 0;
  return new MockLanguageModelV3({
    provider: "mock",
    modelId: "mock-run",
    doGenerate: async () => {
      const step = steps[Math.min(call++, steps.length - 1)];
      const calls = step.calls ?? [];
      return {
        content: [
          ...(step.text ? [{ type: "text" as const, text: step.text }] : []),
          ...calls.map((c, i) => ({
            type: "tool-call" as const,
            toolCallId: `call-${call}-${i}`,
            toolName: c.toolName,
            input: JSON.stringify(c.input),
          })),
        ],
        finishReason: calls.length
          ? { unified: "tool-calls" as const, raw: "tool_calls" }
          : { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 3000, noCache: 3000, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 60, text: 60, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}

function deps(model: MockLanguageModelV3, spoken: string[] = []): DeviceRunDeps {
  return {
    now: () => new Date(),
    resolveModel: async () => ({
      model,
      provider: "lmstudio",
      modelId: "mock-run",
      target: { provider: "lmstudio", settings: {}, model: "mock-run" },
    }),
    speak: async ({ text }) => {
      spoken.push(text);
      return { spoken: true, durationMs: 1500, language: "en", voice: "en_US-lessac-medium" };
    },
    capture: async () => {
      throw new Error("not used");
    },
    ask: async () => "not used",
  };
}

const userMessages = (messages: UIMessage[]) => messages.filter((m) => m.role === "user");
const textOf = (message: UIMessage) =>
  message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");

describe("run triggers", () => {
  it("wake on the model's wake level, on salience, and on a new person or animal", async () => {
    const { device } = await makeDevice();
    const agent = DEFAULT_DEVICE_SETTINGS.agent;
    expect(captionTriggers(await captioned(device, arrival), agent).map((t) => t.kind)).toEqual([
      "wake",
      "salience",
      "new_entity",
    ]);
    const cat = caption("A cat sits on the wall.", {
      entities: [{ kind: "animal", description: "grey cat", isNew: true }],
      wake: "log",
    });
    expect(captionTriggers(await captioned(device, cat), agent)).toMatchObject([
      { kind: "new_entity", detail: "animal: grey cat" },
    ]);
    expect(captionTriggers(await captioned(device, caption("Empty lawn.", { wake: "log" })), agent)).toEqual([]);
  });
});

describe("device runs", () => {
  it("write the day's log with the frame, speak, and store device memories", async () => {
    const { agent, device } = await makeDevice();
    await captioned(device, caption("An empty lawn in the afternoon sun."), new Date(Date.now() - 60_000));
    const observation = await captioned(device, arrival);
    const triggers = captionTriggers(observation, DEFAULT_DEVICE_SETTINGS.agent);

    const model = scriptedModel([
      {
        calls: [
          { toolName: "speak", input: { text: "Hello! Welcome to the garden." } },
          {
            toolName: "remember",
            input: { content: "A wooden bench stands by the garden wall.", subject: "shared", importance: 0.4, category: "home" },
          },
        ],
      },
      { text: "A person arrived on the lawn; I greeted them." },
    ]);
    const spoken: string[] = [];
    expect(await executeDeviceRun(device.id, triggers, deps(model, spoken))).toBe("done");
    expect(spoken).toEqual(["Hello! Welcome to the garden."]);

    const log = (await latestDeviceConversation(device.id))!;
    expect(log).toMatchObject({ agentId: agent.id, shared: true, memory: true, deviceId: device.id });
    const [user, assistant] = log.messages as UIMessage[];
    const context = textOf(user);
    expect(context).toContain("<device-context>");
    expect(context).toContain("Device: Rover");
    expect(context).toContain("someone or something new in view");
    expect(context).toContain("An empty lawn in the afternoon sun.");
    expect(context).toContain("Changes: A person entered from the left.");
    const file = user.parts.find((p) => p.type === "file")!;
    expect(file).toMatchObject({ mediaType: "image/jpeg", filename: expect.stringMatching(/^frame-\d{6}-.+\.jpg$/) });
    expect(await readdir(join(root, log.id, "uploads"))).toEqual([(file as { filename: string }).filename]);
    expect(user.metadata).toMatchObject({ deviceRun: { triggers: ["wake", "salience", "new_entity"] } });

    // The model got the device rules, the context and the pixels.
    const call = model.doGenerateCalls[0];
    expect(JSON.stringify(call.prompt[0])).toContain("Device runs");
    const prompt = call.prompt.find((m) => m.role === "user")!.content as Array<{ type: string; mediaType?: string }>;
    expect(prompt.some((p) => p.type === "file" && p.mediaType === "image/jpeg")).toBe(true);
    expect(call.tools?.map((t) => t.name)).toEqual(
      expect.arrayContaining(["speak", "zoom", "searchObservations", "remember", "getDate"])
    );

    expect(assistant.parts.map((p) => p.type)).toEqual(
      expect.arrayContaining(["tool-speak", "tool-remember", "text"])
    );
    const memories = await findMemories(agent.memoryPoolId!);
    expect(memories).toMatchObject([{ content: "A wooden bench stands by the garden wall.", source: "device", category: "home" }]);

    const [event] = await listDeviceEvents({ deviceId: device.id, kind: "run", limit: 1 });
    expect(event.detail).toMatchObject({ status: "done", conversationId: log.id, tools: ["speak", "remember"], steps: 2 });
  });

  it("append later runs to the same log, from the last caption on, with two frames kept as images", async () => {
    const { device } = await makeDevice();
    const model = scriptedModel([{ text: "Noted." }]);
    const summaries = ["A fox crosses the lawn.", "The fox sniffs the bench.", "The fox leaves through the hedge."];
    for (const [i, summary] of summaries.entries()) {
      const observation = await captioned(device, caption(summary, { wake: "agent", salience: 0.6 }));
      expect(await executeDeviceRun(device.id, captionTriggers(observation, DEFAULT_DEVICE_SETTINGS.agent), deps(model))).toBe("done");
      // Each run lists only the captions since the previous one.
      const log = (await latestDeviceConversation(device.id))!;
      const context = textOf(userMessages(log.messages as UIMessage[]).at(-1)!);
      expect(context).toContain(summary);
      for (const earlier of summaries.slice(0, i)) expect(context).not.toContain(earlier);
    }
    const log = (await latestDeviceConversation(device.id))!;
    expect(userMessages(log.messages as UIMessage[])).toHaveLength(3);

    // The third call: the first frame became its caption, the last two stayed images.
    const third = model.doGenerateCalls[2].prompt.filter((m) => m.role === "user");
    const files = third.map((m) => (m.content as Array<{ type: string }>).filter((p) => p.type === "file").length);
    expect(files).toEqual([0, 1, 1]);
    expect(JSON.stringify(third[0].content)).toMatch(/\[frame \d\d:\d\d: A fox crosses the lawn\.\]/);
  });

  it("hold the hourly run budget and record runs that can't start", async () => {
    const { device } = await makeDevice({ agent: { runsPerHour: 1 } });
    const model = scriptedModel([{ text: "Noted." }]);
    const trigger: RunTrigger[] = [{ kind: "look", at: new Date(), detail: "asked by Elia" }];
    await captioned(device, caption("An empty lawn."));
    expect(await executeDeviceRun(device.id, trigger, deps(model))).toBe("done");
    expect(await executeDeviceRun(device.id, trigger, deps(model))).toBe("over_budget");
    expect(await executeDeviceRun(device.id, trigger, { ...deps(model), resolveModel: async () => null })).toBe(
      "over_budget"
    );

    const { device: other } = await makeDevice();
    expect(await executeDeviceRun(other.id, trigger, { ...deps(model), resolveModel: async () => null })).toBe(
      "no_model"
    );
    const events = await listDeviceEvents({ deviceId: device.id, kind: "run", limit: 10 });
    expect(events.map((e) => e.detail?.status)).toEqual(["over_budget", "over_budget", "done"]);
  });
});

describe("the runner", () => {
  const trigger = (detail: string): RunTrigger => ({ kind: "wake", at: new Date(), detail });

  it("run one at a time, at least the gap apart, merging triggers that arrive meanwhile", async () => {
    const runs: Array<{ at: number; details: string[] }> = [];
    const runner = new DeviceRunner({
      execute: async (_id, triggers) => {
        runs.push({ at: Date.now(), details: triggers.map((t) => t.detail) });
        await new Promise((r) => setTimeout(r, 50));
      },
      now: () => Date.now(),
      listDevices: async () => [],
      countNotable: async () => 0,
    });
    runner.trigger("d", [trigger("a")], 300);
    await new Promise((r) => setTimeout(r, 10));
    runner.trigger("d", [trigger("b")], 300);
    runner.trigger("d", [trigger("c")], 300);
    await runner.idle("d");
    expect(runs.map((r) => r.details)).toEqual([["a"], ["b", "c"]]);
    expect(runs[1].at - runs[0].at).toBeGreaterThanOrEqual(295);
  });

  it("reflect once a period, and only when something was logged", async () => {
    const { device } = await makeDevice({ agent: { reflectionMin: 30 } });
    let now = Date.now();
    let notable = 2;
    const runs: RunTrigger[][] = [];
    const runner = new DeviceRunner({
      execute: async (_id, triggers) => void runs.push(triggers),
      now: () => now,
      listDevices: async () => [device],
      countNotable: async () => notable,
    });
    await runner.reflect();
    expect(runs).toEqual([]);
    now += 30 * 60_000;
    await runner.reflect();
    await runner.idle(device.id);
    expect(runs).toMatchObject([[{ kind: "reflection", detail: "2 notable captions since the last reflection" }]]);
    await runner.reflect();
    now += 30 * 60_000;
    notable = 0;
    await runner.reflect();
    await runner.idle(device.id);
    expect(runs).toHaveLength(1);
  });
});

describe("the image window", () => {
  it("replace images outside the last `keep` messages with their labels", () => {
    const message = (n: number): UIMessage => ({
      id: `m${n}`,
      role: "user",
      metadata: { imageLabels: { [`f${n}.jpg`]: `frame 10:0${n}: scene ${n}` } },
      parts: [
        { type: "text", text: `report ${n}` },
        { type: "file", mediaType: "image/jpeg", filename: `f${n}.jpg`, url: `/f${n}` },
      ],
    });
    const reply: UIMessage = { id: "a", role: "assistant", parts: [{ type: "text", text: "ok" }] };
    const windowed = windowImageParts([message(1), reply, message(2), reply, message(3)], 2);
    expect(windowed[0].parts[1]).toEqual({ type: "text", text: "[frame 10:01: scene 1]" });
    expect(windowed[2].parts[1].type).toBe("file");
    expect(windowed[4].parts[1].type).toBe("file");
  });
});
