import { flushSync, useRenderEffect, useSignal } from "@shadow-js/core";
import { describe, expect, it } from "vitest";
import { useQuery } from "../src/query";
import { FakeConvexClient } from "./support/fake-client";
import { api, task } from "./support/refs";
import { mount, mountWith } from "./support/root";

describe("useQuery: subscription lifecycle", () => {
  it("[QRY-1] subscribes once, with the function name and the arguments", () => {
    const client = new FakeConvexClient();
    mountWith(client, () => useQuery(api.tasks.list, { done: false }));
    expect(client.created.length).toBe(1);
    expect(client.created[0]?.name).toBe("tasks:list");
    expect(client.created[0]?.args).toEqual({ done: false });
  });

  it("[QRY-2] starts loading with no data", () => {
    const client = new FakeConvexClient();
    const { value: tasks } = mountWith(client, () => useQuery(api.tasks.list, {}));
    expect(tasks.status).toBe("loading");
    expect(tasks.isLoading).toBe(true);
    expect(tasks()).toBeUndefined();
    expect(tasks.error).toBeUndefined();
  });

  it("[QRY-3] a delivered result becomes the data and ends loading", () => {
    const client = new FakeConvexClient();
    const { value: tasks } = mountWith(client, () => useQuery(api.tasks.list, {}));
    const rows = [task("1"), task("2", true)];
    client.emit("tasks:list", rows);
    expect(tasks()).toEqual(rows);
    expect(tasks.status).toBe("success");
    expect(tasks.isLoading).toBe(false);
  });

  it("[QRY-4] a subscription error sets status error and the error property, and clears the data", () => {
    const client = new FakeConvexClient();
    const { value: tasks } = mountWith(client, () => useQuery(api.tasks.list, {}));
    client.emit("tasks:list", [task("1")]);
    const failure = new Error("denied");
    client.fail("tasks:list", failure);
    expect(tasks.status).toBe("error");
    expect(tasks.error).toBe(failure);
    expect(tasks()).toBeUndefined();
  });

  it("[QRY-5] with throwOnError, reading the result throws the error", () => {
    const client = new FakeConvexClient();
    const failure = new Error("boom");
    const { value: tasks } = mountWith(client, () =>
      useQuery(api.tasks.list, {}, { throwOnError: true }),
    );
    client.fail("tasks:list", failure);
    expect(() => tasks()).toThrow(failure);
    expect(tasks.error).toBe(failure);
  });

  it("[QRY-6] without throwOnError, reading after an error returns undefined and does not throw", () => {
    const client = new FakeConvexClient();
    const { value: tasks } = mountWith(client, () => useQuery(api.tasks.list, {}));
    client.fail("tasks:list", new Error("boom"));
    expect(tasks()).toBeUndefined();
  });

  it("[QRY-7] a result after an error clears the error", () => {
    const client = new FakeConvexClient();
    const { value: tasks } = mountWith(client, () => useQuery(api.tasks.list, {}));
    client.fail("tasks:list", new Error("boom"));
    client.emit("tasks:list", [task("1")]);
    expect(tasks.error).toBeUndefined();
    expect(tasks.status).toBe("success");
  });

  it("[QRY-8] the reactive status getter follows each transition in order", () => {
    const client = new FakeConvexClient();
    const seen: string[] = [];
    mountWith(client, () => {
      const tasks = useQuery(api.tasks.list, {});
      useRenderEffect(
        () => tasks.status,
        (status) => {
          seen.push(status);
        },
      );
      return tasks;
    });
    client.emit("tasks:list", []);
    client.fail("tasks:list", new Error("x"));
    expect(seen).toEqual(["loading", "success", "error"]);
  });

  it("[QRY-9] the accessor is reactive: a render effect reading it re-runs on each result", () => {
    const client = new FakeConvexClient();
    const seen: Array<number | undefined> = [];
    mountWith(client, () => {
      const tasks = useQuery(api.tasks.list, {});
      useRenderEffect(
        () => tasks()?.length,
        (count) => {
          seen.push(count);
        },
      );
      return tasks;
    });
    client.emit("tasks:list", [task("1")]);
    client.emit("tasks:list", [task("1"), task("2")]);
    expect(seen).toEqual([undefined, 1, 2]);
  });

  it("[QRY-10] unmounting unsubscribes: no live subscriptions remain", () => {
    const client = new FakeConvexClient();
    const { dispose } = mountWith(client, () => useQuery(api.tasks.list, {}));
    expect(client.liveCount).toBe(1);
    dispose();
    expect(client.liveCount).toBe(0);
  });

  it("[QRY-11] a result delivered after unmount is ignored", () => {
    const client = new FakeConvexClient();
    const { value: tasks, dispose } = mountWith(client, () => useQuery(api.tasks.list, {}));
    client.emit("tasks:list", [task("1")]);
    dispose();
    client.created[0]?.deliver([task("late")]);
    expect(tasks()).toEqual([task("1")]);
  });

  it("[QRY-12] an error delivered after unmount is ignored: no throw, no state change", () => {
    const client = new FakeConvexClient();
    const { value: tasks, dispose } = mountWith(client, () =>
      useQuery(api.tasks.list, {}, { throwOnError: true }),
    );
    dispose();
    client.created[0]?.fail(new Error("late"));
    expect(tasks.status).toBe("loading");
    expect(() => tasks()).not.toThrow();
  });

  it("[QRY-13] a query without arguments subscribes with an empty object", () => {
    const client = new FakeConvexClient();
    mountWith(client, () => useQuery(api.tasks.count));
    expect(client.created[0]?.args).toEqual({});
  });

  it("[QRY-14] two hooks on the same query keep independent subscriptions and both update", () => {
    const client = new FakeConvexClient();
    const first = mountWith(client, () => useQuery(api.tasks.list, { done: true }));
    const second = mountWith(client, () => useQuery(api.tasks.list, { done: true }));
    client.emit("tasks:list", [task("1", true)]);
    expect(first.value()).toEqual([task("1", true)]);
    expect(second.value()).toEqual([task("1", true)]);
    expect(client.liveCount).toBe(2);
  });

  it("[QRY-15] a result for another query does not reach this hook", () => {
    const client = new FakeConvexClient();
    const { value: tasks } = mountWith(client, () => useQuery(api.tasks.list, {}));
    client.emit("tasks:count", 9);
    expect(tasks.status).toBe("loading");
  });
});

