import { describe, expect, it } from "vitest";
import { createSuspenseHold } from "../src/internal/hold";
import { countingTracker } from "./support/root";

describe("createSuspenseHold", () => {
  it("[HOLD-1] without a tracker, acquire and release do nothing and never throw", () => {
    const hold = createSuspenseHold(null);
    hold.acquire();
    expect(hold.held).toBe(false);
    hold.release();
    expect(hold.held).toBe(false);
  });

  it("[HOLD-2] acquire increments the tracker once, however often it is called", () => {
    const tracker = countingTracker();
    const hold = createSuspenseHold(tracker);
    hold.acquire();
    hold.acquire();
    hold.acquire();
    expect(tracker.up).toBe(1);
    expect(hold.held).toBe(true);
  });

  it("[HOLD-3] release decrements exactly once; a second release is a no-op", () => {
    const tracker = countingTracker();
    const hold = createSuspenseHold(tracker);
    hold.acquire();
    hold.release();
    hold.release();
    expect(tracker.down).toBe(1);
    expect(hold.held).toBe(false);
  });

  it("[HOLD-4] release without acquire does not decrement", () => {
    const tracker = countingTracker();
    createSuspenseHold(tracker).release();
    expect(tracker.down).toBe(0);
  });

  it("[HOLD-5] a hold can be taken again after it was released", () => {
    const tracker = countingTracker();
    const hold = createSuspenseHold(tracker);
    hold.acquire();
    hold.release();
    hold.acquire();
    hold.release();
    expect([tracker.up, tracker.down]).toEqual([2, 2]);
  });
});
