import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import WebSocket from "ws";
import { serverUrl } from "../config";
import { TestClient } from "../helpers/client";
import { signUp } from "../helpers/auth";
import { closeDb, db, resetDb } from "../helpers/db";
import { providerSettings } from "../../lib/global/schema";
import { encodeBinaryMessage } from "../../lib/devices/protocol";

const BASE = serverUrl("api");
const WS_URL = BASE.replace(/^http/, "ws") + "/agent/devices/ws";

// A stand-in vision model: an OpenAI-compatible server (the LM Studio provider
// accepts any URL) that answers every chat completion with the next scripted
// caption and records the requests. No real model involved.
let fake: Server;
let fakeUrl: string;
let requests: any[] = [];
let captions: object[] = [];

const caption = (summary: string, salience = 0.2) => ({
  summary,
  changes: "none",
  entities: [],
  salience,
  wake: "none",
  reason: "test",
});

beforeAll(async () => {
  fake = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const json = JSON.parse(body || "{}");
      requests.push(json);
      const content = JSON.stringify(captions.shift() ?? caption("Nothing scripted."));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: `cmpl-${requests.length}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: json.model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1500, completion_tokens: 90, total_tokens: 1590 },
        })
      );
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});

afterAll(async () => {
  fake.close();
  await closeDb();
});

const sockets: WebSocket[] = [];
beforeEach(async () => {
  await resetDb();
  requests = [];
  captions = [];
});
afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
});

/** A user with a device whose captions run on the fake model. */
async function setup(perception: Record<string, unknown> = {}) {
  const client = new TestClient(BASE);
  const user = await signUp(client, "Alice");
  await db.insert(providerSettings).values({
    userId: user.id,
    provider: "lmstudio",
    settings: { url: fakeUrl, model: "fake-vision" },
  });
  const res = await client.post("/agent/devices", { name: "Rover" });
  const device = res.body.device;
  const patched = await client.patch("/agent/devices", {
    id: device.id,
    settings: { perception: { provider: "lmstudio", model: "fake-vision", ...perception } },
  });
  expect(patched.status).toBe(200);

  const ws = new WebSocket(WS_URL, { headers: { authorization: `Bearer ${res.body.token}` } });
  sockets.push(ws);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { client, device, ws };
}

let seq = 0;
async function sendFrame(ws: WebSocket) {
  const jpeg = await sharp({ create: { width: 96, height: 54, channels: 3, background: "#3a6" } })
    .jpeg()
    .toBuffer();
  ws.send(encodeBinaryMessage({ type: "frame", seq: seq++, capturedAt: Date.now(), trigger: "change" }, jpeg));
}

/** Reads server-sent events from a streaming response until `done` says stop. */
async function readEvents(res: Response, done: (events: any[]) => boolean, timeoutMs = 15_000) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: any[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (!done(events)) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`No more events; got ${JSON.stringify(events)}`)), deadline - Date.now())
        ),
      ]);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (data) events.push(JSON.parse(data.slice(6)));
      }
    }
  } finally {
    await reader.cancel();
  }
  return events;
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("captions", () => {
  it("caption each frame and stream it live", async () => {
    const { client, device, ws } = await setup();
    captions.push(caption("A green test card fills the view.", 0.3));

    const live = await client.request(`/agent/devices/live?id=${device.id}`);
    expect(live.status).toBe(200);
    expect(live.headers.get("content-type")).toBe("text/event-stream");
    const eventsPromise = readEvents(live, (events) => events.some((e) => e.type === "caption"));
    await sendFrame(ws);
    const events = await eventsPromise;

    expect(events.map((e) => e.type)).toEqual(["status", "observation", "caption"]);
    expect(events[0]).toEqual({ type: "status", online: true });
    expect(events[2].observation).toMatchObject({
      captionStatus: "captioned",
      caption: { summary: "A green test card fills the view." },
      captionMeta: { provider: "lmstudio", model: "fake-vision", inputTokens: 1500, outputTokens: 90 },
      hasFrame: true,
    });
    expect(events[2].observation).not.toHaveProperty("embedding");

    // What the model got: the schema (structured outputs) and the frame.
    expect(requests).toHaveLength(1);
    expect(requests[0].response_format).toMatchObject({ type: "json_schema" });
    const parts = requests[0].messages.find((m: any) => m.role === "user").content;
    expect(parts.some((p: any) => p.type === "image_url" && p.image_url.url.startsWith("data:image/jpeg;base64,"))).toBe(true);

    const status = await client.get(`/agent/devices/status?id=${device.id}`);
    expect(status.body.perception).toEqual({
      enabled: true,
      model: { provider: "lmstudio", model: "fake-vision" },
      framesPerHour: 300,
      callsLastHour: 1,
      overBudget: false,
    });
    expect(status.body.lastCaptioned.caption.summary).toBe("A green test card fills the view.");
  });

  it("finds observations by meaning and by salience", async () => {
    const { client, device, ws } = await setup();
    captions.push(caption("A red fox walks across the lawn.", 0.8), caption("Rain falls on an empty patio.", 0.1));
    for (let i = 0; i < 2; i++) {
      await sendFrame(ws);
      await waitFor(
        () => client.get(`/agent/devices/observations?device_id=${device.id}`),
        (res) => res.body.filter((r: any) => r.captionStatus === "captioned").length === i + 1
      );
    }

    const search = await client.get(
      `/agent/devices/observations?device_id=${device.id}&q=${encodeURIComponent("an animal in the garden")}`
    );
    expect(search.status).toBe(200);
    expect(search.body[0].caption.summary).toBe("A red fox walks across the lawn.");
    expect(search.body[0].relevance).toBeGreaterThan(search.body[1].relevance);

    const salient = await client.get(`/agent/devices/observations?device_id=${device.id}&min_salience=0.5`);
    expect(salient.body.map((r: any) => r.caption.summary)).toEqual(["A red fox walks across the lawn."]);
  });

  it("hold the hourly budget: frames over it are stored without a caption", async () => {
    const { client, device, ws } = await setup({ framesPerHour: 1 });
    for (let i = 0; i < 2; i++) {
      await sendFrame(ws);
      await waitFor(
        () => client.get(`/agent/devices/observations?device_id=${device.id}`),
        (res) => res.body.length === i + 1 && res.body.every((r: any) => r.captionStatus !== null)
      );
    }
    const rows = (await client.get(`/agent/devices/observations?device_id=${device.id}`)).body;
    expect(rows.map((r: any) => r.captionStatus)).toEqual(["over_budget", "captioned"]);
    expect(rows.every((r: any) => r.hasFrame)).toBe(true);
    expect(requests).toHaveLength(1);
    expect((await client.get(`/agent/devices/status?id=${device.id}`)).body.perception.overBudget).toBe(true);
  });

  it("keep the live stream to people who can see the device", async () => {
    const { device } = await setup();
    const stranger = new TestClient(BASE);
    await signUp(stranger, "Mallory");
    expect((await stranger.request(`/agent/devices/live?id=${device.id}`)).status).toBe(404);
    expect((await new TestClient(BASE).request(`/agent/devices/live?id=${device.id}`)).status).toBe(401);
  });
});
