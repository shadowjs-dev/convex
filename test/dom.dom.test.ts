import {
  flushSync,
  SuspenseContext,
  type SuspenseTracker,
  useRenderEffect,
  useSignal,
} from "@shadow-js/core";
import { captureWarnings } from "@shadow-js/testing";
import { createComponent, ErrorBoundary, hydrate, render, Suspense } from "@shadow-js/web";
import { describe, expect, it } from "vitest";
import { Authenticated, AuthLoading, ConvexProviderWithAuth, Unauthenticated } from "../src/auth";
import { ConvexProvider } from "../src/client";
import { type ActionHandle, type MutationHandle, useAction, useMutation } from "../src/mutation";
import { type PaginatedQueryResult, usePaginatedQuery } from "../src/paginated";
import { useQuery } from "../src/query";
import type { AuthHookState } from "../src/types";
import { load } from "./support/compile";
import { FakeConvexClient } from "./support/fake-client";
import { TASK_SUMMARY_GOLDEN } from "./support/golden";
import { api, type Message, msg, pageOf, task } from "./support/refs";
import { TASK_SUMMARY_SRC } from "./support/sources";

/** Renders `body` into a fresh element. `unmount` removes it and disposes everything. */
function mountInto(body: () => unknown): { host: HTMLElement; unmount: () => void } {
  const host = document.createElement("div");
  document.body.append(host);
  const dispose = render(body, host);
  return {
    host,
    unmount: () => {
      dispose();
      host.remove();
    },
  };
}

/** Lets promise continuations run, then flushes effects. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  flushSync();
}

/** Shows a query's status and length. The returned accessor is reactive in the DOM. */
function Summary(list: "all" | "open"): () => string {
  const tasks = useQuery(api.tasks.list, list === "open" ? { done: false } : {});
  return () => `${tasks.status}:${tasks()?.length ?? "-"}`;
}

describe("useQuery in the DOM", () => {
  it("[DOM-1] the result is rendered as text and follows each server push", () => {
    const client = new FakeConvexClient();
    const view = mountInto(() =>
      ConvexProvider({
        client,
        get children() {
          return Summary("open");
        },
      }),
    );
    expect(view.host.textContent).toBe("loading:-");
    client.emit("tasks:list", [task("1"), task("2")]);
    expect(view.host.textContent).toBe("success:2");
    client.emit("tasks:list", [task("1")]);
    expect(view.host.textContent).toBe("success:1");
    view.unmount();
  });

  it("[DOM-2] inside <Suspense>, the fallback shows until the first result", () => {
    const client = new FakeConvexClient();
    const view = mountInto(() =>
      ConvexProvider({
        client,
        get children() {
          return Suspense({
            fallback: "loading...",
            get children() {
              return Summary("all");
            },
          });
        },
      }),
    );
    expect(view.host.textContent).toBe("loading...");
    client.emit("tasks:list", []);
    expect(view.host.textContent).toBe("success:0");
    view.unmount();
  });

  it("[DOM-3] a subscription error reaches the nearest ErrorBoundary when the result is read", () => {
    const client = new FakeConvexClient();
    const view = mountInto(() =>
      ConvexProvider({
        client,
        get children() {
          return ErrorBoundary({
            fallback: (error: unknown) => `failed: ${error instanceof Error ? error.message : "?"}`,
            get children() {
              const tasks = useQuery(api.tasks.list, {}, { throwOnError: true });
              // The value is read under the boundary's scope, so a late error reaches it. The shown
              // text reads only the status, which never throws.
              useRenderEffect(
                () => tasks(),
                () => undefined,
              );
              return () => tasks.status;
            },
          });
        },
      }),
    );
    expect(view.host.textContent).toBe("loading");
    client.fail("tasks:list", new Error("permission denied"));
    expect(view.host.textContent).toBe("failed: permission denied");
    view.unmount();
  });

  it("[DOM-4] unmounting the tree stops the subscription", () => {
    const client = new FakeConvexClient();
    const view = mountInto(() =>
      ConvexProvider({
        client,
        get children() {
          return Summary("open");
        },
      }),
    );
    expect(client.liveCount).toBe(1);
    view.unmount();
    expect(client.liveCount).toBe(0);
  });

  it('[DOM-5] switching the arguments to "skip" and back is shown as text', () => {
    const client = new FakeConvexClient();
    const [enabled, setEnabled] = useSignal(true);
    const view = mountInto(() =>
      ConvexProvider({
        client,
        get children() {
          const tasks = useQuery(api.tasks.list, () => (enabled() ? {} : "skip"));
          return () => tasks.status;
        },
      }),
    );
    expect(view.host.textContent).toBe("loading");
    setEnabled(false);
    flushSync();
    expect(view.host.textContent).toBe("skipped");
    expect(client.liveCount).toBe(0);
    setEnabled(true);
    flushSync();
    expect(client.liveCount).toBe(1);
    view.unmount();
  });

  it("[DOM-6] keepPreviousData keeps the old rows on screen while new arguments load", () => {
    const client = new FakeConvexClient();
    const [done, setDone] = useSignal(false);
    const view = mountInto(() =>
      ConvexProvider({
        client,
        get children() {
          const tasks = useQuery(api.tasks.list, () => ({ done: done() }), {
            keepPreviousData: true,
          });
          return () => `${tasks()?.length ?? "-"}${tasks.isLoading ? "…" : ""}`;
        },
      }),
    );
    client.emit("tasks:list", [task("1")], { done: false });
    expect(view.host.textContent).toBe("1");
    setDone(true);
    flushSync();
    expect(view.host.textContent).toBe("1…");
    client.emit("tasks:list", [task("1", true), task("2", true)], { done: true });
    expect(view.host.textContent).toBe("2");
    view.unmount();
  });

  it("[DOM-7] without a ConvexProvider, rendering a query throws a message that names it", () => {
    expect(() => mountInto(() => Summary("open"))).toThrow(/ConvexProvider/);
  });
});

