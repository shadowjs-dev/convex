import { type Accessor, type Context, createContext } from "@shadow-js/core";
import type { ConvexAuthState, ConvexClientLike, ConvexHttpClientLike } from "../types";

/**
 * What `<ConvexProvider>` provides: the browser client and the counter of the mutations in flight
 * under that provider.
 * @internal
 */
export interface ConvexScope {
  readonly client: ConvexClientLike;
  readonly pending: PendingCounter;
}

/**
 * The scope provided by `<ConvexProvider>`. `null` outside a provider.
 * @internal
 */
export const ConvexContext: Context<ConvexScope | null> = createContext<ConvexScope | null>(null, {
  name: "Convex",
});

/**
 * The one-shot HTTP client provided by `<ServerConvexProvider>` for server rendering.
 * @internal
 */
export const ServerConvexContext: Context<ConvexHttpClientLike | null> =
  createContext<ConvexHttpClientLike | null>(null, {
    name: "ServerConvex",
  });

/**
 * Auth state provided by `<ConvexProviderWithAuth>`. `null` outside that provider.
 * @internal
 */
export const ConvexAuthContext: Context<ConvexAuthState | null> =
  createContext<ConvexAuthState | null>(null, {
    name: "ConvexAuth",
  });

/**
 * Counts the mutations in flight under one `<ConvexProvider>`. The provider creates it; each
 * mutation handle reports its calls to it, so `usePendingMutations` and the unload guard see every
 * handle of the provider at once.
 * @internal
 */
export interface PendingCounter {
  /** The number of mutations that have not settled yet. Tracked. */
  readonly count: Accessor<number>;
  /** Called when a mutation call starts. */
  start(): void;
  /** Called exactly once when a mutation call settles, whether it resolved or rejected. */
  settle(): void;
}
