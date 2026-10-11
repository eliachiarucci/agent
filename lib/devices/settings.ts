import { z } from "zod";
import { PROVIDER_TYPES } from "../global/schema";
import type { DeviceConfig } from "./protocol";

// Per-device settings, stored as JSONB on `devices.settings`. Rows are always
// read over the current defaults (readDeviceSettings), so a field added later
// gets its default on existing devices without a data migration.

// Overview sizes the rover renders (a 16:9 rectilinear view, plan D16).
export const FRAME_SIZES = ["2576x1449", "1920x1080"] as const;

const cadenceSchema = z.object({
  // A frame at least this often even when nothing changes.
  heartbeatSec: z.number().int().min(10).max(3600),
  // Minimum gap between change-triggered frames.
  minIntervalMs: z.number().int().min(250).max(60_000),
  // Fraction of the small grayscale frame that must change to send a frame.
  changeThreshold: z.number().min(0).max(1),
  size: z.enum(FRAME_SIZES),
  jpegQuality: z.number().int().min(50).max(95),
  // Diagonal field of view of the corrected view, in degrees. The IMX219-160
  // fills at most 127° in 16:9 (plan D18).
  fov: z.number().min(60).max(127),
});

const retentionSchema = z.object({
  // Days a frame image is kept on disk.
  frameDays: z.number().int().min(1).max(365),
  // Days an observation row is kept. Frames never outlive their row.
  observationDays: z.number().int().min(1).max(3650),
});

const routeSchema = z
  .object({
    only: z.array(z.string().min(1).max(100)).min(1).max(8),
    allowFallbacks: z.boolean(),
  })
  .nullable();

const perceptionSchema = z.object({
  // Off: frames are stored but never captioned.
  enabled: z.boolean(),
  // The captioning model, resolved against the owner's provider settings. NULL
  // provider → the owner's default model; NULL model → the provider's default.
  provider: z.enum(PROVIDER_TYPES).nullable(),
  model: z.string().min(1).max(200).nullable(),
  // OpenRouter only: the endpoints allowed to serve the call, e.g.
  // ["google-vertex/europe"] (plan D20).
  route: routeSchema,
  // Captions per rolling hour. Over it, frames are stored but not captioned.
  framesPerHour: z.number().int().min(0).max(3600),
});

const agentSchema = z.object({
  // Off: captions are stored, but the agent never runs on them.
  enabled: z.boolean(),
  // The run's model, like perception's: NULL provider → the owner's default
  // model. `route` pins OpenRouter endpoints (the frame goes to this model too).
  provider: z.enum(PROVIDER_TYPES).nullable(),
  model: z.string().min(1).max(200).nullable(),
  route: routeSchema,
  // A caption at or above this salience starts a run (besides wake = "agent"
  // and a new person or animal).
  salience: z.number().min(0).max(1),
  // Runs start at least this far apart; triggers in between merge into the next run.
  minGapSec: z.number().int().min(5).max(3600),
  // Every this many minutes, if anything was logged, a run sums up the period. 0 = off.
  reflectionMin: z.number().int().min(0).max(24 * 60),
  // Runs per rolling hour; triggers over it are dropped.
  runsPerHour: z.number().int().min(0).max(600),
});

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM");

export const SPEECH_PROVIDERS = ["piper", "openai"] as const;
export type SpeechProvider = (typeof SPEECH_PROVIDERS)[number];

