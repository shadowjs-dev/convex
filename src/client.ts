import {
  type Accessor,
  batch,
  isServer,
  useContext,
  useMemo,
  useRenderEffect,
  useSignal,
} from "@shadow-js/core";
import { ConvexClient, type ConvexClientOptions } from "convex/browser";
import {
  ConvexContext,
  type ConvexScope,
  type PendingCounter,
  ServerConvexContext,
} from "./internal/contexts";
import { checkDeploymentUrl } from "./internal/deployment-url";
import type { ConvexClientLike, ConvexHttpClientLike } from "./types";

/** Shown by the browser when the user tries to leave while a mutation is unsettled. @internal */
const UNLOAD_MESSAGE = "A change is still being saved. Leaving now may lose it.";

/**
 * Props of {@link ConvexProvider}.
 *
 * @example
 * ```tsx
 * import { ConvexProvider, type ConvexProviderProps, createConvexClient } from "@shadow-js/convex";
 *
 * const props: ConvexProviderProps = {
 *   client: createConvexClient("https://happy-otter-123.convex.cloud"),
 *   unloadGuard: false,
 *   children: <main>Tasks</main>,
 * };
 *
 * export const app = ConvexProvider(props);
 * ```
 * @since 1.0.0
 */
export interface ConvexProviderProps {
  /** The client every hook below this provider uses. */
  readonly client: ConvexClientLike;
  /**
   * Asks the browser to confirm before the page unloads while a mutation of this provider has not
   * settled. Default `true`. Pass `false` to opt out, for example when the page saves its own drafts.
   * Actions and queries never trigger it.
   */
  readonly unloadGuard?: boolean;
  /** The application. Read lazily inside the provider's scope. */
  readonly children?: unknown;
}

/**
 * Props of {@link ServerConvexProvider}.
 *
 * @example
 * ```tsx
 * import {
 *   type ConvexHttpClientLike,
 *   ServerConvexProvider,
 *   type ServerConvexProviderProps,
 * } from "@shadow-js/convex";
 *
 * // Stands in for `new ConvexHttpClient(url)` from convex/browser.
 * declare const http: ConvexHttpClientLike;
 *
 * const props: ServerConvexProviderProps = { client: http, children: <main>Tasks</main> };
 *
 * export const page = ServerConvexProvider(props);
 * ```
 * @since 1.0.0
 */
export interface ServerConvexProviderProps {
  /** One-shot HTTP client used by `useQuery` while the page is rendered on the server. */
  readonly client: ConvexHttpClientLike;
  /** The application. Read lazily inside the provider's scope. */
  readonly children?: unknown;
}

/**
 * Makes `client` available to every hook in `children`. Put it once, near the root. It also counts
 * the mutations of its hooks that have not settled ({@link usePendingMutations}) and, unless
 * `unloadGuard` is `false`, asks the browser to confirm before the page unloads while one is
 * pending. The nearest provider wins when providers are nested.
 *
 * @param props See {@link ConvexProviderProps}.
 * @returns The rendered children.
 * @example
 * ```tsx
 * import { ConvexProvider, createConvexClient } from "@shadow-js/convex";
 * import { render } from "@shadow-js/web";
 *
 * const client = createConvexClient("https://happy-otter-123.convex.cloud");
 *
 * function App() {
 *   return <main>Tasks</main>;
 * }
 *
 * const dispose = render(
 *   () => (
 *     <ConvexProvider client={client}>
 *       <App />
 *     </ConvexProvider>
 *   ),
 *   document.body,
 * );
 *
 * window.addEventListener("pagehide", dispose);
 * ```
 * @see {@link ConvexProviderWithAuth}
 * @see {@link useConvex}
 * @since 1.0.0
 */
export function ConvexProvider(props: ConvexProviderProps): unknown {
  const pending = createPendingCounter();
  if (!isServer && props.unloadGuard !== false) installUnloadGuard(pending);
  const scope: ConvexScope = { client: props.client, pending };
  return ConvexContext({
    value: scope,
    get children() {
      return props.children;
    },
  });
}

