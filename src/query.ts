import {
  type Accessor,
  batch,
  isServer,
  onCleanup,
  ResourceCacheContext,
  SuspenseContext,
  untrack,
  useContext,
  useMemo,
  useRenderEffect,
  useSignal,
} from "@shadow-js/core";
import { type FunctionArgs, type FunctionReturnType, getFunctionName } from "convex/server";
import { missingProvider } from "./client";
import { runHttpQuery, subscribeTo } from "./internal/adapters";
import { type ArgRecord, isRecord, stableKey } from "./internal/args";
import { ConvexContext, ServerConvexContext } from "./internal/contexts";
import { createSuspenseHold } from "./internal/hold";
import type { ConvexHttpClientLike, QueryRef } from "./types";

/**
 * Lifecycle of a reactive query: `"loading"` until a result for the current arguments arrives,
 * `"success"` once one has, `"error"` when the subscription failed, and `"skipped"` when the
 * arguments are `"skip"`, so nothing runs.
 *
 * @example
 * ```ts
 * import type { QueryStatus } from "@shadow-js/convex";
 *
 * function statusText(status: QueryStatus): string {
 *   if (status === "error") return "Could not load the tasks.";
 *   return status === "loading" ? "Loading" : "";
 * }
 *
 * statusText("loading");
 * ```
 * @see {@link QueryResult}
 * @since 1.0.0
 */
export type QueryStatus = "loading" | "success" | "error" | "skipped";

/**
 * What {@link useQuery} returns. Calling it gives the latest data, or `undefined` while loading,
 * skipped or failed. Reading it, or one of its properties, inside a computation subscribes that
 * computation.
 *
 * @example
 * ```tsx
 * import { type QueryRef, type QueryResult, useQuery } from "@shadow-js/convex";
 *
 * // Stands in for `api.tasks.count` from convex/_generated/api.
 * declare const countTasks: QueryRef;
 *
 * export function TaskCount() {
 *   const count: QueryResult<number> = useQuery(countTasks);
 *   return (
 *     <p>
 *       {() => {
 *         if (count.status === "error") return "Could not count the tasks.";
 *         return count.isLoading ? "Counting" : `${count() ?? 0} tasks`;
 *       }}
 *     </p>
 *   );
 * }
 * ```
 * @since 1.0.0
 */
export interface QueryResult<T> {
  /**
   * Returns the latest data, or `undefined` while loading (unless `keepPreviousData` keeps the
   * previous data), skipped or failed. With `throwOnError`, it throws the subscription's error
   * instead of returning `undefined` after a failure.
   */
  (): T | undefined;
  /** Where the query is in its lifecycle. */
  readonly status: QueryStatus;
  /** True while the first result, or a result for new arguments, is awaited. */
  readonly isLoading: boolean;
  /** The error of the failed subscription, or `undefined`. A later result clears it. */
  readonly error: unknown;
}

/**
 * Options of {@link useQuery}.
 *
 * @example
 * ```ts
 * import { fetchQuery, type QueryRef, type UseQueryOptions, useQuery } from "@shadow-js/convex";
 *
 * // Stands in for `api.tasks.list` from convex/_generated/api.
 * declare const listTasks: QueryRef;
 *
 * type Task = { _id: string; title: string; done: boolean };
 *
 * const options: UseQueryOptions<Task[]> = {
 *   keepPreviousData: true,
 *   throwOnError: true,
 *   key: "open-tasks",
 *   preload: () => fetchQuery("https://happy-otter-123.convex.cloud", listTasks, { done: false }),
 * };
 *
 * export function useOpenTasks() {
 *   return useQuery(listTasks, { done: false }, options);
 * }
 * ```
 * @since 1.0.0
 */
export interface UseQueryOptions<T> {
  /**
   * Keep showing the previous data while new arguments load. Default `false`: the data is cleared
   * as soon as the arguments change.
   */
  readonly keepPreviousData?: boolean;
  /**
   * Rethrow the subscription's error when the result is read, so an error boundary catches it.
   * Default `false`. The error is also available as `.error` either way.
   */
  readonly throwOnError?: boolean;
  /**
   * Resource-cache key, used on the server and during hydration. Must be the same on both sides.
   * {@link preloadQuery} returns a suitable value as its `token`. Without it, the renderer's
   * resource cache assigns the key.
   */
  readonly key?: string;
  /**
   * Fetch function used on the server, for example
   * `() => fetchQuery(url, api.tasks.list, {})`. It takes precedence over the client of a
   * `ServerConvexProvider`. It is never called in the browser, and not for skipped arguments.
   */
  readonly preload?: () => Promise<T>;
}

