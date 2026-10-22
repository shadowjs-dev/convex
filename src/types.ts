import type { MutationOptions, OptimisticUpdate } from "convex/browser";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
  OptionalRestArgs,
} from "convex/server";

/**
 * Status of a paginated query, as convex reports it: `"LoadingFirstPage"` until the first page
 * arrives, `"CanLoadMore"` when another page can be requested, `"LoadingMore"` while one is on its
 * way, and `"Exhausted"` after the last page. Declared here because convex 1.20 does not export the
 * type; the values are the same.
 *
 * @example
 * ```ts
 * import type { PaginationStatus } from "@shadow-js/convex";
 *
 * function moreLabel(status: PaginationStatus): string {
 *   if (status === "Exhausted") return "No more messages";
 *   return status === "CanLoadMore" ? "Load more" : "Loading";
 * }
 *
 * moreLabel("CanLoadMore");
 * ```
 * @see {@link usePaginatedQuery}
 * @since 1.0.0
 */
export type PaginationStatus = "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";

/**
 * The `fetchToken` argument of `setAuth`: returns a JWT, or `null` or `undefined` when there is
 * none. `forceRefreshToken` is `true` when the client needs a new token because the previous one
 * was rejected or is about to expire. Declared here because convex 1.20 does not export
 * `AuthTokenFetcher`; `ConvexClient` accepts it unchanged.
 *
 * @example
 * ```ts
 * import { type AuthTokenFetcherLike, createConvexClient } from "@shadow-js/convex";
 *
 * const fetchToken: AuthTokenFetcherLike = async ({ forceRefreshToken }) => {
 *   const response = await fetch(`/auth/convex-token?refresh=${forceRefreshToken ? "1" : "0"}`);
 *   return response.ok ? response.text() : null;
 * };
 *
 * const client = createConvexClient("https://happy-otter-123.convex.cloud");
 * client.setAuth(fetchToken);
 * ```
 * @see {@link ConvexClientLike}
 * @since 1.0.0
 */
export type AuthTokenFetcherLike = (args: {
  readonly forceRefreshToken: boolean;
}) => Promise<string | null | undefined>;

/**
 * Any query function reference: a generated `api.module.fn` from `convex/_generated/api`, or one
 * built with `makeFunctionReference` from `convex/server`. The `FunctionReference_future` shape is
 * not accepted, because convex 1.20 does not have it.
 *
 * @example
 * ```ts
 * import { type QueryRef, useQuery } from "@shadow-js/convex";
 *
 * // Stands in for `api.tasks.list` from convex/_generated/api.
 * declare const listTasks: QueryRef;
 *
 * export function useOpenTasks() {
 *   return useQuery(listTasks, { done: false });
 * }
 * ```
 * @see {@link useQuery}
 * @since 1.0.0
 */
export type QueryRef = FunctionReference<"query">;

/**
 * Any mutation function reference, generated (`api.tasks.add`) or built with
 * `makeFunctionReference`.
 *
 * @example
 * ```ts
 * import { type MutationRef, useMutation } from "@shadow-js/convex";
 *
 * // Stands in for `api.tasks.add` from convex/_generated/api.
 * declare const addTask: MutationRef;
 *
 * export function useAddTask() {
 *   return useMutation(addTask);
 * }
 * ```
 * @see {@link useMutation}
 * @since 1.0.0
 */
export type MutationRef = FunctionReference<"mutation">;

/**
 * Any action function reference, generated (`api.emails.send`) or built with
 * `makeFunctionReference`.
 *
 * @example
 * ```ts
 * import { type ActionRef, useAction } from "@shadow-js/convex";
 *
 * // Stands in for `api.emails.send` from convex/_generated/api.
 * declare const sendEmail: ActionRef;
 *
 * export function useSendEmail() {
 *   return useAction(sendEmail);
 * }
 * ```
 * @see {@link useAction}
 * @since 1.0.0
 */
