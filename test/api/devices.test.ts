import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import WebSocket from "ws";
import { serverUrl } from "../config";
import { TestClient } from "../helpers/client";
import { signUp } from "../helpers/auth";
import { agentMembers, closeDb, db, resetDb } from "../helpers/db";
import { encodeBinaryMessage } from "../../lib/devices/protocol";

const BASE = serverUrl("api");
const WS_URL = BASE.replace(/^http/, "ws") + "/agent/devices/ws";

async function userWithAgent(name: string) {
  const client = new TestClient(BASE);
  const user = await signUp(client, name);
  const agentId: string = (await client.get("/agent/agents")).body[0].id;
  return { client, user, agentId };
}

async function register(client: TestClient, name = "Rover") {
  const res = await client.post("/agent/devices", { name });
  expect(res.status).toBe(201);
  return { device: res.body.device, token: res.body.token as string };
}

const jpeg = (width = 64, height = 36) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } })
    .jpeg()
    .toBuffer();

const frameMessage = (payload: Buffer, header: Record<string, unknown> = {}) =>
  encodeBinaryMessage(
    { type: "frame", seq: 1, capturedAt: Date.now(), trigger: "change", ...header },
    payload
  );

// A device's end of the link: collects server messages and the close.
class Device {
  private queue: any[] = [];
  private waiting: Array<{ type: string; resolve: (m: any) => void }> = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString());
      const i = this.waiting.findIndex((w) => w.type === message.type);
      if (i >= 0) this.waiting.splice(i, 1)[0].resolve(message);
      else this.queue.push(message);
    });
    this.closed = new Promise((resolve) =>
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }))
    );
  }

  static connect(token: string): Promise<Device> {
    const ws = new WebSocket(WS_URL, { headers: { authorization: `Bearer ${token}` } });
    const device = new Device(ws);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(device));
      ws.once("error", reject);
    });
  }

  next(type: string, timeoutMs = 5000): Promise<any> {
    const i = this.queue.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No ${type} message within ${timeoutMs} ms`)), timeoutMs);
      this.waiting.push({ type, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  }

  sendJson(message: unknown) {
    this.ws.send(JSON.stringify(message));
  }
}

/** HTTP status of a refused upgrade. */
function refusedWith(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("open", () => reject(new Error("Upgrade was accepted")));
    ws.on("error", () => {});
  });
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const open: Device[] = [];
async function connect(token: string) {
  const device = await Device.connect(token);
  open.push(device);
  return device;
}

beforeEach(resetDb);
afterEach(() => {
  for (const device of open.splice(0)) device.ws.terminate();
});
afterAll(closeDb);

describe("/agent/devices", () => {
  it("registers a device and shows its token only once", async () => {
    const { client, agentId } = await userWithAgent("Alice");
    const { device, token } = await register(client);

    expect(token).toMatch(/^dev_/);
    // The device gets its own agent (test/api/device-agent.test.ts).
    expect(device).toMatchObject({ name: "Rover", role: "owner", online: false });
    expect(device.agentId).not.toBe(agentId);
    expect(device.settings.cadence).toMatchObject({ fov: 125, size: "2576x1449" });
    expect(device).not.toHaveProperty("tokenHash");

    const listed = await client.get("/agent/devices");
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(token);
    expect(listed.body[0]).not.toHaveProperty("tokenHash");
  });

  it("updates settings section by section and rejects bad values", async () => {
    const { client } = await userWithAgent("Alice");
    const { device } = await register(client);

    const updated = await client.patch("/agent/devices", {
      id: device.id,
      name: "Garden rover",
      settings: { cadence: { fov: 110 } },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe("Garden rover");
    expect(updated.body.settings.cadence).toMatchObject({ fov: 110, size: "2576x1449" });

    expect((await client.patch("/agent/devices", { id: device.id, settings: { cadence: { fov: 170 } } })).status).toBe(400);
    expect((await client.patch("/agent/devices", { id: device.id, settings: { bogus: 1 } })).status).toBe(400);
  });

  it("stores the owner's description, changes and clears it", async () => {
    const { client } = await userWithAgent("Alice");
    const res = await client.post("/agent/devices", { name: "Dino", description: "  A rover in the garden.  " });
    expect(res.status).toBe(201);
    const id = res.body.device.id;
    expect(res.body.device.description).toBe("A rover in the garden.");
    expect((await register(client, "Cam")).device.description).toBeNull();

    const changed = await client.patch("/agent/devices", { id, description: "A rover. It watches the vegetable patch." });
    expect(changed.body.description).toBe("A rover. It watches the vegetable patch.");
    // Leaving it out keeps it; null or "" clears it.
    expect((await client.patch("/agent/devices", { id, name: "Dino 2" })).body.description).toBe(changed.body.description);
    expect((await client.patch("/agent/devices", { id, description: null })).body.description).toBeNull();
    await client.patch("/agent/devices", { id, description: "x" });
    expect((await client.patch("/agent/devices", { id, description: "" })).body.description).toBeNull();
    expect((await client.patch("/agent/devices", { id, description: "x".repeat(1001) })).status).toBe(400);
  });
});

describe("device link", () => {
  it("refuses a missing or wrong token and unknown paths", async () => {
    const { client } = await userWithAgent("Alice");
    const { token } = await register(client);

    expect(await refusedWith(WS_URL)).toBe(401);
    expect(await refusedWith(WS_URL, { authorization: "Bearer dev_wrong" })).toBe(401);
    expect(await refusedWith(WS_URL, { authorization: token })).toBe(401);
    expect(await refusedWith(BASE.replace(/^http/, "ws") + "/agent/other", { authorization: `Bearer ${token}` })).toBe(404);
    // A session cookie is not a device token.
    expect(await refusedWith(WS_URL, { cookie: "better-auth.session_token=x" })).toBe(401);
  });

  it("stores frames and shows them through the observations API", async () => {
    const { client } = await userWithAgent("Alice");
    const { device, token } = await register(client);

    const link = await connect(token);
    expect(await link.next("config")).toMatchObject({ paused: false, fov: 125, size: "2576x1449", heartbeatSec: 60 });

    link.sendJson({ type: "hello", version: "test/1", capabilities: { sizes: ["2576x1449"] } });
    link.sendJson({ type: "telemetry", cpuTempC: 61.5, wifiRssiDbm: -70, uptimeS: 12 });
    const capturedAt = Date.now() - 1500;
    const bytes = await jpeg(160, 90);
    link.ws.send(frameMessage(bytes, { seq: 42, capturedAt, trigger: "heartbeat" }));

    const observations = await waitFor(
      () => client.get(`/agent/devices/observations?device_id=${device.id}`),
      (res) => res.body.length === 1
    );
    expect(observations.body[0]).toMatchObject({
      deviceId: device.id,
      seq: 42,
      trigger: "heartbeat",
      width: 160,
      height: 90,
      bytes: bytes.length,
      hasFrame: true,
    });
    expect(new Date(observations.body[0].capturedAt).getTime()).toBe(capturedAt);

    const frame = await client.request(`/agent/devices/frame?id=${observations.body[0].id}`);
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await frame.arrayBuffer()).equals(bytes)).toBe(true);

    const status = await waitFor(
      () => client.get(`/agent/devices/status?id=${device.id}`),
      (res) => res.body.telemetry !== null && res.body.hello !== null
    );
    expect(status.body).toMatchObject({
      online: true,
      hello: { version: "test/1" },
      telemetry: { cpuTempC: 61.5, wifiRssiDbm: -70, uptimeS: 12 },
      lastObservation: { seq: 42 },
    });
  });

  it("rejects frames that aren't JPEGs and malformed messages, and keeps the link", async () => {
    const { client } = await userWithAgent("Alice");
    const { device, token } = await register(client);
    const link = await connect(token);
    await link.next("config");

    link.ws.send(frameMessage(Buffer.from("not a jpeg")));
    expect((await link.next("error")).message).toBe("Not a JPEG");
    link.ws.send(Buffer.from([0, 0, 0, 1]));
    expect((await link.next("error")).message).toMatch(/shorter/);
    link.sendJson({ type: "launch", target: "moon" });
    expect((await link.next("error")).message).toMatch(/Unknown/);
    link.ws.send(frameMessage(await jpeg(), { seq: -1 }));
    expect((await link.next("error")).message).toMatch(/malformed/);

    link.ws.send(frameMessage(await jpeg(), { seq: 2 }));
    const rows = await waitFor(
      () => client.get(`/agent/devices/observations?device_id=${device.id}`),
      (res) => res.body.length === 1
    );
    expect(rows.body[0].seq).toBe(2);
  });

  it("rate-limits frames per connection", async () => {
    const { client } = await userWithAgent("Alice");
    const { device, token } = await register(client);
    const link = await connect(token);
    await link.next("config");

    const bytes = await jpeg();
    for (let seq = 0; seq < 15; seq++) link.ws.send(frameMessage(bytes, { seq }));
    expect((await link.next("error")).message).toMatch(/Too many frames/);
    const rows = await waitFor(
      () => client.get(`/agent/devices/observations?device_id=${device.id}&limit=50`),
      (res) => res.body.length >= 10
    );
    expect(rows.body.length).toBeLessThan(15);
  });

  it("keeps one connection per device: a new one replaces the old", async () => {
    const { client } = await userWithAgent("Alice");
    const { device, token } = await register(client);

    const first = await connect(token);
    await first.next("config");
    const second = await connect(token);
    await second.next("config");

    expect(await first.closed).toMatchObject({ code: 4000 });
    second.ws.send(frameMessage(await jpeg(), { seq: 9 }));
    const rows = await waitFor(
      () => client.get(`/agent/devices/observations?device_id=${device.id}`),
      (res) => res.body.length === 1
    );
    expect(rows.body[0].seq).toBe(9);
    expect((await client.get(`/agent/devices/status?id=${device.id}`)).body.online).toBe(true);
  });

  it("pushes new settings to the connected device and drops frames while paused", async () => {
    const { client } = await userWithAgent("Alice");
    const { device, token } = await register(client);
    const link = await connect(token);
    await link.next("config");

    await client.patch("/agent/devices", { id: device.id, settings: { paused: true, cadence: { size: "1920x1080" } } });
    expect(await link.next("config")).toMatchObject({ paused: true, size: "1920x1080" });

    link.ws.send(frameMessage(await jpeg(), { seq: 1, trigger: "change" }));
    link.ws.send(frameMessage(await jpeg(), { seq: 2, trigger: "request", requestId: "r1" }));
    const rows = await waitFor(
      () => client.get(`/agent/devices/observations?device_id=${device.id}`),
      (res) => res.body.length >= 1
    );
    await new Promise((r) => setTimeout(r, 200));
    const all = (await client.get(`/agent/devices/observations?device_id=${device.id}`)).body;
    expect(all.map((r: any) => r.seq)).toEqual([2]);
    expect(rows.body[0]).toMatchObject({ trigger: "request", requestId: "r1" });
  });

  it("rotating the token cuts the old one off, live connection included", async () => {
    const { client } = await userWithAgent("Alice");
    const { device, token } = await register(client);
    const link = await connect(token);
    await link.next("config");

    const rotated = await client.post("/agent/devices/token", { id: device.id });
    expect(rotated.status).toBe(200);
    expect(rotated.body.token).not.toBe(token);
    expect(await link.closed).toMatchObject({ code: 4001 });
    expect(await refusedWith(WS_URL, { authorization: `Bearer ${token}` })).toBe(401);

    const fresh = await connect(rotated.body.token);
    expect(await fresh.next("config")).toMatchObject({ type: "config" });
  });

  it("deleting a device closes its link and removes its data", async () => {
    const { client } = await userWithAgent("Alice");
    const { device, token } = await register(client);
    const link = await connect(token);
    await link.next("config");
    link.ws.send(frameMessage(await jpeg()));
    const rows = await waitFor(
      () => client.get(`/agent/devices/observations?device_id=${device.id}`),
      (res) => res.body.length === 1
    );

    expect((await client.delete(`/agent/devices?id=${device.id}`)).status).toBe(204);
    expect(await link.closed).toMatchObject({ code: 4002 });
    expect((await client.get(`/agent/devices/observations?device_id=${device.id}`)).status).toBe(404);
    expect((await client.request(`/agent/devices/frame?id=${rows.body[0].id}`)).status).toBe(404);
    expect(await refusedWith(WS_URL, { authorization: `Bearer ${token}` })).toBe(401);
  });
});

describe("device access", () => {
  it("hides a device from other users and lets agent members view but not change it", async () => {
    const alice = await userWithAgent("Alice");
    const bob = await userWithAgent("Bob");
    const { device, token } = await register(alice.client);
    const link = await connect(token);
    await link.next("config");
    link.ws.send(frameMessage(await jpeg()));
    const rows = await waitFor(
      () => alice.client.get(`/agent/devices/observations?device_id=${device.id}`),
      (res) => res.body.length === 1
    );
    const frameUrl = `/agent/devices/frame?id=${rows.body[0].id}`;

    // A stranger: nothing is visible, and ids can't be probed.
    expect((await bob.client.get("/agent/devices")).body).toEqual([]);
    expect((await bob.client.get(`/agent/devices/observations?device_id=${device.id}`)).status).toBe(404);
    expect((await bob.client.get(`/agent/devices/status?id=${device.id}`)).status).toBe(404);
    expect((await bob.client.request(frameUrl)).status).toBe(404);
    expect((await bob.client.patch("/agent/devices", { id: device.id, name: "Mine" })).status).toBe(404);
    expect((await bob.client.post("/agent/devices/token", { id: device.id })).status).toBe(404);
    expect((await bob.client.delete(`/agent/devices?id=${device.id}`)).status).toBe(404);

    // Bob joins the agent the device works for: he can watch, not manage.
    await db.insert(agentMembers).values({ agentId: device.agentId, userId: bob.user.id });
    const listed = (await bob.client.get("/agent/devices")).body;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: device.id, role: "member" });
    expect((await bob.client.get(`/agent/devices/observations?device_id=${device.id}`)).body).toHaveLength(1);
    expect((await bob.client.request(frameUrl)).status).toBe(200);
    expect((await bob.client.patch("/agent/devices", { id: device.id, name: "Mine" })).status).toBe(403);
    expect((await bob.client.post("/agent/devices/token", { id: device.id })).status).toBe(403);
    expect((await bob.client.delete(`/agent/devices?id=${device.id}`)).status).toBe(403);

    // No session at all.
    const anonymous = new TestClient(BASE);
    expect((await anonymous.get("/agent/devices")).status).toBe(401);
    expect((await anonymous.request(frameUrl)).status).toBe(401);
  });

  it("only registers devices on agents the user belongs to", async () => {
    const alice = await userWithAgent("Alice");
    const bob = await userWithAgent("Bob");
    const res = await bob.client.post("/agent/devices", { name: "Spy", agent_id: alice.agentId });
    expect(res.status).toBe(403);
  });
});
