import type { DeviceSettings } from "./settings";

// The speech limits (plan 4.7, D6), checked in code before any synthesis: a
// prompt alone can't hold them, and the camera is untrusted input. A refusal
// carries a reason the model can act on.

export type SpeechPolicyInput = {
  speech: DeviceSettings["speech"];
  timeZone: string;
  now: Date;
  online: boolean;
  // Bypasses the cooldown only.
  urgent: boolean;
  // News someone asked for (a run woken by a trigger the agent set, plan 4.12):
  // bypasses the cooldown and the hourly cap; mute and quiet hours still hold.
  requested?: boolean;
  lastSpokenAt: Date | null;
  spokenLastHour: number;
};

export type SpeechPolicyResult = { ok: true } | { ok: false; reason: string };

/** Minutes since local midnight in `timeZone`. */
export function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

const toMinutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** Whether `now` falls in the quiet window, which may cross midnight. */
export function inQuietHours(
  quiet: DeviceSettings["speech"]["quietHours"],
  now: Date,
  timeZone: string
): boolean {
  if (!quiet) return false;
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === end) return false;
  const minutes = localMinutes(now, timeZone);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export function checkSpeechPolicy(input: SpeechPolicyInput): SpeechPolicyResult {
  const { speech } = input;
  if (!input.online) return { ok: false, reason: "The device is offline." };
  if (speech.muted) return { ok: false, reason: "The device is muted." };
  if (inQuietHours(speech.quietHours, input.now, input.timeZone)) {
    return {
      ok: false,
      reason: `Quiet hours (${speech.quietHours!.start}–${speech.quietHours!.end}): don't speak until they end.`,
    };
  }
  if (input.requested) return { ok: true };
  if (input.spokenLastHour >= speech.maxPerHour) {
    return { ok: false, reason: `Already spoke ${input.spokenLastHour} times in the last hour (the limit).` };
  }
  if (!input.urgent && input.lastSpokenAt) {
    const waitMs = input.lastSpokenAt.getTime() + speech.cooldownSec * 1000 - input.now.getTime();
    if (waitMs > 0) {
      return {
        ok: false,
        reason: `Spoke less than ${speech.cooldownSec} s ago; wait ${Math.ceil(waitMs / 1000)} s, or mark it urgent if it can't wait.`,
      };
    }
  }
  return { ok: true };
}
