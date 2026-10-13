import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  countObservations,
  createDevice,
  getObservation,
  insertDeviceEvent,
  insertObservation,
  listObservations,
  type Device,
} from "../../lib/db/devices";
import { InvalidFrameError, frameFilePath, inspectJpeg, writeFrame } from "../../lib/devices/frames";
import { observationToolsPrompt } from "../../lib/devices/observation-tools";
import {
  MAX_HEADER_BYTES,
  ProtocolError,
  decodeBinaryMessage,
  encodeBinaryMessage,
} from "../../lib/devices/protocol";
import { TokenBucket } from "../../lib/devices/rate-limit";
import { runDeviceRetention } from "../../lib/devices/retention";
import {
  DEFAULT_DEVICE_SETTINGS,
  deviceSettingsPatchSchema,
  mergeDeviceSettings,
  readDeviceSettings,
} from "../../lib/devices/settings";
import { bearerToken, generateDeviceToken, hashDeviceToken } from "../../lib/devices/tokens";
import { closeDb, db, makeUserWithAgent, resetDb } from "../helpers/db";
import { deviceEvents } from "../../lib/global/schema";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-devices-"));
  process.env.FILES_DIR = root;
});

beforeEach(resetDb);

afterAll(async () => {
  await closeDb();
  await rm(root, { recursive: true, force: true });
});

const jpeg = (width = 64, height = 36) =>
  sharp({ create: { width, height, channels: 3, background: { r: 40, g: 80, b: 120 } } })
    .jpeg()
    .toBuffer();

describe("device tokens", () => {
  it("are random, prefixed, and stored only as their SHA-256", () => {
    const a = generateDeviceToken();
    const b = generateDeviceToken();
    expect(a.token).toMatch(/^dev_[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashDeviceToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("are read from a Bearer header only", () => {
    const { token } = generateDeviceToken();
    expect(bearerToken(`Bearer ${token}`)).toBe(token);
    expect(bearerToken(token)).toBeNull();
    expect(bearerToken(`Basic ${token}`)).toBeNull();
    expect(bearerToken("Bearer a b")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe("binary message framing", () => {
  it("round-trips a header and a payload", () => {
    const payload = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]);
    const header = { type: "frame", seq: 7, capturedAt: 1, trigger: "change" };
    const decoded = decodeBinaryMessage(encodeBinaryMessage(header, payload));
    expect(decoded.header).toEqual(header);
    expect(decoded.payload.equals(payload)).toBe(true);
  });

  it("allows an empty payload", () => {
    const decoded = decodeBinaryMessage(encodeBinaryMessage({ type: "x" }, new Uint8Array()));
    expect(decoded.payload.length).toBe(0);
  });

  it("rejects truncated, oversized and non-JSON headers", () => {
    const bad = (bytes: Buffer) => () => decodeBinaryMessage(bytes);
    expect(bad(Buffer.from([0, 0]))).toThrow(ProtocolError);

    const short = Buffer.alloc(4 + 3);
    short.writeUInt32BE(10, 0);
    expect(bad(short)).toThrow(ProtocolError);

    const huge = Buffer.alloc(4);
    huge.writeUInt32BE(MAX_HEADER_BYTES + 1, 0);
    expect(bad(huge)).toThrow(ProtocolError);

    const zero = Buffer.alloc(4);
    expect(bad(zero)).toThrow(ProtocolError);

    const notJson = Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from("{{{")]);
    expect(bad(notJson)).toThrow(ProtocolError);

    expect(() => encodeBinaryMessage({ pad: "x".repeat(MAX_HEADER_BYTES) }, new Uint8Array())).toThrow(
      ProtocolError
    );
  });
});

describe("device settings", () => {
  it("read stored values over the defaults", () => {
    expect(readDeviceSettings(undefined)).toEqual(DEFAULT_DEVICE_SETTINGS);
    const stored = { cadence: { fov: 110 } };
    expect(readDeviceSettings(stored).cadence).toEqual({ ...DEFAULT_DEVICE_SETTINGS.cadence, fov: 110 });
    // Garbage falls back to the defaults instead of breaking the device.
    expect(readDeviceSettings({ cadence: { fov: "wide" } })).toEqual(DEFAULT_DEVICE_SETTINGS);
  });

  it("merge a patch section by section", () => {
    const patch = deviceSettingsPatchSchema.parse({ paused: true, cadence: { size: "1920x1080" } });
    const merged = mergeDeviceSettings(DEFAULT_DEVICE_SETTINGS, patch);
    expect(merged.paused).toBe(true);
    expect(merged.cadence).toEqual({ ...DEFAULT_DEVICE_SETTINGS.cadence, size: "1920x1080" });
    expect(merged.retention).toEqual(DEFAULT_DEVICE_SETTINGS.retention);
  });

  it("reject unknown keys and out-of-range values", () => {
    expect(deviceSettingsPatchSchema.safeParse({ cadence: { fov: 130 } }).success).toBe(false);
    expect(deviceSettingsPatchSchema.safeParse({ cadence: { zoom: 2 } }).success).toBe(false);
    expect(deviceSettingsPatchSchema.safeParse({ faces: {} }).success).toBe(false);
  });
});

describe("frame rate limit", () => {
  it("allows a burst, then refills at the set rate", () => {
    let now = 0;
    const bucket = new TokenBucket(3, 2, () => now);
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false]);
    now += 499;
    expect(bucket.take()).toBe(false);
    now += 1;
    expect(bucket.take()).toBe(true);
    now += 10_000;
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false]);
  });
});

describe("frame checks", () => {
  it("accept a JPEG and report its size", async () => {
    expect(await inspectJpeg(await jpeg(64, 36))).toEqual({ width: 64, height: 36 });
  });

  it("reject other formats and junk", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } })
      .png()
      .toBuffer();
    await expect(inspectJpeg(png)).rejects.toThrow(InvalidFrameError);
    await expect(inspectJpeg(Buffer.alloc(0))).rejects.toThrow(InvalidFrameError);
    await expect(inspectJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))).rejects.toThrow(
      InvalidFrameError
    );
  });

  it("refuse frame names that aren't generated ones", () => {
    expect(() => frameFilePath("d", "../../etc/passwd")).toThrow();
  });
});

