import { type Accessor, flushSync, useRenderEffect, useSignal } from "@shadow-js/core";
import { describe, expect, it, vi } from "vitest";
import {
  Authenticated,
  AuthLoading,
  ConvexProviderWithAuth,
  Unauthenticated,
  useConvexAuth,
} from "../src/auth";
import { useQuery } from "../src/query";
import type { AuthHookState, ConvexAuthState, ConvexClientLike } from "../src/types";
import { type AuthCall, FakeConvexClient } from "./support/fake-client";
import { api, task } from "./support/refs";
import { mount } from "./support/root";

/** A provider whose state the test drives. Its fetcher identity changes only with `token`. */
interface ProviderState {
  readonly isLoading: boolean;
  readonly isAuthenticated: boolean;
  readonly token: string;
}

function fakeProvider(initial: ProviderState): {
  readonly useAuth: () => AuthHookState;
  set(next: Partial<ProviderState>): void;
  readonly fetchers: Map<string, (args: { forceRefreshToken: boolean }) => Promise<string | null>>;
} {
  const [state, setState] = useSignal(initial, { equals: false });
  const fetchers = new Map<
    string,
    (args: { forceRefreshToken: boolean }) => Promise<string | null>
  >();
  const fetcherFor = (
    token: string,
  ): ((args: { forceRefreshToken: boolean }) => Promise<string | null>) => {
    const known = fetchers.get(token);
    if (known !== undefined) return known;
    const made = (_args: { forceRefreshToken: boolean }) => Promise.resolve(token);
    fetchers.set(token, made);
    return made;
  };
  return {
    useAuth: () => {
      const current = state();
      return {
        isLoading: current.isLoading,
        isAuthenticated: current.isAuthenticated,
        fetchAccessToken: fetcherFor(current.token),
      };
    },
    set(next) {
      setState((previous) => ({ ...previous, ...next }));
      flushSync();
    },
    fetchers,
  };
}

/** Mounts `body` under `ConvexProviderWithAuth` for `client` and `provider`. */
function mountAuth<T>(
  client: ConvexClientLike,
  provider: ReturnType<typeof fakeProvider>,
  body: () => T,
): { value: T; dispose: () => void } {
  const slot: { value: T | undefined } = { value: undefined };
  const dispose = mount(() =>
    ConvexProviderWithAuth({
      client,
      useAuth: provider.useAuth,
      get children() {
        slot.value = body();
        return null;
      },
    }),
  ).dispose;
  if (slot.value === undefined) throw new Error("mountAuth(): the body did not run.");
  return { value: slot.value, dispose };
}

/** The `set` calls the client received, as their fetcher and callback. */
function setCalls(client: FakeConvexClient): Extract<AuthCall, { kind: "set" }>[] {
  return client.authCalls.filter(
    (call): call is Extract<AuthCall, { kind: "set" }> => call.kind === "set",
  );
}

/**
 * Records the changes of a reactive accessor. A render effect can re-run on a notification whose
 * value is unchanged, so repeated values are dropped.
 */
function watch<T>(accessor: Accessor<T>): T[] {
  const seen: T[] = [];
  useRenderEffect(accessor, (value) => {
    if (seen.length === 0 || seen[seen.length - 1] !== value) seen.push(value);
  });
  return seen;
}

