import {
  type Accessor,
  batch,
  isServer,
  onCleanup,
  untrack,
  useContext,
  useMemo,
  useRenderEffect,
  useSignal,
} from "@shadow-js/core";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { missingProvider } from "./client";
import { subscribeTo } from "./internal/adapters";
import { type ArgRecord, isRecord, stableKey } from "./internal/args";
import { ConvexContext } from "./internal/contexts";
import {
  isPageResult,
  type PageHost,
  PaginationModel,
  type PaginationSnapshot,
} from "./internal/pagination";
import type { PaginationStatus, QueryRef } from "./types";

/**
 * Options of {@link usePaginatedQuery}.
 *
 * @example
 * ```ts
 * import { type PaginatedQueryOptions, type QueryRef, usePaginatedQuery } from "@shadow-js/convex";
 *
 * // Stands in for `api.messages.list` from convex/_generated/api.
 * declare const listMessages: QueryRef;
 *
 * const options: PaginatedQueryOptions = { initialNumItems: 25 };
 *
 * export function useChannelMessages(channel: string) {
 *   return usePaginatedQuery(listMessages, { channel }, options);
 * }
 * ```
 * @since 1.0.0
 */
export interface PaginatedQueryOptions {
  /**
   * Items requested for the first page. Required. Must be an integer of at least 1; anything else
   * makes `usePaginatedQuery` throw a `RangeError`.
   */
  readonly initialNumItems: number;
}

/**
 * Arguments of a paginated query: its arguments without `paginationOpts`, which the hook supplies.
 * An accessor is re-read when its signals change; when the arguments differ by content, every page
 * is stopped and the pages restart from the first one.
 *
 * @example
 * ```ts
 * import { type PaginatedArgsInput, type QueryRef, usePaginatedQuery } from "@shadow-js/convex";
 * import { useSignal } from "@shadow-js/core";
 *
 * // Stands in for `api.messages.list` from convex/_generated/api.
 * declare const listMessages: QueryRef;
 *
 * export function useMessagesOfChannel() {
 *   const [channel, setChannel] = useSignal("general");
 *   const args: PaginatedArgsInput<typeof listMessages> = () => ({ channel: channel() });
 *   return { messages: usePaginatedQuery(listMessages, args, { initialNumItems: 20 }), setChannel };
 * }
 * ```
 * @since 1.0.0
 */
export type PaginatedArgsInput<Query extends QueryRef> =
  | Omit<FunctionArgs<Query>, "paginationOpts">
  | Accessor<Omit<FunctionArgs<Query>, "paginationOpts">>;

/**
 * The item type of a paginated query's result, from its `{ page }` return value. `never` when the
 * result has no `page` array.
 *
 * @example
 * ```ts
 * import type { PageItem } from "@shadow-js/convex";
 *
 * type MessagePage = {
 *   page: { _id: string; body: string }[];
 *   isDone: boolean;
 *   continueCursor: string;
 * };
 *
 * // { _id: string; body: string }
 * type Message = PageItem<MessagePage>;
 *
 * export const first: Message = { _id: "m1", body: "Hello" };
 * ```
 * @see {@link PaginatedQueryResult}
 * @since 1.0.0
 */
export type PageItem<Result> = Result extends { readonly page: readonly (infer Item)[] }
  ? Item
  : never;

/**
 * What {@link usePaginatedQuery} returns. Every member is an accessor except `loadMore`.
 *
 * @example
 * ```tsx
 * import { type PaginatedQueryResult, type QueryRef, usePaginatedQuery } from "@shadow-js/convex";
 *
 * // Stands in for `api.messages.list` from convex/_generated/api.
 * declare const listMessages: QueryRef;
 *
 * type Message = { _id: string; body: string };
 *
 * export function MessageCount(props: { channel: string }) {
 *   const messages = usePaginatedQuery(listMessages, { channel: props.channel }, {
 *     initialNumItems: 50,
 *   }) as PaginatedQueryResult<Message>;
 *   return <p>{() => (messages.isLoading() ? "Loading" : `${messages.results().length} messages`)}</p>;
 * }
 * ```
 * @since 1.0.0
 */
export interface PaginatedQueryResult<Item> {
  /** The items of every loaded page, in order. Empty while the first page loads. */
  readonly results: Accessor<Item[]>;
  /** Where the pagination is: first page loading, can load more, loading more, or exhausted. */
  readonly status: Accessor<PaginationStatus>;
  /** True while the first page or a further page is loading. */
  readonly isLoading: Accessor<boolean>;
  /**
   * The error of a failed page subscription, or `undefined`. A page that is not
   * `{ page, isDone, continueCursor }` is reported here as a `TypeError`.
   */
  readonly error: Accessor<unknown>;
  /**
   * Requests the next page of up to `numItems` items. Returns `false` when nothing was requested:
   * the last page has not arrived yet, there are no more items, or the hook runs on the server.
   * Throws a `RangeError` when `numItems` is not an integer of at least 1.
   */
  loadMore(numItems: number): boolean;
}

/** The arguments the subscription effect runs with. @internal */
interface ArgsPlan {
  readonly key: string;
  readonly args: ArgRecord;
}

