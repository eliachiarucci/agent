import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import WebSocket from "ws";
import { fakePiperPort, SERVER_PORTS, serverUrl } from "../config";
import { TestClient } from "../helpers/client";
import { signUp } from "../helpers/auth";
import { agentMembers, closeDb, db, resetDb } from "../helpers/db";
import { startFakePiper } from "../helpers/fake-piper";
import { providerSettings } from "../../lib/global/schema";
import { decodeBinaryMessage, encodeBinaryMessage } from "../../lib/devices/protocol";

const BASE = serverUrl("api");
const WS_URL = BASE.replace(/^http/, "ws") + "/agent/devices/ws";

// A stand-in model server (OpenAI-compatible, through the LM Studio provider):
// caption requests (they carry a JSON schema) get the next scripted caption;
// agent-run requests (they carry tools) get the next scripted step, a tool
// call or plain text.
let fake: Server;
let fakeUrl: string;
let captions: object[] = [];
let steps: Array<{ text?: string; call?: { name: string; args: object } }> = [];
let runRequests: any[] = [];
let piper: Awaited<ReturnType<typeof startFakePiper>>;

const caption = (summary: string, extra: object = {}) => ({
  summary,
  changes: "none",
  entities: [],
  salience: 0.1,
  wake: "none",
  reason: "quiet",
  ...extra,
});

