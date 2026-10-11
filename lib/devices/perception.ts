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
} from "../db/devices";
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

type DeviceQueue = {
  pending: string | null;
  running: Promise<void> | null;
  // The last caption, the model's "previous description". Undefined until
  // loaded from the database on the first frame after a restart.
  previous?: Caption | null;
};

export class PerceptionWorker {
  private queues = new Map<string, DeviceQueue>();

  constructor(private readonly deps: PerceptionDeps = defaultDeps) {}

  /** Queues a stored frame for captioning, replacing any frame still waiting. */
  enqueue(deviceId: string, observationId: string): void {
    const queue = this.queues.get(deviceId) ?? { pending: null, running: null };
    this.queues.set(deviceId, queue);
    if (queue.pending) this.settle(deviceId, queue.pending, "superseded");
    queue.pending = observationId;
    queue.running ??= this.drain(deviceId, queue);
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
      const observationId = queue.pending;
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
    if (row) publishLive(deviceId, { type: "caption", observation: publicObservation(row) });
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

    const started = performance.now();
    const result: CaptionResult = await this.deps.caption({ target, image, previous: queue.previous });
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
    if (row) publishLive(deviceId, { type: "caption", observation: publicObservation(row) });
  }
}

export const perceptionWorker = new PerceptionWorker();
