// A simulated camera + speaker device: speaks the device protocol
// (lib/devices/protocol.ts) the way the rover does, so the backend can be
// developed without the rover. Streams a folder of JPEGs, or the Mac's webcam
// through ffmpeg, and plays speech it receives with afplay.
//
//   DEVICE_TOKEN=dev_… npm run device-sim -- --dir ../rover2/radxa_software/captures/bench-20261011/frames --match 2576x1449
//   DEVICE_TOKEN=dev_… npm run device-sim -- --files empty.jpg,empty.jpg,person.jpg --no-loop
//   DEVICE_TOKEN=dev_… npm run device-sim -- --webcam [--camera 0] [--size 1280x720]
//
// Options: --url (default ws://localhost:3001/agent/devices/ws); --interval,
// seconds between frames (default 2; never faster than the server's
// minIntervalMs); --match, to stream only the JPEGs whose name contains it;
// --files, a comma-separated list of JPEGs played in that order (a scripted
// scene); --no-loop, to stop sending change frames after the last one (capture
// requests still get it). A capture request with a region gets that region of
// the current frame, cropped (the rover renders it from the full sensor frame).
// The token comes from DEVICE_TOKEN, so it stays out of the shell history;
// register a device with POST /agent/devices to get one.
//
// Voice mode (plan 4.11), with or without a frame source:
//   --speak a.wav,b.wav   streams each file as one stretch of speech, in real
//                         time (any format ffmpeg reads), --speak-gap seconds
//                         after the previous reply finished (default 2);
//   --interrupt           sends the next file 1.5 s into the reply instead (barge-in);
//   --mic                 the Mac's microphone (--mic-device, default 0) through
//                         ffmpeg, with an energy VAD (300 ms pre-roll, ends after
//                         300 ms of silence); half duplex unless --full-duplex
//                         (use headphones), so the reply doesn't hear itself.
// Speech chunks play back to back with afplay; stop_speech drops the queue.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import WebSocket from "ws";
import { decodeBinaryMessage, encodeBinaryMessage, type DeviceConfig, type FrameTrigger } from "../lib/devices/protocol";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "ws://localhost:3001/agent/devices/ws" },
    dir: { type: "string" },
    files: { type: "string" },
    "no-loop": { type: "boolean", default: false },
    match: { type: "string", default: "" },
    webcam: { type: "boolean", default: false },
    camera: { type: "string", default: "0" },
    size: { type: "string", default: "1280x720" },
    interval: { type: "string", default: "2" },
    speak: { type: "string" },
    "speak-gap": { type: "string", default: "2" },
    interrupt: { type: "boolean", default: false },
    mic: { type: "boolean", default: false },
    "mic-device": { type: "string", default: "0" },
    "full-duplex": { type: "boolean", default: false },
  },
});

const token = process.env.DEVICE_TOKEN;
if (!token) fail("Set DEVICE_TOKEN to the token from POST /agent/devices.");
const frameSources = [args.dir, args.files, args.webcam].filter(Boolean).length;
const voice = !!(args.speak || args.mic);
if (frameSources > 1 || (frameSources === 0 && !voice)) {
  fail("Pick one frame source (--dir, --files or --webcam), and/or --speak / --mic.");
}

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

// next() advances to the following frame (null when a --no-loop scene is
// over); current() is the frame on screen, for capture requests.
type Source = { next(): Promise<Buffer | null>; current(): Promise<Buffer | null> };

function listSource(paths: string[], label: string): Source {
  const loop = !args["no-loop"];
  console.log(`Streaming ${paths.length} JPEGs from ${label}${loop ? ", in a loop" : ", once"}`);
  let i = -1;
  return {
    next: async () => {
      if (!loop && i >= paths.length - 1) return null;
      i = (i + 1) % paths.length;
      return readFile(paths[i]);
    },
    current: () => readFile(paths[Math.max(i, 0)]),
  };
}

