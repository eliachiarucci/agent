import { z } from "zod";
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

export const deviceSettingsSchema = z.object({
  paused: z.boolean(),
  cadence: cadenceSchema,
  retention: retentionSchema,
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
};

// What PATCH /agent/devices accepts: any subset, section by section.
export const deviceSettingsPatchSchema = z.strictObject({
  paused: z.boolean().optional(),
  cadence: cadenceSchema.partial().strict().optional(),
  retention: retentionSchema.partial().strict().optional(),
});
export type DeviceSettingsPatch = z.infer<typeof deviceSettingsPatchSchema>;

export function mergeDeviceSettings(base: DeviceSettings, patch: DeviceSettingsPatch): DeviceSettings {
  return {
    paused: patch.paused ?? base.paused,
    cadence: { ...base.cadence, ...patch.cadence },
    retention: { ...base.retention, ...patch.retention },
  };
}

/** Stored settings over the current defaults; an invalid stored value falls back to the defaults. */
export function readDeviceSettings(stored: unknown): DeviceSettings {
  const value = (stored && typeof stored === "object" ? stored : {}) as Partial<DeviceSettings>;
  const merged = {
    paused: value.paused ?? DEFAULT_DEVICE_SETTINGS.paused,
    cadence: { ...DEFAULT_DEVICE_SETTINGS.cadence, ...value.cadence },
    retention: { ...DEFAULT_DEVICE_SETTINGS.retention, ...value.retention },
  };
  const parsed = deviceSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_DEVICE_SETTINGS;
}

export function deviceConfig(settings: DeviceSettings): DeviceConfig {
  return { paused: settings.paused, ...settings.cadence };
}