describe("ConvexProviderWithAuth: state machine", () => {
  it("[AUTH-1] while the provider loads, the state is loading and nothing is registered", () => {
    const client = new FakeConvexClient();
    const provider = fakeProvider({ isLoading: true, isAuthenticated: false, token: "t1" });
    const { value: auth } = mountAuth(client, provider, () => useConvexAuth());
    expect(auth.isLoading()).toBe(true);
    expect(auth.isAuthenticated()).toBe(false);
    expect(client.authCalls).toEqual([]);
  });

  it("[AUTH-2] a signed-in provider registers its token, but stays loading until the server answers", () => {
    const client = new FakeConvexClient();
    const provider = fakeProvider({ isLoading: false, isAuthenticated: true, token: "t1" });
    const { value: auth } = mountAuth(client, provider, () => useConvexAuth());
    expect(setCalls(client).length).toBe(1);
    expect(auth.isLoading()).toBe(true);
    expect(auth.isAuthenticated()).toBe(false);
  });

  it("[AUTH-3] the server confirming the token makes the user authenticated", () => {
    const client = new FakeConvexClient();
    const provider = fakeProvider({ isLoading: false, isAuthenticated: true, token: "t1" });
    const { value: auth } = mountAuth(client, provider, () => useConvexAuth());
    setCalls(client)[0]?.onChange?.(true);
    expect(auth.isLoading()).toBe(false);
    expect(auth.isAuthenticated()).toBe(true);
  });

  it("[AUTH-4] the server rejecting the token leaves the user unauthenticated and not loading", () => {
    const client = new FakeConvexClient();
    const provider = fakeProvider({ isLoading: false, isAuthenticated: true, token: "t1" });
    const { value: auth } = mountAuth(client, provider, () => useConvexAuth());
    setCalls(client)[0]?.onChange?.(false);
    expect(auth.isLoading()).toBe(false);
    expect(auth.isAuthenticated()).toBe(false);
  });

  it("[AUTH-5] a provider that is signed out from the start never registers a token", () => {
    const client = new FakeConvexClient();
    const provider = fakeProvider({ isLoading: false, isAuthenticated: false, token: "t1" });
    const { value: auth } = mountAuth(client, provider, () => useConvexAuth());
    expect(setCalls(client).length).toBe(0);
    expect(auth.isLoading()).toBe(false);
    expect(auth.isAuthenticated()).toBe(false);
  });

  it("[AUTH-6] loading, then authenticated, then signed out: the observed states follow in order", () => {
    const client = new FakeConvexClient();
    const provider = fakeProvider({ isLoading: true, isAuthenticated: false, token: "t1" });
    let seen: string[] = [];
    mountAuth(client, provider, () => {
      const auth = useConvexAuth();
      seen = watch(() => `${auth.isLoading()}/${auth.isAuthenticated()}`);
      return auth;
    });
    provider.set({ isLoading: false, isAuthenticated: true });
    setCalls(client)[0]?.onChange?.(true);
    provider.set({ isLoading: false, isAuthenticated: false });
    expect(seen).toEqual(["true/false", "false/true", "false/false"]);
  });

  it("[AUTH-7] a new fetchAccessToken re-registers the token: clear, then set again, and loads until confirmed", () => {
    const client = new FakeConvexClient();
    const provider = fakeProvider({ isLoading: false, isAuthenticated: true, token: "t1" });
    const { value: auth } = mountAuth(client, provider, () => useConvexAuth());
    setCalls(client)[0]?.onChange?.(true);
    provider.set({ token: "t2" });
    expect(client.authCalls.map((call) => call.kind)).toEqual(["set", "clear", "set"]);
    expect(auth.isLoading()).toBe(true);
    setCalls(client)[1]?.onChange?.(true);
    expect(auth.isAuthenticated()).toBe(true);
  });

  it("[AUTH-8] registering the same provider state twice does not register again", () => {
    const client = new FakeConvexClient();
    const provider = fakeProvider({ isLoading: false, isAuthenticated: true, token: "t1" });
    mountAuth(client, provider, () => null);
    provider.set({ isLoading: false, isAuthenticated: true });
    expect(setCalls(client).length).toBe(1);
  });

  it("[AUTH-9] signing out clears the token through clearAuth when the client has it", () => {
    const client = new FakeConvexClient();
    const provider = fakeProvider({ isLoading: false, isAuthenticated: true, token: "t1" });
    mountAuth(client, provider, () => null);
    provider.set({ isLoading: false, isAuthenticated: false });
    expect(client.authCalls.map((call) => call.kind)).toEqual(["set", "clear"]);
  });

  it("[AUTH-9b] ConvexClient has no clearAuth: the base client's real clearAuth tells the server", () => {
    const client = new FakeConvexClient({ viaBase: true });
    const provider = fakeProvider({ isLoading: false, isAuthenticated: true, token: "t1" });
    mountAuth(client, provider, () => null);
    provider.set({ isLoading: false, isAuthenticated: false });
    // One registration, then the base client's clear: no second setAuth with a null fetcher.
    expect(client.authCalls.map((call) => call.kind)).toEqual(["set", "clear"]);
  });

  it("[AUTH-10] without clearAuth, signing out registers a fetcher that returns null", async () => {
    const client = new FakeConvexClient({ withClearAuth: false });
    const provider = fakeProvider({ isLoading: false, isAuthenticated: true, token: "t1" });
    mountAuth(client, provider, () => null);
    provider.set({ isLoading: false, isAuthenticated: false });
    const last = setCalls(client).at(-1);
    expect(last).toBeDefined();
    await expect(last?.fetchToken({ forceRefreshToken: false })).resolves.toBeNull();
  });

  it("[AUTH-11] a server answer that arrives after sign-out is ignored", () => {
    const client = new FakeConvexClient();
    const provider = fakeProvider({ isLoading: false, isAuthenticated: true, token: "t1" });
    const { value: auth } = mountAuth(client, provider, () => useConvexAuth());
    const late = setCalls(client)[0]?.onChange;
    provider.set({ isLoading: false, isAuthenticated: false });
    late?.(true);
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.isLoading()).toBe(false);
  });

  it("[AUTH-12] sign in, sign out and sign in again registers twice and ends authenticated", () => {
    const client = new FakeConvexClient();
    const provider = fakeProvider({ isLoading: false, isAuthenticated: true, token: "t1" });
    const { value: auth } = mountAuth(client, provider, () => useConvexAuth());
    setCalls(client)[0]?.onChange?.(true);
    provider.set({ isLoading: false, isAuthenticated: false });
    provider.set({ isLoading: false, isAuthenticated: true });
    expect(setCalls(client).length).toBe(2);
    setCalls(client)[1]?.onChange?.(true);
    expect(auth.isAuthenticated()).toBe(true);
  });

  it("[AUTH-13] the registered fetcher is the provider's own fetchAccessToken", () => {
    const client = new FakeConvexClient();
    const provider = fakeProvider({ isLoading: false, isAuthenticated: true, token: "t1" });
    mountAuth(client, provider, () => null);
    expect(setCalls(client)[0]?.fetchToken).toBe(provider.fetchers.get("t1"));
  });

  it("[AUTH-14] a provider that reloads (loading again) drops the registration and reports loading", () => {
    const client = new FakeConvexClient();
    const provider = fakeProvider({ isLoading: false, isAuthenticated: true, token: "t1" });
    const { value: auth } = mountAuth(client, provider, () => useConvexAuth());
    setCalls(client)[0]?.onChange?.(true);
    provider.set({ isLoading: true, isAuthenticated: false });
    expect(auth.isLoading()).toBe(true);
    expect(auth.isAuthenticated()).toBe(false);
    expect(client.authCalls.at(-1)?.kind).toBe("clear");
  });

  it("[AUTH-15] unmounting clears the token and ignores later server answers", () => {
    const client = new FakeConvexClient();
    const provider = fakeProvider({ isLoading: false, isAuthenticated: true, token: "t1" });
    const { dispose } = mountAuth(client, provider, () => null);
    const onChange = setCalls(client)[0]?.onChange;
    dispose();
    expect(client.authCalls.at(-1)?.kind).toBe("clear");
    expect(() => onChange?.(true)).not.toThrow();
  });

  it("[AUTH-16] isAuthenticated is reactive: an effect sees the server's confirmation", () => {
    const client = new FakeConvexClient();
    const provider = fakeProvider({ isLoading: false, isAuthenticated: true, token: "t1" });
    let seen: boolean[] = [];
    mountAuth(client, provider, () => {
      const auth = useConvexAuth();
      seen = watch(auth.isAuthenticated);
      return auth;
    });
    setCalls(client)[0]?.onChange?.(true);
    setCalls(client)[0]?.onChange?.(false);
    expect(seen).toEqual([false, true, false]);
  });

  it("[AUTH-17] a query inside the auth provider subscribes through the same client", () => {
    const client = new FakeConvexClient();
    const provider = fakeProvider({ isLoading: false, isAuthenticated: true, token: "t1" });
    mountAuth(client, provider, () => useQuery(api.tasks.list, {}));
    expect(client.created.length).toBe(1);
    client.emit("tasks:list", [task("1")]);
    expect(client.created[0]?.name).toBe("tasks:list");
  });

  it("[AUTH-18] useConvexAuth outside a ConvexProviderWithAuth throws a message that names it", () => {
    expect(() => mount(() => useConvexAuth())).toThrow(/ConvexProviderWithAuth/);
  });

  it("[AUTH-19] the provider's signed-in state gates the registration, not its loading flag", () => {
    const client = new FakeConvexClient();
    const provider = fakeProvider({ isLoading: true, isAuthenticated: true, token: "t1" });
    mountAuth(client, provider, () => null);
    expect(setCalls(client).length).toBe(1);
  });
});

