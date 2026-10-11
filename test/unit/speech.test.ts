import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDevice, listDeviceEvents, type Device } from "../../lib/db/devices";
import { DEFAULT_DEVICE_SETTINGS, mergeDeviceSettings, type DeviceSettings } from "../../lib/devices/settings";
import { speak, type SpeakDeps } from "../../lib/devices/speech";
import { checkSpeechPolicy, inQuietHours } from "../../lib/devices/speech-policy";
import { parseWav, resolveVoice } from "../../lib/devices/tts";
import { localDayRange, zonedInstant } from "../../lib/devices/time";
import { generateDeviceToken } from "../../lib/devices/tokens";
import { closeDb, makeUserWithAgent, resetDb } from "../helpers/db";
import { silentWav } from "../helpers/fake-piper";

beforeEach(resetDb);
afterAll(closeDb);

const ROME = "Europe/Rome";
const speech = DEFAULT_DEVICE_SETTINGS.speech;
// 2026-10-11 is CEST (UTC+2).
const romeAt = (clock: string) => zonedInstant("2026-10-11", clock, ROME);

const wav = (ms: number, sampleRate?: number) => new Uint8Array(silentWav(ms, sampleRate));

describe("speech policy", () => {
  const input = {
    speech,
    timeZone: ROME,
    online: true,
    urgent: false,
    lastSpokenAt: null,
    spokenLastHour: 0,
  };

  it("keep quiet hours that cross midnight, in the device's zone", () => {
    expect(inQuietHours(speech.quietHours, romeAt("21:59"), ROME)).toBe(false);
    expect(inQuietHours(speech.quietHours, romeAt("22:00"), ROME)).toBe(true);
    expect(inQuietHours(speech.quietHours, romeAt("03:00"), ROME)).toBe(true);
    expect(inQuietHours(speech.quietHours, romeAt("08:00"), ROME)).toBe(false);
    expect(inQuietHours({ start: "13:00", end: "15:00" }, romeAt("14:00"), ROME)).toBe(true);
    expect(inQuietHours(null, romeAt("03:00"), ROME)).toBe(false);
    // 20:30 UTC is 22:30 in Rome: quiet there, not by the UTC clock.
    expect(inQuietHours(speech.quietHours, new Date("2026-10-11T20:30:00Z"), "UTC")).toBe(false);
    expect(inQuietHours(speech.quietHours, new Date("2026-10-11T20:30:00Z"), ROME)).toBe(true);
  });

  it("refuse offline, muted, quiet, over the cap and in the cooldown; urgent skips only the cooldown", () => {
    const now = romeAt("12:00");
    expect(checkSpeechPolicy({ ...input, now })).toEqual({ ok: true });
    expect(checkSpeechPolicy({ ...input, now, online: false })).toMatchObject({ ok: false, reason: /offline/ });
    expect(checkSpeechPolicy({ ...input, now, speech: { ...speech, muted: true } })).toMatchObject({
      ok: false,
      reason: /muted/,
    });
    expect(checkSpeechPolicy({ ...input, now: romeAt("23:00"), urgent: true })).toMatchObject({
      ok: false,
      reason: /Quiet hours/,
    });
    expect(checkSpeechPolicy({ ...input, now, spokenLastHour: 20, urgent: true })).toMatchObject({
      ok: false,
      reason: /limit/,
    });
    const lastSpokenAt = new Date(now.getTime() - 30_000);
    expect(checkSpeechPolicy({ ...input, now, lastSpokenAt })).toMatchObject({ ok: false, reason: /wait 30 s/ });
    expect(checkSpeechPolicy({ ...input, now, lastSpokenAt, urgent: true })).toEqual({ ok: true });
    expect(checkSpeechPolicy({ ...input, now, lastSpokenAt: new Date(now.getTime() - 61_000) })).toEqual({
      ok: true,
    });
  });
});