async function folderSource(dir: string): Promise<Source> {
  const names = (await readdir(dir)).filter((n) => /\.jpe?g$/i.test(n) && n.includes(args.match!)).sort();
  if (names.length === 0) fail(`No JPEGs in ${dir}`);
  return listSource(names.map((n) => join(dir, n)), dir);
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
  return { next: async () => latest, current: async () => latest };
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
        void sendCapture(source, message.requestId, message.region);
        break;
      case "stop_speech":
        stopSpeech();
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

// The answer to a capture request: the current frame, or a region of it.
async function sendCapture(
  source: Source,
  requestId: string,
  region?: { x: number; y: number; w: number; h: number }
): Promise<void> {
  let bytes = await source.current();
  if (!bytes || ws?.readyState !== WebSocket.OPEN) return;
  if (region) {
    const { width = 0, height = 0 } = await sharp(bytes).metadata();
    const left = Math.min(Math.round(region.x * width), width - 1);
    const top = Math.min(Math.round(region.y * height), height - 1);
    bytes = await sharp(bytes)
      .extract({
        left,
        top,
        width: Math.max(1, Math.min(Math.round(region.w * width), width - left)),
        height: Math.max(1, Math.min(Math.round(region.h * height), height - top)),
      })
      .jpeg({ quality: 92 })
      .toBuffer();
  }
  const header = { type: "frame", seq: seq++, capturedAt: Date.now(), trigger: "request", requestId };
  ws.send(encodeBinaryMessage(header, bytes));
  console.log(`Sent ${region ? "crop" : "frame"} ${header.seq} for request ${requestId} (${(bytes.length / 1024).toFixed(0)} KB)`);
}

function sendTelemetry(): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "telemetry", uptimeS: Math.round((Date.now() - startedAt) / 1000) }));
}

// ── Speech ───────────────────────────────────────────────────────────────────

// Chunks play back to back (a voice reply arrives sentence by sentence).
let player: ChildProcess | null = null;
const playQueue: { speechId: string; file: string; dir: string }[] = [];
let playing = false;

function playing_(): boolean {
  return playing || playQueue.length > 0;
}

async function onBinary(data: Buffer): Promise<void> {
  const { header, payload } = decodeBinaryMessage(data) as { header: any; payload: Buffer };
  if (header?.type !== "speech") {
    console.log("Unhandled binary message:", header?.type);
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "device-sim-"));
  const file = join(dir, `speech.${String(header.format ?? "wav").replace(/[^a-z0-9]/gi, "")}`);
  await writeFile(file, payload);
  playQueue.push({ speechId: header.speechId, file, dir });
  if (!playing) void playNext();
}

async function playNext(): Promise<void> {
  const next = playQueue.shift();
  if (!next) {
    playing = false;
    return;
  }
  playing = true;
  console.log(`Playing speech ${next.speechId}`);
  const started = Date.now();
  const code = await new Promise<number | null>((resolve) => {
    player = spawn("afplay", [next.file], { stdio: "ignore" });
    player.on("exit", (c) => resolve(c));
    player.on("error", () => resolve(1));
  });
  player = null;
  await rm(next.dir, { recursive: true, force: true });
  const ok = code === 0;
  ws?.send(JSON.stringify({ type: "played", speechId: next.speechId, ok, durationMs: Date.now() - started, ...(!ok && { error: "Stopped" }) }));
  void playNext();
}

function stopSpeech(): void {
  // Queued chunks are acknowledged as not played; the current one is cut.
  for (const item of playQueue.splice(0)) {
    ws?.send(JSON.stringify({ type: "played", speechId: item.speechId, ok: false, durationMs: 0, error: "Stopped" }));
    void rm(item.dir, { recursive: true, force: true });
  }
  player?.kill();
}

// ── Voice uplink ─────────────────────────────────────────────────────────────

const CHUNK_MS = 40;
const BYTES_PER_MS = 32; // 16 kHz s16le mono
let segment = 0;
let audioSeq = 0;

function sendAudio(seg: string, pcm: Buffer, flags: { start?: boolean; end?: boolean } = {}): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const header = { type: "audio", segment: seg, seq: audioSeq++, format: "pcm_s16le", sampleRate: 16000, ...flags };
  ws.send(encodeBinaryMessage(header, pcm));
}