export type ActionRef = FunctionReference<"action">;

/**
 * The part of `ConvexClient` (from `convex/browser`) that the hooks depend on. The real client is
 * assignable to it; tests use a hand-written implementation instead, so no network is needed.
 *
 * `clearAuth` is optional because `ConvexClient` does not expose it; the provider then calls the
 * `clearAuth` of its base client (`client.client`), and only without that registers a fetcher that
 * returns `null` (which stops refreshing but does not make the server forget the old identity).
 *
 * @example
 * ```ts
 * import { type ConvexClientLike, createConvexClient } from "@shadow-js/convex";
 *
 * const client: ConvexClientLike = createConvexClient("https://happy-otter-123.convex.cloud");
 * ```
 * @see {@link ConvexProvider}
 * @see {@link createConvexClient}
 * @since 1.0.0
 */
export interface ConvexClientLike {
  /**
   * Subscribes to `query` with `args`. `callback` receives every new result and `onError` the error
   * of a failed run. Returns the function that ends the subscription; the hooks call it when the
   * component is disposed or the arguments change.
   */
  onUpdate<Query extends QueryRef>(
    query: Query,
    args: FunctionArgs<Query>,
    callback: (result: FunctionReturnType<Query>) => unknown,
    onError?: (error: Error) => unknown,
  ): () => void;
  /**
   * Runs `mutation` with `args` and resolves with its return value. `options.optimisticUpdate` is
   * applied to the local query results until the server answers.
   */
  mutation<Mutation extends MutationRef>(
    mutation: Mutation,
    args: FunctionArgs<Mutation>,
    options?: MutationOptions,
  ): Promise<Awaited<FunctionReturnType<Mutation>>>;
  /** Runs `action` with `args` and resolves with its return value. */
  action<Action extends ActionRef>(
    action: Action,
    args: FunctionArgs<Action>,
  ): Promise<Awaited<FunctionReturnType<Action>>>;
  /**
   * Registers `fetchToken` as the source of the auth token. `onChange` is called with `true` when
   * the server accepts the token and `false` when it rejects it.
   */
  setAuth(fetchToken: AuthTokenFetcherLike, onChange?: (isAuthenticated: boolean) => void): void;
  /**
   * Removes the token and signs the connection out. Optional: `ConvexClient` does not have it, and
   * the provider then uses `client.clearAuth` instead.
   */
  clearAuth?(): void;
  /**
   * The base client behind `ConvexClient` (its public `client` getter). It has the real `clearAuth`,
   * which tells the server the connection is signed out so subscribed queries run again without an
   * identity. Its `url` is the deployment URL: when present, `useUploadFile` accepts an upload URL
   * only on that origin (or one named in the call's `allowedOrigins`).
   */
  readonly client?: { clearAuth?(): void; readonly url?: string };
}

/**
 * The part of `ConvexHttpClient` used on the server, where subscriptions do not exist: one-shot
 * queries only. The real HTTP client (`new ConvexHttpClient(url)` from `convex/browser`) is
 * assignable to it.
 *
 * @example
 * ```tsx
 * import { type ConvexHttpClientLike, ServerConvexProvider } from "@shadow-js/convex";
 * import { renderToStringAsync } from "@shadow-js/web/server";
 *
 * // Stands in for `new ConvexHttpClient(url)` from convex/browser.
 * declare const http: ConvexHttpClientLike;
 *
 * function App() {
 *   return <main>Tasks</main>;
 * }
 *
 * const { html } = await renderToStringAsync(() => (
 *   <ServerConvexProvider client={http}>
 *     <App />
 *   </ServerConvexProvider>
 * ));
 * ```
 * @see {@link ServerConvexProvider}
 * @see {@link preloadQuery}
 * @since 1.0.0
 */