/**
 * Pages the results of a Convex paginated query. Each page is one subscription with its own
 * cursor, so results stay live. The hook follows the protocol of convex's own client, including
 * splitting a page the server reports as too large.
 *
 * Only the browser paginates: on the server the hook reports its initial loading state, and no
 * page is fetched during server rendering.
 *
 * @param query A query reference whose function takes `paginationOpts` and returns `{ page, isDone, continueCursor }`.
 * @param args The arguments without `paginationOpts`, or an accessor returning them.
 * @param options See {@link PaginatedQueryOptions}.
 * @returns A {@link PaginatedQueryResult}.
 * @throws RangeError when `initialNumItems` is not an integer of at least 1.
 * @throws Error when there is no `ConvexProvider` above the component (in the browser). The message
 * starts with `usePaginatedQuery() must be used inside <ConvexProvider>`.
 * @throws TypeError when the arguments are not an object or an accessor returning one.
 * @example
 * ```tsx
 * import { type QueryRef, usePaginatedQuery } from "@shadow-js/convex";
 * import { For } from "@shadow-js/web";
 *
 * // Stands in for `api.messages.list` from convex/_generated/api.
 * declare const listMessages: QueryRef;
 *
 * type Message = { _id: string; body: string };
 *
 * export function Messages(props: { channel: string }) {
 *   const messages = usePaginatedQuery(listMessages, { channel: props.channel }, {
 *     initialNumItems: 20,
 *   });
 *   return (
 *     <section>
 *       <ul>
 *         <For each={messages.results() as Message[]}>{(message) => <li>{message.body}</li>}</For>
 *       </ul>
 *       <button
 *         type="button"
 *         disabled={messages.status() !== "CanLoadMore"}
 *         onClick={() => messages.loadMore(20)}
 *       >
 *         More
 *       </button>
 *     </section>
 *   );
 * }
 * ```
 * @see {@link useQuery}
 * @since 1.0.0
 */
export function usePaginatedQuery<Query extends QueryRef>(
  query: Query,
  args: PaginatedArgsInput<Query>,
  options: PaginatedQueryOptions,
): PaginatedQueryResult<PageItem<FunctionReturnType<Query>>> {
  type Item = PageItem<FunctionReturnType<Query>>;
  const initialNumItems = options.initialNumItems;
  if (!Number.isInteger(initialNumItems) || initialNumItems < 1) {
    throw new RangeError("usePaginatedQuery(): initialNumItems must be an integer of at least 1.");
  }
  const scope = useContext(ConvexContext);
  const client = scope === null ? null : scope.client;
  if (client === null && !isServer) throw missingProvider("usePaginatedQuery", "ConvexProvider");

  const readArgs: () => unknown = typeof args === "function" ? args : () => args;
  const plan = useMemo<ArgsPlan>((previous) => {
    const next: unknown = readArgs();
    if (!isRecord(next)) {
      throw new TypeError(
        "usePaginatedQuery() arguments must be an object, or an accessor returning one.",
      );
    }
    const key = stableKey(next);
    if (previous !== undefined && previous.key === key) return previous;
    return { key, args: next };
  });

  const initialState = (): PaginationSnapshot => ({
    results: [],
    status: "LoadingFirstPage",
    error: undefined,
  });
  const [snapshot, setSnapshot] = useSignal<PaginationSnapshot>(initialState(), {
    equals: false,
  });

  let disposed = false;
  let model: PaginationModel | null = null;
  const stopModel = (): void => {
    const live = model;
    model = null;
    live?.dispose();
  };
  onCleanup(() => {
    disposed = true;
    stopModel();
  });

  const publish = (current: PaginationModel): void => {
    if (disposed) return;
    const state = current.snapshot();
    batch(() => {
      setSnapshot({ results: state.results, status: state.status, error: state.error });
    });
  };

  if (!isServer) {
    const live = client;
    if (live === null) throw missingProvider("usePaginatedQuery", "ConvexProvider");

    useRenderEffect(plan, (next) => {
      stopModel();
      setSnapshot(initialState());
      const host: PageHost = {
        open(spec, handlers) {
          const paginationOpts =
            spec.endCursor === undefined
              ? { numItems: spec.numItems, cursor: spec.cursor }
              : { numItems: spec.numItems, cursor: spec.cursor, endCursor: spec.endCursor };
          return untrack(() =>
            subscribeTo(
              live,
              query,
              { ...next.args, paginationOpts },
              (value) => {
                if (isPageResult(value)) handlers.onResult(value);
                else
                  handlers.onError(
                    new TypeError(
                      "A paginated query must return { page, isDone, continueCursor }.",
                    ),
                  );
              },
              (error) => handlers.onError(error),
            ),
          );
        },
      };
      const started = new PaginationModel(host, initialNumItems, () => {
        if (model === started) publish(started);
      });
      model = started;
      started.start();
      publish(started);
      return () => stopModel();
    });
  }

  const isLoading = (): boolean => {
    const status = snapshot().status;
    return status === "LoadingFirstPage" || status === "LoadingMore";
  };

  return {
    results: () => snapshot().results as Item[],
    status: () => snapshot().status,
    isLoading,
    error: () => snapshot().error,
    loadMore(numItems: number): boolean {
      if (!Number.isInteger(numItems) || numItems < 1) {
        throw new RangeError("loadMore(): numItems must be an integer of at least 1.");
      }
      const live = model;
      if (live === null) return false;
      return live.loadMore(numItems);
    },
  };
}
