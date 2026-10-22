import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fetchAction, fetchMutation, fetchQuery } from "../src/fetch";
import { api } from "./support/refs";

/**
 * SEC2-CONVEX-3x: the server helpers against real loopback HTTP servers (nothing leaves the
 * machine). A redirect must never carry the call to another origin, a response is bounded in size,
 * and a call that never answers is aborted.
 */

interface Hit {
  readonly url: string | undefined;
  readonly authorization: string | undefined;
  readonly body: string;
}

let origin: string;
let sinkOrigin: string;
let primary: Server;
let sink: Server;
let primaryHits: Hit[] = [];
let sinkHits: Hit[] = [];
let primaryHandler: (request: IncomingMessage, response: ServerResponse) => void;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

beforeAll(async () => {
  sink = createServer((request, response) => {
    void readBody(request).then((body) => {
      sinkHits.push({ url: request.url, authorization: request.headers.authorization, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "success", value: "leaked" }));
    });
  });
  sinkOrigin = await listen(sink);
  primary = createServer((request, response) => {
    void readBody(request).then((body) => {
      primaryHits.push({ url: request.url, authorization: request.headers.authorization, body });
      primaryHandler(request, response);
    });
  });
  origin = await listen(primary);
});

afterAll(async () => {
  sink.closeAllConnections();
  primary.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolve) => sink.close(() => resolve())),
    new Promise<void>((resolve) => primary.close(() => resolve())),
  ]);
});

afterEach(() => {
  primaryHits = [];
  sinkHits = [];
  vi.useRealTimers();
});

function ok(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: "success", value }));
}

/** The error a promise rejects with, or undefined. */
async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("SEC2-CONVEX server helper transport", () => {
  it("SEC2-CONVEX-30 sanity: a normal call reaches the server with the token in the header only", async () => {
    primaryHandler = (_request, response) => ok(response, ["a"]);
    await expect(
      fetchQuery(origin, api.tasks.list, {}, { token: "tok.en.value" }),
    ).resolves.toEqual(["a"]);
    expect(primaryHits.length).toBe(1);
    expect(primaryHits[0]?.authorization).toBe("Bearer tok.en.value");
    expect(primaryHits[0]?.url).toBe("/api/query");
  });

  it("SEC2-CONVEX-31 a 307 or 308 to another origin is not followed: the body and token never reach it", async () => {
    for (const status of [301, 302, 307, 308]) {
      primaryHits = [];
      sinkHits = [];
      primaryHandler = (_request, response) => {
        response.writeHead(status, { location: `${sinkOrigin}/api/query` });
        response.end();
      };
      const failure = await failureOf(
        fetchQuery(origin, api.tasks.list, { done: true }, { token: "tok.en.value" }),
      );
      expect(failure, `status ${status}`).toBeInstanceOf(Error);
      expect(sinkHits, `status ${status}`).toEqual([]);
      expect(primaryHits.length).toBe(1);
    }
  });

  it("SEC2-CONVEX-32 mutations and actions are not redirected either", async () => {
    primaryHandler = (_request, response) => {
      response.writeHead(307, { location: `${sinkOrigin}/api/mutation` });
      response.end();
    };
    const mutation = await failureOf(
      fetchMutation(origin, api.tasks.add, { title: "t" }, { token: "tok.en.value" }),
    );
    const action = await failureOf(
      fetchAction(origin, api.emails.send, { to: "a" }, { token: "tok.en.value" }),
    );
    expect(mutation).toBeInstanceOf(Error);
    expect(action).toBeInstanceOf(Error);
    expect(sinkHits).toEqual([]);
  });

  it("SEC2-CONVEX-33 a response over maxResponseBytes is refused, with or without a content-length", async () => {
    primaryHandler = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "success", value: "x".repeat(4096) }));
    };
    const declared = await failureOf(
      fetchQuery(origin, api.tasks.list, {}, { maxResponseBytes: 1024 }),
    );
    expect(declared).toBeInstanceOf(RangeError);

    primaryHandler = (_request, response) => {
      // Chunked: no content-length, so only counting the bytes can stop it.
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"status":"success","value":"');
      for (let index = 0; index < 8; index += 1) response.write("y".repeat(512));
      response.end('"}');
    };
    const chunked = await failureOf(
      fetchQuery(origin, api.tasks.list, {}, { maxResponseBytes: 1024 }),
    );
    expect(chunked).toBeInstanceOf(RangeError);
    expect(String((chunked as Error).message)).not.toContain("yyyy");
  });

  it("SEC2-CONVEX-34 a response under the bound still works", async () => {
    primaryHandler = (_request, response) => ok(response, "small");
    await expect(fetchQuery(origin, api.tasks.list, {}, { maxResponseBytes: 4096 })).resolves.toBe(
      "small",
    );
  });

  it("SEC2-CONVEX-35 timeoutMs aborts a call whose request never answers", async () => {
    vi.useFakeTimers();
    const realFetch = globalThis.fetch;
    let received: AbortSignal | null | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      received = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }) as typeof fetch;
    try {
      const pending = failureOf(fetchQuery(origin, api.tasks.list, {}, { timeoutMs: 50 }));
      await vi.advanceTimersByTimeAsync(49);
      expect(received?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const failure = await pending;
      expect(received?.aborted).toBe(true);
      expect(failure).toBeInstanceOf(DOMException);
      expect((failure as DOMException).name).toBe("TimeoutError");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("SEC2-CONVEX-36 a default timeout exists even when the caller sets none", async () => {
    vi.useFakeTimers();
    const realFetch = globalThis.fetch;
    let received: AbortSignal | null | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      received = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }) as typeof fetch;
    try {
      const pending = failureOf(fetchQuery(origin, api.tasks.list, {}));
      expect(received).toBeInstanceOf(AbortSignal);
      // A query has a 30 s default; an action a longer one (see SEC2-CONVEX-37).
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await pending).toBeInstanceOf(DOMException);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("SEC2-CONVEX-37 an action gets a longer default than a query (Convex actions run for minutes)", async () => {
    vi.useFakeTimers();
    const realFetch = globalThis.fetch;
    let received: AbortSignal | null | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      received = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }) as typeof fetch;
    try {
      const pending = failureOf(fetchAction(origin, api.emails.send, { to: "a" }, {}));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(received?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(await pending).toBeInstanceOf(DOMException);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
