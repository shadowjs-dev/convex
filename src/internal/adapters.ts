import type { MutationOptions } from "convex/browser";
import type {
  ActionRef,
  ConvexClientLike,
  ConvexHttpClientLike,
  MutationRef,
  QueryRef,
} from "../types";

/*
 * Thin adapters between the typed public API and the convex client. The internal functions take
 * `args: unknown`: `FunctionArgs` of the base reference types is `any`, so the boundary is typed
 * once here and the generic public signatures carry the real types.
 */

/** Starts a subscription. Returns the unsubscribe function. @internal */
export function subscribeTo(
  client: ConvexClientLike,
  query: QueryRef,
  args: unknown,
  onValue: (value: unknown) => void,
  onError: (error: unknown) => void,
): () => void {
  return client.onUpdate(query, args, onValue, onError);
}

/** Runs a mutation through the client. @internal */
export function runMutation(
  client: ConvexClientLike,
  mutation: MutationRef,
  args: unknown,
  options: MutationOptions | undefined,
): Promise<unknown> {
  return client.mutation(mutation, args, options);
}

/** Runs an action through the client. @internal */
export function runAction(
  client: ConvexClientLike,
  action: ActionRef,
  args: unknown,
): Promise<unknown> {
  return client.action(action, args);
}

/** Runs a one-shot query over HTTP (server side). @internal */
export function runHttpQuery(
  http: ConvexHttpClientLike,
  query: QueryRef,
  args: unknown,
): Promise<unknown> {
  return http.query(query, args);
}
