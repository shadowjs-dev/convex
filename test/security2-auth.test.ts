import { inspect } from "node:util";
import { flushSync, useSignal } from "@shadow-js/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexProviderWithAuth, useConvexAuth } from "../src/auth";
import type { AuthHookState } from "../src/types";
import { FakeConvexClient } from "./support/fake-client";
import { mount } from "./support/root";

/**
 * SEC2-CONVEX-27..28: the auth provider. It must pass the token fetcher to the client and nothing
 * else: no call of its own, no log, and a clear between two identities. This file is not a
 * `.server` test because render effects do not run on the server.
 */

const TOKEN = "eyJhbGciOiJSUzI1NiJ9.SECRETPAYLOAD.SECRETSIGNATURE";

let consoleLines: string[];

beforeEach(() => {
  consoleLines = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map((arg) => inspect(arg, { depth: 6 })).join(" "));
    });
  }
});

/** A provider state the test drives: the fetcher's identity is the "user". */
function driver(initial: AuthHookState): {
  readonly useAuth: () => AuthHookState;
  set(next: AuthHookState): void;
} {
  const [state, setState] = useSignal(initial, { equals: false });
  return {
    useAuth: () => state(),
    set(next) {
      setState(next);
      flushSync();
    },
  };
}

function mountAuth(client: FakeConvexClient, provider: { readonly useAuth: () => AuthHookState }) {
  return mount(() =>
    ConvexProviderWithAuth({
      client,
      useAuth: provider.useAuth,
      get children() {
        return useConvexAuth();
      },
    }),
  );
}

describe("SEC2-CONVEX auth provider", () => {
  it("SEC2-CONVEX-27 the provider hands the fetcher to the client and never calls it, logs it or stores the token", () => {
    let fetched = 0;
    const fetchAccessToken = async (): Promise<string | null> => {
      fetched += 1;
      return TOKEN;
    };
    const client = new FakeConvexClient();
    const provider = driver({ isLoading: false, isAuthenticated: true, fetchAccessToken });
    const mounted = mountAuth(client, provider);
    expect(client.authCalls.map((call) => call.kind)).toEqual(["set"]);
    // Only the client calls the fetcher, when it needs a token: the provider itself never does.
    expect(fetched).toBe(0);
    expect(inspect(mounted.value, { depth: 6 })).not.toContain("SECRET");
    expect(consoleLines).toEqual([]);
    mounted.dispose();
    expect(client.authCalls.map((call) => call.kind)).toEqual(["set", "clear"]);
  });

  it("SEC2-CONVEX-28 a change of user clears the client before the next fetcher is registered, and sign-out clears it", () => {
    const userA = async (): Promise<string | null> => TOKEN;
    const userB = async (): Promise<string | null> => "other-user-token";
    const client = new FakeConvexClient();
    const provider = driver({ isLoading: false, isAuthenticated: true, fetchAccessToken: userA });
    mountAuth(client, provider);
    provider.set({ isLoading: false, isAuthenticated: true, fetchAccessToken: userB });
    expect(client.authCalls.map((call) => call.kind)).toEqual(["set", "clear", "set"]);
    const registered = client.authCalls.filter((call) => call.kind === "set");
    expect(registered.map((call) => (call.kind === "set" ? call.fetchToken : undefined))).toEqual([
      userA,
      userB,
    ]);
    provider.set({ isLoading: false, isAuthenticated: false, fetchAccessToken: userB });
    expect(client.authCalls.map((call) => call.kind)).toEqual(["set", "clear", "set", "clear"]);
  });
});