describe("device retention", () => {
  const DAY = 24 * 60 * 60 * 1000;

  async function deviceWithFrames(ages: number[], settings = DEFAULT_DEVICE_SETTINGS) {
    const { user, agent } = await makeUserWithAgent("Alice");
    const device = await createDevice({
      ownerId: user.id,
      agentId: agent.id,
      name: "Rover",
      tokenHash: generateDeviceToken().hash,
      settings,
    });
    const now = Date.now();
    const rows = [];
    for (const [i, ageDays] of ages.entries()) {
      const at = new Date(now - ageDays * DAY);
      const frame = await writeFrame(device.id, await jpeg());
      rows.push(
        await insertObservation({
          deviceId: device.id,
          seq: i,
          trigger: "heartbeat",
          capturedAt: at,
          receivedAt: at,
          frame,
          width: 64,
          height: 36,
          bytes: 1,
        })
      );
    }
    return { device, rows };
  }

  const exists = (path: string) => stat(path).then(() => true, () => false);

  it("deletes frames after frameDays and rows after observationDays", async () => {
    const { device, rows } = await deviceWithFrames([0.5, 8, 100]);
    await insertDeviceEvent(device.id, "connected");
    await db.update(deviceEvents).set({ createdAt: new Date(Date.now() - 100 * DAY) });
    await insertDeviceEvent(device.id, "connected");

    const result = await runDeviceRetention();
    expect(result).toEqual({ frames: 2, observations: 1, events: 1 });

    const [fresh, week, old] = rows;
    expect((await getObservation(fresh.id))?.frame).toBe(fresh.frame);
    expect(await exists(frameFilePath(device.id, fresh.frame!))).toBe(true);
    expect((await getObservation(week.id))?.frame).toBeNull();
    expect(await exists(frameFilePath(device.id, week.frame!))).toBe(false);
    expect(await getObservation(old.id)).toBeUndefined();
    expect(await exists(frameFilePath(device.id, old.frame!))).toBe(false);
    expect(await countObservations(device.id)).toBe(2);

    // Nothing left to do on a second run.
    expect(await runDeviceRetention()).toEqual({ frames: 0, observations: 0, events: 0 });
  });

  it("follows each device's own settings, and never leaves a frame without its row", async () => {
    const { device, rows } = await deviceWithFrames([2, 4], {
      ...DEFAULT_DEVICE_SETTINGS,
      retention: { frameDays: 30, observationDays: 3 },
    });
    expect(await runDeviceRetention()).toEqual({ frames: 1, observations: 1, events: 0 });
    expect(await exists(frameFilePath(device.id, rows[1].frame!))).toBe(false);
    expect((await listObservations({ deviceId: device.id, limit: 10 })).map((r) => r.id)).toEqual([rows[0].id]);
  });

  it("tolerates a frame file that is already gone", async () => {
    const { device, rows } = await deviceWithFrames([10]);
    await rm(frameFilePath(device.id, rows[0].frame!));
    expect(await runDeviceRetention()).toEqual({ frames: 1, observations: 0, events: 0 });
  });
});

describe("the chat prompt's device section", () => {
  const device = (name: string, description: string | null) => ({ id: `${name}-0000`, name, description }) as Device;

  it("lists each device with what it is and what it's for", () => {
    const prompt = observationToolsPrompt([
      device("Dino", "A rover in the garden.\nIt watches the vegetable patch."),
      device("Cam", null),
    ]);
    expect(prompt).toContain("- Dino: A rover in the garden. It watches the vegetable patch.");
    expect(prompt).toContain("- Cam: (no description)");
    expect(prompt).toContain('"what did Dino see today?"');
    expect(prompt).toContain("Use it only when the question is about what a device saw");
  });
});
