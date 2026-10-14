import { tool } from "ai";
import { z } from "zod";
import type { Device } from "../db/devices";
import { createDeviceTrigger, deleteDeviceTrigger, listDeviceTriggers } from "../db/device-triggers";
import type { DeviceSettings } from "./settings";
import { localDate, zonedInstant } from "./time";
import {
  MAX_ACTIVE_TRIGGERS,
  REMINDER_GRACE_MS,
  TRIGGER_MAX_MIN,
  WATCH_DEFAULT_MIN,
  describeTrigger,
  logTrigger,
} from "./triggers";

// The agent's tools for triggers (plan 4.12), in a device's runs and voice turns.

// Without it, a voice turn that sets a watch often ends <silent/>: the note says
// to tell them later, so the model finds nothing to say now.
export const CONFIRM = "Now confirm it to whoever asked, in one short sentence (in a voice turn, that is your reply).";

const noteSchema = z
  .string()
  .min(1)
  .max(1000)
  .describe(
    'For your future self, who reads it when this fires, maybe after the conversation was summarised: who asked, when, and what to do. E.g. "Elia asked at 18:02 to be told when a computer mouse is in view. Tell them."'
  );

/** "HH:MM" (the next one) or "YYYY-MM-DD HH:MM", in the device's zone. */
function resolveAt(at: string, timeZone: string, now: Date): Date {
  const match = /^(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{1,2}):(\d{2})$/.exec(at.trim());
  if (!match) throw new Error(`Couldn't read "${at}": use "HH:MM" or "YYYY-MM-DD HH:MM"`);
  const time = `${match[2].padStart(2, "0")}:${match[3]}`;
  if (match[1]) return zonedInstant(match[1], time, timeZone);
  const today = zonedInstant(localDate(now, timeZone), time, timeZone);
  if (today > now) return today;
  return zonedInstant(localDate(new Date(now.getTime() + 24 * 3600_000), timeZone), time, timeZone);
}

export function buildTriggerTools(params: {
  device: Device;
  settings: DeviceSettings;
  agentId: string;
  timeZone: string;
  source: "voice" | "run";
  now: () => Date;
}) {
  const { device, settings, agentId, timeZone, source } = params;

  const roomFor = async () => {
    const active = await listDeviceTriggers(device.id, agentId);
    return active.length < MAX_ACTIVE_TRIGGERS
      ? null
      : `There are already ${MAX_ACTIVE_TRIGGERS} triggers; cancel one first (listTriggers shows them).`;
  };

  return {
    remindAt: tool({
      description: `Set a reminder for yourself: at that time you're woken in this conversation with the note, and can tell them (out loud) or do what it says. Use it whenever you promise to do something later ("remind me at 6", "tell me in 10 minutes"). Times are in ${timeZone}.`,
      inputSchema: z.object({
        note: noteSchema,
        in_minutes: z.number().int().min(1).max(TRIGGER_MAX_MIN).optional().describe("Minutes from now"),
        at: z
          .string()
          .optional()
          .describe('Local time: "HH:MM" (the next one) or "YYYY-MM-DD HH:MM". Give this or in_minutes.'),
      }),
      execute: async ({ note, in_minutes, at }) => {
        const now = params.now();
        let when: Date;
        try {
          if (in_minutes !== undefined) when = new Date(now.getTime() + in_minutes * 60_000);
          else if (at) when = resolveAt(at, timeZone, now);
          else return { error: "Give at or in_minutes." };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
        if (when.getTime() < now.getTime() + 60_000) return { error: "A reminder must be at least a minute from now." };
        if (when.getTime() > now.getTime() + TRIGGER_MAX_MIN * 60_000) return { error: "At most 7 days ahead." };
        const full = await roomFor();
        if (full) return { error: full };
        const trigger = await createDeviceTrigger({
          deviceId: device.id,
          agentId,
          kind: "at",
          note,
          at: when,
          expiresAt: new Date(when.getTime() + REMINDER_GRACE_MS),
          source,
        });
        await logTrigger(device.id, "set", trigger, { source });
        return { set: describeTrigger(trigger, timeZone, now), reply: CONFIRM };
      },
    }),

    watchFor: tool({
      description: `Watch the camera for something and be woken in this conversation when it shows up ("tell me when the cat comes", "let me know when a mouse is in view"). Every captioned frame is checked; when one shows it, you get the newest frame and your note. Never promise to keep an eye out without it. Lasts ${WATCH_DEFAULT_MIN} minutes unless they ask for longer.`,
      inputSchema: z.object({
        what: z.string().min(1).max(200).describe('What to look for, as it would look in the frame: "a computer mouse", "a grey cat"'),
        note: noteSchema,
        minutes: z
          .number()
          .int()
          .min(1)
          .max(TRIGGER_MAX_MIN)
          .optional()
          .describe(`How long to keep watching (default ${WATCH_DEFAULT_MIN})`),
        repeat: z
          .boolean()
          .optional()
          .describe("Every time it shows up (until it expires), instead of only the first time"),
      }),
      execute: async ({ what, note, minutes, repeat }) => {
        const now = params.now();
        if (device.hello && !device.hello.capabilities?.sizes?.length) return { error: `${device.name} has no camera.` };
        if (!settings.perception.enabled) {
          return { error: `Captioning is off for ${device.name}, so nothing in view is checked. The owner can turn it on in Settings → Devices.` };
        }
        const full = await roomFor();
        if (full) return { error: full };
        const trigger = await createDeviceTrigger({
          deviceId: device.id,
          agentId,
          kind: "seen",
          note,
          what,
          repeat: repeat ?? false,
          expiresAt: new Date(now.getTime() + (minutes ?? WATCH_DEFAULT_MIN) * 60_000),
          source,
        });
        await logTrigger(device.id, "set", trigger, { source });
        return {
          set: describeTrigger(trigger, timeZone, now),
          note: `Frames are checked when the view changes, up to ${settings.perception.framesPerHour} an hour; something that appears and goes within seconds can be missed.`,
          reply: CONFIRM,
        };
      },
    }),

    listTriggers: tool({
      description: "The reminders and watches you have set on this device.",
      inputSchema: z.object({}),
      execute: async () => {
        const now = params.now();
        const active = await listDeviceTriggers(device.id, agentId);
        return active.length ? { triggers: active.map((t) => describeTrigger(t, timeZone, now)) } : { triggers: [], note: "None." };
      },
    }),

    cancelTrigger: tool({
      description: "Cancel a reminder or watch you set (its id is in listTriggers and the <triggers> list).",
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        const active = await listDeviceTriggers(device.id, agentId);
        const trigger = active.find((t) => t.id === id.trim());
        if (!trigger) return { error: "No such trigger on this device." };
        if (!(await deleteDeviceTrigger(trigger.id))) return { error: "It already fired or expired." };
        await logTrigger(device.id, "cancelled", trigger, { source });
        return { cancelled: describeTrigger(trigger, timeZone, params.now()) };
      },
    }),
  };
}
