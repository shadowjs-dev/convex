import { createRoot } from "@shadow-js/core";
import { afterEach, describe, expect, it } from "vitest";
import { ConvexProvider, type ConvexProviderProps, usePendingMutations } from "../src/client";
import { useMutation } from "../src/mutation";
import { FakeConvexClient } from "./support/fake-client";
import { api } from "./support/refs";

/**
 * Mounts a provider (with or without the unload guard setting) and runs `body` under it. Returns
 * the value `body` produced and the function that disposes the provider.
 */
function mountProvider<T>(
  client: FakeConvexClient,
  unloadGuard: boolean | undefined,
  body: () => T,
): { readonly value: T; readonly dispose: () => void } {
  const slot: { value: T | undefined } = { value: undefined };
  const dispose = createRoot((disposeRoot) => {
    // Spreads come before the getter: spreading a getter would run the body too early.
    const props: ConvexProviderProps = {
      client,
      ...(unloadGuard === undefined ? {} : { unloadGuard }),
      get children() {
        slot.value = body();
        return null;
      },
    };
    ConvexProvider(props);
    return disposeRoot;
  });
  if (slot.value === undefined) throw new Error("mountProvider(): the body did not run.");
  return { value: slot.value, dispose };
}

/** Fires `beforeunload` and reports whether a listener asked to stop the unload. */
function unloadIsPrevented(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

describe("pending mutations: count signal", () => {
  it("[PEND-1] usePendingMutations counts in-flight mutations across every handle of the provider", async () => {
    const client = new FakeConvexClient();
    const { value, dispose } = mountProvider(client, undefined, () => ({
      count: usePendingMutations(),
      add: useMutation(api.tasks.add),
      toggle: useMutation(api.tasks.toggle),
    }));
    disposers.push(dispose);
    expect(value.count()).toBe(0);
    const first = value.add({ title: "a" });
    const second = value.toggle({ id: "b" });
    expect(value.count()).toBe(2);
    client.mutations[0]?.resolve("id");
    await first;
    expect(value.count()).toBe(1);
    client.mutations[1]?.resolve(null);
    await second;
    expect(value.count()).toBe(0);
  });

  it("[PEND-2] a mutation is sent exactly once: the wrapper never re-sends a pending call", async () => {
    const client = new FakeConvexClient();
    const { value, dispose } = mountProvider(client, undefined, () => useMutation(api.tasks.add));
    disposers.push(dispose);
    const pending = value({ title: "slow" });
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
    expect(client.mutations.length).toBe(1);
    client.mutations[0]?.resolve("ok");
    await expect(pending).resolves.toBe("ok");
  });

  it("[PEND-3] usePendingMutations outside a provider throws a message that names the provider", () => {
    expect(() =>
      createRoot((disposeRoot) => {
        usePendingMutations();
        return disposeRoot;
      }),
    ).toThrow(/ConvexProvider/);
  });
});

describe("pending mutations: beforeunload guard", () => {
  it("[PEND-4] unload is prevented while a mutation is pending and allowed again once it settles", async () => {
    const client = new FakeConvexClient();
    const { value, dispose } = mountProvider(client, undefined, () => useMutation(api.tasks.add));
    disposers.push(dispose);
    expect(unloadIsPrevented()).toBe(false);
    const pending = value({ title: "x" });
    expect(unloadIsPrevented()).toBe(true);
    client.mutations[0]?.resolve("ok");
    await pending;
    expect(unloadIsPrevented()).toBe(false);
  });

  it("[PEND-5] unloadGuard={false} is the opt-out: no listener is installed while a mutation is pending", async () => {
    const client = new FakeConvexClient();
    const { value, dispose } = mountProvider(client, false, () => useMutation(api.tasks.add));
    disposers.push(dispose);
    const pending = value({ title: "x" });
    expect(unloadIsPrevented()).toBe(false);
    client.mutations[0]?.resolve("ok");
    await pending;
  });

  it("[PEND-6] disposing the provider removes the listener, even while a mutation is pending", () => {
    const client = new FakeConvexClient();
    const { value, dispose } = mountProvider(client, undefined, () => useMutation(api.tasks.add));
    void value({ title: "x" });
    expect(unloadIsPrevented()).toBe(true);
    dispose();
    expect(unloadIsPrevented()).toBe(false);
  });
});
