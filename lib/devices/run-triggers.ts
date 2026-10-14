import type { DeviceObservation } from "../db/devices";
import type { DeviceSettings } from "./settings";

// What wakes a device's agent (plan 4.5). Captions decide most of it; "look"
// comes from a person pressing Look, "reflection" from the timer, "trigger"
// from something the agent set aside (a reminder or a watch, plan 4.12).

export const RUN_TRIGGER_KINDS = ["wake", "salience", "new_entity", "look", "reflection", "trigger"] as const;

export type RunTrigger = {
  kind: (typeof RUN_TRIGGER_KINDS)[number];
  at: Date;
  detail: string;
  observationId?: string;
  // kind "trigger": the device trigger that fired.
  triggerId?: string;
};

/** The triggers in one caption, if any. */
export function captionTriggers(
  observation: DeviceObservation,
  agent: DeviceSettings["agent"]
): RunTrigger[] {
  const caption = observation.caption;
  if (observation.captionStatus !== "captioned" || !caption) return [];
  const base = { at: observation.capturedAt, observationId: observation.id };
  const triggers: RunTrigger[] = [];
  if (caption.wake === "agent") triggers.push({ ...base, kind: "wake", detail: caption.reason });
  if (caption.salience >= agent.salience) {
    triggers.push({ ...base, kind: "salience", detail: `salience ${caption.salience.toFixed(2)}` });
  }
  const arrivals = caption.entities.filter((e) => e.isNew && (e.kind === "person" || e.kind === "animal"));
  if (arrivals.length > 0) {
    triggers.push({
      ...base,
      kind: "new_entity",
      detail: arrivals.map((e) => `${e.kind}: ${e.description}`).join("; "),
    });
  }
  return triggers;
}