/**
 * Counts the mutations in flight for one provider. The count is a signal, so a binding that reads
 * it updates when a call starts or settles.
 * @internal
 */
function createPendingCounter(): PendingCounter {
  const [inflight, setInflight] = useSignal(0);
  return {
    count: inflight,
    start(): void {
      batch(() => setInflight((count) => count + 1));
    },
    settle(): void {
      batch(() => setInflight((count) => count - 1));
    },
  };
}

/**
 * Adds a `beforeunload` listener while the counter is above zero, and removes it when the count
 * returns to zero or the provider is disposed. Skipped where there is no `window`.
 * @internal
 */
function installUnloadGuard(counter: PendingCounter): void {
  const pending = useMemo<boolean>(() => counter.count() > 0);
  useRenderEffect(pending, (isPending) => {
    if (!isPending || typeof window === "undefined") return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent): string => {
      event.preventDefault();
      event.returnValue = UNLOAD_MESSAGE;
      return UNLOAD_MESSAGE;
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  });
}

/**
 * Reads how many mutations of the nearest {@link ConvexProvider} have not settled yet. Use it for
 * a global saving indicator; `useMutation(...).pending()` covers a single mutation. Actions and
 * uploads are not counted.
 *
 * @returns An accessor of the count (0 on the server, where nothing is written).
 * @throws Error when there is no `ConvexProvider` above the component (in the browser). The message
 * starts with `usePendingMutations() must be used inside <ConvexProvider>`.
 * @example
 * ```tsx
 * import { usePendingMutations } from "@shadow-js/convex";
 *
 * export function SavingIndicator() {
 *   const saving = usePendingMutations();
 *   return (
 *     <p role="status" hidden={saving() === 0}>
 *       Saving
 *     </p>
 *   );
 * }
 * ```
 * @see {@link useMutation}
 * @since 1.0.0
 */
export function usePendingMutations(): Accessor<number> {
  const scope = useContext(ConvexContext);
  if (scope !== null) return scope.pending.count;
  if (!isServer) throw missingProvider("usePendingMutations", "ConvexProvider");
  return () => 0;
}

/**
 * Provides a one-shot HTTP client to `useQuery` during server rendering. Subscriptions do not exist
 * on the server, so queries are fetched once through this client and the result is handed to the
 * browser through the resource cache. A query with its own `options.preload` uses that instead.
 *
 * @param props See {@link ServerConvexProviderProps}.
 * @returns The rendered children.
 * @example
 * ```tsx
 * import { type ConvexHttpClientLike, type QueryRef, ServerConvexProvider, useQuery } from "@shadow-js/convex";
 * import { For } from "@shadow-js/web";
 * import { renderToStringAsync } from "@shadow-js/web/server";
 *
 * // Stand in for `new ConvexHttpClient(url)` from convex/browser and `api.tasks.list`.
 * declare const http: ConvexHttpClientLike;
 * declare const listTasks: QueryRef;
 *
 * function Tasks() {
 *   const tasks = useQuery(listTasks, {}, { key: "tasks" });
 *   return (
 *     <ul>
 *       <For each={tasks()}>{(task: { title: string }) => <li>{task.title}</li>}</For>
 *     </ul>
 *   );
 * }
 *
 * const { html, data } = await renderToStringAsync(() => (
 *   <ServerConvexProvider client={http}>
 *     <Tasks />
 *   </ServerConvexProvider>
 * ));
 * ```
 * @see {@link preloadQuery}
 * @since 1.0.0
 */
export function ServerConvexProvider(props: ServerConvexProviderProps): unknown {
  return ServerConvexContext({
    value: props.client,
    get children() {
      return props.children;
    },
  });
}

