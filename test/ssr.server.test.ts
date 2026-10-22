import type { SuspenseTracker } from "@shadow-js/core";
import { SuspenseContext } from "@shadow-js/core";
import { Suspense } from "@shadow-js/web";
import { createComponent, renderToString, renderToStringAsync } from "@shadow-js/web/server";
import { describe, expect, it } from "vitest";
import { ServerConvexProvider } from "../src/client";
import { stableKey } from "../src/internal/args";
import { preloadQuery, useQuery } from "../src/query";
import { load } from "./support/compile";
import { FakeConvexClient, FakeHttpClient } from "./support/fake-client";
import { TASK_SUMMARY_GOLDEN } from "./support/golden";
import { api, type Task, task } from "./support/refs";
import { mountWith } from "./support/root";
import { TASK_SUMMARY_SRC } from "./support/sources";

/** Waits until the render has asked the HTTP client for a query, then answers it. */
async function answer(http: FakeHttpClient, value: unknown, index = 0): Promise<void> {
  for (let i = 0; i < 100 && http.queries.length <= index; i += 1) await Promise.resolve();
  http.queries[index]?.resolve(value);
}

/** A component that counts its items: `loading` while pending, the count once loaded. */
function Count(args: { readonly preload?: () => Promise<Task[]> }): () => string {
  const options =
    args.preload === undefined ? { key: "count" } : { key: "count", preload: args.preload };
  const tasks = useQuery(api.tasks.list, {}, options);
  return () => (tasks() === undefined ? "none" : String(tasks()?.length));
}

/** Server-renders `app` with an HTTP client, answering its first query with `value`. */
async function renderWithHttp(
  http: FakeHttpClient,
  value: unknown,
  app: () => unknown,
): Promise<{ html: string; data: Record<string, unknown> }> {
  const pending = renderToStringAsync(() =>
    ServerConvexProvider({
      client: http,
      get children() {
        return app();
      },
    }),
  );
  await answer(http, value);
  return pending;
}

describe("useQuery on the server", () => {
  it("[SSR-1] nothing subscribes on the server, even under a ConvexProvider", () => {
    const client = new FakeConvexClient();
    const { value: tasks } = mountWith(client, () => useQuery(api.tasks.list, {}));
    expect(client.created.length).toBe(0);
    expect(tasks.status).toBe("loading");
  });

  it("[SSR-2] a query is fetched once through the HTTP client and its value is rendered", async () => {
    const http = new FakeHttpClient();
    const result = await renderWithHttp(http, [task("1"), task("2")], () => Count({}));
    expect(result.html).toBe("2");
    expect(http.queries.map((call) => call.name)).toEqual(["tasks:list"]);
  });

  it("[SSR-3] a preload function is used when there is no HTTP client", async () => {
    let calls = 0;
    const result = await renderToStringAsync(() =>
      Count({
        preload: () => {
          calls += 1;
          return Promise.resolve([task("1")]);
        },
      }),
    );
    expect(result.html).toBe("1");
    expect(calls).toBe(1);
  });

  it("[SSR-4] while the fetch is pending the Suspense fallback is rendered (synchronous render)", () => {
    const http = new FakeHttpClient();
    const html = renderToString(() =>
      ServerConvexProvider({
        client: http,
        get children() {
          return Suspense({
            fallback: "loading",
            get children() {
              return Count({});
            },
          });
        },
      }),
    );
    expect(html).toBe("loading");
  });

  it("[SSR-5] an async render shows the content, not the fallback, once the fetch resolved", async () => {
    const http = new FakeHttpClient();
    const result = await renderWithHttp(http, [task("1")], () =>
      Suspense({
        fallback: "loading",
        get children() {
          return Count({});
        },
      }),
    );
    expect(result.html).toBe("1");
    expect(result.html).not.toContain("loading");
  });

  it("[SSR-6] a rejected fetch is not cached: the data has no entry and the render still completes", async () => {
    let calls = 0;
    const result = await renderToStringAsync(() =>
      Count({
        preload: () => {
          calls += 1;
          return Promise.reject(new Error("offline"));
        },
      }),
    );
    expect(result.data).toEqual({});
    expect(result.html).toBe("none");
    expect(calls).toBe(1);
  });

  it("[SSR-7] a skipped query is never fetched", async () => {
    let calls = 0;
    const result = await renderToStringAsync(() => {
      const tasks = useQuery(api.tasks.list, "skip", {
        preload: () => {
          calls += 1;
          return Promise.resolve([task("1")]);
        },
      });
      return () => (tasks.status === "skipped" ? "skipped" : "other");
    });
    expect(calls).toBe(0);
    expect(result.html).toBe("skipped");
  });

  it("[SSR-8] without a preload or HTTP client, nothing is fetched and nothing is held", () => {
    const tracker = { up: 0, down: 0 };
    const counting: SuspenseTracker = {
      increment: () => {
        tracker.up += 1;
      },
      decrement: () => {
        tracker.down += 1;
      },
    };
    const html = renderToString(() =>
      SuspenseContext({
        value: counting,
        get children() {
          return Count({});
        },
      }),
    );
    expect(html).toBe("none");
    expect(tracker).toEqual({ up: 0, down: 0 });
  });

  it("[SSR-9] the first load holds the server Suspense boundary exactly once and releases it once", async () => {
    const http = new FakeHttpClient();
    const tracker = { up: 0, down: 0 };
    const counting: SuspenseTracker = {
      increment: () => {
        tracker.up += 1;
      },
      decrement: () => {
        tracker.down += 1;
      },
    };
    const pending = renderToStringAsync(() =>
      ServerConvexProvider({
        client: http,
        get children() {
          return SuspenseContext({
            value: counting,
            get children() {
              return Count({});
            },
          });
        },
      }),
    );
    await answer(http, [task("1")]);
    await pending;
    expect(tracker).toEqual({ up: 1, down: 1 });
  });

  it("[SSR-10] the fetch is not repeated on the next pass: the cache serves the value", async () => {
    const http = new FakeHttpClient();
    const result = await renderWithHttp(http, [task("1")], () => Count({}));
    expect(result.html).toBe("1");
    expect(http.queries.length).toBe(1);
  });

  it("[SSR-11] the cached value is keyed by the explicit key, so the browser can find it", async () => {
    const http = new FakeHttpClient();
    const result = await renderWithHttp(http, [task("1")], () => Count({}));
    expect(Object.keys(result.data)).toEqual(["k:count"]);
  });

  it("[SSR-12] two queries get distinct keys and both values are returned", async () => {
    const http = new FakeHttpClient();
    const pending = renderToStringAsync(() =>
      ServerConvexProvider({
        client: http,
        get children() {
          const first = useQuery(api.tasks.list, { done: false });
          const second = useQuery(api.tasks.list, { done: true });
          return () => `${first()?.length ?? "-"}/${second()?.length ?? "-"}`;
        },
      }),
    );
    await answer(http, [task("1")], 0);
    await answer(http, [task("2"), task("3")], 1);
    const result = await pending;
    expect(result.html).toBe("1/2");
    expect(Object.keys(result.data).length).toBe(2);
  });

  it("[SSR-13] the same render twice produces the same keys and the same markup", async () => {
    const render = async (): Promise<{ html: string; data: Record<string, unknown> }> => {
      const http = new FakeHttpClient();
      return renderWithHttp(http, [task("1")], () => Count({}));
    };
    const first = await render();
    const second = await render();
    expect(second).toEqual(first);
  });

  it("[SSR-14] a server render without any provider still renders the loading state", () => {
    const html = renderToString(() => Count({}));
    expect(html).toBe("none");
  });

  it("[SSR-15] the server reads the arguments accessor once per render pass, not per read of the result", async () => {
    let reads = 0;
    const http = new FakeHttpClient();
    const result = await renderWithHttp(http, [task("1")], () => {
      const tasks = useQuery(api.tasks.list, () => {
        reads += 1;
        return { done: false };
      });
      return () => String(tasks()?.length ?? "none");
    });
    expect(result.html).toBe("1");
    // Two render passes (the second one serves the fetched value), one read per pass.
    expect(reads).toBe(2);
  });
});