describe("ConvexProviderWithAuth: prop changes and token refresh", () => {
  it("[AUTH-22] a reactive useAuth prop: switching the hook re-registers with the new provider", () => {
    const client = new FakeConvexClient();
    const first = fakeProvider({ isLoading: false, isAuthenticated: true, token: "first" });
    const second = fakeProvider({ isLoading: false, isAuthenticated: true, token: "second" });
    const [current, setCurrent] = useSignal(first);
    mount(() =>
      ConvexProviderWithAuth({
        client,
        get useAuth() {
          return current().useAuth;
        },
        children: null,
      }),
    );
    expect(setCalls(client).map((call) => call.fetchToken)).toEqual([first.fetchers.get("first")]);
    setCurrent(second);
    flushSync();
    expect(client.authCalls.map((call) => call.kind)).toEqual(["set", "clear", "set"]);
    expect(setCalls(client)[1]?.fetchToken).toBe(second.fetchers.get("second"));
  });

  it("[AUTH-23] the registered fetcher receives forceRefreshToken and returns the provider's token", async () => {
    const client = new FakeConvexClient();
    const provider = fakeProvider({ isLoading: false, isAuthenticated: true, token: "t1" });
    mountAuth(client, provider, () => null);
    const fetchToken = setCalls(client)[0]?.fetchToken;
    expect(fetchToken).toBeDefined();
    await expect(fetchToken?.({ forceRefreshToken: true })).resolves.toBe("t1");
  });
});

