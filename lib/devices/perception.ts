import { readFile } from "node:fs/promises";
import { embedText } from "../global/ai";
import {
  countCaptionCalls,
  getDevice,
  getObservation,
  latestCaptioned,
  settleWaitingCaption,
  updateCaption,
  type Device,
  type DeviceObservation,
} from "../db/devices";
import { listDeviceTriggers } from "../db/device-triggers";
import type { CaptionStatus } from "../global/schema";
import { captionFrame, type Caption, type CaptionResult } from "./caption";
import { frameFilePath } from "./frames";
import { publicObservation, publishLive } from "./live";
import { resolvePerceptionTarget, type PerceptionTarget } from "./perception-model";
import { readDeviceSettings } from "./settings";

// The perception worker (plan 4.4): one per device, one model call at a time.
// Only the newest waiting frame is kept, so a slow model never builds a
// backlog: a frame that is overtaken while it waits is marked "superseded".
// The budget caps model calls per rolling hour; frames over it are stored
// without a caption.

const HOUR_MS = 60 * 60 * 1000;

export type PerceptionDeps = {
  resolveTarget: (device: Device) => Promise<PerceptionTarget | null>;
  caption: typeof captionFrame;
  embed: (text: string) => Promise<number[]>;
  now: () => Date;
};

const defaultDeps: PerceptionDeps = {
  resolveTarget: (device) =>
    resolvePerceptionTarget(device.ownerId, readDeviceSettings(device.settings).perception),
  caption: captionFrame,
  embed: (text) => embedText(text, "document"),
  now: () => new Date(),
};

// Called with each observation once its caption has settled (any status).
export type CaptionListener = (deviceId: string, observation: DeviceObservation) => void;

type DeviceQueue = {
  // A requested frame (someone is waiting for it) isn't superseded by change frames.
  pending: { id: string; priority: boolean } | null;
  running: Promise<void> | null;
  // The last caption, the model's "previous description". Undefined until
  // loaded from the database on the first frame after a restart.
  previous?: Caption | null;
};

export class PerceptionWorker {
  private queues = new Map<string, DeviceQueue>();
  private listeners = new Set<CaptionListener>();

  constructor(private readonly deps: PerceptionDeps = defaultDeps) {}

  /** Queues a stored frame for captioning, replacing any frame still waiting. */
  enqueue(deviceId: string, observationId: string, options: { priority?: boolean } = {}): void {
    const queue = this.queues.get(deviceId) ?? { pending: null, running: null };
    this.queues.set(deviceId, queue);
    const priority = options.priority ?? false;
    if (queue.pending?.priority && !priority) {
      this.settle(deviceId, observationId, "superseded");
    } else {
      if (queue.pending) this.settle(deviceId, queue.pending.id, "superseded");
      queue.pending = { id: observationId, priority };
    }
    queue.running ??= this.drain(deviceId, queue);
  }

