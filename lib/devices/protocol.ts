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

export const deviceTextMessageSchema = z.discriminatedUnion("type", [helloSchema, telemetrySchema]);
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

// ── server → device ──────────────────────────────────────────────────────────

export type ServerTextMessage =
  | ({ type: "config" } & DeviceConfig)
  | { type: "error"; message: string };

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
