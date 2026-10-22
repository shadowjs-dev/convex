import { describe, expect, it, vi } from "vitest";
import { useMutation } from "../src/mutation";
import { FakeConvexClient } from "./support/fake-client";
import { api } from "./support/refs";
import { mountWith } from "./support/root";

interface Task {
  readonly _id: string;
  readonly _creationTime?: number;
  readonly title: string;
  readonly done: boolean;
}

/**
 * The part of Convex's `OptimisticLocalStore` the tests need: one loaded `tasks:list` result, and a
 * record of every `setQuery`. The fake client does not run optimistic updates, so each test runs
 * the update itself, the way the real client does when the mutation is sent.
 */
function localStore(initial: Task[]): {
  readonly store: never;
  readonly writes: Array<{ args: unknown; value: unknown }>;
} {
  const writes: Array<{ args: unknown; value: unknown }> = [];
  const store = {
    getQuery: () => initial,
    getAllQueries: () => [{ args: {}, value: initial }],
    setQuery: (_query: unknown, args: unknown, value: unknown) => {
      writes.push({ args, value });
    },
  };
  return { store: store as never, writes };
}

/** The warnings the dev checks printed, cleared so the test asserts them and nothing leaks. */
function takeWarnings(): string[] {
  const calls = vi.mocked(console.warn).mock.calls.map((args) => args.map(String).join(" "));
  vi.mocked(console.warn).mockClear();
  return calls;
}

const seed: Task[] = [{ _id: "t1", title: "ship", done: false }];

