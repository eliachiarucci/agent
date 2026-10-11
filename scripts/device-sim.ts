// A simulated camera + speaker device: speaks the device protocol
// (lib/devices/protocol.ts) the way the rover does, so the backend can be
// developed without the rover. Streams a folder of JPEGs, or the Mac's webcam
// through ffmpeg, and plays speech it receives with afplay.
//
//   DEVICE_TOKEN=dev_… npm run device-sim -- --dir ../rover2/radxa_software/captures/bench-20261011/frames --match 2576x1449
//   DEVICE_TOKEN=dev_… npm run device-sim -- --webcam [--camera 0] [--size 1280x720]
//
// Options: --url (default ws://localhost:3001/agent/devices/ws); --interval,
// seconds between frames (default 2; never faster than the server's
// minIntervalMs); --match, to stream only the JPEGs whose name contains it.
// The token comes from DEVICE_TOKEN, so it stays out of the shell history;
// register a device with POST /agent/devices to get one.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import WebSocket from "ws";
import { decodeBinaryMessage, encodeBinaryMessage, type DeviceConfig, type FrameTrigger } from "../lib/devices/protocol";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "ws://localhost:3001/agent/devices/ws" },
    dir: { type: "string" },
    match: { type: "string", default: "" },
    webcam: { type: "boolean", default: false },
    camera: { type: "string", default: "0" },
    size: { type: "string", default: "1280x720" },
    interval: { type: "string", default: "2" },
  },
});

const token = process.env.DEVICE_TOKEN;
if (!token) fail("Set DEVICE_TOKEN to the token from POST /agent/devices.");
if (!args.dir === !args.webcam) fail("Pick one source: --dir <folder of JPEGs> or --webcam.");

const intervalMs = Number(args.interval) * 1000;
if (!(intervalMs > 0)) fail("--interval must be a positive number of seconds.");

// Close codes after which reconnecting is pointless (lib/devices/gateway.ts).
const FINAL_CLOSES: Record<number, string> = {
  4000: "another connection took over this device",
  4001: "the token was rotated",
  4002: "the device was deleted",
};

let config: DeviceConfig | null = null;
let seq = 0;
let ws: WebSocket | null = null;
let backoffMs = 1000;
const startedAt = Date.now();

// ── Frame sources ────────────────────────────────────────────────────────────

type Source = { next(): Promise<Buffer | null> };

async function folderSource(dir: string): Promise<Source> {
  const names = (await readdir(dir)).filter((n) => /\.jpe?g$/i.test(n) && n.includes(args.match!)).sort();
  if (names.length === 0) fail(`No JPEGs in ${dir}`);
  console.log(`Streaming ${names.length} JPEGs from ${dir}, in a loop`);
  let i = 0;
  return { next: () => readFile(join(dir, names[i++ % names.length])) };
}

// ffmpeg writes a stream of JPEGs to stdout; keep only the newest one.
function webcamSource(camera: string, size: string): Source {
  let latest: Buffer | null = null;
  let pending = Buffer.alloc(0);
  const ffmpeg = spawn(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-framerate", "30", "-video_size", size,
     "-i", `${camera}:none`, "-vf", "fps=5", "-c:v", "mjpeg", "-q:v", "3", "-f", "image2pipe", "-"],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  ffmpeg.on("error", (error) => fail(`ffmpeg failed to start: ${error.message}`));
  ffmpeg.on("exit", (code) => fail(`ffmpeg exited with code ${code} (camera permission for this terminal?)`));
  ffmpeg.stdout.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    // A JPEG runs from SOI (FF D8) to EOI (FF D9); the encoder never emits FF D9 inside the data.
    for (;;) {
      const start = pending.indexOf(Buffer.from([0xff, 0xd8]));
      const end = start < 0 ? -1 : pending.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) break;
      latest = pending.subarray(start, end + 2);
      pending = pending.subarray(end + 2);
    }
  });
  process.on("exit", () => ffmpeg.kill());
  console.log(`Streaming webcam ${camera} at ${size}`);
  return { next: async () => latest };
}

// ── Link ─────────────────────────────────────────────────────────────────────

