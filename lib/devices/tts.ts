import { createOpenAI } from "@ai-sdk/openai";
import { experimental_generateSpeech as generateSpeech } from "ai";
import { getProviderSetting } from "../db/provider-settings";
import type { DeviceSettings } from "./settings";
import { sonioxKey } from "./voice/stt";

// Text to speech on the server (plan 4.7), so voices and languages live in one
// place. Piper (the default) runs as its own container, reached at PIPER_URL
// (it is GPL-3.0, so it stays out of the agent image); OpenAI and Soniox use the
// device owner's key (Soniox: the same one as voice mode's speech to text). All return WAV.

export class SpeechUnavailableError extends Error {}

export type SpeechAudio = {
  audio: Uint8Array;
  format: "wav";
  sampleRate: number;
  durationMs: number;
};

// One voice per language unless the device settings say otherwise
// (huggingface.co/rhasspy/piper-voices). The Piper container must have them.
export const PIPER_DEFAULT_VOICES: Record<string, string> = {
  en: "en_US-lessac-medium",
  it: "it_IT-paola-medium",
};
// OpenAI's voices speak every language it supports.
export const OPENAI_DEFAULT_VOICE = "alloy";
export const OPENAI_DEFAULT_SPEECH_MODEL = "gpt-4o-mini-tts";
// Soniox's voices also speak every language it supports (63 for tts-rt-v2,
// soniox.com/docs/tts/concepts/voices). Adrian: "a deep, focused male voice".
export const SONIOX_DEFAULT_VOICE = "Adrian";
export const SONIOX_DEFAULT_SPEECH_MODEL = "tts-rt-v2";
const SONIOX_TTS_URL = "https://tts-rt.soniox.com/tts";

/** The voice for a language: exact tag, then its primary subtag ("it-IT" → "it"), then the default language's. */
export function resolveVoice(
  speech: DeviceSettings["speech"],
  language: string
): { voice: string; fallback: boolean } {
  const primary = language.split("-")[0].toLowerCase();
  if (speech.provider === "openai" || speech.provider === "soniox") {
    const fallbackVoice = speech.provider === "openai" ? OPENAI_DEFAULT_VOICE : SONIOX_DEFAULT_VOICE;
    return { voice: speech.voices[language] ?? speech.voices[primary] ?? fallbackVoice, fallback: false };
  }
  const voices = { ...PIPER_DEFAULT_VOICES, ...speech.voices };
  const voice = voices[language] ?? voices[primary];
  if (voice) return { voice, fallback: false };
  const fallbackPrimary = speech.language.split("-")[0].toLowerCase();
  return {
    voice: voices[speech.language] ?? voices[fallbackPrimary] ?? PIPER_DEFAULT_VOICES.en,
    fallback: true,
  };
}

/** Sample rate and length of a PCM WAV file, read from its chunks. */
export function parseWav(bytes: Uint8Array): { sampleRate: number; durationMs: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a WAV file");
  let sampleRate = 0;
  let byteRate = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      sampleRate = view.getUint32(offset + 12, true);
      byteRate = view.getUint32(offset + 16, true);
    } else if (id === "data") {
      if (!byteRate) break;
      // Streamed WAVs leave the size unset (0 or 0xFFFFFFFF): count what is there.
      const available = bytes.length - offset - 8;
      const dataBytes = size === 0 || size > available ? available : size;
      return { sampleRate, durationMs: Math.round((dataBytes / byteRate) * 1000) };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV file without a format or data chunk");
}

async function piper(text: string, voice: string): Promise<Uint8Array> {
  const url = process.env.PIPER_URL;
  if (!url) throw new SpeechUnavailableError("Piper isn't set up on the server (PIPER_URL).");
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/+$/, "")}/synthesize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new SpeechUnavailableError(`Piper isn't reachable: ${error instanceof Error ? error.message : error}`);
  }
  if (!res.ok) throw new SpeechUnavailableError(`Piper answered HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function openai(ownerId: string, model: string, text: string, voice: string): Promise<Uint8Array> {
  const setting = await getProviderSetting(ownerId, "openai");
  if (!setting?.settings.apiKey) throw new SpeechUnavailableError("OpenAI isn't configured for the device's owner.");
  const result = await generateSpeech({
    model: createOpenAI({ apiKey: setting.settings.apiKey }).speech(model),
    text,
    voice,
    outputFormat: "wav",
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(30_000),
  });
  return result.audio.uint8Array;
}

// POST /tts answers with the audio (soniox.com/docs/api-reference/tts/generate_tts).
async function soniox(ownerId: string, model: string, text: string, voice: string, language: string): Promise<Uint8Array> {
  const key = await sonioxKey(ownerId);
  if (!key) throw new SpeechUnavailableError("Soniox isn't configured for the device's owner (Settings → Models → Speech).");
  let res: Response;
  try {
    res = await fetch(process.env.SONIOX_TTS_URL ?? SONIOX_TTS_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, voice, language: language.split("-")[0].toLowerCase(), text, audio_format: "wav" }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new SpeechUnavailableError(`Soniox isn't reachable: ${error instanceof Error ? error.message : error}`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error_type?: string; error_message?: string } | null;
    throw new SpeechUnavailableError(
      `Soniox answered HTTP ${res.status}${body?.error_message ? `: ${body.error_message}` : body?.error_type ? ` (${body.error_type})` : ""}`
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}

export async function synthesize(params: {
  ownerId: string;
  speech: DeviceSettings["speech"];
  text: string;
  voice: string;
  // BCP-47 tag of the text (Soniox needs it; Piper's voice already implies it).
  language: string;
}): Promise<SpeechAudio> {
  const { speech, text, voice } = params;
  const audio =
    speech.provider === "openai"
      ? await openai(params.ownerId, speech.model ?? OPENAI_DEFAULT_SPEECH_MODEL, text, voice)
      : speech.provider === "soniox"
        ? await soniox(params.ownerId, speech.model ?? SONIOX_DEFAULT_SPEECH_MODEL, text, voice, params.language)
        : await piper(text, voice);
  const { sampleRate, durationMs } = parseWav(audio);
  return { audio, format: "wav", sampleRate, durationMs };
}