describe("voices and audio", () => {
  it("pick a voice per language, falling back to the default language's", () => {
    expect(resolveVoice(speech, "it")).toEqual({ voice: "it_IT-paola-medium", fallback: false });
    expect(resolveVoice(speech, "it-IT")).toEqual({ voice: "it_IT-paola-medium", fallback: false });
    expect(resolveVoice(speech, "de")).toEqual({ voice: "en_US-lessac-medium", fallback: true });
    expect(resolveVoice({ ...speech, voices: { it: "it_IT-riccardo-x_low" } }, "it").voice).toBe(
      "it_IT-riccardo-x_low"
    );
    expect(resolveVoice({ ...speech, provider: "openai" }, "de")).toEqual({ voice: "alloy", fallback: false });
  });

  it("read the sample rate and length of a WAV", () => {
    expect(parseWav(wav(1500))).toEqual({ sampleRate: 22050, durationMs: 1500 });
    // A streamed WAV with no data size set.
    const streamed = wav(500, 24000);
    new DataView(streamed.buffer).setUint32(40, 0xffffffff, true);
    expect(parseWav(streamed)).toEqual({ sampleRate: 24000, durationMs: 500 });
    expect(() => parseWav(new Uint8Array([1, 2, 3]))).toThrow(/WAV/);
  });

  it("turn local days into instants across a DST change", () => {
    expect(zonedInstant("2026-10-11", "00:00", ROME).toISOString()).toBe("2026-10-10T22:00:00.000Z");
    // Rome leaves summer time on 2026-10-25: that day lasts 25 hours.
    const { from, to } = localDayRange("2026-10-25", ROME);
    expect(from.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(to.toISOString()).toBe("2026-10-25T22:59:59.999Z");
  });
});

describe("speak", () => {
  let device: Device;
  let clock: Date;
  let sent: number;
  let online: boolean;

  const deps = (): SpeakDeps => ({
    synthesize: async () => ({ audio: wav(1200), format: "wav", sampleRate: 22050, durationMs: 1200 }),
    send: async (_id, audio) => {
      sent++;
      return { speechId: "s", ok: true, durationMs: audio.durationMs + 100 };
    },
    online: () => online,
    now: () => clock,
  });

  async function setup(patch: Parameters<typeof mergeDeviceSettings>[1] = {}) {
    const { user, agent } = await makeUserWithAgent("Elia");
    const settings: DeviceSettings = mergeDeviceSettings(DEFAULT_DEVICE_SETTINGS, {
      timezone: ROME,
      speech: { quietHours: null },
      ...patch,
    });
    device = await createDevice({
      ownerId: user.id,
      agentId: agent.id,
      name: "Rover",
      tokenHash: generateDeviceToken().hash,
      settings,
    });
  }

  beforeEach(() => {
    clock = new Date();
    sent = 0;
    online = true;
  });

  it("speak, log it, and hold the cooldown from the log", async () => {
    await setup();
    const first = await speak({ device, text: "Hello there", source: "agent" }, deps());
    expect(first).toEqual({ spoken: true, durationMs: 1300, language: "en", voice: "en_US-lessac-medium" });

    const second = await speak({ device, text: "Hello again", source: "agent" }, deps());
    expect(second).toMatchObject({ spoken: false, reason: expect.stringMatching(/less than 60 s/) });
    expect(sent).toBe(1);

    // A person pressing say isn't held to the agent's limits.
    expect(await speak({ device, text: "From the app", source: "user", userId: "u" }, deps())).toMatchObject({
      spoken: true,
    });

    const events = await listDeviceEvents({ deviceId: device.id, kind: "speech", limit: 10 });
    expect(events.map((e) => e.detail?.status)).toEqual(["spoken", "refused", "spoken"]);
    expect(events[2].detail).toMatchObject({ text: "Hello there", source: "agent", voice: "en_US-lessac-medium" });
  });

  it("note a language without a voice, and refuse when muted or offline without synthesising", async () => {
    await setup();
    expect(await speak({ device, text: "Hallo", language: "de", source: "agent" }, deps())).toMatchObject({
      spoken: true,
      voice: "en_US-lessac-medium",
      note: expect.stringMatching(/No voice for "de"/),
    });

    device = { ...device, settings: mergeDeviceSettings(device.settings, { speech: { muted: true } }) };
    expect(await speak({ device, text: "Hi", source: "agent", urgent: true }, deps())).toEqual({
      spoken: false,
      reason: "The device is muted.",
    });
    online = false;
    expect(await speak({ device, text: "Hi", source: "user" }, deps())).toEqual({
      spoken: false,
      reason: "The device is offline.",
    });
    expect(sent).toBe(1);
  });

  it("report a failed delivery", async () => {
    await setup();
    const failing = { ...deps(), send: async () => ({ speechId: "s", ok: false, error: "No answer from the device" }) };
    expect(await speak({ device, text: "Hi", source: "agent" }, failing)).toEqual({
      spoken: false,
      reason: "No answer from the device",
    });
    // A failed delivery doesn't start the cooldown.
    expect(await speak({ device, text: "Hi", source: "agent" }, deps())).toMatchObject({ spoken: true });
  });
});
