import { describe, expect, it } from "vitest";
import { createConvexClient } from "../src/client";
import { fetchAction, fetchMutation, fetchQuery } from "../src/fetch";

/**
 * SEC-R10: the server helpers send the Clerk token to the deployment in the same request, so a
 * plain `http:` deployment URL would carry it in clear text. Only https is accepted, and http only
 * for a loopback host (the local backend that `npx convex dev` runs).
 */

interface Recorded {
  readonly urls: string[];
  readonly tokens: Array<string | undefined>;
}

function recordingCaller(recorded: Recorded) {
  return (url: string) => {
    recorded.urls.push(url);
    let token: string | undefined;
    return {
      setAuth: (value: string) => {
        token = value;
        recorded.tokens.push(token);
      },
      query: async () => "ok",
      mutation: async () => "ok",
      action: async () => "ok",
    };
  };
}

const refs = { query: {} as never, mutation: {} as never, action: {} as never };

describe("SEC-R10 Convex deployment URL", () => {
  it("SEC-R10-01 accepts an https deployment URL and builds a client for it", async () => {
    const recorded: Recorded = { urls: [], tokens: [] };
    const createClient = recordingCaller(recorded);
    const url = "https://happy-otter-123.convex.cloud";
    await expect(fetchQuery(url, refs.query, {} as never, { createClient })).resolves.toBe("ok");
    await expect(fetchMutation(url, refs.mutation, {} as never, { createClient })).resolves.toBe(
      "ok",
    );
    await expect(fetchAction(url, refs.action, {} as never, { createClient })).resolves.toBe("ok");
    expect(recorded.urls).toEqual([url, url, url]);
  });

  it("SEC-R10-02 refuses a plain http deployment URL before any client is built", () => {
    const recorded: Recorded = { urls: [], tokens: [] };
    const createClient = recordingCaller(recorded);
    for (const url of [
      "http://happy-otter-123.convex.cloud",
      "HTTP://happy-otter-123.convex.cloud",
      "http://203.0.113.7:3210",
    ]) {
      expect(() => fetchQuery(url, refs.query, {} as never, { token: "t", createClient })).toThrow(
        /must use https/,
      );
    }
    expect(recorded.urls).toEqual([]);
    expect(recorded.tokens).toEqual([]);
  });

  it("SEC-R10-03 accepts http only for loopback hosts (localhost, *.localhost, 127.0.0.1, [::1])", () => {
    const recorded: Recorded = { urls: [], tokens: [] };
    const createClient = recordingCaller(recorded);
    const loopback = [
      "http://localhost:3210",
      "http://backend.localhost:3210",
      "http://127.0.0.1:3210",
      "http://[::1]:3210",
    ];
    for (const url of loopback) {
      expect(() => fetchQuery(url, refs.query, {} as never, { createClient })).not.toThrow();
    }
    expect(recorded.urls).toEqual(loopback);
  });

  it("SEC-R10-04 refuses look-alike hosts, other schemes, and text that is not a URL", () => {
    const createClient = recordingCaller({ urls: [], tokens: [] });
    for (const url of [
      "http://localhost.example.com",
      "http://127.0.0.1.example.com",
      "http://example.com/localhost",
      "ws://happy-otter-123.convex.cloud",
      "ftp://happy-otter-123.convex.cloud",
      "not a url",
      "https://",
    ]) {
      expect(() => fetchQuery(url, refs.query, {} as never, { createClient }), url).toThrow(
        TypeError,
      );
    }
  });

  it("SEC-R10-05 keeps the empty-URL refusal with its own message", () => {
    expect(() => fetchQuery("", refs.query, {} as never)).toThrow(
      "The Convex deployment URL must be a non-empty string.",
    );
  });

  it("SEC-R10-06 the browser client refuses a plain http deployment URL before it connects", () => {
    expect(() => createConvexClient("http://happy-otter-123.convex.cloud")).toThrow(TypeError);
    expect(() => createConvexClient("")).toThrow(TypeError);
  });
});