describe("useQuery: arguments and skip", () => {
  it('[QRY-17] the literal "skip" subscribes to nothing and reports skipped', () => {
    const client = new FakeConvexClient();
    const { value: tasks } = mountWith(client, () => useQuery(api.tasks.list, "skip"));
    expect(client.created.length).toBe(0);
    expect(tasks.status).toBe("skipped");
    expect(tasks.isLoading).toBe(false);
    expect(tasks()).toBeUndefined();
  });

  it('[QRY-18] an accessor that switches to "skip" stops the subscription', () => {
    const client = new FakeConvexClient();
    const [enabled, setEnabled] = useSignal(true);
    const { value: tasks } = mountWith(client, () =>
      useQuery(api.tasks.list, () => (enabled() ? {} : "skip")),
    );
    expect(client.liveCount).toBe(1);
    setEnabled(false);
    flushSync();
    expect(client.liveCount).toBe(0);
    expect(tasks.status).toBe("skipped");
  });

  it('[QRY-19] switching back from "skip" subscribes again', () => {
    const client = new FakeConvexClient();
    const [enabled, setEnabled] = useSignal(false);
    mountWith(client, () => useQuery(api.tasks.list, () => (enabled() ? {} : "skip")));
    expect(client.created.length).toBe(0);
    setEnabled(true);
    flushSync();
    expect(client.created.length).toBe(1);
    expect(client.liveCount).toBe(1);
  });

  it("[QRY-20] changing the arguments stops the old subscription and opens a new one", () => {
    const client = new FakeConvexClient();
    const [id, setId] = useSignal("a");
    mountWith(client, () => useQuery(api.tasks.byId, () => ({ id: id() })));
    const first = client.created[0];
    setId("b");
    flushSync();
    expect(first?.active).toBe(false);
    expect(client.created.length).toBe(2);
    expect(client.created[1]?.args).toEqual({ id: "b" });
    expect(client.liveCount).toBe(1);
  });

  it("[QRY-21] an accessor returning equal content does not resubscribe", () => {
    const client = new FakeConvexClient();
    const [tick, setTick] = useSignal(0);
    mountWith(client, () => useQuery(api.tasks.list, () => ({ done: false, t: tick() * 0 })));
    setTick(1);
    flushSync();
    setTick(2);
    flushSync();
    expect(client.created.length).toBe(1);
  });

  it("[QRY-22] arguments with the same content in another key order do not resubscribe", () => {
    const client = new FakeConvexClient();
    const [flip, setFlip] = useSignal(false);
    mountWith(client, () =>
      useQuery(api.tasks.list, () => (flip() ? { done: true, t: 1 } : { t: 1, done: true })),
    );
    setFlip(true);
    flushSync();
    expect(client.created.length).toBe(1);
  });

  it("[QRY-23] rapid argument changes leave exactly one live subscription", () => {
    const client = new FakeConvexClient();
    const [id, setId] = useSignal("0");
    mountWith(client, () => useQuery(api.tasks.byId, () => ({ id: id() })));
    for (let i = 1; i <= 20; i += 1) {
      setId(String(i));
      flushSync();
    }
    expect(client.created.length).toBe(21);
    expect(client.liveCount).toBe(1);
    expect(client.subscriptionsFor("tasks:byId", { id: "20" }).length).toBe(1);
  });

  it("[QRY-24] a stale subscription's result is ignored after the arguments changed", () => {
    const client = new FakeConvexClient();
    const [id, setId] = useSignal("a");
    const { value: task1 } = mountWith(client, () =>
      useQuery(api.tasks.byId, () => ({ id: id() })),
    );
    const stale = client.created[0];
    setId("b");
    flushSync();
    stale?.deliver(task("from-a"));
    expect(task1()).toBeUndefined();
    expect(task1.status).toBe("loading");
  });

  it("[QRY-25] a stale subscription's error is ignored after the arguments changed", () => {
    const client = new FakeConvexClient();
    const [id, setId] = useSignal("a");
    const { value: row } = mountWith(client, () =>
      useQuery(api.tasks.byId, () => ({ id: id() }), { throwOnError: true }),
    );
    const stale = client.created[0];
    setId("b");
    flushSync();
    stale?.fail(new Error("old"));
    expect(row.status).toBe("loading");
    expect(() => row()).not.toThrow();
  });

  it("[QRY-26] keepPreviousData keeps the data while new arguments load", () => {
    const client = new FakeConvexClient();
    const [id, setId] = useSignal("a");
    const { value: row } = mountWith(client, () =>
      useQuery(api.tasks.byId, () => ({ id: id() }), { keepPreviousData: true }),
    );
    client.emit("tasks:byId", task("a"), { id: "a" });
    setId("b");
    flushSync();
    expect(row()).toEqual(task("a"));
    expect(row.isLoading).toBe(true);
    client.emit("tasks:byId", task("b"), { id: "b" });
    expect(row()).toEqual(task("b"));
    expect(row.isLoading).toBe(false);
  });

  it("[QRY-27] without keepPreviousData, the data is cleared when the arguments change", () => {
    const client = new FakeConvexClient();
    const [id, setId] = useSignal("a");
    const { value: row } = mountWith(client, () => useQuery(api.tasks.byId, () => ({ id: id() })));
    client.emit("tasks:byId", task("a"), { id: "a" });
    setId("b");
    flushSync();
    expect(row()).toBeUndefined();
  });

  it("[QRY-28] an error on new arguments clears the previous data even with keepPreviousData", () => {
    const client = new FakeConvexClient();
    const [id, setId] = useSignal("a");
    const { value: row } = mountWith(client, () =>
      useQuery(api.tasks.byId, () => ({ id: id() }), { keepPreviousData: true }),
    );
    client.emit("tasks:byId", task("a"), { id: "a" });
    setId("b");
    flushSync();
    client.fail("tasks:byId", new Error("nope"), { id: "b" });
    expect(row()).toBeUndefined();
    expect(row.status).toBe("error");
  });

  it("[QRY-29] twenty toggles between two arguments never leak a subscription", () => {
    const client = new FakeConvexClient();
    const [flip, setFlip] = useSignal(false);
    mountWith(client, () =>
      useQuery(api.tasks.list, () => (flip() ? { done: true } : { done: false })),
    );
    for (let i = 0; i < 20; i += 1) {
      setFlip(!flip());
      flushSync();
    }
    expect(client.created.length).toBe(21);
    expect(client.liveCount).toBe(1);
  });

  it("[QRY-30] an accessor that reads no signals runs once, however often the scope flushes", () => {
    const client = new FakeConvexClient();
    let calls = 0;
    mountWith(client, () =>
      useQuery(api.tasks.list, () => {
        calls += 1;
        return { done: false };
      }),
    );
    for (let i = 0; i < 5; i += 1) flushSync();
    expect(calls).toBe(1);
    expect(client.created.length).toBe(1);
  });

  it("[QRY-31] arguments that are not an object are rejected when the hook is created", () => {
    const client = new FakeConvexClient();
    expect(() => mountWith(client, () => useQuery(api.tasks.list, ["x"] as never))).toThrow(
      TypeError,
    );
    expect(client.created.length).toBe(0);
  });

  it("[QRY-32] a function returning a non-object is rejected", () => {
    const client = new FakeConvexClient();
    expect(() => mountWith(client, () => useQuery(api.tasks.list, (() => 5) as never))).toThrow(
      TypeError,
    );
  });
});

describe("useQuery: providers", () => {
  it("[QRY-33] without a ConvexProvider, creating the hook throws a message that names the provider", () => {
    expect(() => mount(() => useQuery(api.tasks.list, {}))).toThrow(/ConvexProvider/);
  });

  it("[QRY-34] the nearest provider wins: an inner provider's client receives the subscription", () => {
    const outer = new FakeConvexClient();
    const inner = new FakeConvexClient();
    mountWith(outer, () => {
      mountWith(inner, () => useQuery(api.tasks.list, {}));
      return null;
    });
    expect(outer.created.length).toBe(0);
    expect(inner.created.length).toBe(1);
  });
});