describe("ConvexProviderWithAuth: getter-based provider state", () => {
  it("[AUTH-24] a provider whose state is getters over its own signals (as Clerk exposes it) is tracked", () => {
    const client = new FakeConvexClient();
    const [session, setSession] = useSignal({ loaded: true, signedIn: true });
    const fetchAccessToken = (_args: { forceRefreshToken: boolean }): Promise<string | null> =>
      Promise.resolve("token");
    const useAuth = (): AuthHookState => ({
      get isLoading() {
        return !session().loaded;
      },
      get isAuthenticated() {
        return session().signedIn;
      },
      fetchAccessToken,
    });
    const { value: auth } = mount(() => {
      const slot: { value: ConvexAuthState | undefined } = { value: undefined };
      ConvexProviderWithAuth({
        client,
        useAuth,
        get children() {
          slot.value = useConvexAuth();
          return null;
        },
      });
      return slot.value;
    });
    if (auth === undefined) throw new Error("the auth state was not provided");
    setCalls(client)[0]?.onChange?.(true);
    expect(auth.isAuthenticated()).toBe(true);
    setSession({ loaded: false, signedIn: true });
    flushSync();
    expect(auth.isLoading()).toBe(true);
    expect(auth.isAuthenticated()).toBe(false);
    setSession({ loaded: true, signedIn: false });
    flushSync();
    expect(auth.isLoading()).toBe(false);
    expect(auth.isAuthenticated()).toBe(false);
  });
});

describe("Authenticated / Unauthenticated / AuthLoading", () => {
  it("[AUTH-20] each gate shows only in its own state, and switches as the state changes", () => {
    const client = new FakeConvexClient();
    const provider = fakeProvider({ isLoading: true, isAuthenticated: false, token: "t1" });
    const gates = mountAuth(client, provider, () => ({
      in: Authenticated({ children: "in" }),
      out: Unauthenticated({ children: "out" }),
      wait: AuthLoading({ children: "wait" }),
    }));
    const shown = () => [gates.value.in(), gates.value.out(), gates.value.wait()];
    expect(shown()).toEqual([null, null, "wait"]);
    provider.set({ isLoading: false, isAuthenticated: true });
    expect(shown()).toEqual([null, null, "wait"]);
    setCalls(client)[0]?.onChange?.(true);
    expect(shown()).toEqual(["in", null, null]);
    provider.set({ isLoading: false, isAuthenticated: false });
    expect(shown()).toEqual([null, "out", null]);
  });

  it("[AUTH-21] a rejected token shows Unauthenticated, not Authenticated", () => {
    const client = new FakeConvexClient();
    const provider = fakeProvider({ isLoading: false, isAuthenticated: true, token: "t1" });
    const gates = mountAuth(client, provider, () => ({
      in: Authenticated({ children: "in" }),
      out: Unauthenticated({ children: "out" }),
    }));
    setCalls(client)[0]?.onChange?.(false);
    expect([gates.value.in(), gates.value.out()]).toEqual([null, "out"]);
  });
});

describe("ConvexProviderWithAuth: transient token failures", () => {
  it("[AUTH-30] a token the server rejected is registered again after a delay while the provider stays signed in", () => {
    vi.useFakeTimers();
    try {
      const client = new FakeConvexClient();
      const provider = fakeProvider({ isLoading: false, isAuthenticated: true, token: "t1" });
      const { value: auth } = mountAuth(client, provider, () => useConvexAuth());
      setCalls(client)[0]?.onChange?.(false);
      expect(auth.isAuthenticated()).toBe(false);
      expect(setCalls(client).length).toBe(1);

      vi.advanceTimersByTime(1_000);
      expect(setCalls(client).length).toBe(2);
      expect(auth.isLoading()).toBe(true);

      setCalls(client)[1]?.onChange?.(true);
      expect(auth.isAuthenticated()).toBe(true);
      vi.advanceTimersByTime(120_000);
      expect(setCalls(client).length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("[AUTH-31] signing out while a retry is pending cancels the retry", () => {
    vi.useFakeTimers();
    try {
      const client = new FakeConvexClient();
      const provider = fakeProvider({ isLoading: false, isAuthenticated: true, token: "t1" });
      mountAuth(client, provider, () => null);
      setCalls(client)[0]?.onChange?.(false);
      provider.set({ isLoading: false, isAuthenticated: false });
      vi.advanceTimersByTime(120_000);
      expect(setCalls(client).length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