describe("mutations and actions in the DOM", () => {
  it("[DOM-8] the pending text follows a mutation through its call", async () => {
    const client = new FakeConvexClient();
    let add: MutationHandle<typeof api.tasks.add> | undefined;
    const view = mountInto(() =>
      ConvexProvider({
        client,
        get children() {
          add = useMutation(api.tasks.add);
          return () => (add?.pending() === true ? "saving" : "idle");
        },
      }),
    );
    expect(view.host.textContent).toBe("idle");
    const pending = add?.({ title: "x" });
    flushSync();
    expect(view.host.textContent).toBe("saving");
    client.mutations[0]?.resolve("id");
    await pending;
    await settle();
    expect(view.host.textContent).toBe("idle");
    view.unmount();
  });

  it("[DOM-9] an error from a mutation is shown after the pending state clears", async () => {
    const client = new FakeConvexClient();
    let remove: MutationHandle<typeof api.tasks.toggle> | undefined;
    const view = mountInto(() =>
      ConvexProvider({
        client,
        get children() {
          remove = useMutation(api.tasks.toggle);
          return () => {
            const failure = remove?.error();
            return failure instanceof Error ? `error: ${failure.message}` : "ok";
          };
        },
      }),
    );
    const call = remove?.({ id: "1" });
    client.mutations[0]?.reject(new Error("conflict"));
    await expect(call).rejects.toThrow("conflict");
    await settle();
    expect(view.host.textContent).toBe("error: conflict");
    view.unmount();
  });

  it("[DOM-10] an action's pending state is reactive", async () => {
    const client = new FakeConvexClient();
    let send: ActionHandle<typeof api.emails.send> | undefined;
    const view = mountInto(() =>
      ConvexProvider({
        client,
        get children() {
          send = useAction(api.emails.send);
          return () => (send?.pending() === true ? "sending" : "ready");
        },
      }),
    );
    const call = send?.({ to: "a@b.c" });
    flushSync();
    expect(view.host.textContent).toBe("sending");
    client.actions[0]?.resolve(true);
    await call;
    await settle();
    expect(view.host.textContent).toBe("ready");
    view.unmount();
  });
});

describe("paginated queries in the DOM", () => {
  it("[DOM-11] items grow as pages arrive, and the status text follows", () => {
    const client = new FakeConvexClient();
    let list: PaginatedQueryResult<Message> | undefined;
    const view = mountInto(() =>
      ConvexProvider({
        client,
        get children() {
          list = usePaginatedQuery(api.messages.page, { channel: "a" }, { initialNumItems: 2 });
          return () =>
            `${
              list
                ?.results()
                .map((item) => item.body)
                .join(",") ?? ""
            }|${list?.status() ?? ""}`;
        },
      }),
    );
    expect(view.host.textContent).toBe("|LoadingFirstPage");
    client.emit("messages:page", pageOf([msg("1"), msg("2")], "c1", false));
    expect(view.host.textContent).toBe("body 1,body 2|CanLoadMore");
    list?.loadMore(2);
    client.emit("messages:page", pageOf([msg("3")], "c2", true), {
      channel: "a",
      paginationOpts: { numItems: 2, cursor: "c1" },
    });
    expect(view.host.textContent).toBe("body 1,body 2,body 3|Exhausted");
    view.unmount();
  });
});

