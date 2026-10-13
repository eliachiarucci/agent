import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import sharp from "sharp";

// Captions embed their summary; scripted vectors make search ranking exact.
vi.mock("../../lib/global/ai", async () => {
  const { fakeEmbedding } = await import("../helpers/embeddings");
  return {
    embedText: async (text: string) => fakeEmbedding(text),
    chatModelFromSettings: () => {
      throw new Error("not used in these tests");
    },
  };
});

import {
  createDevice,
  getObservation,
  insertObservation,
  listObservations,
  searchObservations,
  updateDevice,
  type Device,
} from "../../lib/db/devices";
import type { Caption } from "../../lib/devices/caption";
import { captionFrame } from "../../lib/devices/caption";
import { writeFrame } from "../../lib/devices/frames";
import { subscribeLive, type LiveEvent } from "../../lib/devices/live";
import { PerceptionWorker } from "../../lib/devices/perception";
import { perceptionProviderOptions, type PerceptionTarget } from "../../lib/devices/perception-model";
import {
  DEFAULT_DEVICE_SETTINGS,
  deviceSettingsPatchSchema,
  mergeDeviceSettings,
  readDeviceSettings,
  type DeviceSettings,
} from "../../lib/devices/settings";
import { generateDeviceToken } from "../../lib/devices/tokens";
import { fakeEmbedding } from "../helpers/embeddings";
import { closeDb, makeUserWithAgent, resetDb } from "../helpers/db";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-perception-"));
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

type Reply = Caption | string | Error;