describe("optimistic updates: dev checks", () => {
  it("[DEV-OPT-1] a query result handed to an optimistic update is read-only: mutating it throws and warns", () => {
    const client = new FakeConvexClient();
    const { value: add } = mountWith(client, () =>
      useMutation(api.tasks.add, {
        optimisticUpdate: (store, args) => {
          const tasks = store.getQuery(api.tasks.list, {});
          tasks?.push({ _id: "new", title: args.title, done: false });
        },
      }),
    );
    void add({ title: "x" });
    const { store } = localStore(seed);
    const update = client.mutations[0]?.options?.optimisticUpdate;
    expect(update).toBeDefined();
    expect(() => update?.(store, { title: "x" })).toThrow(TypeError);
    const warnings = takeWarnings();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/optimistic update threw/);
    expect(warnings[0]).toMatch(/copy the value first/);
  });

  it("[DEV-OPT-2] an update that copies the result and writes a new array raises no warning", () => {
    const client = new FakeConvexClient();
    const { value: add } = mountWith(client, () =>
      useMutation(api.tasks.add, {
        optimisticUpdate: (store, args) => {
          const tasks = store.getQuery(api.tasks.list, {}) ?? [];
          store.setQuery(api.tasks.list, {}, [
            ...tasks,
            { _id: "new", title: args.title, done: false },
          ]);
        },
      }),
    );
    void add({ title: "x" });
    const { store, writes } = localStore(seed);
    client.mutations[0]?.options?.optimisticUpdate?.(store, { title: "x" });
    expect(writes.length).toBe(1);
    expect(takeWarnings()).toEqual([]);
  });

  it("[DEV-OPT-3] when the settled server value differs from the optimistic value, the dev check warns", async () => {
    const client = new FakeConvexClient();
    const { value: add } = mountWith(client, () =>
      useMutation(api.tasks.add, {
        optimisticUpdate: (store, args) => {
          const tasks = store.getQuery(api.tasks.list, {}) ?? [];
          store.setQuery(api.tasks.list, {}, [
            ...tasks,
            { _id: "local", title: args.title, done: false },
          ]);
        },
      }),
    );
    const pending = add({ title: "x" });
    const { store } = localStore(seed);
    client.mutations[0]?.options?.optimisticUpdate?.(store, { title: "x" });
    client.mutations[0]?.resolve("server-id");
    await pending;
    // The check reads the settled server value: here the server stored the row with another title.
    client.emit(api.tasks.list, [{ _id: "server", title: "renamed", done: false }], {});
    const warnings = takeWarnings();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/differs from the server result/);
  });

  it("[DEV-OPT-4] a settled value equal to the optimistic one raises no warning and stops the check's subscription", async () => {
    const client = new FakeConvexClient();
    const { value: add } = mountWith(client, () =>
      useMutation(api.tasks.add, {
        optimisticUpdate: (store, args) => {
          const tasks = store.getQuery(api.tasks.list, {}) ?? [];
          store.setQuery(api.tasks.list, {}, [
            ...tasks,
            { _id: "server", title: args.title, done: false },
          ]);
        },
      }),
    );
    const pending = add({ title: "x" });
    const { store } = localStore(seed);
    client.mutations[0]?.options?.optimisticUpdate?.(store, { title: "x" });
    client.mutations[0]?.resolve("server");
    await pending;
    expect(client.liveCount).toBe(1);
    client.emit(api.tasks.list, [...seed, { _id: "server", title: "x", done: false }], {});
    expect(takeWarnings()).toEqual([]);
    expect(client.liveCount).toBe(0);
  });

  it("[DEV-OPT-5] a mutation whose update wrote nothing starts no check subscription", async () => {
    const client = new FakeConvexClient();
    const { value: add } = mountWith(client, () =>
      useMutation(api.tasks.add, { optimisticUpdate: () => undefined }),
    );
    const pending = add({ title: "x" });
    client.mutations[0]?.options?.optimisticUpdate?.(localStore(seed).store, { title: "x" });
    client.mutations[0]?.resolve("server");
    await pending;
    expect(client.created.length).toBe(0);
    expect(takeWarnings()).toEqual([]);
  });

  it("[DEV-OPT-6] a temporary _id that the server replaces with its own does not warn; any other field does", async () => {
    const client = new FakeConvexClient();
    const { value: add } = mountWith(client, () =>
      useMutation(api.tasks.add, {
        optimisticUpdate: (store, args) => {
          const tasks = store.getQuery(api.tasks.list, {}) ?? [];
          store.setQuery(api.tasks.list, {}, [
            ...tasks,
            { _id: "pending", _creationTime: 0, title: args.title, done: false },
          ]);
        },
      }),
    );
    const pending = add({ title: "x" });
    client.mutations[0]?.options?.optimisticUpdate?.(localStore(seed).store, { title: "x" });
    client.mutations[0]?.resolve("server-id");
    await pending;
    client.emit(
      api.tasks.list,
      [...seed, { _id: "server-id", _creationTime: 1767950000000, title: "x", done: false }],
      {},
    );
    expect(takeWarnings()).toEqual([]);
  });

  it("[DEV-OPT-7] an update that runs again is judged by its latest run only", async () => {
    const client = new FakeConvexClient();
    const { value: add } = mountWith(client, () =>
      useMutation(api.tasks.add, {
        optimisticUpdate: (store, args) => {
          const tasks = store.getQuery(api.tasks.list, {}) ?? [];
          // Idempotent: once the server has the row, the update writes nothing new.
          if (tasks.some((task) => task.title === args.title)) return;
          store.setQuery(api.tasks.list, {}, [
            ...tasks,
            { _id: "pending", _creationTime: 0, title: args.title, done: false },
          ]);
        },
      }),
    );
    const pending = add({ title: "x" });
    const update = client.mutations[0]?.options?.optimisticUpdate;
    // The first run saw the list before the server had the row; the second run saw it after.
    update?.(localStore([]).store, { title: "x" });
    update?.(localStore([{ _id: "server", title: "x", done: false }]).store, { title: "x" });
    client.mutations[0]?.resolve("server");
    await pending;
    client.emit(api.tasks.list, [{ _id: "server", title: "x", done: false }], {});
    expect(takeWarnings()).toEqual([]);
  });
});
