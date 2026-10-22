import { ConvexHttpClient } from "convex/browser";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { checkDeploymentUrl } from "./internal/deployment-url";
import { createGuardedFetch, type FetchLimits } from "./internal/guarded-fetch";
import type { ActionRef, MutationRef, QueryRef } from "./types";

/**
 * The part of `ConvexHttpClient` the server helpers use: one call per function kind, and a token.
 * The real client is wrapped by {@link createHttpCaller}; tests pass a fake through the
 * `createClient` option of {@link ServerCallOptions}.
 *
 * @example
 * ```ts
 * import { type ConvexHttpCallerLike, fetchQuery, type QueryRef } from "@shadow-js/convex";
 *
 * // Stands in for `api.tasks.list` from convex/_generated/api.
 * declare const listTasks: QueryRef;
 *
 * // A caller that answers without a network, for a unit test of a loader.
 * const fake: ConvexHttpCallerLike = {
 *   setAuth: () => undefined,
 *   clearAuth: () => undefined,
 *   query: async () => [{ _id: "1", title: "Write the docs" }],
 *   mutation: async () => null,
 *   action: async () => null,
 * };
 *
 * const tasks = await fetchQuery("https://happy-otter-123.convex.cloud", listTasks, {}, {
 *   createClient: () => fake,
 * });
 * ```
 * @since 1.0.0
 */
export interface ConvexHttpCallerLike {
  /** Sets the JWT sent with every following call. */
  setAuth(token: string): void;
  /**
   * Removes the token. The helpers call it for a call without a token, so a caller that a custom
   * `createClient` shares between requests cannot carry the previous request's identity. Optional,
   * for callers written before it existed; such a caller must not be shared.
   */
  clearAuth?(): void;
  /** Runs `query` once with `args` and resolves with its result. */
  query(query: QueryRef, args: unknown): Promise<unknown>;
  /** Runs `mutation` once with `args` and resolves with its result. */
  mutation(mutation: MutationRef, args: unknown): Promise<unknown>;
  /** Runs `action` once with `args` and resolves with its result. */
  action(action: ActionRef, args: unknown): Promise<unknown>;
}

/**
 * Options of the server helpers {@link fetchQuery}, {@link fetchMutation} and {@link fetchAction}.
 *
 * @example
 * ```ts
 * import { fetchQuery, type QueryRef, type ServerCallOptions } from "@shadow-js/convex";
 *
 * // Stands in for `api.tasks.list` from convex/_generated/api.
 * declare const listTasks: QueryRef;
 *
 * export async function loadTasks(token: string | null) {
 *   const options: ServerCallOptions = { token, timeoutMs: 5_000, maxResponseBytes: 1_048_576 };
 *   return fetchQuery("https://happy-otter-123.convex.cloud", listTasks, {}, options);
 * }
 * ```
 * @since 1.0.0
 */
export interface ServerCallOptions {
  /**
   * The JWT of the signed-in user, for example the Clerk token for the `convex` template, from
   * `auth.getToken({ template: "convex" })` on the server. `null`, `""` or omitted makes an
   * anonymous call, which sees only what the functions allow signed-out callers to see. Pass the
   * JWT alone: a value with a space, a control character or a non-ASCII character (a `Bearer `
   * prefix, a trailing newline) is rejected with a `TypeError` before any request is made.
   */
  readonly token?: string | null;
  /**
   * Builds the HTTP client for one call from the checked deployment URL. The default is
   * {@link createHttpCaller}. It is called for every call, so the token of one request can never
   * reach another request; a caller that returns a shared client must implement `clearAuth`.
   */
  readonly createClient?: (url: string) => ConvexHttpCallerLike;
  /**
   * Milliseconds the call may take, reading the body included; the call then rejects with a
   * `TimeoutError`. Default 30 000 for a query or mutation and 600 000 for an action. Applies to the
   * default client only.
   */
  readonly timeoutMs?: number;
  /**
   * Largest response body accepted, in bytes; a larger one rejects with a `RangeError`. Default
   * 33 554 432 (32 MiB, above the 16 MiB Convex allows a function to return). Applies to the
   * default client only.
   */
  readonly maxResponseBytes?: number;
}

/** Default deadline of a query or mutation, in milliseconds. @internal */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Default deadline of an action: actions may run for minutes. @internal */
const DEFAULT_ACTION_TIMEOUT_MS = 600_000;
/** Default response bound: Convex caps a function's return value at 16 MiB. @internal */
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * What a bearer token may look like: printable ASCII with no space. A JWT is base64url and dots.
 * Anything else would make `fetch` reject the header with a message that contains the whole token.
 * @internal
 */
