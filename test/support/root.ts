import { createRoot, SuspenseContext, type SuspenseTracker } from "@shadow-js/core";
import { ConvexProvider } from "../../src/client";
import type { ConvexClientLike } from "../../src/types";

/** A mounted hook or component: its value and the function that disposes it. */
export interface Mounted<T> {
  readonly value: T;
  readonly dispose: () => void;
}

/** Runs `body` inside a fresh owner, without any provider. */
export function mount<T>(body: () => T): Mounted<T> {
  return createRoot((dispose) => ({ value: body(), dispose }));
}

/**
 * Runs `body` inside a fresh owner under a `ConvexProvider` for `client`. The body's value is
 * captured, so hooks can be called directly in it.
 */
export function mountWith<T>(client: ConvexClientLike, body: () => T): Mounted<T> {
  const slot: { value: T | undefined } = { value: undefined };
  const dispose = createRoot((root) => {
    ConvexProvider({
      client,
      get children() {
        slot.value = body();
        return null;
      },
    });
    return root;
  });
  if (slot.value === undefined) throw new Error("mountWith(): the body did not run.");
  return { value: slot.value, dispose };
}

/** Runs `body` inside a `SuspenseContext` provided by `tracker`. */
export function inSuspense<T>(tracker: SuspenseTracker, body: () => T): Mounted<T> {
  const slot: { value: T | undefined } = { value: undefined };
  const dispose = createRoot((root) => {
    SuspenseContext({
      value: tracker,
      get children() {
        slot.value = body();
        return null;
      },
    });
    return root;
  });
  if (slot.value === undefined) throw new Error("inSuspense(): the body did not run.");
  return { value: slot.value, dispose };
}

/** A tracker that counts increments and decrements. */
export function countingTracker(): SuspenseTracker & {
  readonly up: number;
  readonly down: number;
} {
  const counts = { up: 0, down: 0 };
  return {
    increment(): void {
      counts.up += 1;
    },
    decrement(): void {
      counts.down += 1;
    },
    get up(): number {
      return counts.up;
    },
    get down(): number {
      return counts.down;
    },
  };
}
