import { executeDeviceRun } from "../agent/device-run";
import { countNotableSince, getDevice, listAllDevices, type Device } from "../db/devices";
import { perceptionWorker } from "./perception";
import { captionTriggers, type RunTrigger } from "./run-triggers";
import { readDeviceSettings } from "./settings";

// Schedules device agent runs (plan 4.5): one run at a time per device, runs
// at least minGapSec apart (start to start); triggers that arrive meanwhile
// merge into the next run. The reflection timer adds a run every
// reflectionMin minutes when anything was logged in the period.

export type RunnerDeps = {
  execute: (deviceId: string, triggers: RunTrigger[]) => Promise<unknown>;
  now: () => number;
  listDevices: () => Promise<Device[]>;
  countNotable: (deviceId: string, since: Date) => Promise<number>;
};

type DeviceState = {
  pending: RunTrigger[];
  running: Promise<void> | null;
  lastStart: number;
  minGapMs: number;
  timer: NodeJS.Timeout | null;
  lastReflection: number;
};

export class DeviceRunner {
  private states = new Map<string, DeviceState>();
  private readonly startedAt: number;

  constructor(private readonly deps: RunnerDeps) {
    this.startedAt = deps.now();
  }

  private state(deviceId: string): DeviceState {
    let state = this.states.get(deviceId);
    if (!state) {
      state = {
        pending: [],
        running: null,
        lastStart: -Infinity,
        minGapMs: 20_000,
        timer: null,
        lastReflection: this.startedAt,
      };
      this.states.set(deviceId, state);
    }
    return state;
  }

  trigger(deviceId: string, triggers: RunTrigger[], minGapMs: number): void {
    if (triggers.length === 0) return;
    const state = this.state(deviceId);
    state.pending.push(...triggers);
    state.minGapMs = minGapMs;
    this.schedule(deviceId, state);
  }

  /** Resolves once the device has no run going, waiting or scheduled. */
  async idle(deviceId: string): Promise<void> {
    for (;;) {
      const state = this.states.get(deviceId);
      if (!state) return;
      if (state.running) await state.running;
      else if (state.timer || state.pending.length) await new Promise((r) => setTimeout(r, 20));
      else return;
    }
  }

  /** Drops what is waiting for a device (deleted). A run in progress finishes. */
  forget(deviceId: string): void {
    const state = this.states.get(deviceId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.pending = [];
    if (!state.running) this.states.delete(deviceId);
  }

  private schedule(deviceId: string, state: DeviceState): void {
    if (state.running || state.timer || state.pending.length === 0) return;
    const wait = state.lastStart + state.minGapMs - this.deps.now();
    if (wait > 0) {
      state.timer = setTimeout(() => {
        state.timer = null;
        this.schedule(deviceId, state);
      }, wait);
      return;
    }
    const triggers = state.pending.splice(0);
    state.lastStart = this.deps.now();
    state.running = this.deps
      .execute(deviceId, triggers)
      .then(
        () => {},
        (error) => console.error(`Device run failed for ${deviceId}:`, error)
      )
      .finally(() => {
        state.running = null;
        this.schedule(deviceId, state);
      });
  }

  /** One reflection pass: a run for each device whose period had notable captions. */
  async reflect(): Promise<void> {
    const now = this.deps.now();
    for (const device of await this.deps.listDevices()) {
      const { agent } = readDeviceSettings(device.settings);
      if (!device.agentId || !agent.enabled || agent.reflectionMin === 0) continue;
      const state = this.state(device.id);
      const periodMs = agent.reflectionMin * 60_000;
      if (now - state.lastReflection < periodMs) continue;
      const since = new Date(state.lastReflection);
      state.lastReflection = now;
      const notable = await this.deps.countNotable(device.id, since);
      if (notable === 0) continue;
      this.trigger(
        device.id,
        [{ kind: "reflection", at: new Date(now), detail: `${notable} notable captions since the last reflection` }],
        agent.minGapSec * 1000
      );
    }
  }
}

export const deviceRunner = new DeviceRunner({
  execute: executeDeviceRun,
  now: () => Date.now(),
  listDevices: listAllDevices,
  countNotable: countNotableSince,
});

/** Runs a device's agent when its captions call for it. */
export async function onCaptionSettled(deviceId: string, observation: Parameters<typeof captionTriggers>[0]) {
  if (observation.captionStatus !== "captioned") return;
  const device = await getDevice(deviceId);
  if (!device?.agentId) return;
  const { agent } = readDeviceSettings(device.settings);
  if (!agent.enabled) return;
  deviceRunner.trigger(deviceId, captionTriggers(observation, agent), agent.minGapSec * 1000);
}

const REFLECTION_TICK_MS = 60_000;

/** Wires captions to runs and starts the reflection timer (index.ts). */
export function startDeviceRuns(): () => void {
  const unsubscribe = perceptionWorker.onSettled((deviceId, observation) => {
    onCaptionSettled(deviceId, observation).catch((error) => console.error("Run trigger failed:", error));
  });
  const timer = setInterval(() => {
    deviceRunner.reflect().catch((error) => console.error("Reflection tick failed:", error));
  }, REFLECTION_TICK_MS);
  return () => {
    unsubscribe();
    clearInterval(timer);
  };
}
