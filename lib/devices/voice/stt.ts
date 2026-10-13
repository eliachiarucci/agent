import { EventEmitter } from "node:events";
import WebSocket from "ws";

// Streaming speech to text (plan 4.11, D25): Soniox's real-time API.
// Measured in V0 (rev 13): endpoint detection stays off (it hurts the speaker
// labels); the session sends `finalize` when the turn ends and takes the words
// up to <fin>; ≈ 115 ms from finalize to the final text. Billing is by
// connection time, so the session opens on speech and closes when idle.

export type SttToken = {
  text: string;
  startMs?: number;
  endMs?: number;
  isFinal: boolean;
  speaker?: string;
  language?: string;
  confidence?: number;
};

/** One streaming STT connection. Emits "tokens" (final, nonFinal), "fin", "error" and "close". */
export interface SttStream extends EventEmitter {
  send(pcm: Buffer): void;
  finalize(): void;
  close(): void;
  readonly open: boolean;
}

export type SttOptions = { languageHints: string[] };

const SONIOX_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
const KEEPALIVE_MS = 10_000;

export class SonioxStream extends EventEmitter implements SttStream {
  private ws: WebSocket;
  private queue: Buffer[] = [];
  private lastSent = Date.now();
  private keepalive: NodeJS.Timeout;
  private ready = false;
  private closed = false;

  constructor(apiKey: string, options: SttOptions) {
    super();
    this.ws = new WebSocket(process.env.SONIOX_URL ?? SONIOX_URL, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    this.ws.on("open", () => {
      this.ws.send(
        JSON.stringify({
          model: "stt-rt-v5",
          audio_format: "pcm_s16le",
          sample_rate: 16000,
          num_channels: 1,
          language_hints: options.languageHints,
          enable_speaker_diarization: true,
          enable_language_identification: true,
          enable_endpoint_detection: false,
        })
      );
      this.ready = true;
      for (const chunk of this.queue.splice(0)) this.ws.send(chunk);
    });
    this.ws.on("message", (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.error_code) {
        this.emit("error", new Error(`Soniox ${msg.error_code} ${msg.error_type}: ${msg.error_message}`));
        return;
      }
      const tokens: SttToken[] = (msg.tokens ?? []).map((t: any) => ({
        text: t.text,
        startMs: t.start_ms,
        endMs: t.end_ms,
        isFinal: !!t.is_final,
        speaker: t.speaker,
        language: t.language,
        confidence: t.confidence,
      }));
      const final = tokens.filter((t) => t.isFinal && t.text !== "<fin>" && t.text !== "<end>");
      const nonFinal = tokens.filter((t) => !t.isFinal);
      if (final.length || nonFinal.length) this.emit("tokens", final, nonFinal);
      if (tokens.some((t) => t.text === "<fin>")) this.emit("fin");
    });
    this.ws.on("error", (error) => this.emit("error", error));
    this.ws.on("close", () => {
      this.closed = true;
      clearInterval(this.keepalive);
      this.emit("close");
    });
    // Soniox closes a stream without audio or keepalives for ~20 s.
    this.keepalive = setInterval(() => {
      if (this.ready && Date.now() - this.lastSent > KEEPALIVE_MS) this.control({ type: "keepalive" });
    }, KEEPALIVE_MS / 2);
  }

  get open(): boolean {
    return !this.closed;
  }

  send(pcm: Buffer): void {
    if (this.closed || pcm.length === 0) return;
    this.lastSent = Date.now();
    if (this.ready) this.ws.send(pcm);
    else this.queue.push(pcm);
  }

  finalize(): void {
    this.control({ type: "finalize" });
  }

  close(): void {
    if (this.closed) return;
    clearInterval(this.keepalive);
    // An empty text frame ends the stream; Soniox sends what's left, then closes.
    if (this.ready) this.ws.send("");
    else this.ws.terminate();
  }

  private control(message: object): void {
    if (this.closed) return;
    this.lastSent = Date.now();
    const text = JSON.stringify(message);
    if (this.ready) this.ws.send(text);
    else this.ws.once("open", () => this.ws.send(text));
  }
}

/** The STT stream for a device, or null when no STT key is configured. */
export function openStt(options: SttOptions): SttStream | null {
  const key = process.env.SONIOX_API_KEY;
  if (!key) return null;
  return new SonioxStream(key, options);
}