const speechSchema = z.object({
  // The mute switch: the agent can't speak (the say route still can).
  muted: z.boolean(),
  // Piper runs in its own container (PIPER_URL); OpenAI uses the owner's key.
  provider: z.enum(SPEECH_PROVIDERS),
  // OpenAI speech model; NULL → gpt-4o-mini-tts. Unused with Piper.
  model: z.string().min(1).max(100).nullable(),
  // BCP-47 tag used when the agent doesn't name a language.
  language: z.string().min(2).max(35),
  // Voice per language ("en", "it", …), over the provider's built-in defaults.
  voices: z.record(z.string().min(2).max(35), z.string().min(1).max(100)),
  cooldownSec: z.number().int().min(0).max(3600),
  maxPerHour: z.number().int().min(0).max(600),
  // Local wall-clock window (the device's timezone) with no agent speech; it may
  // cross midnight. NULL = never quiet.
  quietHours: z.object({ start: clockTime, end: clockTime }).nullable(),
});

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const deviceSettingsSchema = z.object({
  paused: z.boolean(),
  // IANA zone for the daily log, quiet hours and times shown to the agent.
  // NULL → the server's zone.
  timezone: z.string().max(64).refine(isTimeZone, "Unknown timezone").nullable(),
  cadence: cadenceSchema,
  retention: retentionSchema,
  perception: perceptionSchema,
  agent: agentSchema,
  speech: speechSchema,
});
export type DeviceSettings = z.infer<typeof deviceSettingsSchema>;

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  paused: false,
  timezone: null,
  cadence: {
    heartbeatSec: 60,
    minIntervalMs: 1000,
    changeThreshold: 0.02,
    size: "2576x1449",
    jpegQuality: 90,
    fov: 125,
  },
  retention: { frameDays: 7, observationDays: 90 },
  // 300 an hour is ≈ $0.27 an hour at most with Claude Haiku 5.5 at 2576×1449 (P0 bench).
  perception: { enabled: true, provider: null, model: null, route: null, framesPerHour: 300 },
  agent: {
    enabled: true,
    provider: null,
    model: null,
    route: null,
    salience: 0.6,
    minGapSec: 20,
    reflectionMin: 30,
    runsPerHour: 30,
  },
  // Plan D6: 60 s cooldown, 20 an hour, quiet 22:00–08:00.
  speech: {
    muted: false,
    provider: "piper",
    model: null,
    language: "en",
    voices: {},
    cooldownSec: 60,
    maxPerHour: 20,
    quietHours: { start: "22:00", end: "08:00" },
  },
};

// What PATCH /agent/devices accepts: any subset, section by section.
export const deviceSettingsPatchSchema = z.strictObject({
  paused: z.boolean().optional(),
  timezone: deviceSettingsSchema.shape.timezone.optional(),
  cadence: cadenceSchema.partial().strict().optional(),
  retention: retentionSchema.partial().strict().optional(),
  perception: perceptionSchema.partial().strict().optional(),
  agent: agentSchema.partial().strict().optional(),
  speech: speechSchema.partial().strict().optional(),
});
export type DeviceSettingsPatch = z.infer<typeof deviceSettingsPatchSchema>;

export function mergeDeviceSettings(base: DeviceSettings, patch: DeviceSettingsPatch): DeviceSettings {
  return {
    paused: patch.paused ?? base.paused,
    timezone: patch.timezone !== undefined ? patch.timezone : base.timezone,
    cadence: { ...base.cadence, ...patch.cadence },
    retention: { ...base.retention, ...patch.retention },
    perception: { ...base.perception, ...patch.perception },
    agent: { ...base.agent, ...patch.agent },
    speech: { ...base.speech, ...patch.speech },
  };
}

/** Stored settings over the current defaults; an invalid stored value falls back to the defaults. */
export function readDeviceSettings(stored: unknown): DeviceSettings {
  const value = (stored && typeof stored === "object" ? stored : {}) as Partial<DeviceSettings>;
  const merged = {
    paused: value.paused ?? DEFAULT_DEVICE_SETTINGS.paused,
    timezone: value.timezone ?? DEFAULT_DEVICE_SETTINGS.timezone,
    cadence: { ...DEFAULT_DEVICE_SETTINGS.cadence, ...value.cadence },
    retention: { ...DEFAULT_DEVICE_SETTINGS.retention, ...value.retention },
    perception: { ...DEFAULT_DEVICE_SETTINGS.perception, ...value.perception },
    agent: { ...DEFAULT_DEVICE_SETTINGS.agent, ...value.agent },
    speech: { ...DEFAULT_DEVICE_SETTINGS.speech, ...value.speech },
  };
  const parsed = deviceSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_DEVICE_SETTINGS;
}

/** The device's timezone, or the server's when none is set. */
export function deviceTimeZone(settings: DeviceSettings): string {
  return settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function deviceConfig(settings: DeviceSettings): DeviceConfig {
  return { paused: settings.paused, ...settings.cadence };
}