  /** Subscribes to settled captions; returns the unsubscribe function. */
  onSettled(listener: CaptionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves with the observation once its caption has settled, or null on timeout. */
  async waitFor(observationId: string, timeoutMs: number): Promise<DeviceObservation | null> {
    let unsubscribe = () => {};
    const settled = new Promise<DeviceObservation>((resolve) => {
      unsubscribe = this.onSettled((_deviceId, row) => {
        if (row.id === observationId) resolve(row);
      });
    });
    try {
      // It may have settled before the subscription.
      const current = await getObservation(observationId);
      if (!current || current.captionStatus !== null) return current ?? null;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), timeoutMs)));
      const result = await Promise.race([settled, timeout]);
      clearTimeout(timer);
      return result;
    } finally {
      unsubscribe();
    }
  }

  /** Resolves once the device's queue is empty (for tests and shutdown). */
  async idle(deviceId: string): Promise<void> {
    while (this.queues.get(deviceId)?.running) await this.queues.get(deviceId)!.running;
  }

  /** Forgets the device's last caption, e.g. when the device is deleted. */
  forget(deviceId: string): void {
    const queue = this.queues.get(deviceId);
    if (queue && !queue.running) this.queues.delete(deviceId);
  }

  private async drain(deviceId: string, queue: DeviceQueue): Promise<void> {
    while (queue.pending) {
      const observationId = queue.pending.id;
      queue.pending = null;
      try {
        await this.process(deviceId, observationId, queue);
      } catch (error) {
        console.error(`Perception failed for device ${deviceId}:`, error);
        this.settle(deviceId, observationId, "failed");
      }
    }
    queue.running = null;
  }

  private settle(deviceId: string, observationId: string, status: CaptionStatus): void {
    settleWaitingCaption(observationId, status).then(
      () => this.publish(deviceId, observationId),
      (error) => console.error("Perception bookkeeping failed:", error)
    );
  }

  private async publish(deviceId: string, observationId: string): Promise<void> {
    const row = await getObservation(observationId);
    if (row) this.announce(deviceId, row);
  }

  private announce(deviceId: string, row: DeviceObservation): void {
    publishLive(deviceId, { type: "caption", observation: publicObservation(row) });
    for (const listener of this.listeners) {
      try {
        listener(deviceId, row);
      } catch (error) {
        console.error("Caption listener failed:", error);
      }
    }
  }

  private async process(deviceId: string, observationId: string, queue: DeviceQueue): Promise<void> {
    const [device, observation] = await Promise.all([getDevice(deviceId), getObservation(observationId)]);
    if (!device || !observation?.frame) return;
    const { perception } = readDeviceSettings(device.settings);

    if (!perception.enabled) return this.finish(deviceId, observationId, { captionStatus: "disabled" });
    const since = new Date(this.deps.now().getTime() - HOUR_MS);
    if ((await countCaptionCalls(deviceId, since)) >= perception.framesPerHour) {
      return this.finish(deviceId, observationId, { captionStatus: "over_budget" });
    }
    const target = await this.deps.resolveTarget(device);
    if (!target) return this.finish(deviceId, observationId, { captionStatus: "no_model" });

    if (queue.previous === undefined) queue.previous = (await latestCaptioned(deviceId))?.caption ?? null;
    const image = await readFile(frameFilePath(deviceId, observation.frame));
    // The active watches (plan 4.12), as short ids the model can copy back.
    const now = this.deps.now();
    const watches = device.agentId
      ? (await listDeviceTriggers(deviceId, device.agentId)).filter((t) => t.kind === "seen" && t.expiresAt > now)
      : [];
    const label = new Map(watches.map((w, i) => [`w${i + 1}`, w.id]));

    const started = performance.now();
    const result: CaptionResult = await this.deps.caption({
      target,
      image,
      previous: queue.previous,
      watches: watches.map((w, i) => ({ id: `w${i + 1}`, what: w.what ?? "" })),
    });
    const meta = {
      provider: target.provider,
      model: target.modelId,
      ms: Math.round(performance.now() - started),
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
    };
    const captionedAt = this.deps.now();

    if (!result.ok) {
      return this.finish(deviceId, observationId, {
        captionStatus: "failed",
        captionedAt,
        captionMeta: { ...meta, error: result.error.slice(0, 500) },
      });
    }

    // Stored with the triggers' own ids.
    result.caption.watchHits = [
      ...new Set((result.caption.watchHits ?? []).flatMap((id) => (label.has(id) ? [label.get(id)!] : []))),
    ];
    queue.previous = result.caption;
    // A failed embedding loses search for this frame, not its caption.
    const embedding = await this.deps.embed(result.caption.summary).catch((error) => {
      console.error("Caption embedding failed:", error);
      return null;
    });
    return this.finish(deviceId, observationId, {
      captionStatus: "captioned",
      caption: result.caption,
      captionMeta: meta,
      captionedAt,
      salience: result.caption.salience,
      embedding,
    });
  }

  private async finish(
    deviceId: string,
    observationId: string,
    changes: Parameters<typeof updateCaption>[1]
  ): Promise<void> {
    const row = await updateCaption(observationId, changes);
    if (row) this.announce(deviceId, row);
  }
}

export const perceptionWorker = new PerceptionWorker();
