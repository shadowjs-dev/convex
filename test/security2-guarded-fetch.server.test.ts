import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuardedFetch } from "../src/internal/guarded-fetch";

/**
 * SEC2-CONVEX-4x: the fetch wrapper the HTTP caller uses. It is the one place that decides where a
 * request with an Authorization header may go, how long it may take and how much it may bring back.
 */

const BASE = "https://happy-otter-123.convex.cloud";
const LIMITS = { timeoutMs: 1000, maxResponseBytes: 64 } as const;

interface Call {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit | undefined;
}

function recordingFetch(respond: () => Response): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return respond();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SEC2-CONVEX guarded fetch", () => {
  it("SEC2-CONVEX-40 sends only to the configured origin and refuses any other before fetch runs", async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response("{}"));
    const guarded = createGuardedFetch(BASE, LIMITS, fetchImpl);
    const headers = { Authorization: "Bearer SECRET" };
    await guarded(`${BASE}/api/query`, { method: "POST", headers });
    for (const target of [
      "https://evil.example/api/query",
      "http://happy-otter-123.convex.cloud/api/query",
      "https://happy-otter-123.convex.cloud.evil.example/api/query",
      "https://happy-otter-123.convex.cloud:8443/api/query",
      "https://user@evil.example/api/query",
      "//evil.example/api/query",
      "not a url",
      new URL("https://evil.example/x"),
    ]) {
      const failure = await guarded(target, { method: "POST", headers }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure, String(target)).toBeInstanceOf(TypeError);
      expect(String((failure as Error).message)).not.toContain("SECRET");
    }
    expect(calls.length).toBe(1);
  });

  it("SEC2-CONVEX-41 never follows a redirect: the request is sent with redirect error", async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response("{}"));
    const guarded = createGuardedFetch(BASE, LIMITS, fetchImpl);
    await guarded(`${BASE}/api/query`, { method: "POST", redirect: "follow" });
    expect(calls[0]?.init?.redirect).toBe("error");
  });

  it("SEC2-CONVEX-42 the caller's own abort signal still cancels the request", async () => {
    const calls: Call[] = [];
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }) as typeof fetch;
    const guarded = createGuardedFetch(BASE, LIMITS, fetchImpl);
    const controller = new AbortController();
    const pending = guarded(`${BASE}/api/query`, { signal: controller.signal }).then(
      () => undefined,
      (error: unknown) => error,
    );
    controller.abort(new Error("caller gave up"));
    expect(((await pending) as Error).message).toBe("caller gave up");
  });

  it("SEC2-CONVEX-43 a stalled body is cut off by the timeout, not only a stalled request", async () => {
    vi.useFakeTimers();
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
    });
    const { fetchImpl } = recordingFetch(() => new Response(stalled, { status: 200 }));
    const guarded = createGuardedFetch(BASE, LIMITS, fetchImpl);
    const outcome = guarded(`${BASE}/api/query`).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(1000);
    const failure = await outcome;
    expect(failure).toBeInstanceOf(DOMException);
    expect((failure as DOMException).name).toBe("TimeoutError");
  });

  it("SEC2-CONVEX-44 the size bound is enforced on the declared length and on the counted bytes", async () => {
    const declared = createGuardedFetch(
      BASE,
      LIMITS,
      recordingFetch(
        () => new Response("x".repeat(10), { headers: { "content-length": "100000" } }),
      ).fetchImpl,
    );
    const first = await declared(`${BASE}/api/query`).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(first).toBeInstanceOf(RangeError);

    const counted = createGuardedFetch(
      BASE,
      LIMITS,
      recordingFetch(() => new Response("x".repeat(65))).fetchImpl,
    );
    const second = await counted(`${BASE}/api/query`).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(second).toBeInstanceOf(RangeError);

    const exact = createGuardedFetch(
      BASE,
      LIMITS,
      recordingFetch(() => new Response("x".repeat(64))).fetchImpl,
    );
    const response = await exact(`${BASE}/api/query`);
    expect((await response.text()).length).toBe(64);
  });

  it("SEC2-CONVEX-45 status, status text and content type survive; a Convex 560 stays readable", async () => {
    const guarded = createGuardedFetch(
      BASE,
      LIMITS,
      recordingFetch(
        () =>
          new Response('{"a":1}', {
            status: 560,
            statusText: "Function failed",
            headers: { "content-type": "application/json" },
          }),
      ).fetchImpl,
    );
    const response = await guarded(`${BASE}/api/query`);
    expect(response.status).toBe(560);
    expect(response.statusText).toBe("Function failed");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ a: 1 });
  });

  it("SEC2-CONVEX-46 an empty-body status (204) passes through", async () => {
    const guarded = createGuardedFetch(
      BASE,
      LIMITS,
      recordingFetch(() => new Response(null, { status: 204 })).fetchImpl,
    );
    const response = await guarded(`${BASE}/api/query`);
    expect(response.status).toBe(204);
  });
});