describe("ConvexProviderWithAuth in the DOM", () => {
  /** A provider the test drives; the fetcher identity is fixed per token. */
  function driveAuth(): {
    readonly useAuth: () => AuthHookState;
    set(next: { isLoading?: boolean; isAuthenticated?: boolean }): void;
  } {
    const [state, setState] = useSignal({ isLoading: true, isAuthenticated: false });
    const fetchAccessToken = (_args: { forceRefreshToken: boolean }): Promise<string | null> =>
      Promise.resolve("token");
    return {
      useAuth: () => {
        const current = state();
        return { ...current, fetchAccessToken };
      },
      set(next) {
        setState((previous) => ({ ...previous, ...next }));
        flushSync();
      },
    };
  }

  it("[DOM-12] the gates switch from loading to authenticated when the server confirms", () => {
    const client = new FakeConvexClient();
    const auth = driveAuth();
    const view = mountInto(() =>
      ConvexProviderWithAuth({
        client,
        useAuth: auth.useAuth,
        get children() {
          return [
            AuthLoading({ children: "checking" }),
            Authenticated({ children: "hello" }),
            Unauthenticated({ children: "sign in" }),
          ];
        },
      }),
    );
    expect(view.host.textContent).toBe("checking");
    auth.set({ isLoading: false, isAuthenticated: true });
    expect(view.host.textContent).toBe("checking");
    const registered = client.authCalls.find((call) => call.kind === "set");
    if (registered?.kind === "set") registered.onChange?.(true);
    flushSync();
    expect(view.host.textContent).toBe("hello");
    view.unmount();
  });

  it("[DOM-13] a signed-out user sees the Unauthenticated content", () => {
    const client = new FakeConvexClient();
    const auth = driveAuth();
    auth.set({ isLoading: false, isAuthenticated: false });
    const view = mountInto(() =>
      ConvexProviderWithAuth({
        client,
        useAuth: auth.useAuth,
        get children() {
          return [Authenticated({ children: "hello" }), Unauthenticated({ children: "sign in" })];
        },
      }),
    );
    expect(view.host.textContent).toBe("sign in");
    view.unmount();
  });
});

describe("hydration of server markup", () => {
  it("[DOM-14] hydrating the golden markup shows the server's value at once, then subscribes", async () => {
    const dom = await load<{ TaskSummary: (props: unknown) => unknown }>(TASK_SUMMARY_SRC, "dom");
    const client = new FakeConvexClient();
    const host = document.createElement("div");
    host.innerHTML = TASK_SUMMARY_GOLDEN.html;
    document.body.append(host);
    hydrate(
      () =>
        ConvexProvider({
          client,
          get children() {
            return createComponent(dom.TaskSummary, { list: api.tasks.list, args: {} });
          },
        }),
      host,
      { data: TASK_SUMMARY_GOLDEN.data },
    );
    expect(host.textContent).toBe("success:2");
    expect(client.created.length).toBe(1);
    expect(client.created[0]?.name).toBe("tasks:list");
    client.emit("tasks:list", [task("1"), task("2"), task("3")]);
    expect(host.textContent).toBe("success:3");
    host.remove();
  });

  it("[DOM-15] a seeded value does not hold a Suspense boundary during hydration", async () => {
    const dom = await load<{ TaskSummary: (props: unknown) => unknown }>(TASK_SUMMARY_SRC, "dom");
    const client = new FakeConvexClient();
    const tracker = { up: 0, down: 0 };
    const counting: SuspenseTracker = {
      increment: () => {
        tracker.up += 1;
      },
      decrement: () => {
        tracker.down += 1;
      },
    };
    const host = document.createElement("div");
    host.innerHTML = TASK_SUMMARY_GOLDEN.html;
    document.body.append(host);
    hydrate(
      () =>
        ConvexProvider({
          client,
          get children() {
            return SuspenseContext({
              value: counting,
              get children() {
                return createComponent(dom.TaskSummary, { list: api.tasks.list, args: {} });
              },
            });
          },
        }),
      host,
      { data: TASK_SUMMARY_GOLDEN.data },
    );
    expect(tracker).toEqual({ up: 0, down: 0 });
    expect(host.textContent).toBe("success:2");
    host.remove();
  });

  it("[DOM-16] without seeded data, hydration waits for the first live result", async () => {
    const dom = await load<{ TaskSummary: (props: unknown) => unknown }>(TASK_SUMMARY_SRC, "dom");
    const client = new FakeConvexClient();
    const host = document.createElement("div");
    host.innerHTML = TASK_SUMMARY_GOLDEN.html;
    document.body.append(host);
    // The server rendered the seeded value; the client, without it, first shows the loading state.
    const { messages } = captureWarnings(() =>
      hydrate(
        () =>
          ConvexProvider({
            client,
            get children() {
              return createComponent(dom.TaskSummary, { list: api.tasks.list, args: {} });
            },
          }),
        host,
      ),
    );
    expect(messages).toEqual([
      '[shadow HYDRATION_TEXT_MISMATCH] expected text "loading" but the server sent text "success"',
      '[shadow HYDRATION_TEXT_MISMATCH] expected text "none" but the server sent text "2"',
    ]);
    expect(host.textContent).toBe("loading:none");
    client.emit("tasks:list", [task("9")]);
    expect(host.textContent).toBe("success:1");
    host.remove();
  });
});