export interface ConvexHttpClientLike {
  /**
   * Runs `query` once over HTTP and resolves with its result. Omit the arguments for a query
   * without arguments.
   */
  query<Query extends QueryRef>(
    query: Query,
    ...args: OptionalRestArgs<Query>
  ): Promise<FunctionReturnType<Query>>;
}

/**
 * Reactive state of an auth integration, as read by {@link useConvexAuth}. Both members are
 * accessors, so reading them inside a computation subscribes it to changes.
 *
 * @example
 * ```tsx
 * import { type ConvexAuthState, useConvexAuth } from "@shadow-js/convex";
 *
 * function sessionLabel(auth: ConvexAuthState): string {
 *   if (auth.isLoading()) return "Checking session";
 *   return auth.isAuthenticated() ? "Signed in" : "Signed out";
 * }
 *
 * export function SessionBadge() {
 *   const auth = useConvexAuth();
 *   return <span>{() => sessionLabel(auth)}</span>;
 * }
 * ```
 * @see {@link ConvexProviderWithAuth}
 * @since 1.0.0
 */
export interface ConvexAuthState {
  /**
   * True while the server has not yet confirmed (or rejected) the current token, and while the
   * auth provider itself is loading. On the server, where there is no provider, it is always true.
   */
  readonly isLoading: () => boolean;
  /** True once the provider reports a signed-in user and the server has confirmed the token. */
  readonly isAuthenticated: () => boolean;
}

/**
 * Value returned by the `useAuth` prop of {@link ConvexProviderWithAuth}: the auth provider's
 * (Clerk, Auth0, your own) view of the session, and how to get a token for Convex.
 *
 * @example
 * ```ts
 * import type { AuthHookState } from "@shadow-js/convex";
 *
 * async function fetchAccessToken(): Promise<string | null> {
 *   const response = await fetch("/auth/convex-token");
 *   return response.ok ? response.text() : null;
 * }
 *
 * export function useSessionAuth(): AuthHookState {
 *   return {
 *     isLoading: false,
 *     isAuthenticated: document.cookie.includes("signed_in=1"),
 *     fetchAccessToken,
 *   };
 * }
 * ```
 * @since 1.0.0
 */
export interface AuthHookState {
  /** True while the auth provider has not decided whether a user is signed in. */
  readonly isLoading: boolean;
  /**
   * True when the auth provider has a signed-in user. Only then is `fetchAccessToken` registered
   * with the client.
   */
  readonly isAuthenticated: boolean;
  /**
   * Returns a JWT, or `null` when none can be obtained (the user is then treated as signed out).
   * `forceRefreshToken` asks for a new token instead of a cached one. Keep the function's identity
   * stable: a new function re-registers the token with the client.
   */
  fetchAccessToken(args: { readonly forceRefreshToken: boolean }): Promise<string | null>;
}

/**
 * Optimistic update function for a mutation, typed from the mutation's arguments. It receives the
 * client's local query store and the call's arguments, and may change local query results with
 * `setQuery` until the server answers.
 *
 * @example
 * ```ts
 * import { type MutationRef, type OptimisticUpdateFor, type QueryRef, useMutation } from "@shadow-js/convex";
 *
 * // Stand in for `api.tasks.list` and `api.tasks.add` from convex/_generated/api.
 * declare const listTasks: QueryRef;
 * declare const addTask: MutationRef;
 *
 * const showNewTask: OptimisticUpdateFor<typeof addTask> = (store, args: { title: string }) => {
 *   const current: { _id: string; title: string }[] | undefined = store.getQuery(listTasks, {});
 *   if (current === undefined) return;
 *   store.setQuery(listTasks, {}, [...current, { _id: "pending", title: args.title }]);
 * };
 *
 * export function useAddTask() {
 *   return useMutation(addTask, { optimisticUpdate: showNewTask });
 * }
 * ```
 * @see {@link useMutation}
 * @since 1.0.0
 */
export type OptimisticUpdateFor<Mutation extends MutationRef> = OptimisticUpdate<
  FunctionArgs<Mutation>
>;
