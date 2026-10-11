import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  getDeviceByTokenHash,
  insertDeviceEvent,
  insertObservation,
  touchDevice,
} from "../db/devices";
import {
  MAX_HEADER_BYTES,
  MAX_TEXT_MESSAGE_BYTES,
  ProtocolError,
  decodeBinaryMessage,
  deviceTextMessageSchema,
  frameHeaderSchema,
  type ServerTextMessage,
} from "./protocol";
import { InvalidFrameError, MAX_FRAME_BYTES, inspectJpeg, removeFrame, writeFrame } from "./frames";
import { TokenBucket } from "./rate-limit";
import { deviceConfig, readDeviceSettings, type DeviceSettings } from "./settings";
import { bearerToken, hashDeviceToken } from "./tokens";

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
  ws: WebSocket;
  settings: DeviceSettings;
  connectedAt: Date;
  alive: boolean;
  frames: TokenBucket;
  // Set when the server closes the connection; from then on its messages are ignored.
  closedWith?: number;
};

const connections = new Map<string, Connection>();

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

function close(connection: Connection, code: number, reason: string): void {
  connection.closedWith = code;
  if (connections.get(connection.deviceId) === connection) connections.delete(connection.deviceId);
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
          onConnection(ws, device.id, readDeviceSettings(device.settings), req);
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
  settings: DeviceSettings,
  req: IncomingMessage
): void {
  // One live connection per device: the newest wins (the old one is usually a
  // half-dead socket the device has already given up on).
  const previous = connections.get(deviceId);
  if (previous) close(previous, CLOSE_REPLACED, "Replaced by a new connection");

  const connection: Connection = {
    deviceId,
    ws,
    settings,
    connectedAt: new Date(),
    alive: true,
    frames: new TokenBucket(FRAME_BURST, FRAMES_PER_SECOND),
  };
  connections.set(deviceId, connection);
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
    if (connections.get(deviceId) === connection) connections.delete(deviceId);
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

  const { type, ...body } = parsed.data;
  if (type === "hello") await touchDevice(connection.deviceId, { hello: body });
  else await touchDevice(connection.deviceId, { telemetry: body });
}

async function onBinary(connection: Connection, data: Buffer): Promise<void> {
  const { header, payload } = decodeBinaryMessage(data);
  const parsed = frameHeaderSchema.safeParse(header);
  if (!parsed.success) throw new ProtocolError("Unknown or malformed binary message");
  const frame = parsed.data;

  // Paused devices are told so in their config; frames they send anyway are
  // dropped, except answers to explicit capture requests.
  if (connection.settings.paused && frame.trigger !== "request") return;
  if (!connection.frames.take()) throw new ProtocolError("Too many frames; slow down");

  const { width, height } = await inspectJpeg(payload);
  const receivedAt = new Date();
  const capturedAt =
    Math.abs(frame.capturedAt - receivedAt.getTime()) <= MAX_CLOCK_SKEW_MS
      ? new Date(frame.capturedAt)
      : receivedAt;

  const name = await writeFrame(connection.deviceId, payload);
  try {
    await insertObservation({
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
    await removeFrame(connection.deviceId, name);
    throw error;
  }
  await touchDevice(connection.deviceId);
}

function log(promise: Promise<unknown>): void {
  promise.catch((error) => console.error("Device bookkeeping failed:", error));
}
