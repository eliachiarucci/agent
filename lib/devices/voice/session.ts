import type { AudioHeader } from "../protocol";
import type { DeviceSettings } from "../settings";
import { NoSttKeyError, openStt, sonioxKey, type SttStream, type SttToken } from "./stt";
import type { HeardLine } from "./text";

// One voice session per connected device (plan 4.11): audio from the device's
// VAD goes to streaming STT; when the device has been silent for endOfTurnMs
// after a stretch of speech, the session asks STT to finalise and hands the
// turn (what was said, split by voice) to the voice-turn handler. New speech
// while the device answers interrupts the reply (barge-in). Before any of the
// reply was played, the person was still talking (a pause mid-sentence ended
// the turn too early): the reply is dropped and the turn's words go in front
// of what they say next, as one turn. After some of it was played, the next
// turn is marked as talking over the reply.

/** Within this long after the device spoke, speech is taken as part of the conversation. */
export const CONVERSATION_WINDOW_MS = 30_000;

export type HeardTurn = {
  lines: HeardLine[];
  at: Date;
  // Server clock (ms): when the device's last speech segment ended, and when the final text arrived.
  speechEndAt: number;
  finalAt: number;
  audioMs: number;
  // The lines start with a turn whose reply was dropped before it played (see above).
  continued?: boolean;
  // This speech talked over the device's reply, after some of it was played.
  afterInterruption?: boolean;
  // Since the device last spoke a reply (ms); null if it hasn't in this session.
  sinceReplyMs?: number | null;
};

/** The reply being worked on (generated or spoken), for barge-in. */
export type ActiveReply = {
  // Some of it was sent to the device.
  started: () => boolean;
  // merged: nothing was played, so the turn goes in front of the next one.
  interrupt: (merged: boolean) => void;
};

export type TurnHandler = (deviceId: string, turn: HeardTurn) => void;

type Deps = {
  openStt: typeof openStt;
  sttKey: (ownerId: string) => Promise<string | null>;
  now: () => number;
};

// Speech this long while the device is talking interrupts it: shorter blips
// (a cough, residual echo) don't (Pipecat/LiveKit use 0.3–0.5 s).
export const BARGE_IN_MS = 400;
const BYTES_PER_MS = 32; // 16 kHz, 16-bit mono
// After "no key", audio is dropped this long before the key is looked up again.
const NO_KEY_RETRY_MS = 60_000;

export class VoiceSession {
  private stt: SttStream | null = null;
  private finals: SttToken[] = [];
  private segmentOpen = false;
  private segmentMs = 0;
  private turnAudioMs = 0;
  private finalizing = false;
  private resumed = false;
  private speechEndAt = 0;
  private endTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private noKeyUntil = 0;
  // The last turn handed over, the words carried into the next turn, and whether
  // the speech being collected talked over a reply.
  private lastLines: HeardLine[] = [];
  private carry: HeardLine[] = [];
  private talkedOver = false;
  private lastReplyAt: number | null = null;
  reply: ActiveReply | null = null;

  constructor(
    readonly deviceId: string,
    private readonly ownerId: string,
    private readonly settings: () => DeviceSettings["voice"],
    private readonly onTurn: () => TurnHandler | null,
    private readonly deps: Deps
  ) {}

  onAudio(header: AudioHeader, pcm: Buffer): void {
    const voice = this.settings();
    if (!voice.enabled) return;
    const stt = this.ensureStt(voice);
    if (!stt) return;

    if (header.start) {
      this.segmentOpen = true;
      this.segmentMs = 0;
      if (this.endTimer) clearTimeout(this.endTimer);
      this.endTimer = null;
      if (this.finalizing) this.resumed = true;
    }
    if (pcm.length) {
      stt.send(pcm);
      const ms = pcm.length / BYTES_PER_MS;
      this.segmentMs += ms;
      this.turnAudioMs += ms;
    }
    if (this.reply && this.segmentOpen && this.segmentMs >= BARGE_IN_MS) {
      const reply = this.reply;
      this.reply = null;
      const merged = !reply.started();
      if (merged) this.carry = mergeLines(this.carry, this.lastLines);
      else this.talkedOver = true;
      reply.interrupt(merged);
    }
    if (header.end) {
      this.segmentOpen = false;
      this.speechEndAt = this.deps.now();
      this.endTimer = setTimeout(() => {
        this.endTimer = null;
        this.finalizing = true;
        this.resumed = false;
        this.stt?.finalize();
      }, voice.endOfTurnMs);
    }
    this.resetIdle(voice.closeAfterSec);
  }

  /** The device finished speaking a reply (or was cut off after part of it). */
  replied(at: number): void {
    this.lastReplyAt = at;
  }

  close(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.stt?.close();
    this.stt = null;
  }