/**
 * Arguments accepted by {@link useQuery}: a plain object, `"skip"`, or an accessor returning either.
 * An accessor is re-read whenever a signal it reads changes; the query resubscribes only when the
 * resulting arguments differ by content (key order and fields holding `undefined` do not count).
 *
 * @example
 * ```ts
 * import { type QueryArgsInput, type QueryRef, useQuery } from "@shadow-js/convex";
 * import { useSignal } from "@shadow-js/core";
 *
 * // Stands in for `api.tasks.byId` from convex/_generated/api.
 * declare const taskById: QueryRef;
 *
 * export function useSelectedTask() {
 *   const [selected, setSelected] = useSignal<string | null>(null);
 *   const args: QueryArgsInput<typeof taskById> = () => {
 *     const id = selected();
 *     return id === null ? "skip" : { id };
 *   };
 *   return { task: useQuery(taskById, args), select: setSelected };
 * }
 * ```
 * @since 1.0.0
 */
export type QueryArgsInput<Query extends QueryRef> =
  | FunctionArgs<Query>
  | "skip"
  | Accessor<FunctionArgs<Query> | "skip">;

/**
 * The value of a query fetched on the server, for a loader or a `preload` function.
 *
 * @example
 * ```ts
 * import { type ConvexHttpClientLike, type PreloadedQuery, preloadQuery, type QueryRef } from "@shadow-js/convex";
 *
 * // Stand in for `new ConvexHttpClient(url)` from convex/browser and `api.tasks.list`.
 * declare const http: ConvexHttpClientLike;
 * declare const listTasks: QueryRef;
 *
 * type Task = { _id: string; title: string; done: boolean };
 *
 * export async function loader(): Promise<PreloadedQuery<Task[]>> {
 *   return preloadQuery(http, listTasks, { done: false });
 * }
 * ```
 * @since 1.0.0
 */
export interface PreloadedQuery<T> {
  /** The query result. */
  readonly value: T;
  /**
   * Stable identity of the call: the function name, a colon, and a key of the arguments that does
   * not depend on their key order. Pass it as `options.key` of `useQuery` so the browser finds the
   * server value under the same key.
   */
  readonly token: string;
}

/** What the subscription effect runs with. @internal */
type Plan =
  | { readonly kind: "skip" }
  | { readonly kind: "run"; readonly key: string; readonly args: ArgRecord };

/** The state the hook publishes. @internal */
interface Snapshot<T> {
  readonly status: QueryStatus;
  readonly data: T | undefined;
  readonly error: unknown;
}

/** One live subscription. `active` turns false when it is stopped; late callbacks then do nothing. @internal */
interface Subscription {
  active: boolean;
  stop: () => void;
}

/** The plan of skipped arguments, shared so an unchanged skip does not re-run the effect. @internal */
const SKIP_PLAN: Plan = { kind: "skip" };

/** The stop of a subscription that has not been made yet: there is nothing to stop. */
function nothingToStop(): void {
  // A subscription is stopped by its own `stop`; before `subscribeTo` returns there is none.
}

/** Reads the arguments input, turning a plain value into a constant accessor. @internal */
function argsReader(input: unknown): () => unknown {
  if (typeof input === "function") return input as () => unknown;
  return () => input;
}

