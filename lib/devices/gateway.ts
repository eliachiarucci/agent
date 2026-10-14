import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  type DeviceObservation,
  getDeviceByTokenHash,
  insertDeviceEvent,
  insertObservation,
  touchDevice,
} from "../db/devices";
import {
  MAX_HEADER_BYTES,
  MAX_TEXT_MESSAGE_BYTES,
  ProtocolError,
  audioHeaderSchema,
  MAX_AUDIO_CHUNK_BYTES,
  decodeBinaryMessage,
  deviceTextMessageSchema,
  encodeBinaryMessage,
  frameHeaderSchema,
  type CaptureRegion,
  type DevicePlayed,
  type ServerTextMessage,
  type SpeechHeader,
} from "./protocol";
import { InvalidFrameError, MAX_FRAME_BYTES, inspectJpeg, removeFrame, writeFrame } from "./frames";
import { publicObservation, publishLive } from "./live";
import { perceptionWorker } from "./perception";
import { TokenBucket } from "./rate-limit";
import { deviceConfig, readDeviceSettings, type DeviceSettings } from "./settings";
import { bearerToken, hashDeviceToken } from "./tokens";
import { voiceSessions } from "./voice/session";

// The device link (plan 4.2): each device keeps one outbound WebSocket to
// /agent/devices/ws, authenticated once with `Authorization: Bearer <token>`.
// The upgrade is handled on the http.Server (index.ts), since the file-based
// Express routes can't take upgrades. Connections live in this process's memory;
// the API routes reach them through the exported helpers.

export const DEVICE_WS_PATH = "/agent/devices/ws";

// Close codes sent to the device.
export const CLOSE_REPLACED = 4000;
export const CLOSE_TOKEN_REVOKED = 4001;
export const CLOSE_DELETED = 4002;

const PING_MS = 15_000;
// Frames per connection: bursts of 10 (capture requests on top of change
// frames), 4 per second on average. The rover sends 1–2.
const FRAME_BURST = 10;
const FRAMES_PER_SECOND = 4;
// A device clock this far from the server's is ignored (no NTP yet at boot).
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

type Connection = {
  deviceId: string;
  // The device's owner: voice mode uses their Soniox key.
  ownerId: string;
  ws: WebSocket;
  settings: DeviceSettings;
  connectedAt: Date;
  alive: boolean;
  frames: TokenBucket;
  // Set when the server closes the connection; from then on its messages are ignored.
  closedWith?: number;
};

const connections = new Map<string, Connection>();

export class DeviceOfflineError extends Error {
  constructor() {
    super("The device is offline");
  }
}

// Requests waiting for the device's answer: frames for `capture`, acks for
// `speech`. Keyed by the id sent with the request; settled on the answer, on
// timeout, or when the connection goes.
export type CaptureResult =
  | { kind: "overview"; observation: DeviceObservation }
  | { kind: "crop"; image: Buffer; width: number; height: number };

type PendingCapture = {
  deviceId: string;
  crop: boolean;
  resolve: (result: CaptureResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};
type PendingSpeech = {
  deviceId: string;
  resolve: (played: DevicePlayed) => void;
  timer: NodeJS.Timeout;
};
const captures = new Map<string, PendingCapture>();
const speeches = new Map<string, PendingSpeech>();

const CAPTURE_TIMEOUT_MS = 15_000;
// The ack comes after playback, so the wait is the clip's length plus this.
const SPEECH_ACK_MS = 30_000;

export type DeviceLinkStatus = { online: boolean; connectedAt: Date | null };

export function deviceLinkStatus(deviceId: string): DeviceLinkStatus {
  const connection = connections.get(deviceId);
  return { online: !!connection, connectedAt: connection?.connectedAt ?? null };
}

/** Sends the device its new settings, if it is connected. */
export function pushDeviceSettings(deviceId: string, settings: DeviceSettings): void {
  const connection = connections.get(deviceId);
  if (!connection) return;
  connection.settings = settings;
  send(connection.ws, { type: "config", ...deviceConfig(settings) });
}

/** Closes the device's connection, e.g. after its token was rotated or it was deleted. */
export function disconnectDevice(deviceId: string, code: number, reason: string): void {
  const connection = connections.get(deviceId);
  if (connection) close(connection, code, reason);
}

/**
 * Asks the device for a fresh frame: the overview (stored and captioned like any
 * frame, ahead of change frames) or, with a region, a full-resolution crop that
 * is returned without being stored.
 */
export function requestCapture(
  deviceId: string,
  options: { region?: CaptureRegion; timeoutMs?: number } = {}
): Promise<CaptureResult> {
  const connection = connections.get(deviceId);
  if (!connection) return Promise.reject(new DeviceOfflineError());
  const requestId = crypto.randomUUID();
  return new Promise<CaptureResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      captures.delete(requestId);
      reject(new Error("The device didn't send the frame in time"));
    }, options.timeoutMs ?? CAPTURE_TIMEOUT_MS);
    captures.set(requestId, { deviceId, crop: !!options.region, resolve, reject, timer });
    send(connection.ws, { type: "capture", requestId, ...(options.region && { region: options.region }) });
  });
}

