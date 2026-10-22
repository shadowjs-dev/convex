import { getFunctionName } from "convex/server";
import { describe, expect, it } from "vitest";
import { type ConvexHttpCallerLike, fetchAction, fetchMutation, fetchQuery } from "../src/fetch";
import type { ActionRef, MutationRef, QueryRef } from "../src/types";
import { api } from "./support/refs";

/** One call the server helper made on its one-shot HTTP client. */
interface Call {
  readonly kind: "query" | "mutation" | "action" | "setAuth";
  readonly name?: string;
  readonly args?: unknown;
  readonly token?: string;
}

/**
 * A stand-in for `ConvexHttpClient`. It records every call and answers with `answer`. Each client
 * the factory builds gets its own record, so a test can check that no auth is shared.
 */
function recordingFactory(answer: (name: string) => unknown): {
  readonly create: (url: string) => ConvexHttpCallerLike;
  readonly clients: Array<{ readonly url: string; readonly calls: Call[] }>;
} {
  const clients: Array<{ readonly url: string; readonly calls: Call[] }> = [];
  return {
    clients,
    create(url: string): ConvexHttpCallerLike {
      const calls: Call[] = [];
      clients.push({ url, calls });
      return {
        setAuth(token: string): void {
          calls.push({ kind: "setAuth", token });
        },
        query(query: QueryRef, args: unknown): Promise<unknown> {
          calls.push({ kind: "query", name: getFunctionName(query), args });
          return Promise.resolve(answer(getFunctionName(query)));
        },
        mutation(mutation: MutationRef, args: unknown): Promise<unknown> {
          calls.push({ kind: "mutation", name: getFunctionName(mutation), args });
          return Promise.resolve(answer(getFunctionName(mutation)));
        },
        action(action: ActionRef, args: unknown): Promise<unknown> {
          calls.push({ kind: "action", name: getFunctionName(action), args });
          return Promise.resolve(answer(getFunctionName(action)));
        },
      };
    },
  };
}

describe("server helpers: fetchQuery, fetchMutation, fetchAction", () => {
  it("[SRV-1] fetchQuery calls the query with its arguments and returns the value", async () => {
    const factory = recordingFactory(() => [{ title: "ship" }]);
    const value = await fetchQuery(
      "https://happy-otter-123.convex.cloud",
      api.tasks.list,
      { done: false },
      {
        createClient: factory.create,
      },
    );
    expect(value).toEqual([{ title: "ship" }]);
    expect(factory.clients.map((client) => client.url)).toEqual([
      "https://happy-otter-123.convex.cloud",
    ]);
    expect(factory.clients[0]?.calls).toEqual([
      { kind: "query", name: "tasks:list", args: { done: false } },
    ]);
  });

  it("[SRV-2] a token is set on the client before the call; no token means no setAuth", async () => {
    const withToken = recordingFactory(() => null);
    await fetchQuery(
      "https://a.convex.cloud",
      api.tasks.list,
      {},
      {
        token: "jwt-1",
        createClient: withToken.create,
      },
    );
    expect(withToken.clients[0]?.calls.map((call) => call.kind)).toEqual(["setAuth", "query"]);
    expect(withToken.clients[0]?.calls[0]?.token).toBe("jwt-1");

    const anonymous = recordingFactory(() => null);
    await fetchQuery(
      "https://a.convex.cloud",
      api.tasks.list,
      {},
      {
        token: null,
        createClient: anonymous.create,
      },
    );
    expect(anonymous.clients[0]?.calls.map((call) => call.kind)).toEqual(["query"]);
  });

  it("[SRV-3] every call gets its own client, so two users' tokens never share auth state", async () => {
    const factory = recordingFactory(() => null);
    await Promise.all([
      fetchQuery(
        "https://a.convex.cloud",
        api.tasks.list,
        {},
        { token: "alice", createClient: factory.create },
      ),
      fetchQuery(
        "https://a.convex.cloud",
        api.tasks.list,
        {},
        { token: "bob", createClient: factory.create },
      ),
    ]);
    expect(factory.clients.length).toBe(2);
    expect(factory.clients.map((client) => client.calls[0]?.token)).toEqual(["alice", "bob"]);
  });

  it("[SRV-4] fetchMutation and fetchAction call their own kind of function", async () => {
    const factory = recordingFactory((name) => (name === "tasks:add" ? "id-1" : "sent"));
    await expect(
      fetchMutation(
        "https://a.convex.cloud",
        api.tasks.add,
        { title: "x" },
        { createClient: factory.create },
      ),
    ).resolves.toBe("id-1");
    await expect(
      fetchAction(
        "https://a.convex.cloud",
        api.emails.send,
        { to: "ada@example.com" },
        { createClient: factory.create },
      ),
    ).resolves.toBe("sent");
    expect(factory.clients.map((client) => client.calls.map((call) => call.kind))).toEqual([
      ["mutation"],
      ["action"],
    ]);
  });

  it("[SRV-5] a failing call rejects with the same error object", async () => {
    const failure = new Error("UNAUTHENTICATED");
    const create = (): ConvexHttpCallerLike => ({
      setAuth: () => undefined,
      query: () => Promise.reject(failure),
      mutation: () => Promise.reject(failure),
      action: () => Promise.reject(failure),
    });
    await expect(
      fetchQuery("https://a.convex.cloud", api.tasks.list, {}, { createClient: create }),
    ).rejects.toBe(failure);
  });

  it("[SRV-6] an empty deployment URL is rejected before any client is made", () => {
    const factory = recordingFactory(() => null);
    expect(() => fetchQuery("", api.tasks.list, {}, { createClient: factory.create })).toThrow(
      TypeError,
    );
    expect(factory.clients.length).toBe(0);
  });
});