/**
 * Subscribes to a Convex query and exposes the result reactively.
 *
 * Subscribing starts when the component is created and stops when it is disposed or its arguments
 * change. Results from a superseded subscription are ignored. Inside a `<Suspense>` the first
 * load holds the boundary until the first result or error. On the server nothing subscribes: the
 * value comes from the resource cache, or is fetched once through `options.preload` or
 * `ServerConvexProvider`, so the page is complete before it is sent. Without either, the server
 * renders the loading state.
 *
 * @param query A query reference, for example `api.tasks.list`.
 * @param args Arguments, `"skip"`, or an accessor returning either. Omit for a query without arguments.
 * @param options See {@link UseQueryOptions}.
 * @returns A {@link QueryResult}.
 * @throws Error when there is no `ConvexProvider` above the component (in the browser). The message
 * starts with `useQuery() must be used inside <ConvexProvider>`.
 * @throws TypeError when the arguments are not an object, `"skip"`, or an accessor returning one.
 * @throws RangeError when the arguments hold more than 100 000 values (they are cyclic or huge).
 * @example
 * ```tsx
 * import { type QueryRef, useQuery } from "@shadow-js/convex";
 * import { useSignal } from "@shadow-js/core";
 * import { For, Show } from "@shadow-js/web";
 *
 * // Stands in for `api.tasks.list` from convex/_generated/api.
 * declare const listTasks: QueryRef;
 *
 * type Task = { _id: string; title: string; done: boolean };
 *
 * export function TaskList() {
 *   const [showDone, setShowDone] = useSignal(false);
 *   const tasks = useQuery(listTasks, () => (showDone() ? {} : { done: false }), {
 *     keepPreviousData: true,
 *   });
 *   return (
 *     <section>
 *       <label>
 *         <input type="checkbox" onChange={(event) => setShowDone(event.currentTarget.checked)} />
 *         Show done
 *       </label>
 *       <Show when={tasks()} fallback={<p>Loading</p>}>
 *         {(list) => (
 *           <ul>
 *             <For each={list() as Task[]}>{(task) => <li>{task.title}</li>}</For>
 *           </ul>
 *         )}
 *       </Show>
 *     </section>
 *   );
 * }
 * ```
 * @see {@link usePaginatedQuery}
 * @see {@link preloadQuery}
 * @since 1.0.0
 */
export function useQuery<Query extends QueryRef>(
  query: Query,
  args?: QueryArgsInput<Query>,
  options?: UseQueryOptions<FunctionReturnType<Query>>,
): QueryResult<FunctionReturnType<Query>> {
  type Value = FunctionReturnType<Query>;
  const opts: UseQueryOptions<Value> = options ?? {};
  const keepPrevious = opts.keepPreviousData === true;
  const scope = useContext(ConvexContext);
  const client = scope === null ? null : scope.client;
  const http = useContext(ServerConvexContext);
  const cache = useContext(ResourceCacheContext);
  const tracker = useContext(SuspenseContext);
  if (client === null && !isServer) throw missingProvider("useQuery", "ConvexProvider");

  const readArgs = argsReader(args ?? {});
  // The memo keeps one plan object per distinct argument content: equal arguments stop here, so
  // the subscription effect does not run again.
  const plan = useMemo<Plan>((previous) => {
    const next = readArgs();
    if (next === "skip") return SKIP_PLAN;
    const value: unknown = next === undefined ? {} : next;
    if (!isRecord(value)) {
      throw new TypeError(
        'useQuery() arguments must be an object, "skip", or an accessor returning one.',
      );
    }
    const key = stableKey(value);
    if (previous !== undefined && previous.kind === "run" && previous.key === key) return previous;
    return { kind: "run", key, args: value };
  });

  // Called exactly once per hook so that server and browser allocate the same cache keys.
  const cacheKey: string | undefined = cache?.key(opts.key);
  const firstPlan = untrack(plan);
  const seeded =
    cache !== null && cacheKey !== undefined && firstPlan.kind === "run"
      ? cache.read(cacheKey)
      : undefined;
  let settled = seeded !== undefined;
  const hold = createSuspenseHold(tracker);

  const initial: Snapshot<Value> =
    firstPlan.kind === "skip"
      ? { status: "skipped", data: undefined, error: undefined }
      : seeded !== undefined
        ? { status: "success", data: seeded.value as Value, error: undefined }
        : { status: "loading", data: undefined, error: undefined };
  const [snapshot, setSnapshot] = useSignal<Snapshot<Value>>(initial, { equals: false });

  let disposed = false;
  let current: Subscription | null = null;

  const stopCurrent = (): void => {
    const live = current;
    if (live === null) return;
    current = null;
    live.active = false;
    live.stop();
  };

  const publish = (next: Snapshot<Value>): void => {
    if (disposed) return;
    settled = true;
    batch(() => {
      setSnapshot(next);
      hold.release();
    });
  };

  onCleanup(() => {
    disposed = true;
    stopCurrent();
    hold.release();
  });

  if (isServer) {
    // Nothing subscribes on the server. The fetch starts here and is tracked by the cache, so the
    // render waits for it on the next pass.
    if (firstPlan.kind === "run" && !settled) {
      const run = firstPlan;
      const fetcher: (() => Promise<unknown>) | undefined =
        opts.preload ?? (http === null ? undefined : () => runHttpQuery(http, query, run.args));
      if (fetcher !== undefined) {
        hold.acquire();
        let fetched: Promise<unknown>;
        try {
          fetched = Promise.resolve(fetcher());
        } catch (error) {
          fetched = Promise.reject(error);
        }
        if (cache !== null && cacheKey !== undefined) cache.track(cacheKey, fetched);
        void fetched.then(
          (value) => publish({ status: "success", data: value as Value, error: undefined }),
          (error: unknown) => publish({ status: "error", data: undefined, error }),
        );
      }
    }
  } else {
    const live = client;
    if (live === null) throw missingProvider("useQuery", "ConvexProvider");

    const subscribe = (run: Extract<Plan, { kind: "run" }>): void => {
      const sub: Subscription = { active: true, stop: nothingToStop };
      current = sub;
      if (!settled) hold.acquire();
      untrack(() => {
        sub.stop = subscribeTo(
          live,
          query,
          run.args,
          (value) => {
            if (!sub.active) return;
            publish({ status: "success", data: value as Value, error: undefined });
          },
          (error) => {
            if (!sub.active) return;
            publish({ status: "error", data: undefined, error });
          },
        );
      });
    };

    // The first run of a hydrated query uses the value the server sent; it is already published.
    let seedApplies = seeded !== undefined;
    useRenderEffect(plan, (next) => {
      stopCurrent();
      if (next.kind === "skip") {
        hold.release();
        seedApplies = false;
        setSnapshot({ status: "skipped", data: undefined, error: undefined });
        return undefined;
      }
      if (seedApplies) {
        seedApplies = false;
      } else {
        setSnapshot((previous) =>
          keepPrevious
            ? { status: "loading", data: previous.data, error: undefined }
            : { status: "loading", data: undefined, error: undefined },
        );
      }
      subscribe(next);
      return () => stopCurrent();
    });
  }

  const read = (): Value | undefined => {
    const state = snapshot();
    if (state.status === "error" && opts.throwOnError === true) throw state.error;
    return state.data;
  };
  Object.defineProperties(read, {
    status: { get: () => snapshot().status, enumerable: true },
    isLoading: { get: () => snapshot().status === "loading", enumerable: true },
    error: { get: () => snapshot().error, enumerable: true },
  });
  return read as QueryResult<Value>;
}