describe("preloadQuery", () => {
  it("[SSR-16] returns the value and a token made of the name and the arguments", async () => {
    const http = new FakeHttpClient();
    const pending = preloadQuery(http, api.tasks.list, { done: false });
    await answer(http, [task("1")]);
    const loaded = await pending;
    expect(loaded.value).toEqual([task("1")]);
    expect(loaded.token).toBe(`tasks:list:${stableKey({ done: false })}`);
  });

  it("[SSR-17] without arguments the token uses an empty object", async () => {
    const http = new FakeHttpClient();
    const pending = preloadQuery(http, api.tasks.count);
    await answer(http, 4);
    const loaded = await pending;
    expect(loaded.value).toBe(4);
    expect(loaded.token).toBe(`tasks:count:${stableKey({})}`);
  });

  it("[SSR-18] the token differs for different arguments", async () => {
    const http = new FakeHttpClient();
    const first = preloadQuery(http, api.tasks.byId, { id: "a" });
    const second = preloadQuery(http, api.tasks.byId, { id: "b" });
    await answer(http, null, 0);
    await answer(http, null, 1);
    const [a, b] = await Promise.all([first, second]);
    expect(a.token).not.toBe(b.token);
  });

  it("[SSR-19] a failing preload rejects with the same error", async () => {
    const http = new FakeHttpClient();
    const pending = preloadQuery(http, api.tasks.list, {});
    for (let i = 0; i < 20 && http.queries.length === 0; i += 1) await Promise.resolve();
    http.queries[0]?.reject(new Error("down"));
    await expect(pending).rejects.toThrow("down");
  });
});

describe("compiled components: golden markup", () => {
  it("[SSR-20] the compiled server output matches the golden markup and data", async () => {
    const ssr = await load<{ TaskSummary: (props: unknown) => unknown }>(TASK_SUMMARY_SRC, "ssr");
    const http = new FakeHttpClient();
    const result = await renderWithHttp(http, [task("1"), task("2")], () =>
      createComponent(ssr.TaskSummary, { list: api.tasks.list, args: {} }),
    );
    expect(result.html).toBe(TASK_SUMMARY_GOLDEN.html);
    expect(result.data).toEqual(TASK_SUMMARY_GOLDEN.data);
  });
});