function completion(model: string, message: object, finish: string) {
  return {
    id: `cmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 2000, completion_tokens: 40, total_tokens: 2040 },
  };
}

beforeAll(async () => {
  fake = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method !== "POST") {
        res.statusCode = 404;
        res.end();
        return;
      }
      const json = JSON.parse(body || "{}");
      res.setHeader("content-type", "application/json");
      if (json.tools && json.stream) {
        // The chat route streams.
        runRequests.push(json);
        const step = steps.shift() ?? { text: "Nothing to add." };
        const delta = step.call
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call-${runRequests.length}`,
                  type: "function",
                  function: { name: step.call.name, arguments: JSON.stringify(step.call.args) },
                },
              ],
            }
          : { role: "assistant", content: step.text };
        const chunk = (choice: object, extra: object = {}) =>
          `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: json.model, choices: [{ index: 0, ...choice }], ...extra })}\n\n`;
        res.setHeader("content-type", "text/event-stream");
        res.write(chunk({ delta }));
        res.write(
          chunk(
            { delta: {}, finish_reason: step.call ? "tool_calls" : "stop" },
            { usage: { prompt_tokens: 2000, completion_tokens: 40, total_tokens: 2040 } }
          )
        );
        res.end("data: [DONE]\n\n");
        return;
      }
      if (json.tools) {
        runRequests.push(json);
        const step = steps.shift() ?? { text: "Nothing to add." };
        const message = step.call
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call-${runRequests.length}`,
                  type: "function",
                  function: { name: step.call.name, arguments: JSON.stringify(step.call.args) },
                },
              ],
            }
          : { role: "assistant", content: step.text };
        res.end(JSON.stringify(completion(json.model, message, step.call ? "tool_calls" : "stop")));
        return;
      }
      const content = JSON.stringify(captions.shift() ?? caption("Nothing scripted."));
      res.end(JSON.stringify(completion(json.model, { role: "assistant", content }, "stop")));
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  piper = await startFakePiper(fakePiperPort(SERVER_PORTS.api));
});

afterAll(async () => {
  fake.close();
  await piper.close();
  await closeDb();
});

const links: Link[] = [];
beforeEach(async () => {
  await resetDb();
  captions = [];
  steps = [];
  runRequests = [];
  piper.requests.length = 0;
});
afterEach(() => {
  for (const link of links.splice(0)) link.ws.terminate();
});

const jpeg = () =>
  sharp({ create: { width: 96, height: 54, channels: 3, background: "#3a6" } }).jpeg().toBuffer();

// The device's end: answers capture requests with a frame and plays speech
// (acks it at once), like scripts/device-sim.ts.
class Link {
  speech: Array<{ header: any; bytes: number }> = [];
  private seq = 0;

  private constructor(readonly ws: WebSocket) {
    ws.on("message", async (data: Buffer, isBinary) => {
      if (isBinary) {
        const { header, payload } = decodeBinaryMessage(data) as { header: any; payload: Buffer };
        this.speech.push({ header, bytes: payload.length });
        ws.send(JSON.stringify({ type: "played", speechId: header.speechId, ok: true, durationMs: 850 }));
        return;
      }
      const message = JSON.parse(data.toString());
      if (message.type === "capture") await this.frame("request", message.requestId);
    });
  }

  static async open(token: string): Promise<Link> {
    const ws = new WebSocket(WS_URL, { headers: { authorization: `Bearer ${token}` } });
    const link = new Link(ws);
    links.push(link);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return link;
  }

  async frame(trigger: "change" | "request", requestId?: string) {
    const header = { type: "frame", seq: this.seq++, capturedAt: Date.now(), trigger, ...(requestId && { requestId }) };
    this.ws.send(encodeBinaryMessage(header, await jpeg()));
  }
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

/** A user with a device whose captions and runs go to the fake model. */
async function setup(name = "Alice") {
  const client = new TestClient(BASE);
  const user = await signUp(client, name);
  await db.insert(providerSettings).values({
    userId: user.id,
    provider: "lmstudio",
    settings: { url: fakeUrl, model: "fake-vision" },
  });
  const res = await client.post("/agent/devices", { name: "Rover", timezone: "Europe/Rome" });
  expect(res.status).toBe(201);
  const patched = await client.patch("/agent/devices", {
    id: res.body.device.id,
    settings: {
      perception: { provider: "lmstudio", model: "fake-vision" },
      agent: { provider: "lmstudio", model: "fake-run" },
      // Tests run at any hour.
      speech: { quietHours: null },
    },
  });
  expect(patched.status).toBe(200);
  return { client, user, device: res.body.device, agent: res.body.agent, token: res.body.token as string };
}

describe("device agents", () => {
  it("give a new device its own agent on the Personal Assistant's pool, shared with the same people", async () => {
    const alice = new TestClient(BASE);
    const aliceUser = await signUp(alice, "Alice");
    const bob = new TestClient(BASE);
    const bobUser = await signUp(bob, "Bob");
    const personal = (await alice.get("/agent/agents")).body[0];
    await db.insert(agentMembers).values({ agentId: personal.id, userId: bobUser.id });

    const res = await alice.post("/agent/devices", { name: "Rover" });
    expect(res.status).toBe(201);
    expect(res.body.agent).toMatchObject({ name: "Rover", memoryPoolId: personal.memoryPoolId });
    expect(res.body.device.agentId).toBe(res.body.agent.id);
    expect(res.body.device.settings).toMatchObject({ timezone: null, agent: { enabled: true, minGapSec: 20 } });

    // Bob shares the Personal Assistant, so he shares the device agent too.
    const bobAgents = (await bob.get("/agent/agents")).body.map((a: any) => a.name);
    expect(bobAgents).toContain("Rover");
    expect((await bob.get("/agent/devices")).body).toMatchObject([{ id: res.body.device.id, role: "member" }]);

    // An existing agent instead, or a pool of one's own; not someone else's pool.
    const onPersonal = await alice.post("/agent/devices", { name: "Cam", agent_id: personal.id });
    expect(onPersonal.body.device.agentId).toBe(personal.id);
    const bobPool = (await bob.get("/agent/agents")).body.find((a: any) => a.name !== "Rover" && a.ownerId === bobUser.id);
    expect((await alice.post("/agent/devices", { name: "X", memory_pool_id: bobPool.memoryPoolId })).status).toBe(404);
    expect(
      (await alice.post("/agent/devices", { name: "X", agent_id: personal.id, memory_pool_id: personal.memoryPoolId }))
        .status
    ).toBe(400);
    expect((await alice.post("/agent/devices", { name: "X", timezone: "Mars/Olympus" })).status).toBe(400);
    expect(aliceUser.id).toBeTruthy();
  });
});

describe("say", () => {
  it("synthesise with the language's voice, play it on the device and log it", async () => {
    const { client, device, token } = await setup();
    expect((await client.post("/agent/devices/say", { id: device.id, text: "Hello" })).status).toBe(409);

    const link = await Link.open(token);
    const res = await client.post("/agent/devices/say", { id: device.id, text: "Ciao, benvenuto!", language: "it" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ spoken: true, durationMs: 850, language: "it", voice: "it_IT-paola-medium" });
    expect(piper.requests).toEqual([{ text: "Ciao, benvenuto!", voice: "it_IT-paola-medium" }]);
    expect(link.speech).toMatchObject([{ header: { type: "speech", format: "wav", sampleRate: 22050 } }]);

    const status = (await client.get(`/agent/devices/status?id=${device.id}`)).body;
    expect(status.speech).toMatchObject({ spokenLastHour: 1, lastSpeech: { kind: "speech", detail: { status: "spoken", source: "user" } } });

    const stranger = new TestClient(BASE);
    await signUp(stranger, "Mallory");
    expect((await stranger.post("/agent/devices/say", { id: device.id, text: "Hi" })).status).toBe(404);
    expect((await client.post("/agent/devices/say", { id: device.id, text: "x".repeat(301) })).status).toBe(400);
  });
});

describe("look and agent runs", () => {
  it("take a fresh frame, caption it, and run the agent on it", async () => {
    const { client, device, agent, token } = await setup();
    await Link.open(token);
    captions.push(caption("An empty lawn with a wooden bench."));
    steps.push({ text: "Looked at the garden on request: empty lawn." });

    const res = await client.post("/agent/devices/look", { id: device.id });
    expect(res.status).toBe(200);
    expect(res.body.observation).toMatchObject({
      trigger: "request",
      captionStatus: "captioned",
      caption: { summary: "An empty lawn with a wooden bench." },
    });

    const status = await waitFor(
      () => client.get(`/agent/devices/status?id=${device.id}`),
      (r) => r.body.agent.lastRun !== null
    );
    expect(status.body.agent).toMatchObject({
      model: { provider: "lmstudio", model: "fake-run" },
      runsLastHour: 1,
      lastRun: { detail: { status: "done", triggers: [{ kind: "look" }] } },
    });
    const logs = (await client.get(`/agent/conversation?agent_id=${agent.id}`)).body;
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ deviceId: device.id, shared: true });
    expect(logs[0].messages[1].parts.at(-1)).toMatchObject({ text: "Looked at the garden on request: empty lawn." });
  });

  it("wake on a caption, speak through the device, and keep the exchange in the day's log", async () => {
    const { client, device, agent, token } = await setup();
    const link = await Link.open(token);
    captions.push(
      caption("A person in a green sweater walks onto the lawn.", {
        entities: [{ kind: "person", description: "adult in a green sweater", isNew: true }],
        salience: 0.7,
        wake: "agent",
        reason: "Someone arrived.",
      })
    );
    steps.push({ call: { name: "speak", args: { text: "Hello! Welcome to the garden." } } }, { text: "Greeted a visitor." });

    await link.frame("change");
    const status = await waitFor(
      () => client.get(`/agent/devices/status?id=${device.id}`),
      (r) => r.body.agent.lastRun?.detail.status === "done"
    );
    expect(status.body.agent.lastRun.detail).toMatchObject({
      triggers: [{ kind: "wake" }, { kind: "salience" }, { kind: "new_entity" }],
      tools: ["speak"],
    });
    expect(link.speech).toHaveLength(1);
    expect(piper.requests).toEqual([{ text: "Hello! Welcome to the garden.", voice: "en_US-lessac-medium" }]);

    // The run's first request: the device's tools, and the frame inline.
    const tools = runRequests[0].tools.map((t: any) => t.function.name);
    expect(tools).toEqual(
      expect.arrayContaining(["speak", "zoom", "searchObservations", "remember", "getDate", "webSearch", "readPage"])
    );
    const user = runRequests[0].messages.find((m: any) => m.role === "user");
    expect(JSON.stringify(user.content)).toContain("<device-context>");
    expect(user.content.some((p: any) => p.type === "image_url" && p.image_url.url.startsWith("data:image/jpeg"))).toBe(true);

    const [log] = (await client.get(`/agent/conversation?agent_id=${agent.id}`)).body;
    const parts = log.messages[1].parts;
    expect(parts.find((p: any) => p.type === "tool-speak")).toMatchObject({
      state: "output-available",
      output: { spoken: true, durationMs: 850 },
    });
    // The frame is a file part the chat can show, served from the log's uploads.
    const file = log.messages[0].parts.find((p: any) => p.type === "file");
    const image = await client.request(file.url);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/jpeg");
  });
});

describe("chat", () => {
  it("search what the device saw from any chat", async () => {
    const { client, device, token } = await setup();
    const link = await Link.open(token);
    captions.push(caption("A grey cat sits on the garden wall.", { wake: "log", salience: 0.4 }));
    // No run on this caption.
    await client.patch("/agent/devices", { id: device.id, settings: { agent: { enabled: false } } });
    await link.frame("change");
    await waitFor(
      () => client.get(`/agent/devices/observations?device_id=${device.id}`),
      (r) => r.body[0]?.captionStatus === "captioned"
    );

    // The Personal Assistant's chat turn: the model asks searchObservations, then answers.
    steps.push({ call: { name: "searchObservations", args: {} } }, { text: "A grey cat sat on the wall." });
    const res = await client.request("/agent/conversation", {
      method: "POST",
      body: JSON.stringify({ message: "What did the rover see today?", provider: "lmstudio", model: "fake-chat" }),
    });
    expect(res.status).toBe(200);
    await res.text();
    const toolMessage = runRequests[1].messages.find((m: any) => m.role === "tool");
    expect(toolMessage.content).toContain("A grey cat sits on the garden wall.");
  });
});
