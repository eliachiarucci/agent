// One model call at a time per device (plan 4.11, "Single conversation"): agent
// runs and voice turns write the same conversation. Voice turns jump the queue
// ahead of waiting runs, since someone is waiting for the answer.

type Waiter = { resolve: () => void; urgent: boolean };
type State = { held: boolean; queue: Waiter[] };

const states = new Map<string, State>();

/** Runs `fn` holding the device's lock; `urgent` waiters go first. */
export async function withDeviceLock<T>(deviceId: string, fn: () => Promise<T>, urgent = false): Promise<T> {
  let state = states.get(deviceId);
  if (!state) {
    state = { held: false, queue: [] };
    states.set(deviceId, state);
  }
  if (state.held) {
    await new Promise<void>((resolve) => {
      const waiter = { resolve, urgent };
      if (urgent) {
        const firstNormal = state!.queue.findIndex((w) => !w.urgent);
        state!.queue.splice(firstNormal < 0 ? state!.queue.length : firstNormal, 0, waiter);
      } else {
        state!.queue.push(waiter);
      }
    });
  }
  state.held = true;
  try {
    return await fn();
  } finally {
    const next = state.queue.shift();
    if (next) next.resolve();
    else {
      state.held = false;
      states.delete(deviceId);
    }
  }
}
