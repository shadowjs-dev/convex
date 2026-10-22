import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConvexClient } from "../src/client";
import { createHttpCaller, fetchAction, fetchMutation, fetchQuery } from "../src/fetch";
import { api } from "./support/refs";

/**
 * SEC2-CONVEX-2x: where a bearer token can leak to: the URL, logs, error messages and cause chains,
 * serialized client objects, and a later call on a shared client. The token below is a marker, not
 * a real credential: tests look for it in every place a leak could show up.
 */

const URL_BASE = "https://happy-otter-123.convex.cloud";
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.SECRETPAYLOAD.SECRETSIGNATURE";

interface Seen {
  readonly url: string;
  readonly headers: Record<string, string>;
}

let seen: Seen[];
let realFetch: typeof fetch;
let consoleLines: string[];

/** Everything an error exposes: message, own properties, and the cause chain. */
function exposed(error: unknown): string {
  return `${inspect(error, { depth: 10, showHidden: true })}\n${String(error)}`;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify({ status: "success", value }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  seen = [];
  consoleLines = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    seen.push({ url: input instanceof Request ? input.url : String(input), headers });
    return jsonResponse("ok");
  }) as typeof fetch;
  // The shared setup already spies warn and error and fails the test on any output; these capture
  // the same calls (and log, info, debug) so the tests can look for the token in them.
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map((arg) => inspect(arg, { depth: 6 })).join(" "));
    });
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("SEC2-CONVEX token handling", () => {
  it("SEC2-CONVEX-20 the token travels only in the Authorization header, to the configured origin", async () => {
    await fetchQuery(URL_BASE, api.tasks.list, {}, { token: TOKEN });
    await fetchMutation(URL_BASE, api.tasks.add, { title: "t" }, { token: TOKEN });
    await fetchAction(URL_BASE, api.emails.send, { to: "a" }, { token: TOKEN });
    expect(seen.length).toBe(3);
    for (const call of seen) {
      expect(new URL(call.url).origin).toBe(URL_BASE);
      expect(call.url).not.toContain("SECRET");
      expect(call.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    }
    expect(consoleLines.join("\n")).not.toContain("SECRET");
  });

  it("SEC2-CONVEX-21 a token with a newline is refused before fetch, and the error never contains it", () => {
    for (const bad of [`${TOKEN}\n`, `${TOKEN}\r\nX-Evil: 1`, `${TOKEN} extra`, `${TOKEN}Ā`]) {
      let thrown: unknown;
      try {
        void fetchQuery(URL_BASE, api.tasks.list, {}, { token: bad });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, JSON.stringify(bad)).toBeInstanceOf(TypeError);
      expect(exposed(thrown)).not.toContain("SECRET");
    }
    expect(seen).toEqual([]);
  });

  it("SEC2-CONVEX-22 a token that is not a string is refused instead of silently making an anonymous call", () => {
    expect(() =>
      fetchQuery(URL_BASE, api.tasks.list, {}, { token: { jwt: TOKEN } as never }),
    ).toThrow(TypeError);
    expect(seen).toEqual([]);
  });

  it("SEC2-CONVEX-23 a shared caller is cleared when the next call has no token", async () => {
    let current: string | undefined;
    const used: Array<string | undefined> = [];
    const shared = {
      setAuth: (value: string) => {
        current = value;
      },
      clearAuth: () => {
        current = undefined;
      },
      query: async () => {
        used.push(current);
        return null;
      },
      mutation: async () => null,
      action: async () => null,
    };
    const createClient = () => shared;
    await fetchQuery(URL_BASE, api.tasks.list, {}, { token: TOKEN, createClient });
    await fetchQuery(URL_BASE, api.tasks.list, {}, { token: null, createClient });
    await fetchQuery(URL_BASE, api.tasks.list, {}, { createClient });
    expect(used).toEqual([TOKEN, undefined, undefined]);
  });

  it("SEC2-CONVEX-24 the default caller keeps the token out of JSON, String and inspect", () => {
    const caller = createHttpCaller(URL_BASE);
    caller.setAuth(TOKEN);
    expect(JSON.stringify(caller)).not.toContain("SECRET");
    expect(String(caller)).not.toContain("SECRET");
    expect(inspect(caller, { depth: 10, showHidden: true })).not.toContain("SECRET");
    expect(Object.getOwnPropertyNames(caller).sort()).toEqual(
      ["action", "clearAuth", "mutation", "query", "setAuth"].sort(),
    );
  });

  it("SEC2-CONVEX-25 a failing request does not put the token into the error, its cause chain or the console", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    }) as typeof fetch;
    const failure = await fetchQuery(URL_BASE, api.tasks.list, {}, { token: TOKEN }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(exposed(failure)).not.toContain("SECRET");

    globalThis.fetch = (async () => new Response("denied", { status: 401 })) as typeof fetch;
    const rejected = await fetchQuery(URL_BASE, api.tasks.list, {}, { token: TOKEN }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(exposed(rejected)).not.toContain("SECRET");
    expect(consoleLines.join("\n")).not.toContain("SECRET");
  });

  it("SEC2-CONVEX-26 the browser client object has no token field before or after sign-in", () => {
    const client = createConvexClient(URL_BASE, { disabled: true });
    client.setAuth(async () => TOKEN);
    expect(JSON.stringify(client)).not.toContain("SECRET");
    expect(inspect(client, { depth: 4 })).not.toContain("SECRET");
  });
});
