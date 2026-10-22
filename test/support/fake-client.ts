import type { AuthTokenFetcher, MutationOptions } from "convex/browser";
import { type FunctionArgs, getFunctionName } from "convex/server";
import { stableKey } from "../../src/internal/args";
import type {
  ActionRef,
  ConvexClientLike,
  ConvexHttpClientLike,
  MutationRef,
  QueryRef,
} from "../../src/types";

/** One subscription the hooks opened. `active` is false once it was stopped. */
export interface FakeSubscription {
  readonly id: number;
  readonly name: string;
  readonly args: unknown;
  readonly argsKey: string;
  active: boolean;
  deliver(value: unknown): void;
  fail(error: unknown): void;
}

/** A mutation or action call the hooks made, and the promise they are waiting on. */
export interface FakeCall {
  readonly name: string;
  readonly args: unknown;
  readonly options: MutationOptions | undefined;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

/** Recorded `setAuth` / `clearAuth` calls. */
export type AuthCall =
  | {
      readonly kind: "set";
      readonly fetchToken: AuthTokenFetcher;
      readonly onChange: ((ok: boolean) => void) | undefined;
    }
  | { readonly kind: "clear" };

function settleable(): {
  promise: Promise<unknown>;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
} {
  let resolve: (value: unknown) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve: (value) => resolve(value), reject: (reason) => reject(reason) };
}

/**
 * An in-memory `ConvexClientLike`. It records every subscription, call and auth change, and the
 * test decides when each result arrives. Nothing touches the network.
 */
export class FakeConvexClient implements ConvexClientLike {
  /** Every subscription ever opened, in order. */
  readonly created: FakeSubscription[] = [];
  readonly mutations: FakeCall[] = [];
  readonly actions: FakeCall[] = [];
  readonly authCalls: AuthCall[] = [];
  /** Optional `clearAuth`, present unless the client was built with `withClearAuth: false`. */
  clearAuth?: () => void;
  /** The underlying base client of the real `ConvexClient` (its public `client` getter), when built `viaBase`. */
  client?: { clearAuth(): void };
  private nextId = 0;
  private readonly live = new Map<number, FakeSubscription>();

  constructor(options: { readonly withClearAuth?: boolean; readonly viaBase?: boolean } = {}) {
    if (options.viaBase === true) {
      this.client = {
        clearAuth: () => {
          this.authCalls.push({ kind: "clear" });
        },
      };
    } else if (options.withClearAuth !== false) {
      this.clearAuth = () => {
        this.authCalls.push({ kind: "clear" });
      };
    }
  }

  /** Subscriptions that are still open. */
  get liveCount(): number {
    return this.live.size;
  }

  /** The open subscriptions for `name`, optionally only those with arguments equal to `args`. */
  subscriptionsFor(query: QueryRef | string, args?: unknown): FakeSubscription[] {
    const name = typeof query === "string" ? query : getFunctionName(query);
    const key = args === undefined ? undefined : stableKey(args);
    return [...this.live.values()].filter(
      (sub) => sub.name === name && (key === undefined || sub.argsKey === key),
    );
  }

  /** Delivers `value` to every open subscription for `query` with `args` (all args if omitted). */
  emit(query: QueryRef | string, value: unknown, args?: unknown): number {
    const targets = this.subscriptionsFor(query, args);
    for (const sub of targets) sub.deliver(value);
    return targets.length;
  }

  /** Reports `error` through every open subscription for `query`. */
  fail(query: QueryRef | string, error: unknown, args?: unknown): number {
    const targets = this.subscriptionsFor(query, args);
    for (const sub of targets) sub.fail(error);
    return targets.length;
  }

  onUpdate<Query extends QueryRef>(
    query: Query,
    args: FunctionArgs<Query>,
    callback: (result: never) => unknown,
    onError?: (error: Error) => unknown,
  ): () => void {
    const id = this.nextId;
    this.nextId += 1;
    const sub: FakeSubscription = {
      id,
      name: getFunctionName(query),
      args,
      argsKey: stableKey(args),
      active: true,
      // Deliberately not guarded by `active`: a real client may hand over a result that was already
      // in flight when the subscription stopped. The hook under test must ignore it.
      deliver: (value) => {
        callback(value as never);
      },
      fail: (error) => {
        if (onError !== undefined)
          onError(error instanceof Error ? error : new Error(String(error)));
      },
    };
    this.created.push(sub);
    this.live.set(id, sub);
    return () => {
      sub.active = false;
      this.live.delete(id);
    };
  }

  mutation<Mutation extends MutationRef>(
    mutation: Mutation,
    args: FunctionArgs<Mutation>,
    options?: MutationOptions,
  ): Promise<never> {
    const call = settleable();
    this.mutations.push({ name: getFunctionName(mutation), args, options, ...call });
    return call.promise as Promise<never>;
  }

  action<Action extends ActionRef>(action: Action, args: FunctionArgs<Action>): Promise<never> {
    const call = settleable();
    this.actions.push({ name: getFunctionName(action), args, options: undefined, ...call });
    return call.promise as Promise<never>;
  }

  setAuth(fetchToken: AuthTokenFetcher, onChange?: (isAuthenticated: boolean) => void): void {
    this.authCalls.push({ kind: "set", fetchToken, onChange });
  }
}

/**
 * An in-memory `ConvexHttpClientLike`: each `query` call waits until the test resolves it.
 */
export class FakeHttpClient implements ConvexHttpClientLike {
  readonly queries: Array<{
    name: string;
    args: unknown;
    resolve(value: unknown): void;
    reject(reason: unknown): void;
  }> = [];

  query<Query extends QueryRef>(query: Query, args?: unknown): Promise<never> {
    const call = settleable();
    this.queries.push({ name: getFunctionName(query), args, ...call });
    return call.promise as Promise<never>;
  }
}

/** A fetcher that answers immediately with `value`, counting its calls. */
export function immediate<T>(value: T): { fetch: () => Promise<T>; calls: () => number } {
  let calls = 0;
  return {
    fetch: () => {
      calls += 1;
      return Promise.resolve(value);
    },
    calls: () => calls,
  };
}