  private ensureStt(voice: DeviceSettings["voice"]): SttStream | null {
    if (this.stt?.open) return this.stt;
    if (this.deps.now() < this.noKeyUntil) return null;
    // The key is looked up for every new stream, so a key saved in Settings applies to the next one.
    const stt = this.deps.openStt({ languageHints: voice.languageHints, apiKey: this.deps.sttKey(this.ownerId) });
    this.stt = stt;
    stt.on("tokens", (final: SttToken[]) => this.finals.push(...final));
    stt.on("fin", () => this.onFin());
    stt.on("error", (error: Error) => {
      if (error instanceof NoSttKeyError) {
        if (this.noKeyUntil === 0) console.warn(`[voice] ${this.deviceId}: ${error.message}; audio ignored`);
        this.noKeyUntil = this.deps.now() + NO_KEY_RETRY_MS;
        this.finals = [];
        this.turnAudioMs = 0;
        return;
      }
      console.warn(`[voice] ${this.deviceId}: ${error.message}`);
    });
    stt.on("close", () => {
      if (this.stt === stt) this.stt = null;
      this.finalizing = false;
    });
    return stt;
  }

  private onFin(): void {
    this.finalizing = false;
    // Speech resumed after finalize: keep collecting; the next silence finalises again.
    if (this.resumed || this.segmentOpen) return;
    const heard = linesFromTokens(this.finals);
    const audioMs = this.turnAudioMs;
    this.finals = [];
    this.turnAudioMs = 0;
    // A carried turn goes out even if the speech that cut its reply had no words.
    const lines = mergeLines(this.carry, heard);
    if (lines.length === 0) return;
    const continued = this.carry.length > 0;
    const afterInterruption = this.talkedOver;
    this.carry = [];
    this.talkedOver = false;
    this.lastLines = lines;
    const now = this.deps.now();
    this.onTurn()?.(this.deviceId, {
      lines,
      at: new Date(),
      speechEndAt: this.speechEndAt,
      finalAt: now,
      audioMs: Math.round(audioMs),
      ...(continued && { continued }),
      ...(afterInterruption && { afterInterruption }),
      sinceReplyMs: this.lastReplyAt === null ? null : now - this.lastReplyAt,
    });
  }

  private resetIdle(closeAfterSec: number): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.segmentOpen || this.finalizing) return;
      this.stt?.close();
      this.stt = null;
    }, closeAfterSec * 1000);
  }
}

/** Lines followed by more lines, joining the same voice across the seam. */
export function mergeLines(first: HeardLine[], then: HeardLine[]): HeardLine[] {
  const out = first.map((l) => ({ ...l }));
  for (const line of then) {
    const last = out.at(-1);
    if (last && last.speaker === line.speaker) last.text = `${last.text} ${line.text}`;
    else out.push({ ...line });
  }
  return out;
}

/** Final tokens → one line per stretch of a single voice, with its main language. */
export function linesFromTokens(tokens: SttToken[]): HeardLine[] {
  const groups: { speaker: string; text: string; languages: Map<string, number> }[] = [];
  for (const t of tokens) {
    const speaker = t.speaker ? `voice ${t.speaker}` : "voice";
    let group = groups.at(-1);
    if (!group || group.speaker !== speaker) {
      group = { speaker, text: "", languages: new Map() };
      groups.push(group);
    }
    group.text += t.text;
    if (t.language && t.text.trim()) group.languages.set(t.language, (group.languages.get(t.language) ?? 0) + 1);
  }
  return groups
    .map((g) => {
      const language = [...g.languages.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      return { speaker: g.speaker, text: g.text.replace(/\s+/g, " ").trim(), ...(language && { language }) };
    })
    .filter((l) => l.text);
}

/** The sessions of connected devices. */
class VoiceSessions {
  private sessions = new Map<string, VoiceSession>();
  private handler: TurnHandler | null = null;
  private deps: Deps = { openStt, sttKey: sonioxKey, now: () => Date.now() };

  setTurnHandler(handler: TurnHandler | null): void {
    this.handler = handler;
  }

  /** Tests: swap the STT and the clock. */
  setDeps(deps: Partial<Deps>): void {
    this.deps = { ...this.deps, ...deps };
  }

  onAudio(
    deviceId: string,
    ownerId: string,
    settings: () => DeviceSettings["voice"],
    header: AudioHeader,
    pcm: Buffer
  ): void {
    let session = this.sessions.get(deviceId);
    if (!session) {
      session = new VoiceSession(deviceId, ownerId, settings, () => this.handler, this.deps);
      this.sessions.set(deviceId, session);
    }
    session.onAudio(header, pcm);
  }

  get(deviceId: string): VoiceSession | undefined {
    return this.sessions.get(deviceId);
  }

  drop(deviceId: string): void {
    this.sessions.get(deviceId)?.close();
    this.sessions.delete(deviceId);
  }
}

export const voiceSessions = new VoiceSessions();
