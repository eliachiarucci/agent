import { z } from "zod";

// Wire format of the device link (one WebSocket per device, lib/devices/gateway.ts).
// Control messages are JSON text. Binary messages carry a JSON header and a raw
// payload: [u32 big-endian header length][UTF-8 JSON header][payload bytes], so a
// JPEG or an audio clip travels without base64.

export const MAX_HEADER_BYTES = 16 * 1024;
export const MAX_TEXT_MESSAGE_BYTES = 16 * 1024;

export class ProtocolError extends Error {}

export function encodeBinaryMessage(header: object, payload: Uint8Array): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  if (json.length > MAX_HEADER_BYTES) throw new ProtocolError("Header too large");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(json.length, 0);
  return Buffer.concat([prefix, json, payload]);
}

export function decodeBinaryMessage(data: Buffer): { header: unknown; payload: Buffer } {
  if (data.length < 4) throw new ProtocolError("Binary message shorter than its length prefix");
  const length = data.readUInt32BE(0);
  if (length === 0 || length > MAX_HEADER_BYTES) throw new ProtocolError("Bad header length");
  if (data.length < 4 + length) throw new ProtocolError("Binary message shorter than its header");
  let header: unknown;
  try {
    header = JSON.parse(data.subarray(4, 4 + length).toString("utf8"));
  } catch {
    throw new ProtocolError("Header is not valid JSON");
  }
  return { header, payload: data.subarray(4 + length) };
}

// ── device → server ──────────────────────────────────────────────────────────

export const FRAME_TRIGGERS = ["change", "heartbeat", "request"] as const;
export type FrameTrigger = (typeof FRAME_TRIGGERS)[number];

export const helloSchema = z.object({
  type: z.literal("hello"),
  version: z.string().max(64),
  capabilities: z
    .object({
      sizes: z.array(z.string().max(32)).max(16).optional(),
      audio: z.array(z.string().max(32)).max(16).optional(),
    })
    .optional(),
});
export type DeviceHello = Omit<z.infer<typeof helloSchema>, "type">;

export const telemetrySchema = z.object({
  type: z.literal("telemetry"),
  cpuTempC: z.number().optional(),
  wifiRssiDbm: z.number().optional(),
  uptimeS: z.number().optional(),
});
export type DeviceTelemetry = Omit<z.infer<typeof telemetrySchema>, "type">;

// The device finished (or failed) playing a `speech` message.
export const playedSchema = z.object({
  type: z.literal("played"),
  speechId: z.string().min(1).max(64),
  ok: z.boolean(),
  durationMs: z.number().int().min(0).max(10 * 60 * 1000).optional(),
  error: z.string().max(500).optional(),
});
export type DevicePlayed = Omit<z.infer<typeof playedSchema>, "type">;

export const deviceTextMessageSchema = z.discriminatedUnion("type", [
  helloSchema,
  telemetrySchema,
  playedSchema,
]);
export type DeviceTextMessage = z.infer<typeof deviceTextMessageSchema>;

// Header of a binary `frame` message; the payload is the JPEG.
export const frameHeaderSchema = z.object({
  type: z.literal("frame"),
  seq: z.number().int().min(0).max(2 ** 31 - 1),
  // Epoch milliseconds on the device's clock.
  capturedAt: z.number().int().min(0),
  trigger: z.enum(FRAME_TRIGGERS),
  requestId: z.string().min(1).max(64).optional(),
});
export type FrameHeader = z.infer<typeof frameHeaderSchema>;

// Header of a binary `audio` message (voice mode, plan 4.11): microphone audio
// while the device's VAD hears speech, 16 kHz mono 16-bit PCM in 20–100 ms
// chunks. A segment is one stretch of speech (with ~300 ms of pre-roll); its
// first chunk has start, its last end (the payload may be empty).
export const AUDIO_SAMPLE_RATE = 16_000;
export const MAX_AUDIO_CHUNK_BYTES = 64 * 1024;
export const audioHeaderSchema = z.object({
  type: z.literal("audio"),
  segment: z.string().min(1).max(64),
  seq: z.number().int().min(0).max(2 ** 31 - 1),
  start: z.boolean().optional(),
  end: z.boolean().optional(),
  format: z.literal("pcm_s16le"),
  sampleRate: z.literal(AUDIO_SAMPLE_RATE),
});
export type AudioHeader = z.infer<typeof audioHeaderSchema>;

// ── server → device ──────────────────────────────────────────────────────────

// A region of the overview, in normalised coordinates (0–1, origin top left).
export type CaptureRegion = { x: number; y: number; w: number; h: number };

export type CaptureRequest = {
  requestId: string;
  // Without a region: a fresh overview frame at the configured size. With one:
  // that region rendered as an undistorted view at full resolution (plan 4.4).
  region?: CaptureRegion;
};

export type ServerTextMessage =
  | ({ type: "config" } & DeviceConfig)
  | ({ type: "capture" } & CaptureRequest)
  | { type: "stop_speech" }
  | { type: "error"; message: string };

// Header of a binary `speech` message; the payload is the audio file.
export type SpeechHeader = {
  type: "speech";
  speechId: string;
  format: "wav" | "mp3";
  sampleRate: number;
};

// What the device needs from its settings (lib/devices/settings.ts).
export type DeviceConfig = {
  paused: boolean;
  heartbeatSec: number;
  minIntervalMs: number;
  changeThreshold: number;
  size: string;
  jpegQuality: number;
  fov: number;
};