/** Sends audio to the device and resolves with its `played` ack (ok: false on timeout or disconnect). */
export function sendSpeech(
  deviceId: string,
  speech: { format: SpeechHeader["format"]; sampleRate: number; audio: Uint8Array; durationMs: number }
): Promise<DevicePlayed> {
  const connection = connections.get(deviceId);
  if (!connection) return Promise.reject(new DeviceOfflineError());
  const speechId = crypto.randomUUID();
  return new Promise<DevicePlayed>((resolve) => {
    const timer = setTimeout(() => {
      speeches.delete(speechId);
      resolve({ speechId, ok: false, error: "No answer from the device" });
    }, speech.durationMs + SPEECH_ACK_MS);
    speeches.set(speechId, { deviceId, resolve, timer });
    const header: SpeechHeader = {
      type: "speech",
      speechId,
      format: speech.format,
      sampleRate: speech.sampleRate,
    };
    connection.ws.send(encodeBinaryMessage(header, speech.audio));
  });
}

/** Stops whatever the device is playing. */
export function stopSpeech(deviceId: string): boolean {
  const connection = connections.get(deviceId);
  if (!connection) return false;
  send(connection.ws, { type: "stop_speech" });
  return true;
}

// The connection is gone: nothing it was asked for will come.
function failPending(deviceId: string): void {
  for (const [id, pending] of captures) {
    if (pending.deviceId !== deviceId) continue;
    clearTimeout(pending.timer);
    captures.delete(id);
    pending.reject(new DeviceOfflineError());
  }
  for (const [id, pending] of speeches) {
    if (pending.deviceId !== deviceId) continue;
    clearTimeout(pending.timer);
    speeches.delete(id);
    pending.resolve({ speechId: id, ok: false, error: "The device disconnected" });
  }
}

function close(connection: Connection, code: number, reason: string): void {
  connection.closedWith = code;
  if (connections.get(connection.deviceId) === connection) {
    connections.delete(connection.deviceId);
    failPending(connection.deviceId);
    voiceSessions.drop(connection.deviceId);
    publishLive(connection.deviceId, { type: "status", online: false });
  }
  connection.ws.close(code, reason);
}

function send(ws: WebSocket, message: ServerTextMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function attachDeviceGateway(server: Server): () => void {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 + MAX_HEADER_BYTES + MAX_FRAME_BYTES,
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Errors on a socket we haven't handed to ws yet would otherwise crash the process.
    socket.on("error", () => socket.destroy());
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== DEVICE_WS_PATH) {
      reject(socket, 404, "Not Found");
      return;
    }
    const token = bearerToken(req.headers.authorization);
    if (!token) {
      reject(socket, 401, "Unauthorized");
      return;
    }
    getDeviceByTokenHash(hashDeviceToken(token)).then(
      (device) => {
        if (!device) {
          reject(socket, 401, "Unauthorized");
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          onConnection(ws, device.id, device.ownerId, readDeviceSettings(device.settings), req);
        });
      },
      (error) => {
        console.error("Device upgrade failed:", error);
        reject(socket, 500, "Internal Server Error");
      }
    );
  });

  // A connection that misses a pong for a whole interval is dead (Wi-Fi gone
  // without a FIN); terminating it frees the slot for the reconnect.
  const pinger = setInterval(() => {
    for (const connection of connections.values()) {
      if (!connection.alive) {
        connection.ws.terminate();
        continue;
      }
      connection.alive = false;
      connection.ws.ping();
    }
  }, PING_MS);

  return () => {
    clearInterval(pinger);
    for (const connection of connections.values()) connection.ws.terminate();
    wss.close();
  };
}

function onConnection(
  ws: WebSocket,
  deviceId: string,
  ownerId: string,
  settings: DeviceSettings,
  req: IncomingMessage
): void {
  // One live connection per device: the newest wins (the old one is usually a
  // half-dead socket the device has already given up on).
  const previous = connections.get(deviceId);
  if (previous) close(previous, CLOSE_REPLACED, "Replaced by a new connection");

  const connection: Connection = {
    deviceId,
    ownerId,
    ws,
    settings,
    connectedAt: new Date(),
    alive: true,
    frames: new TokenBucket(FRAME_BURST, FRAMES_PER_SECOND),
  };
  connections.set(deviceId, connection);
  publishLive(deviceId, { type: "status", online: true });
  log(insertDeviceEvent(deviceId, "connected", { remote: req.socket.remoteAddress }));
  log(touchDevice(deviceId));
  send(ws, { type: "config", ...deviceConfig(settings) });

  ws.on("pong", () => {
    connection.alive = true;
  });

  ws.on("message", (data: RawData, isBinary: boolean) => {
    connection.alive = true;
    if (connection.closedWith !== undefined) return;
    const buffer = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data);
    const handled = isBinary ? onBinary(connection, buffer) : onText(connection, buffer);
    handled.catch((error) => {
      if (error instanceof ProtocolError || error instanceof InvalidFrameError) {
        send(ws, { type: "error", message: error.message });
        return;
      }
      console.error(`Device ${deviceId} message failed:`, error);
      send(ws, { type: "error", message: "Internal error" });
    });
  });

  ws.on("close", (code: number) => {
    if (connections.get(deviceId) === connection) {
      connections.delete(deviceId);
      failPending(deviceId);
      voiceSessions.drop(deviceId);
      publishLive(deviceId, { type: "status", online: false });
    }
    // A deleted device has no row left to log against.
    if (connection.closedWith !== CLOSE_DELETED) log(insertDeviceEvent(deviceId, "disconnected", { code }));
  });

  ws.on("error", (error) => {
    log(insertDeviceEvent(deviceId, "error", { message: error.message }));
  });
}

