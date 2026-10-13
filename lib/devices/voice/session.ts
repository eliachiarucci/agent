import type { AudioHeader } from "../protocol";
import type { DeviceSettings } from "../settings";
import { openStt, type SttStream, type SttToken } from "./stt";
import type { HeardLine } from "./text";

// One voice session per connected device (plan 4.11): audio from the device's
// VAD goes to streaming STT; when the device has been silent for endOfTurnMs
// after a stretch of speech, the session asks STT to finalise and hands the
// turn (what was said, split by voice) to the voice-turn handler. New speech
// while the device is talking back interrupts the reply (barge-in).

export type HeardTurn = {
  lines: HeardLine[];
  at: Date;
  // Server clock (ms): when the device's last speech segment ended, and when the final text arrived.
  speechEndAt: number;
  finalAt: number;
  audioMs: number;
};

/** The reply being spoken, for barge-in. */
export type ActiveReply = { speaking: () => boolean; interrupt: () => void };

export type TurnHandler = (deviceId: string, turn: HeardTurn) => void;

type Deps = {
  openStt: typeof openStt;
  now: () => number;
};

// Speech this long while the device is talking interrupts it: shorter blips
// (a cough, residual echo) don't (Pipecat/LiveKit use 0.3–0.5 s).
export const BARGE_IN_MS = 400;
const BYTES_PER_MS = 32; // 16 kHz, 16-bit mono

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
  private warned = false;
  reply: ActiveReply | null = null;

  constructor(
    readonly deviceId: string,
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
    if (this.reply?.speaking() && this.segmentOpen && this.segmentMs >= BARGE_IN_MS) {
      const reply = this.reply;
      this.reply = null;
      reply.interrupt();
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

  close(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.stt?.close();
    this.stt = null;
  }

  private ensureStt(voice: DeviceSettings["voice"]): SttStream | null {
    if (this.stt?.open) return this.stt;
    const stt = this.deps.openStt({ languageHints: voice.languageHints });
    if (!stt) {
      if (!this.warned) console.warn(`[voice] ${this.deviceId}: no speech-to-text key (SONIOX_API_KEY); audio ignored`);
      this.warned = true;
      return null;
    }
    this.stt = stt;
    stt.on("tokens", (final: SttToken[]) => this.finals.push(...final));
    stt.on("fin", () => this.onFin());
    stt.on("error", (error: Error) => console.warn(`[voice] ${this.deviceId}: ${error.message}`));
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
    const lines = linesFromTokens(this.finals);
    const audioMs = this.turnAudioMs;
    this.finals = [];
    this.turnAudioMs = 0;
    if (lines.length === 0) return;
    this.onTurn()?.(this.deviceId, {
      lines,
      at: new Date(),
      speechEndAt: this.speechEndAt,
      finalAt: this.deps.now(),
      audioMs: Math.round(audioMs),
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
  private deps: Deps = { openStt, now: () => Date.now() };

  setTurnHandler(handler: TurnHandler | null): void {
    this.handler = handler;
  }

  /** Tests: swap the STT and the clock. */
  setDeps(deps: Partial<Deps>): void {
    this.deps = { ...this.deps, ...deps };
  }

  onAudio(deviceId: string, settings: () => DeviceSettings["voice"], header: AudioHeader, pcm: Buffer): void {
    let session = this.sessions.get(deviceId);
    if (!session) {
      session = new VoiceSession(deviceId, settings, () => this.handler, this.deps);
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
