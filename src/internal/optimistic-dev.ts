import type { OptimisticLocalStore, OptimisticUpdate } from "convex/browser";
import { getFunctionName } from "convex/server";
import type { Value } from "convex/values";
import type { ConvexClientLike, QueryRef } from "../types";
import { stableKey } from "./args";

/*
 * Development checks for optimistic updates. Every function here is called only under `__DEV__`,
 * so none of it ships in production builds. Three checks:
 *   1. the results an update reads are read-only copies: writing to them throws, and the update's
 *      error is reported with the fix;
 *   2. each value an update writes is compared with the value the server settles on;
 *   3. nothing is subscribed for the comparison unless the update wrote something.
 */

/** One `setQuery` an optimistic update made, kept until the mutation settles. @internal */
export interface OptimisticWrite {
  readonly query: QueryRef;
  readonly args: Record<string, unknown>;
  readonly value: unknown;
}

/**
 * Copies a query result and freezes the copy (iteratively, so deep values are safe). The client's
 * own result is never frozen, so the rest of the app keeps working as before.
 * @internal
 */
function readOnlyCopy(value: unknown): unknown {
  if (value === undefined || value === null || typeof value !== "object") return value;
  const copy: object = structuredClone(value);
  const stack: object[] = [copy];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (Object.isFrozen(node)) continue;
    Object.freeze(node);
    for (const child of Object.values(node)) {
      if (typeof child === "object" && child !== null) stack.push(child);
    }
  }
  return copy;
}

const THREW =
  "An optimistic update threw. If it changed a value returned by getQuery or getAllQueries, copy the value first: query results are shared by the client and read-only in development.";

/**
 * Wraps an optimistic update so its reads are read-only and its writes are recorded in `writes`.
 * An error from the update is reported as a warning, then thrown again so the mutation fails
 * as it would without the check.
 * @internal
 */
export function checkedOptimisticUpdate<Args extends Record<string, Value>>(
  update: OptimisticUpdate<Args>,
  writes: OptimisticWrite[],
): OptimisticUpdate<Args> {
  return (store: OptimisticLocalStore, args: Args): void => {
    // Convex runs an update again whenever the server's results change. Only the latest run's writes
    // are the optimistic state; the writes of earlier runs are dropped before this run records its own.
    writes.length = 0;
    const watched: OptimisticLocalStore = {
      getQuery(query, ...rest) {
        return readOnlyCopy(store.getQuery(query, ...rest)) as ReturnType<
          OptimisticLocalStore["getQuery"]
        >;
      },
      getAllQueries(query) {
        return store.getAllQueries(query).map((entry) => ({
          args: entry.args,
          value: readOnlyCopy(entry.value) as typeof entry.value,
        }));
      },
      setQuery(query, queryArgs, value) {
        // The `_future` reference shape is not supported by this package (see `QueryRef`), so every
        // query an update can name is a classic `FunctionReference`.
        writes.push({ query: query as QueryRef, args: queryArgs, value });
        store.setQuery(query, queryArgs, value);
      },
    };
    try {
      update(watched, args);
    } catch (error) {
      console.warn(`[shadow convex] ${THREW}`);
      throw error;
    }
  };
}

/**
 * Fields the server assigns to every document. An optimistic update names them with a temporary
 * value (a placeholder id, a local time), so they are left out of the comparison: a temporary id
 * does not warn, but a different title or status does.
 * @internal
 */
const SERVER_ASSIGNED: ReadonlySet<string> = new Set(["_id", "_creationTime"]);

/**
 * After a mutation settles, compares each value the optimistic update wrote with the value the
 * server now has for that query. A subscription is opened per write, closed after its first value,
 * and only when there is something to compare.
 * @internal
 */
export function verifySettled(client: ConvexClientLike, writes: readonly OptimisticWrite[]): void {
  for (const write of writes) {
    let finished = false;
    let stop: (() => void) | undefined;
    const finish = (): void => {
      finished = true;
      stop?.();
    };
    stop = client.onUpdate(
      write.query,
      write.args,
      (serverValue: unknown) => {
        if (finished) return;
        finish();
        if (stableKey(serverValue, SERVER_ASSIGNED) !== stableKey(write.value, SERVER_ASSIGNED)) {
          console.warn(
            `[shadow convex] The optimistic value for ${getFunctionName(write.query)} differs from the server result after the mutation settled. The update should compute what the mutation writes: check ids, timestamps and defaults.`,
          );
        }
      },
      () => finish(),
    );
    if (finished) stop();
  }
}
