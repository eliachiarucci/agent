import type { DeviceObservation } from "../db/devices";
import { getDevice, insertDeviceEvent, type Device } from "../db/devices";
import {
  deleteDeviceTrigger,
  deleteExpiredTriggers,
  listDeviceTriggers,
  listDueReminders,
  markWatchFired,
  rearmWatch,
  type DeviceTrigger,
} from "../db/device-triggers";
import { publishLive } from "./live";
import type { RunTrigger } from "./run-triggers";
import { deviceTimeZone, readDeviceSettings } from "./settings";
import { localDate, localDayLabel, localTime } from "./time";

// Triggers (plan 4.12): what a device's agent set aside to be woken by. A
// reminder fires from the ticker at its time; a watch fires when a caption
// reports it in view (the captioner gets the active watches, caption.ts). Either
// wakes a run of kind "trigger" in the device's conversation, carrying the
// note the agent left itself, since the history may be compacted by then.

export const MAX_ACTIVE_TRIGGERS = 20;
export const WATCH_DEFAULT_MIN = 60;
export const TRIGGER_MAX_MIN = 7 * 24 * 60;
// A reminder that couldn't fire on time (server down) still fires within this; later it is dropped.
export const REMINDER_GRACE_MS = 60 * 60_000;
// A repeating watch fires at most this often.
export const REPEAT_GAP_MS = 2 * 60_000;
// Trigger runs skip the device's run budget up to this many an hour; past it they count against the budget.
export const TRIGGER_RUNS_PER_HOUR = 20;
export const TRIGGER_TICK_MS = 15_000;

function when(date: Date, timeZone: string, now: Date): string {
  const time = localTime(date, timeZone);
  return localDate(date, timeZone) === localDate(now, timeZone) ? time : `${localDayLabel(date, timeZone)} ${time}`;
}

/** One line per trigger, for the agent's view and the listTriggers tool. */
export function describeTrigger(t: DeviceTrigger, timeZone: string, now: Date): string {
  const what =
    t.kind === "at"
      ? `reminder at ${when(t.at!, timeZone, now)}`
      : `watch for "${t.what}", ${t.repeat ? "every time it shows up" : "once"}, until ${when(t.expiresAt, timeZone, now)}`;
  return `${t.id}: ${what}. Note: ${t.note}`;
}

/** The active triggers, as listed in run reports and voice turns; null when there are none. */
export function triggersBlock(triggers: DeviceTrigger[], timeZone: string, now: Date): string | null {
  if (triggers.length === 0) return null;
  return [
    "<triggers>",
    "What you set aside (cancelTrigger removes one):",
    ...triggers.map((t) => `- ${describeTrigger(t, timeZone, now)}`),
    "</triggers>",
  ].join("\n");
}

/** Logs a trigger's life ("set", "fired", "expired", "cancelled") as a device event. */
export async function logTrigger(
  deviceId: string,
  status: "set" | "fired" | "expired" | "cancelled",
  t: DeviceTrigger,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const event = await insertDeviceEvent(deviceId, "trigger", {
    status,
    id: t.id,
    kind: t.kind,
    note: t.note,
    ...(t.what && { what: t.what }),
    ...(t.at && { at: t.at.toISOString() }),
    ...extra,
  });
  publishLive(deviceId, { type: "trigger", event });
}

/** The run trigger for a fired trigger: the note and what fired it. */
function runTrigger(t: DeviceTrigger, now: Date, timeZone: string, observation?: DeviceObservation): RunTrigger {
  const set = `set ${when(t.createdAt, timeZone, now)}`;
  let detail: string;
  if (t.kind === "at") {
    const lateMin = Math.round((now.getTime() - t.at!.getTime()) / 60_000);
    detail = `reminder for ${when(t.at!, timeZone, now)} (${set}${lateMin >= 2 ? `; ${lateMin} min late, the server was down` : ""})`;
  } else {
    detail = `watch for "${t.what}" seen at ${localTime(observation?.capturedAt ?? now, timeZone, true)} (${set}; ${
      t.repeat ? `keeps watching until ${when(t.expiresAt, timeZone, now)}` : "a one-time watch, now done"
    })`;
  }
  return {
    kind: "trigger",
    at: now,
    detail: `${detail}. Your note: ${t.note}`,
    triggerId: t.id,
    ...(observation && { observationId: observation.id }),
  };
}

/**
 * The watches a settled caption fired (caption.watchHits). A one-time watch is
 * removed as it fires; a repeating one is disarmed until a caption without it,
 * and fires at most every REPEAT_GAP_MS.
 */
export async function watchTriggers(device: Device, observation: DeviceObservation, now: Date): Promise<RunTrigger[]> {
  if (!device.agentId || observation.captionStatus !== "captioned" || !observation.caption) return [];
  const watches = (await listDeviceTriggers(device.id, device.agentId)).filter(
    (t) => t.kind === "seen" && t.expiresAt > now
  );
  if (watches.length === 0) return [];
  const hits = new Set(observation.caption.watchHits ?? []);
  const timeZone = deviceTimeZone(readDeviceSettings(device.settings));
  const fired: RunTrigger[] = [];
  for (const watch of watches) {
    if (!hits.has(watch.id)) {
      if (watch.repeat && !watch.armed) await rearmWatch(watch.id);
      continue;
    }
    if (watch.repeat) {
      if (!watch.armed || (watch.lastFiredAt && now.getTime() - watch.lastFiredAt.getTime() < REPEAT_GAP_MS)) continue;
      if (!(await markWatchFired(watch.id, now))) continue;
    } else if (!(await deleteDeviceTrigger(watch.id))) {
      continue;
    }
    await logTrigger(device.id, "fired", watch, { observationId: observation.id });
    fired.push(runTrigger(watch, now, timeZone, observation));
  }
  return fired;
}

/**
 * One tick: reminders whose time has come (each removed as it fires), then the
 * triggers past their expiry. Returns the runs to start, per device.
 */
export async function dueTriggers(now: Date): Promise<Array<{ deviceId: string; trigger: RunTrigger }>> {
  const out: Array<{ deviceId: string; trigger: RunTrigger }> = [];
  for (const reminder of await listDueReminders(now)) {
    if (reminder.expiresAt <= now) continue; // too late: expires below
    if (!(await deleteDeviceTrigger(reminder.id))) continue;
    const device = await getDevice(reminder.deviceId);
    if (!device) continue;
    if (device.agentId !== reminder.agentId) {
      await logTrigger(device.id, "cancelled", reminder, { reason: "the device works for another agent now" });
      continue;
    }
    await logTrigger(device.id, "fired", reminder);
    out.push({
      deviceId: device.id,
      trigger: runTrigger(reminder, now, deviceTimeZone(readDeviceSettings(device.settings))),
    });
  }
  for (const expired of await deleteExpiredTriggers(now)) {
    await logTrigger(expired.deviceId, "expired", expired);
  }
  return out;
}
