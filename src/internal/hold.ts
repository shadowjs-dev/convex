import type { SuspenseTracker } from "@shadow-js/core";

/**
 * A hold on the nearest Suspense boundary. `acquire` increments the tracker once; `release`
 * decrements it once. Repeated calls are no-ops, so the counter stays balanced however the
 * caller's loads start and stop.
 * @internal
 */
export interface SuspenseHold {
  acquire(): void;
  release(): void;
  /** True while this hold is counted by the tracker. */
  readonly held: boolean;
}

/**
 * Creates a hold for `tracker`. With no tracker (no enclosing `<Suspense>`) the hold does nothing.
 * @internal
 */
export function createSuspenseHold(tracker: SuspenseTracker | null): SuspenseHold {
  let held = false;
  return {
    acquire(): void {
      if (tracker === null || held) return;
      held = true;
      tracker.increment();
    },
    release(): void {
      if (!held) return;
      held = false;
      tracker?.decrement();
    },
    get held(): boolean {
      return held;
    },
  };
}
