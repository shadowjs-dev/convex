import { flushSync, useSignal } from "@shadow-js/core";
import { describe, expect, it } from "vitest";
import { type QueryArgsInput, type QueryResult, useQuery } from "../src/query";
import { FakeConvexClient } from "./support/fake-client";
import { api, type Task, task } from "./support/refs";
import { countingTracker, inSuspense, type Mounted, mountWith } from "./support/root";

/** Mounts a query under a provider and a Suspense boundary (`tracker`). */
function underSuspense(
  client: FakeConvexClient,
  tracker: ReturnType<typeof countingTracker>,
  args?: QueryArgsInput<typeof api.tasks.list>,
): Mounted<Mounted<QueryResult<Task[]>>> {
  return mountWith(client, () => inSuspense(tracker, () => useQuery(api.tasks.list, args)));
}

describe("useQuery inside <Suspense>: the first load holds the boundary", () => {
  it("[SUS-1] the first load increments the tracker exactly once", () => {
    const client = new FakeConvexClient();
    const tracker = countingTracker();
    underSuspense(client, tracker, {});
    expect(tracker.up).toBe(1);
    expect(tracker.down).toBe(0);
  });

  it("[SUS-2] the first result releases the boundary exactly once", () => {
    const client = new FakeConvexClient();
    const tracker = countingTracker();
    underSuspense(client, tracker, {});
    client.emit("tasks:list", [task("1")]);
    client.emit("tasks:list", [task("1"), task("2")]);
    expect([tracker.up, tracker.down]).toEqual([1, 1]);
  });

  it("[SUS-3] an error on the first load also releases the boundary once", () => {
    const client = new FakeConvexClient();
    const tracker = countingTracker();
    underSuspense(client, tracker, {});
    client.fail("tasks:list", new Error("nope"));
    client.fail("tasks:list", new Error("again"));
    expect([tracker.up, tracker.down]).toEqual([1, 1]);
  });

  it("[SUS-4] changing the arguments while the first load is pending does not hold again", () => {
    const client = new FakeConvexClient();
    const tracker = countingTracker();
    const [done, setDone] = useSignal(false);
    underSuspense(client, tracker, () => ({ done: done() }));
    setDone(true);
    flushSync();
    setDone(false);
    flushSync();
    expect(tracker.up).toBe(1);
    client.emit("tasks:list", []);
    expect([tracker.up, tracker.down]).toEqual([1, 1]);
  });

  it("[SUS-5] after a result, changing the arguments does not hold the boundary again", () => {
    const client = new FakeConvexClient();
    const tracker = countingTracker();
    const [done, setDone] = useSignal(false);
    underSuspense(client, tracker, () => ({ done: done() }));
    client.emit("tasks:list", []);
    setDone(true);
    flushSync();
    client.emit("tasks:list", [task("1", true)]);
    expect([tracker.up, tracker.down]).toEqual([1, 1]);
  });

  it("[SUS-6] skipping while holding releases the boundary; resuming holds it again until a result", () => {
    const client = new FakeConvexClient();
    const tracker = countingTracker();
    const [on, setOn] = useSignal(true);
    underSuspense(client, tracker, () => (on() ? {} : "skip"));
    expect(tracker.up).toBe(1);
    setOn(false);
    flushSync();
    expect([tracker.up, tracker.down]).toEqual([1, 1]);
    setOn(true);
    flushSync();
    expect([tracker.up, tracker.down]).toEqual([2, 1]);
    client.emit("tasks:list", []);
    expect([tracker.up, tracker.down]).toEqual([2, 2]);
  });

  it("[SUS-7] unmounting while the first load is pending releases the boundary once", () => {
    const client = new FakeConvexClient();
    const tracker = countingTracker();
    const view = underSuspense(client, tracker, {});
    view.value.dispose();
    expect([tracker.up, tracker.down]).toEqual([1, 1]);
    view.dispose();
    expect(tracker.down).toBe(1);
  });

  it("[SUS-8] a flurry of argument changes while pending leaves the counter balanced after the result", () => {
    const client = new FakeConvexClient();
    const tracker = countingTracker();
    const [id, setId] = useSignal(0);
    underSuspense(client, tracker, () => ({ done: id() % 2 === 0 }));
    for (let i = 1; i <= 10; i += 1) {
      setId(i);
      flushSync();
    }
    expect(tracker.up - tracker.down).toBe(1);
    client.emit("tasks:list", []);
    expect(tracker.up - tracker.down).toBe(0);
  });

  it("[SUS-9] with no Suspense boundary above, loading does not throw and no tracker exists", () => {
    const client = new FakeConvexClient();
    const view = mountWith(client, () => useQuery(api.tasks.list, {}));
    expect(view.value.status).toBe("loading");
    client.emit("tasks:list", [task("1")]);
    expect(view.value()).toEqual([task("1")]);
  });

  it("[SUS-10] two queries under one boundary each hold it once", () => {
    const client = new FakeConvexClient();
    const tracker = countingTracker();
    mountWith(client, () =>
      inSuspense(tracker, () => {
        useQuery(api.tasks.list, { done: false });
        useQuery(api.tasks.list, { done: true });
        return null;
      }),
    );
    expect(tracker.up).toBe(2);
    client.emit("tasks:list", []);
    expect([tracker.up, tracker.down]).toEqual([2, 2]);
  });

  it("[SUS-11] keepPreviousData does not hold the boundary once data exists", () => {
    const client = new FakeConvexClient();
    const tracker = countingTracker();
    const [id, setId] = useSignal("a");
    mountWith(client, () =>
      inSuspense(tracker, () =>
        useQuery(api.tasks.byId, () => ({ id: id() }), { keepPreviousData: true }),
      ),
    );
    client.emit("tasks:byId", task("a"));
    setId("b");
    flushSync();
    expect(tracker.up).toBe(1);
    expect(tracker.down).toBe(1);
  });

  it("[SUS-12] a skipped query never touches the boundary", () => {
    const client = new FakeConvexClient();
    const tracker = countingTracker();
    const view = underSuspense(client, tracker, "skip");
    expect(view.value.value.status).toBe("skipped");
    expect([tracker.up, tracker.down]).toEqual([0, 0]);
  });
});