async function onText(connection: Connection, data: Buffer): Promise<void> {
  if (data.length > MAX_TEXT_MESSAGE_BYTES) throw new ProtocolError("Text message too large");
  let json: unknown;
  try {
    json = JSON.parse(data.toString("utf8"));
  } catch {
    throw new ProtocolError("Text message is not valid JSON");
  }
  const parsed = deviceTextMessageSchema.safeParse(json);
  if (!parsed.success) throw new ProtocolError("Unknown or malformed message");

  const message = parsed.data;
  if (message.type === "played") {
    const pending = speeches.get(message.speechId);
    if (!pending || pending.deviceId !== connection.deviceId) return;
    clearTimeout(pending.timer);
    speeches.delete(message.speechId);
    const { type: _type, ...played } = message;
    pending.resolve(played);
    return;
  }
  if (message.type === "hello") {
    const { type: _type, ...hello } = message;
    await touchDevice(connection.deviceId, { hello });
  } else {
    const { type: _type, ...telemetry } = message;
    await touchDevice(connection.deviceId, { telemetry });
  }
}

async function onBinary(connection: Connection, data: Buffer): Promise<void> {
  const { header, payload } = decodeBinaryMessage(data);
  // Microphone audio for voice mode (plan 4.11).
  if ((header as { type?: unknown })?.type === "audio") {
    const audio = audioHeaderSchema.safeParse(header);
    if (!audio.success) throw new ProtocolError("Malformed audio message");
    if (payload.length > MAX_AUDIO_CHUNK_BYTES || payload.length % 2) throw new ProtocolError("Bad audio chunk");
    voiceSessions.onAudio(
      connection.deviceId,
      connection.ownerId,
      () => connection.settings.voice,
      audio.data,
      Buffer.from(payload)
    );
    return;
  }
  const parsed = frameHeaderSchema.safeParse(header);
  if (!parsed.success) throw new ProtocolError("Unknown or malformed binary message");
  const frame = parsed.data;

  // Paused devices are told so in their config; frames they send anyway are
  // dropped, except answers to explicit capture requests.
  if (connection.settings.paused && frame.trigger !== "request") return;
  if (!connection.frames.take()) throw new ProtocolError("Too many frames; slow down");

  const { width, height } = await inspectJpeg(payload);

  // The answer to a capture request this server is waiting on.
  const pending =
    frame.trigger === "request" && frame.requestId ? captures.get(frame.requestId) : undefined;
  if (pending && pending.deviceId !== connection.deviceId) throw new ProtocolError("Unknown request id");
  if (pending) {
    clearTimeout(pending.timer);
    captures.delete(frame.requestId!);
    // Crops answer one question; they aren't part of the timeline.
    if (pending.crop) {
      pending.resolve({ kind: "crop", image: Buffer.from(payload), width, height });
      return;
    }
  }
  const receivedAt = new Date();
  const capturedAt =
    Math.abs(frame.capturedAt - receivedAt.getTime()) <= MAX_CLOCK_SKEW_MS
      ? new Date(frame.capturedAt)
      : receivedAt;

  let name: string;
  try {
    name = await writeFrame(connection.deviceId, payload);
  } catch (error) {
    pending?.reject(new Error("The frame couldn't be stored"));
    throw error;
  }
  let observation;
  try {
    observation = await insertObservation({
      deviceId: connection.deviceId,
      seq: frame.seq,
      trigger: frame.trigger,
      requestId: frame.requestId,
      capturedAt,
      receivedAt,
      frame: name,
      width,
      height,
      bytes: payload.length,
    });
  } catch (error) {
    pending?.reject(new Error("The frame couldn't be stored"));
    await removeFrame(connection.deviceId, name);
    throw error;
  }
  publishLive(connection.deviceId, { type: "observation", observation: publicObservation(observation) });
  // Requested frames are captioned ahead of change frames (someone is waiting).
  perceptionWorker.enqueue(connection.deviceId, observation.id, { priority: frame.trigger === "request" });
  pending?.resolve({ kind: "overview", observation });
  await touchDevice(connection.deviceId);
}

function log(promise: Promise<unknown>): void {
  promise.catch((error) => console.error("Device bookkeeping failed:", error));
}