// A vision model that answers from a script. A reply can wait on a gate, so a
// test can hold a call in flight while more frames arrive.
function scriptedModel(replies: Reply[], gate?: Promise<void>) {
  let call = 0;
  const model = new MockLanguageModelV3({
    provider: "mock",
    modelId: "mock-vision",
    doGenerate: async () => {
      const reply = replies[Math.min(call++, replies.length - 1)];
      if (call === 1 && gate) await gate;
      if (reply instanceof Error) throw reply;
      return {
        content: [{ type: "text", text: typeof reply === "string" ? reply : JSON.stringify(reply) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1200, noCache: 1200, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 80, text: 80, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const target: PerceptionTarget = { provider: "lmstudio", modelId: "mock-vision", model };
  return { model, target };
}

function worker(target: PerceptionTarget | null) {
  return new PerceptionWorker({
    resolveTarget: async () => target,
    caption: captionFrame,
    embed: async (text) => fakeEmbedding(text),
    now: () => new Date(),
  });
}

async function makeDevice(perception: Partial<DeviceSettings["perception"]> = {}): Promise<Device> {
  const { user, agent } = await makeUserWithAgent("Alice");
  return createDevice({
    ownerId: user.id,
    agentId: agent.id,
    name: "Rover",
    tokenHash: generateDeviceToken().hash,
    settings: { ...DEFAULT_DEVICE_SETTINGS, perception: { ...DEFAULT_DEVICE_SETTINGS.perception, ...perception } },
  });
}

let seq = 0;
async function frame(device: Device) {
  const bytes = await sharp({ create: { width: 32, height: 18, channels: 3, background: "#456" } })
    .jpeg()
    .toBuffer();
  return insertObservation({
    deviceId: device.id,
    seq: seq++,
    trigger: "change",
    capturedAt: new Date(),
    frame: await writeFrame(device.id, bytes),
    width: 32,
    height: 18,
    bytes: bytes.length,
  });
}

/** The text part of the user message the model got on call `i`. */
function promptText(model: MockLanguageModelV3, i: number): string {
  const user = model.doGenerateCalls[i].prompt.find((m) => m.role === "user")!;
  const parts = user.content as Array<{ type: string; text?: string; mediaType?: string }>;
  expect(parts.some((p) => p.type === "file" && p.mediaType === "image/jpeg")).toBe(true);
  return parts.find((p) => p.type === "text")!.text!;
}

describe("perception worker", () => {
  it("captions a frame, embeds the summary, and publishes the result", async () => {
    const device = await makeDevice();
    const { model, target } = scriptedModel([
      caption("A person sits at a desk.", { salience: 0.4, wake: "log", entities: [{ kind: "person", description: "dark hoodie", isNew: true }] }),
    ]);
    const w = worker(target);
    const events: LiveEvent[] = [];
    const unsubscribe = subscribeLive(device.id, (e) => events.push(e));

    const obs = await frame(device);
    w.enqueue(device.id, obs.id);
    await w.idle(device.id);
    unsubscribe();

    const row = await getObservation(obs.id);
    expect(row).toMatchObject({
      captionStatus: "captioned",
      salience: expect.closeTo(0.4, 5),
      caption: { summary: "A person sits at a desk.", wake: "log" },
      captionMeta: { provider: "lmstudio", model: "mock-vision", inputTokens: 1200, outputTokens: 80 },
    });
    expect(row!.captionedAt).toBeInstanceOf(Date);
    expect(events).toEqual([
      expect.objectContaining({ type: "caption", observation: expect.objectContaining({ id: obs.id, captionStatus: "captioned", hasFrame: true }) }),
    ]);
    // The structured-output path: the schema goes with the request.
    expect(model.doGenerateCalls[0].responseFormat).toMatchObject({ type: "json", schema: expect.any(Object) });
    expect(promptText(model, 0)).toMatch(/first frame/);

    const [hit] = await searchObservations({ deviceId: device.id, vector: fakeEmbedding("A person sits at a desk."), limit: 5 });
    expect(hit.id).toBe(obs.id);
    expect(hit.relevance).toBeCloseTo(1, 2);
  });

  it("gives the model the previous caption, also after a restart", async () => {
    const device = await makeDevice();
    const first = scriptedModel([caption("An empty room."), caption("A cat walks in.")]);
    const w = worker(first.target);
    for (const _ of [0, 1]) {
      w.enqueue(device.id, (await frame(device)).id);
      await w.idle(device.id);
    }
    expect(promptText(first.model, 1)).toContain("An empty room.");

    // A fresh worker (server restart) picks up the last caption from the database.
    const second = scriptedModel([caption("The cat sits down.")]);
    const restarted = worker(second.target);
    restarted.enqueue(device.id, (await frame(device)).id);
    await restarted.idle(device.id);
    expect(promptText(second.model, 0)).toContain("A cat walks in.");
  });

  it("captions only the newest waiting frame", async () => {
    const device = await makeDevice();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { model, target } = scriptedModel([caption("one"), caption("three")], gate);
    const w = worker(target);

    const [a, b, c] = [await frame(device), await frame(device), await frame(device)];
    w.enqueue(device.id, a.id);
    await vi.waitFor(() => expect(model.doGenerateCalls).toHaveLength(1));
    w.enqueue(device.id, b.id);
    w.enqueue(device.id, c.id);
    open();
    await w.idle(device.id);

    expect(model.doGenerateCalls).toHaveLength(2);
    await vi.waitFor(async () => expect((await getObservation(b.id))?.captionStatus).toBe("superseded"));
    expect((await getObservation(a.id))?.caption?.summary).toBe("one");
    expect((await getObservation(c.id))?.caption?.summary).toBe("three");
  });

  it("stops calling the model when the hourly budget is used, failed calls included", async () => {
    const device = await makeDevice({ framesPerHour: 2 });
    const { model, target } = scriptedModel([new Error("provider down"), caption("ok")]);
    const w = worker(target);
    const rows = [];
    for (let i = 0; i < 3; i++) {
      const obs = await frame(device);
      w.enqueue(device.id, obs.id);
      await w.idle(device.id);
      rows.push(await getObservation(obs.id));
    }
    expect(rows.map((r) => r?.captionStatus)).toEqual(["failed", "captioned", "over_budget"]);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(rows[0]?.captionMeta?.error).toMatch(/provider down/);
    expect(rows[2]?.captionedAt).toBeNull();
  });

  it("records output that doesn't match the schema as failed, and keeps going", async () => {
    const device = await makeDevice();
    const { target } = scriptedModel(['{"summary": "half a caption"', caption("fine")]);
    const w = worker(target);
    const bad = await frame(device);
    w.enqueue(device.id, bad.id);
    await w.idle(device.id);
    const good = await frame(device);
    w.enqueue(device.id, good.id);
    await w.idle(device.id);

    expect((await getObservation(bad.id))?.captionStatus).toBe("failed");
    expect((await getObservation(good.id))?.captionStatus).toBe("captioned");
  });

  it("marks frames when there is no model or captions are off", async () => {
    const device = await makeDevice();
    const none = worker(null);
    const a = await frame(device);
    none.enqueue(device.id, a.id);
    await none.idle(device.id);
    expect((await getObservation(a.id))?.captionStatus).toBe("no_model");

    await updateDevice(device.id, {
      settings: mergeDeviceSettings(DEFAULT_DEVICE_SETTINGS, { perception: { enabled: false } }),
    });
    const { model, target } = scriptedModel([caption("unused")]);
    const off = worker(target);
    const b = await frame(device);
    off.enqueue(device.id, b.id);
    await off.idle(device.id);
    expect((await getObservation(b.id))?.captionStatus).toBe("disabled");
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});

describe("observation queries", () => {
  it("filter by salience and rank search results by meaning", async () => {
    const device = await makeDevice();
    const { target } = scriptedModel([
      caption("Leaves move in the wind.", { salience: 0.05 }),
      caption("A fox crosses the lawn.", { salience: 0.8 }),
      caption("The lawn is empty again.", { salience: 0.1 }),
    ]);
    const w = worker(target);
    for (let i = 0; i < 3; i++) {
      w.enqueue(device.id, (await frame(device)).id);
      await w.idle(device.id);
    }

    const salient = await listObservations({ deviceId: device.id, minSalience: 0.5, limit: 10 });
    expect(salient.map((r) => r.caption?.summary)).toEqual(["A fox crosses the lawn."]);

    const results = await searchObservations({ deviceId: device.id, vector: fakeEmbedding("A fox crosses the lawn."), limit: 3 });
    expect(results[0].caption?.summary).toBe("A fox crosses the lawn.");
    expect(results[0].relevance).toBeGreaterThan(results[1].relevance);
    expect(results[0]).not.toHaveProperty("embedding");
  });
});

describe("perception settings", () => {
  it("default to the owner's default model with a budget, and patch per field", () => {
    expect(readDeviceSettings({}).perception).toEqual({
      enabled: true,
      provider: null,
      model: null,
      route: null,
      framesPerHour: 300,
    });
    const patch = deviceSettingsPatchSchema.parse({
      perception: {
        provider: "openrouter",
        model: "anthropic/claude-haiku-5.5",
        route: { only: ["google-vertex/europe"], allowFallbacks: false },
      },
    });
    const merged = mergeDeviceSettings(DEFAULT_DEVICE_SETTINGS, patch);
    expect(merged.perception).toMatchObject({ provider: "openrouter", framesPerHour: 300 });
    expect(deviceSettingsPatchSchema.safeParse({ perception: { provider: "acme" } }).success).toBe(false);
  });

  it("pin an OpenRouter route without fallbacks and turn reasoning off", () => {
    expect(
      perceptionProviderOptions("openrouter", "anthropic/claude-haiku-5.5", {
        only: ["google-vertex/europe"],
        allowFallbacks: false,
      })
    ).toEqual({
      openrouter: {
        reasoning: { enabled: false },
        provider: { only: ["google-vertex/europe"], allow_fallbacks: false },
      },
    });
    expect(perceptionProviderOptions("openrouter", "google/gemini-3.1-flash-lite")).toEqual({
      openrouter: { reasoning: { effort: "minimal" } },
    });
    expect(perceptionProviderOptions("openai", "gpt-6-luna")).toEqual({
      openai: { forceReasoning: true, reasoningEffort: "none" },
    });
    expect(perceptionProviderOptions("anthropic", "claude-haiku-5-5")).toBeUndefined();
  });
});