const BEARER_TOKEN = /^[\u0021-\u007e]+$/u;

/**
 * Wraps the real `ConvexHttpClient` in the {@link ConvexHttpCallerLike} shape. Every request goes
 * through a guarded `fetch`: it is sent only to the deployment's origin, a redirect makes the call
 * reject instead of being followed, and the exchange has a deadline and a response size limit.
 * {@link fetchQuery} and its siblings use it unless `createClient` is given.
 *
 * @param url The deployment URL, for example `https://happy-otter-123.convex.cloud`.
 * @param limits `timeoutMs`: milliseconds a call may take, reading the body included, before it
 * rejects with a `DOMException` named `TimeoutError` (default 30 000). `maxResponseBytes`: largest
 * response body accepted, in bytes, before the call rejects with a `RangeError` (default
 * 33 554 432, 32 MiB).
 * @returns A caller that makes one HTTP request per call.
 * @throws TypeError when the URL is empty, is not a URL, or is plain http for a host other than
 * localhost, `127.0.0.1` or `[::1]`; also when it carries credentials, a query or a fragment.
 * @example
 * ```ts
 * import { createHttpCaller, type QueryRef } from "@shadow-js/convex";
 *
 * // Stands in for `api.tasks.list` from convex/_generated/api.
 * declare const listTasks: QueryRef;
 *
 * const caller = createHttpCaller("https://happy-otter-123.convex.cloud", { timeoutMs: 10_000 });
 * const tasks = await caller.query(listTasks, { done: false });
 * ```
 * @see {@link ServerCallOptions}
 * @since 1.0.0
 */
export function createHttpCaller(
  url: string,
  limits: Partial<FetchLimits> = {},
): ConvexHttpCallerLike {
  const checked = checkDeploymentUrl(url);
  // The guarded fetch is the only transport: it pins the origin, refuses redirects, and bounds the
  // time and size of the exchange. A convex version that ignores the `fetch` option would fall
  // back to the global fetch, which strips the token on a cross-origin redirect but nothing more.
  const http = new ConvexHttpClient(checked, {
    fetch: createGuardedFetch(checked, {
      timeoutMs: limits.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxResponseBytes: limits.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    }),
  });
  return {
    setAuth: (token) => http.setAuth(token),
    clearAuth: () => http.clearAuth(),
    query: (query, args) => http.query(query, args),
    mutation: (mutation, args) => http.mutation(mutation, args),
    action: (action, args) => http.action(action, args),
  };
}

/** Rejects a missing or plain-http deployment URL before any client is built. @internal */
function checkUrl(url: string): string {
  return checkDeploymentUrl(url);
}

/**
 * Validates the token before it reaches any client. Not echoed in the error: a token that `fetch`
 * rejects (a trailing newline from an environment variable, say) would otherwise put itself into
 * the message of the thrown error.
 * @internal
 */
function checkToken(token: unknown): string | null {
  if (token === undefined || token === null || token === "") return null;
  if (typeof token !== "string") {
    throw new TypeError("The Convex auth token must be a string, null or omitted.");
  }
  if (!BEARER_TOKEN.test(token)) {
    throw new TypeError(
      "The Convex auth token has a space, a control character or a non-ASCII character. Pass the JWT alone, without a Bearer prefix or a trailing newline.",
    );
  }
  return token;
}

/**
 * Builds the client for one call and sets its token, or clears it when there is none. Clearing
 * matters for a `createClient` that returns a shared caller: without it, an anonymous call would
 * run with the identity of whoever called last.
 * @internal
 */
function callerFor(
  url: string,
  options: ServerCallOptions,
  defaultTimeoutMs: number,
): ConvexHttpCallerLike {
  const checked = checkUrl(url);
  const token = checkToken(options.token);
  const caller =
    options.createClient === undefined
      ? createHttpCaller(checked, {
          timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
          ...(options.maxResponseBytes === undefined
            ? {}
            : { maxResponseBytes: options.maxResponseBytes }),
        })
      : options.createClient(checked);
  if (token === null) caller.clearAuth?.();
  else caller.setAuth(token);
  return caller;
}

