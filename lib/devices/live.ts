import { EventEmitter } from "node:events";
import type { DeviceObservation } from "../db/devices";

// In-process fan-out of what happens on a device, for GET /agent/devices/live
// (SSE). The app runs as one process, so an EventEmitter is enough.

export type LiveEvent =
  | { type: "status"; online: boolean }
  // A frame arrived, and later its caption settled (captioned, failed, …).
  | { type: "observation"; observation: PublicObservation }
  | { type: "caption"; observation: PublicObservation }
  | { type: "deleted" };

export type PublicObservation = Omit<DeviceObservation, "frame"> & { hasFrame: boolean };

/** The API shape of an observation: whether the frame is kept, not its file name. */
export function publicObservation({ frame, ...row }: DeviceObservation): PublicObservation {
  return { ...row, hasFrame: frame !== null };
}

const bus = new EventEmitter();
// One listener per open live view; there is no fixed ceiling worth warning about.
bus.setMaxListeners(0);

export function publishLive(deviceId: string, event: LiveEvent): void {
  bus.emit(deviceId, event);
}

export function subscribeLive(deviceId: string, listener: (event: LiveEvent) => void): () => void {
  bus.on(deviceId, listener);
  return () => bus.off(deviceId, listener);
}
