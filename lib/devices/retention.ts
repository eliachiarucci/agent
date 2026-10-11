import {
  clearFrames,
  deleteDeviceEventsBefore,
  deleteObservationsBefore,
  findExpiredFrames,
  listAllDevices,
} from "../db/devices";
import { removeFrame } from "./frames";
import { readDeviceSettings } from "./settings";

// Retention per device (settings.retention, plan D8): frame images go after
// `frameDays`, observation rows and device events after `observationDays`.
// Runs hourly from index.ts.

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const BATCH = 500;

export type RetentionResult = { frames: number; observations: number; events: number };

export async function runDeviceRetention(now = new Date()): Promise<RetentionResult> {
  const result: RetentionResult = { frames: 0, observations: 0, events: 0 };
  for (const device of await listAllDevices()) {
    const { frameDays, observationDays } = readDeviceSettings(device.settings).retention;
    // A row's frame goes no later than the row, so no file is left without one.
    const frameCutoff = new Date(now.getTime() - Math.min(frameDays, observationDays) * DAY_MS);
    const rowCutoff = new Date(now.getTime() - observationDays * DAY_MS);

    for (;;) {
      const expired = await findExpiredFrames(device.id, frameCutoff, BATCH);
      if (expired.length === 0) break;
      for (const { frame } of expired) await removeFrame(device.id, frame);
      await clearFrames(expired.map(({ id }) => id));
      result.frames += expired.length;
    }
    result.observations += await deleteObservationsBefore(device.id, rowCutoff);
    result.events += await deleteDeviceEventsBefore(device.id, rowCutoff);
  }
  return result;
}

export function startDeviceRetention(): NodeJS.Timeout {
  const run = () =>
    runDeviceRetention()
      .then(({ frames, observations }) => {
        if (frames || observations) {
          console.log(`Device retention: removed ${frames} frames, ${observations} observations`);
        }
      })
      .catch((error) => console.error("Device retention failed:", error));
  run();
  return setInterval(run, HOUR_MS);
}
