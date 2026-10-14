import { insertDeviceEvent, listDeviceEvents, type Device } from "../db/devices";
import { deviceLinkStatus, DeviceOfflineError, sendSpeech } from "./gateway";
import { publishLive } from "./live";
import { readDeviceSettings, deviceTimeZone } from "./settings";
import { checkSpeechPolicy } from "./speech-policy";
import { resolveVoice, synthesize } from "./tts";

// Saying something through a device (plan 4.7): the policy, synthesis, delivery
// and the speech log (device_events, kind "speech"). The agent's `speak` tool
// goes through every limit; the say route (a person pressing a button) only
// needs the device online.

export const MAX_SPEECH_CHARS = 300;
const HOUR_MS = 60 * 60 * 1000;

export type SpeakResult =
  | { spoken: true; durationMs: number; language: string; voice: string; note?: string }
  | { spoken: false; reason: string };

export type SpeakDeps = {
  synthesize: typeof synthesize;
  send: typeof sendSpeech;
  online: (deviceId: string) => boolean;
  now: () => Date;
};

const defaultDeps: SpeakDeps = {
  synthesize,
  send: sendSpeech,
  online: (deviceId) => deviceLinkStatus(deviceId).online,
  now: () => new Date(),
};

export async function speak(
  params: {
    device: Device;
    text: string;
    language?: string;
    urgent?: boolean;
    // Asked-for news (a trigger run): no cooldown or hourly cap.
    requested?: boolean;
    // "agent": a run's speak tool, under the policy; "user": the say route.
    source: "agent" | "user";
    conversationId?: string;
    // Who pressed say (source "user").
    userId?: string;
  },
  deps: SpeakDeps = defaultDeps
): Promise<SpeakResult> {
  const { device, text, source } = params;
  const settings = readDeviceSettings(device.settings);
  const language = params.language ?? settings.speech.language;
  const base = {
    text,
    language,
    source,
    urgent: params.urgent ?? false,
    ...(params.requested && { requested: true }),
    ...(params.conversationId && { conversationId: params.conversationId }),
    ...(params.userId && { userId: params.userId }),
  };

  const log = async (detail: Record<string, unknown>) => {
    const event = await insertDeviceEvent(device.id, "speech", { ...base, ...detail });
    publishLive(device.id, { type: "speech", event });
  };

  const online = deps.online(device.id);
  if (source === "agent") {
    const recent = await listDeviceEvents({
      deviceId: device.id,
      kind: "speech",
      since: new Date(deps.now().getTime() - HOUR_MS),
      limit: 1000,
    });
    const spoken = recent.filter((e) => e.detail?.status === "spoken");
    const policy = checkSpeechPolicy({
      speech: settings.speech,
      timeZone: deviceTimeZone(settings),
      now: deps.now(),
      online,
      urgent: params.urgent ?? false,
      requested: params.requested,
      lastSpokenAt: spoken[0]?.createdAt ?? null,
      spokenLastHour: spoken.length,
    });
    if (!policy.ok) {
      await log({ status: "refused", reason: policy.reason });
      return { spoken: false, reason: policy.reason };
    }
  } else if (!online) {
    await log({ status: "refused", reason: "The device is offline." });
    return { spoken: false, reason: "The device is offline." };
  }

  const { voice, fallback } = resolveVoice(settings.speech, language);
  const note = fallback
    ? `No voice for "${language}"; spoke with ${voice}, the ${settings.speech.language} voice.`
    : undefined;
  try {
    const audio = await deps.synthesize({ ownerId: device.ownerId, speech: settings.speech, text, voice, language });
    const played = await deps.send(device.id, audio);
    if (!played.ok) {
      const reason = played.error ?? "The device couldn't play it.";
      await log({ status: "failed", voice, reason });
      return { spoken: false, reason };
    }
    const durationMs = played.durationMs ?? audio.durationMs;
    await log({ status: "spoken", voice, durationMs });
    return { spoken: true, durationMs, language, voice, ...(note && { note }) };
  } catch (error) {
    const reason =
      error instanceof DeviceOfflineError
        ? "The device is offline."
        : error instanceof Error
          ? error.message
          : String(error);
    await log({ status: "failed", voice, reason });
    return { spoken: false, reason };
  }
}