/** Any audio file → 16 kHz mono s16le PCM. */
async function decodeAudio(path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"]);
    ff.stdout.on("data", (c: Buffer) => chunks.push(c));
    ff.on("exit", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg failed on ${path}`))));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Streams a clip as one stretch of speech, paced in real time. */
async function speakClip(pcm: Buffer, label: string): Promise<void> {
  const seg = `s${++segment}`;
  const bytes = CHUNK_MS * BYTES_PER_MS;
  console.log(`Speaking ${label} (${(pcm.length / BYTES_PER_MS / 1000).toFixed(1)} s)`);
  const t0 = Date.now();
  for (let off = 0, i = 0; off < pcm.length; off += bytes, i++) {
    sendAudio(seg, pcm.subarray(off, off + bytes), off === 0 ? { start: true } : {});
    const wait = t0 + (i + 1) * CHUNK_MS - Date.now();
    if (wait > 0) await sleep(wait);
  }
  sendAudio(seg, Buffer.alloc(0), { end: true });
  console.log(`Speech ended ${new Date().toISOString().slice(11, 23)}`);
}

async function runSpeakScript(files: string[]): Promise<void> {
  while (ws?.readyState !== WebSocket.OPEN || !config) await sleep(100);
  for (const [i, file] of files.entries()) {
    const pcm = await decodeAudio(file);
    await speakClip(pcm, file);
    if (i === files.length - 1) break;
    // Wait for the reply to start (or a few seconds of silence), then either
    // interrupt it or let it finish.
    const until = Date.now() + 8000;
    while (!playing_() && Date.now() < until) await sleep(50);
    if (args.interrupt && playing_()) {
      await sleep(1500);
      console.log("Interrupting");
      continue;
    }
    while (playing_()) await sleep(50);
    await sleep(Number(args["speak-gap"]) * 1000);
  }
  // Let the last reply play out before exiting.
  const until = Date.now() + 12000;
  while (!playing_() && Date.now() < until) await sleep(50);
  while (playing_()) await sleep(50);
  await sleep(1000);
  process.exit(0);
}

/** The Mac's microphone with an energy VAD. */
function startMic(): void {
  const ff = spawn(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", `:${args["mic-device"]}`, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  ff.on("exit", (code) => fail(`ffmpeg (mic) exited with code ${code} (microphone permission for this terminal?)`));
  process.on("exit", () => ff.kill());
  const frame = 30 * BYTES_PER_MS; // 30 ms
  let pending = Buffer.alloc(0);
  const preroll: Buffer[] = [];
  let noise = 300; // RMS noise floor, adapts while silent
  let inSpeech = false;
  let silentMs = 0;
  let seg = "";
  ff.stdout.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= frame) {
      const f = pending.subarray(0, frame);
      pending = pending.subarray(frame);
      let sum = 0;
      for (let i = 0; i < f.length; i += 2) {
        const v = f.readInt16LE(i);
        sum += v * v;
      }
      const rms = Math.sqrt(sum / (f.length / 2));
      const muted = !args["full-duplex"] && playing_();
      const voiced = !muted && rms > Math.max(noise * 3, 400);
      if (!inSpeech) {
        if (!voiced) noise = noise * 0.95 + rms * 0.05;
        preroll.push(Buffer.from(f));
        if (preroll.length > 10) preroll.shift(); // 300 ms
        if (voiced) {
          inSpeech = true;
          silentMs = 0;
          seg = `m${++segment}`;
          const head = Buffer.concat(preroll.splice(0));
          sendAudio(seg, head, { start: true });
        }
        continue;
      }
      sendAudio(seg, Buffer.from(f));
      silentMs = voiced ? 0 : silentMs + 30;
      if (silentMs >= 300 || muted) {
        sendAudio(seg, Buffer.alloc(0), { end: true });
        inSpeech = false;
      }
    }
  });
  console.log(`Listening on microphone ${args["mic-device"]}${args["full-duplex"] ? " (full duplex)" : ""}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const source: Source = args.dir
  ? await folderSource(args.dir)
  : args.files
    ? listSource(args.files.split(",").filter(Boolean), "--files")
    : args.webcam
      ? webcamSource(args.camera!, args.size!)
      : { next: async () => null, current: async () => null };
connect(source);
if (args.speak) void runSpeakScript(args.speak.split(",").filter(Boolean));
if (args.mic) startMic();

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
