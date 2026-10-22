import { useRenderEffect } from "@shadow-js/core";
import { describe, expect, it } from "vitest";
import { useAction, useMutation } from "../src/mutation";
import { FakeConvexClient } from "./support/fake-client";
import { api } from "./support/refs";
import { mount, mountWith } from "./support/root";

/** A stand-in for an optimistic update; the tests check it is passed through unchanged. */
const optimistic = (): void => undefined;

/**
 * An update that records the arguments it receives, and a store that answers nothing. The
 * development checks wrap the update, so the tests run what the client was given, the way Convex
 * does when it sends the call, and check what the user's update saw.
 */
function recordingUpdate(): {
  readonly update: (store: unknown, args: unknown) => void;
  readonly seen: unknown[];
} {
  const seen: unknown[] = [];
  return { update: (_store, args) => void seen.push(args), seen };
}
const emptyStore = {
  getQuery: () => undefined,
  getAllQueries: () => [],
  setQuery: () => undefined,
};

/** Runs the optimistic update the client received for call `index`, as Convex does. */
function runOptimisticUpdate(
  client: FakeConvexClient,
  index: number,
  args: { title: string },
): void {
  client.mutations[index]?.options?.optimisticUpdate?.(emptyStore as never, args);
}

/** Lets pending promise continuations run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("useMutation: calls and state", () => {
  it("[MUT-1] a call sends the mutation name and arguments to the client", async () => {
    const client = new FakeConvexClient();
    const { value: add } = mountWith(client, () => useMutation(api.tasks.add));
    const pending = add({ title: "ship" });
    expect(client.mutations.map((call) => [call.name, call.args])).toEqual([
      ["tasks:add", { title: "ship" }],
    ]);
    client.mutations[0]?.resolve("id-1");
    await expect(pending).resolves.toBe("id-1");
  });

  it("[MUT-2] pending is true while the call is in flight and false once it resolves", async () => {
    const client = new FakeConvexClient();
    const { value: add } = mountWith(client, () => useMutation(api.tasks.add));
    expect(add.pending()).toBe(false);
    const pending = add({ title: "x" });
    expect(add.pending()).toBe(true);
    client.mutations[0]?.resolve("ok");
    await pending;
    expect(add.pending()).toBe(false);
  });

  it("[MUT-3] pending stays true until the last of several concurrent calls settles", async () => {
    const client = new FakeConvexClient();
    const { value: toggle } = mountWith(client, () => useMutation(api.tasks.toggle));
    const first = toggle({ id: "a" });
    const second = toggle({ id: "b" });
    const third = toggle({ id: "c" });
    client.mutations[1]?.resolve(null);
    await second;
    expect(toggle.pending()).toBe(true);
    client.mutations[0]?.resolve(null);
    await first;
    expect(toggle.pending()).toBe(true);
    client.mutations[2]?.resolve(null);
    await third;
    expect(toggle.pending()).toBe(false);
  });

  it("[MUT-4] a rejected call sets error() and rethrows the same error to the caller", async () => {
    const client = new FakeConvexClient();
    const { value: add } = mountWith(client, () => useMutation(api.tasks.add));
    const failure = new Error("quota");
    const pending = add({ title: "x" });
    client.mutations[0]?.reject(failure);
    await expect(pending).rejects.toBe(failure);
    expect(add.error()).toBe(failure);
    expect(add.pending()).toBe(false);
  });

  it("[MUT-5] a new call clears the previous error", async () => {
    const client = new FakeConvexClient();
    const { value: add } = mountWith(client, () => useMutation(api.tasks.add));
    const first = add({ title: "x" });
    client.mutations[0]?.reject(new Error("first"));
    await expect(first).rejects.toThrow("first");
    const second = add({ title: "y" });
    expect(add.error()).toBeUndefined();
    client.mutations[1]?.resolve("ok");
    await second;
    expect(add.error()).toBeUndefined();
  });

  it("[MUT-6] reset() clears the error and leaves calls in flight alone", async () => {
    const client = new FakeConvexClient();
    const { value: add } = mountWith(client, () => useMutation(api.tasks.add));
    const failed = add({ title: "x" });
    client.mutations[0]?.reject(new Error("bad"));
    await expect(failed).rejects.toThrow("bad");
    const inflight = add({ title: "y" });
    add.reset();
    expect(add.error()).toBeUndefined();
    expect(add.pending()).toBe(true);
    client.mutations[1]?.resolve("ok");
    await inflight;
  });

  it("[MUT-7] a failure of an older call after a newer call started is still recorded", async () => {
    const client = new FakeConvexClient();
    const { value: toggle } = mountWith(client, () => useMutation(api.tasks.toggle));
    const older = toggle({ id: "a" });
    const newer = toggle({ id: "b" });
    client.mutations[0]?.reject(new Error("older failed"));
    await expect(older).rejects.toThrow("older failed");
    expect(toggle.error()).toEqual(new Error("older failed"));
    client.mutations[1]?.resolve(null);
    await newer;
    expect(toggle.pending()).toBe(false);
  });

  it("[MUT-8] the counter returns to zero after mixed successes and failures", async () => {
    const client = new FakeConvexClient();
    const { value: toggle } = mountWith(client, () => useMutation(api.tasks.toggle));
    const calls = [
      toggle({ id: "1" }),
      toggle({ id: "2" }),
      toggle({ id: "3" }),
      toggle({ id: "4" }),
    ];
    client.mutations[0]?.resolve(null);
    client.mutations[1]?.reject(new Error("x"));
    client.mutations[2]?.resolve(null);
    client.mutations[3]?.reject(new Error("y"));
    await Promise.allSettled(calls);
    expect(toggle.pending()).toBe(false);
  });

  it("[MUT-9] a client that throws synchronously still settles the call and rethrows", async () => {
    const client = new FakeConvexClient();
    client.mutation = () => {
      throw new Error("sync");
    };
    const { value: add } = mountWith(client, () => useMutation(api.tasks.add));
    await expect(add({ title: "x" })).rejects.toThrow("sync");
    expect(add.pending()).toBe(false);
    expect(add.error()).toEqual(new Error("sync"));
  });

  it("[MUT-10] pending is reactive: a render effect reading it sees true then false", async () => {
    const client = new FakeConvexClient();
    const seen: boolean[] = [];
    const view = mountWith(client, () => {
      const add = useMutation(api.tasks.add);
      useRenderEffect(
        () => add.pending(),
        (value) => {
          seen.push(value);
        },
      );
      return add;
    });
    const pending = view.value({ title: "x" });
    client.mutations[0]?.resolve("ok");
    await pending;
    await settle();
    expect(seen).toEqual([false, true, false]);
  });

  it("[MUT-11] calling a mutation without a ConvexProvider throws a message that names it", () => {
    expect(() => mount(() => useMutation(api.tasks.add))).toThrow(/ConvexProvider/);
  });

  it("[MUT-12] a mutation without arguments is called with an empty object", () => {
    const client = new FakeConvexClient();
    const { value: clear } = mountWith(client, () => useMutation(api.tasks.clear));
    void clear();
    expect(client.mutations[0]?.args).toEqual({});
    expect(client.mutations[0]?.options).toBeUndefined();
  });
});

describe("useMutation: optimistic updates", () => {
  it("[MUT-13] an optimisticUpdate option is passed to every call", () => {
    const client = new FakeConvexClient();
    const recorder = recordingUpdate();
    const { value: add } = mountWith(client, () =>
      useMutation(api.tasks.add, { optimisticUpdate: recorder.update as never }),
    );
    void add({ title: "x" });
    runOptimisticUpdate(client, 0, { title: "x" });
    expect(recorder.seen).toEqual([{ title: "x" }]);
  });

  it("[MUT-14] withOptimisticUpdate returns a variant that passes the update only to its own calls", () => {
    const client = new FakeConvexClient();
    const recorder = recordingUpdate();
    const { value: add } = mountWith(client, () => useMutation(api.tasks.add));
    const withUpdate = add.withOptimisticUpdate(recorder.update as never);
    void add({ title: "plain" });
    void withUpdate({ title: "optimistic" });
    expect(client.mutations[0]?.options).toBeUndefined();
    runOptimisticUpdate(client, 1, { title: "optimistic" });
    expect(recorder.seen).toEqual([{ title: "optimistic" }]);
  });

  it("[MUT-15] the variant shares pending and error state with the original handle", async () => {
    const client = new FakeConvexClient();
    const { value: add } = mountWith(client, () => useMutation(api.tasks.add));
    const withUpdate = add.withOptimisticUpdate(optimistic);
    const pending = withUpdate({ title: "x" });
    expect(add.pending()).toBe(true);
    client.mutations[0]?.reject(new Error("nope"));
    await expect(pending).rejects.toThrow("nope");
    expect(add.error()).toEqual(new Error("nope"));
  });

  it("[MUT-16] withOptimisticUpdate chains: the last update wins for its own calls", () => {
    const client = new FakeConvexClient();
    const first = recordingUpdate();
    const last = recordingUpdate();
    const { value: add } = mountWith(client, () => useMutation(api.tasks.add));
    void add.withOptimisticUpdate(first.update as never).withOptimisticUpdate(last.update as never)(
      { title: "x" },
    );
    runOptimisticUpdate(client, 0, { title: "x" });
    expect(first.seen).toEqual([]);
    expect(last.seen).toEqual([{ title: "x" }]);
  });

  it("[MUT-17] an optimistic variant's calls resolve to the server result", async () => {
    const client = new FakeConvexClient();
    const { value: add } = mountWith(client, () => useMutation(api.tasks.add));
    const pending = add.withOptimisticUpdate(optimistic)({ title: "x" });
    client.mutations[0]?.resolve("server-id");
    await expect(pending).resolves.toBe("server-id");
  });
});

describe("useAction", () => {
  it("[ACT-1] an action call sends the name and arguments to client.action", async () => {
    const client = new FakeConvexClient();
    const { value: send } = mountWith(client, () => useAction(api.emails.send));
    const pending = send({ to: "ada@example.com" });
    expect(client.actions.map((call) => [call.name, call.args])).toEqual([
      ["emails:send", { to: "ada@example.com" }],
    ]);
    expect(send.pending()).toBe(true);
    client.actions[0]?.resolve(true);
    await expect(pending).resolves.toBe(true);
    expect(send.pending()).toBe(false);
  });

  it("[ACT-2] a failing action sets error() and rethrows; reset() clears it", async () => {
    const client = new FakeConvexClient();
    const { value: send } = mountWith(client, () => useAction(api.emails.send));
    const pending = send({ to: "x" });
    client.actions[0]?.reject(new Error("smtp down"));
    await expect(pending).rejects.toThrow("smtp down");
    expect(send.error()).toEqual(new Error("smtp down"));
    send.reset();
    expect(send.error()).toBeUndefined();
  });

  it("[ACT-3] concurrent actions keep the pending counter right", async () => {
    const client = new FakeConvexClient();
    const { value: send } = mountWith(client, () => useAction(api.emails.send));
    const a = send({ to: "a" });
    const b = send({ to: "b" });
    client.actions[1]?.resolve(true);
    await b;
    expect(send.pending()).toBe(true);
    client.actions[0]?.resolve(false);
    await a;
    expect(send.pending()).toBe(false);
  });

  it("[ACT-4] an action without a ConvexProvider throws a message that names it", () => {
    expect(() => mount(() => useAction(api.emails.send))).toThrow(/ConvexProvider/);
  });
});
