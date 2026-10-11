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

const perceptionSchema = z.object({
  // Off: frames are stored but never captioned.
  enabled: z.boolean(),
  // The captioning model, resolved against the owner's provider settings. NULL
  // provider → the owner's default model; NULL model → the provider's default.
  provider: z.enum(PROVIDER_TYPES).nullable(),
  model: z.string().min(1).max(200).nullable(),
  // OpenRouter only: the endpoints allowed to serve the call, e.g.
  // ["google-vertex/europe"] (plan D20).
  route: z
    .object({
      only: z.array(z.string().min(1).max(100)).min(1).max(8),
      allowFallbacks: z.boolean(),
    })
    .nullable(),
  // Captions per rolling hour. Over it, frames are stored but not captioned.
  framesPerHour: z.number().int().min(0).max(3600),
});

export const deviceSettingsSchema = z.object({
  paused: z.boolean(),
  cadence: cadenceSchema,
  retention: retentionSchema,
  perception: perceptionSchema,
});
export type DeviceSettings = z.infer<typeof deviceSettingsSchema>;

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  paused: false,
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
};

// What PATCH /agent/devices accepts: any subset, section by section.
export const deviceSettingsPatchSchema = z.strictObject({
  paused: z.boolean().optional(),
  cadence: cadenceSchema.partial().strict().optional(),
  retention: retentionSchema.partial().strict().optional(),
  perception: perceptionSchema.partial().strict().optional(),
});
export type DeviceSettingsPatch = z.infer<typeof deviceSettingsPatchSchema>;

export function mergeDeviceSettings(base: DeviceSettings, patch: DeviceSettingsPatch): DeviceSettings {
  return {
    paused: patch.paused ?? base.paused,
    cadence: { ...base.cadence, ...patch.cadence },
    retention: { ...base.retention, ...patch.retention },
    perception: { ...base.perception, ...patch.perception },
  };
}

/** Stored settings over the current defaults; an invalid stored value falls back to the defaults. */
export function readDeviceSettings(stored: unknown): DeviceSettings {
  const value = (stored && typeof stored === "object" ? stored : {}) as Partial<DeviceSettings>;
  const merged = {
    paused: value.paused ?? DEFAULT_DEVICE_SETTINGS.paused,
    cadence: { ...DEFAULT_DEVICE_SETTINGS.cadence, ...value.cadence },
    retention: { ...DEFAULT_DEVICE_SETTINGS.retention, ...value.retention },
    perception: { ...DEFAULT_DEVICE_SETTINGS.perception, ...value.perception },
  };
  const parsed = deviceSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_DEVICE_SETTINGS;
}

export function deviceConfig(settings: DeviceSettings): DeviceConfig {
  return { paused: settings.paused, ...settings.cadence };
}