/**
 * Reads the client from the nearest {@link ConvexProvider} (or {@link ConvexProviderWithAuth}). Use
 * it for a call the hooks do not cover, for example a one-off query from an event handler.
 *
 * @returns The browser client.
 * @throws Error when no `ConvexProvider` is above the caller, on the server as well as in the
 * browser. The message starts with `useConvex() must be used inside <ConvexProvider>`.
 * @example
 * ```tsx
 * import { type MutationRef, useConvex } from "@shadow-js/convex";
 *
 * // Stands in for `api.tasks.clear` from convex/_generated/api.
 * declare const clearTasks: MutationRef;
 *
 * export function ClearButton() {
 *   const client = useConvex();
 *   return (
 *     <button type="button" onClick={() => void client.mutation(clearTasks, {})}>
 *       Clear
 *     </button>
 *   );
 * }
 * ```
 * @since 1.0.0
 */
export function useConvex(): ConvexClientLike {
  const scope = useContext(ConvexContext);
  if (scope === null) throw missingProvider("useConvex", "ConvexProvider");
  return scope.client;
}

/**
 * Creates the real browser client. The URL is the deployment URL, for example
 * `https://happy-otter-123.convex.cloud`; the client connects as soon as it is constructed. Outer
 * whitespace (a trailing newline from an environment variable) is trimmed, and the client is given
 * the canonical form of the URL, without a trailing slash.
 *
 * @param url The deployment URL.
 * @param options Options of `ConvexClient` from `convex/browser` (for example `{ disabled: true }`
 * on the server).
 * @returns A `ConvexClient`, which satisfies {@link ConvexClientLike}.
 * @throws TypeError when the URL is empty, is not a URL, or is plain http for a host other than
 * localhost, `127.0.0.1` or `[::1]`; also when it carries credentials, a query or a fragment, or
 * has a space, a backslash or a missing `//`. The token travels on this connection, so only https
 * (and loopback http for the local backend) is accepted. The message never contains the URL.
 * @example
 * ```ts
 * import { createConvexClient } from "@shadow-js/convex";
 *
 * export const client = createConvexClient("https://happy-otter-123.convex.cloud");
 * ```
 * @see {@link ConvexProvider}
 * @since 1.0.0
 */
export function createConvexClient(url: string, options?: ConvexClientOptions): ConvexClient {
  return new ConvexClient(checkDeploymentUrl(url), options);
}

/**
 * What the mutation and upload hooks use: the provider's scope in the browser. On the server a page
 * that calls such a hook must still render, so there the calls reject with an error that says they
 * run in the browser, nothing is sent, and nothing is counted. Outside a provider in the browser the
 * hook throws, as `useConvex` does.
 *
 * @internal
 */
export function useConvexForCalls(hook: string): ConvexScope {
  const scope = useContext(ConvexContext);
  if (scope !== null) return scope;
  if (!isServer) throw missingProvider(hook, "ConvexProvider");
  return { client: serverCallsUnavailable(hook), pending: NO_PENDING };
}

/** The counter used on the server: nothing is written there, so the count stays at zero. @internal */
const NO_PENDING: PendingCounter = {
  count: () => 0,
  start: () => undefined,
  settle: () => undefined,
};

/** A client for server rendering: nothing subscribes and every call rejects. @internal */
function serverCallsUnavailable(hook: string): ConvexClientLike {
  const reject = (): Promise<never> =>
    Promise.reject(
      new Error(
        `${hook}() was called while rendering on the server, where there is no ConvexProvider. Mutations and actions run in the browser: call them from an event handler or an effect.`,
      ),
    );
  return {
    onUpdate: () => () => undefined,
    mutation: reject,
    action: reject,
    setAuth: () => undefined,
  };
}

/** Builds the error thrown when a hook is used outside its provider. @internal */
export function missingProvider(hook: string, provider: string): Error {
  return new Error(
    `${hook}() must be used inside <${provider}>. Render the component under ${provider} (or check that its module is not loaded twice).`,
  );
}