/**
 * Runs `query` once over HTTP and returns its value together with a token for the browser. Use it in
 * a route loader: pass the `value` to the page and the `token` to `useQuery` as `options.key`.
 *
 * @param http The one-shot HTTP client (`new ConvexHttpClient(url)` from `convex/browser`).
 * @param query A query reference.
 * @param args The arguments; omit for a query without arguments.
 * @returns A promise of the value and the token. It rejects with the query's error.
 * @example
 * ```ts
 * import {
 *   type ConvexHttpClientLike,
 *   type PreloadedQuery,
 *   preloadQuery,
 *   type QueryRef,
 *   useQuery,
 * } from "@shadow-js/convex";
 *
 * // Stand in for `new ConvexHttpClient(url)` from convex/browser and `api.tasks.list`.
 * declare const http: ConvexHttpClientLike;
 * declare const listTasks: QueryRef;
 *
 * type Task = { _id: string; title: string; done: boolean };
 *
 * // In the route loader, on the server.
 * export function loader(): Promise<PreloadedQuery<Task[]>> {
 *   return preloadQuery(http, listTasks, { done: false });
 * }
 *
 * // In the page, with the loader's data.
 * export function useOpenTasks(preloaded: PreloadedQuery<Task[]>) {
 *   return useQuery(listTasks, { done: false }, {
 *     key: preloaded.token,
 *     preload: async () => preloaded.value,
 *   });
 * }
 * ```
 * @see {@link PreloadedQuery}
 * @since 1.0.0
 */
export async function preloadQuery<Query extends QueryRef>(
  http: ConvexHttpClientLike,
  query: Query,
  args?: FunctionArgs<Query>,
): Promise<PreloadedQuery<FunctionReturnType<Query>>> {
  const input: unknown = args ?? {};
  const value = await runHttpQuery(http, query, input);
  return {
    value: value as FunctionReturnType<Query>,
    token: `${getFunctionName(query)}:${stableKey(input)}`,
  };
}