function connect(source: Source): void {
  console.log(`Connecting to ${args.url}`);
  const socket = new WebSocket(args.url!, { headers: { authorization: `Bearer ${token}` } });
  ws = socket;

  socket.on("unexpected-response", (_req, res) => {
    if (res.statusCode === 401) fail("The server refused the token (401).");
    console.error(`Upgrade refused with HTTP ${res.statusCode}`);
    socket.terminate();
  });

  socket.on("open", () => {
    backoffMs = 1000;
    console.log("Connected");
    socket.send(JSON.stringify({
      type: "hello",
      version: "device-sim/1",
      capabilities: { sizes: [args.webcam ? args.size : "as-is"], audio: ["wav", "mp3", "aiff"] },
    }));
    sendTelemetry();
  });

  socket.on("message", (data: Buffer, isBinary) => {
    if (isBinary) {
      void onBinary(data);
      return;
    }
    const message = JSON.parse(data.toString());
    switch (message.type) {
      case "config": {
        const { type: _type, ...rest } = message;
        config = rest;
        console.log("Config:", JSON.stringify(config));
        break;
      }
      case "capture":
        void sendFrame(source, "request", message.requestId);
        break;
      case "stop_speech":
        player?.kill();
        break;
      case "error":
        console.error("Server error:", message.message);
        break;
      default:
        console.log("Unhandled message:", message.type);
    }
  });

  socket.on("close", (code, reason) => {
    ws = null;
    if (FINAL_CLOSES[code]) fail(`Disconnected: ${FINAL_CLOSES[code]}.`);
    console.log(`Disconnected (${code} ${reason.toString()}); retrying in ${backoffMs / 1000} s`);
    setTimeout(() => connect(source), backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  });

  socket.on("error", (error) => console.error("Link error:", error.message));
}

async function sendFrame(source: Source, trigger: FrameTrigger, requestId?: string): Promise<void> {
  const bytes = await source.next();
  if (!bytes || ws?.readyState !== WebSocket.OPEN) return;
  const header = { type: "frame", seq: seq++, capturedAt: Date.now(), trigger, ...(requestId && { requestId }) };
  ws.send(encodeBinaryMessage(header, bytes));
  console.log(`Sent frame ${header.seq} (${trigger}, ${(bytes.length / 1024).toFixed(0)} KB)`);
}

function sendTelemetry(): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "telemetry", uptimeS: Math.round((Date.now() - startedAt) / 1000) }));
}

// ── Speech ───────────────────────────────────────────────────────────────────

let player: ChildProcess | null = null;

async function onBinary(data: Buffer): Promise<void> {
  const { header, payload } = decodeBinaryMessage(data) as { header: any; payload: Buffer };
  if (header?.type !== "speech") {
    console.log("Unhandled binary message:", header?.type);
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "device-sim-"));
  const file = join(dir, `speech.${String(header.format ?? "wav").replace(/[^a-z0-9]/gi, "")}`);
  await writeFile(file, payload);
  console.log(`Playing speech ${header.speechId} (${payload.length} bytes)`);
  const started = Date.now();
  const ok = await new Promise<boolean>((resolve) => {
    player = spawn("afplay", [file], { stdio: "ignore" });
    player.on("exit", (code) => resolve(code === 0));
    player.on("error", () => resolve(false));
  });
  player = null;
  await rm(dir, { recursive: true, force: true });
  ws?.send(JSON.stringify({ type: "played", speechId: header.speechId, ok, durationMs: Date.now() - started }));
}

// ── Main ─────────────────────────────────────────────────────────────────────

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const source = args.dir ? await folderSource(args.dir) : webcamSource(args.camera!, args.size!);
connect(source);

// The frame clock: the requested interval, never faster than the server allows.
let lastFrameAt = 0;
setInterval(() => {
  if (!config || config.paused) return;
  const gap = Math.max(intervalMs, config.minIntervalMs);
  if (Date.now() - lastFrameAt < gap) return;
  lastFrameAt = Date.now();
  void sendFrame(source, "change");
}, 100);
setInterval(sendTelemetry, 30_000);