/**
 * Runs a query on the server, once, over HTTP. Use it in a Dusk loader or server function, where
 * there is no subscription: the result is returned, not watched. Each call builds its own client,
 * so the token of one request never reaches another.
 *
 * @param url The deployment URL (`import.meta.env.VITE_CONVEX_URL` or a server variable).
 * @param query A query reference, for example `api.tasks.list`.
 * @param args The arguments; omit for a query without arguments.
 * @param options See {@link ServerCallOptions}.
 * @returns A promise of the query result. It rejects with the function's error, with a
 * `DOMException` named `TimeoutError` after `timeoutMs` (default 30 000), or with a `RangeError`
 * when the response is larger than `maxResponseBytes`.
 * @throws TypeError synchronously when `url` is empty, is not a URL, or is not https (http only for
 * localhost, `127.0.0.1` or `[::1]`), and when `options.token` is not a string, `null` or omitted,
 * or has a space, a control character or a non-ASCII character.
 * @example
 * ```ts
 * import { fetchQuery, type QueryRef } from "@shadow-js/convex";
 *
 * // Stands in for `api.tasks.list` from convex/_generated/api.
 * declare const listTasks: QueryRef;
 *
 * export async function loadOpenTasks(token: string | null) {
 *   return fetchQuery("https://happy-otter-123.convex.cloud", listTasks, { done: false }, { token });
 * }
 * ```
 * @see {@link preloadQuery}
 * @since 1.0.0
 */
export function fetchQuery<Query extends QueryRef>(
  url: string,
  query: Query,
  args?: FunctionArgs<Query>,
  options: ServerCallOptions = {},
): Promise<FunctionReturnType<Query>> {
  const caller = callerFor(url, options, DEFAULT_TIMEOUT_MS);
  return caller.query(query, args ?? {}) as Promise<FunctionReturnType<Query>>;
}

/**
 * Runs a mutation on the server, once, over HTTP. Same rules as {@link fetchQuery}: one client per
 * call, and a default deadline of 30 000 milliseconds.
 *
 * @param url The deployment URL.
 * @param mutation A mutation reference, for example `api.tasks.add`.
 * @param args The arguments; omit for a mutation without arguments.
 * @param options See {@link ServerCallOptions}.
 * @returns A promise of the mutation result. It rejects as the promise of {@link fetchQuery} does.
 * @throws TypeError synchronously for an invalid `url` or `options.token`, as {@link fetchQuery}.
 * @example
 * ```ts
 * import { fetchMutation, type MutationRef } from "@shadow-js/convex";
 *
 * // Stands in for `api.tasks.add` from convex/_generated/api.
 * declare const addTask: MutationRef;
 *
 * export async function addTaskFromForm(form: FormData, token: string) {
 *   const title = String(form.get("title") ?? "");
 *   return fetchMutation("https://happy-otter-123.convex.cloud", addTask, { title }, { token });
 * }
 * ```
 * @since 1.0.0
 */
export function fetchMutation<Mutation extends MutationRef>(
  url: string,
  mutation: Mutation,
  args?: FunctionArgs<Mutation>,
  options: ServerCallOptions = {},
): Promise<Awaited<FunctionReturnType<Mutation>>> {
  const caller = callerFor(url, options, DEFAULT_TIMEOUT_MS);
  return caller.mutation(mutation, args ?? {}) as Promise<Awaited<FunctionReturnType<Mutation>>>;
}

/**
 * Runs an action on the server, once, over HTTP. Same rules as {@link fetchQuery}, except that the
 * default deadline is 600 000 milliseconds (ten minutes), because actions may run for minutes.
 *
 * @param url The deployment URL.
 * @param action An action reference, for example `api.emails.send`.
 * @param args The arguments; omit for an action without arguments.
 * @param options See {@link ServerCallOptions}.
 * @returns A promise of the action result. It rejects as the promise of {@link fetchQuery} does.
 * @throws TypeError synchronously for an invalid `url` or `options.token`, as {@link fetchQuery}.
 * @example
 * ```ts
 * import { type ActionRef, fetchAction } from "@shadow-js/convex";
 *
 * // Stands in for `api.emails.send` from convex/_generated/api.
 * declare const sendEmail: ActionRef;
 *
 * export async function sendWelcome(to: string, token: string) {
 *   return fetchAction("https://happy-otter-123.convex.cloud", sendEmail, { to }, { token });
 * }
 * ```
 * @since 1.0.0
 */
export function fetchAction<Action extends ActionRef>(
  url: string,
  action: Action,
  args?: FunctionArgs<Action>,
  options: ServerCallOptions = {},
): Promise<Awaited<FunctionReturnType<Action>>> {
  const caller = callerFor(url, options, DEFAULT_ACTION_TIMEOUT_MS);
  return caller.action(action, args ?? {}) as Promise<Awaited<FunctionReturnType<Action>>>;
}
