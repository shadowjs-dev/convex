import { type Accessor, batch, useSignal } from "@shadow-js/core";
import type { MutationOptions, OptimisticUpdate } from "convex/browser";
import type { FunctionReturnType, OptionalRestArgs } from "convex/server";
import type { Value } from "convex/values";
import { useConvexForCalls } from "./client";
import { runAction, runMutation } from "./internal/adapters";
import type { PendingCounter } from "./internal/contexts";
import {
  checkedOptimisticUpdate,
  type OptimisticWrite,
  verifySettled,
} from "./internal/optimistic-dev";
import type { ActionRef, ConvexClientLike, MutationRef, OptimisticUpdateFor } from "./types";

/**
 * A callable mutation with reactive call state. Call it like a function with the mutation's
 * arguments (omit them for a mutation without arguments); it resolves with the mutation's return
 * value and rejects with its error. `pending`, `error` and `reset` describe the calls made through
 * it, and `withOptimisticUpdate` returns a variant that applies a local update while the call is
 * in flight. Variants share the same state.
 *
 * @example
 * ```tsx
 * import { type MutationHandle, type MutationRef, useMutation } from "@shadow-js/convex";
 *
 * // Stands in for `api.tasks.add` from convex/_generated/api.
 * declare const addTask: MutationRef;
 *
 * export function AddTaskButton() {
 *   const add: MutationHandle<typeof addTask> = useMutation(addTask);
 *   return (
 *     <div>
 *       <button type="button" disabled={add.pending()} onClick={() => void add({ title: "Ship it" })}>
 *         Add
 *       </button>
 *       <p role="alert" hidden={add.error() === undefined} onClick={() => add.reset()}>
 *         The task was not saved.
 *       </p>
 *     </div>
 *   );
 * }
 * ```
 * @see {@link useMutation}
 * @since 1.0.0
 */
export interface MutationHandle<Mutation extends MutationRef> {
  /** Runs the mutation with `args` and resolves with its return value. */
  (...args: OptionalRestArgs<Mutation>): Promise<Awaited<FunctionReturnType<Mutation>>>;
  /** True while at least one call has not settled. */
  readonly pending: Accessor<boolean>;
  /** The error of the most recent failed call, or `undefined`; a new call clears it. */
  readonly error: Accessor<unknown>;
  /** Clears `error`. Does not affect calls in flight. */
  reset(): void;
  /**
   * Returns a variant whose calls apply `update` locally until the server answers. It replaces the
   * handle's default `optimisticUpdate` for the variant's calls and shares `pending` and `error`
   * with the handle it came from.
   */
  withOptimisticUpdate(update: OptimisticUpdateFor<Mutation>): MutationHandle<Mutation>;
}

/**
 * A callable action with reactive call state. Actions are not optimistic, so there is no
 * `withOptimisticUpdate`, and their calls are not counted by `usePendingMutations`.
 *
 * @example
 * ```tsx
 * import { type ActionHandle, type ActionRef, useAction } from "@shadow-js/convex";
 *
 * // Stands in for `api.emails.send` from convex/_generated/api.
 * declare const sendEmail: ActionRef;
 *
 * export function InviteButton() {
 *   const send: ActionHandle<typeof sendEmail> = useAction(sendEmail);
 *   return (
 *     <button type="button" disabled={send.pending()} onClick={() => void send({ to: "ada@example.com" })}>
 *       Invite
 *     </button>
 *   );
 * }
 * ```
 * @see {@link useAction}
 * @since 1.0.0
 */
export interface ActionHandle<Action extends ActionRef> {
  /** Runs the action with `args` and resolves with its return value. */
  (...args: OptionalRestArgs<Action>): Promise<Awaited<FunctionReturnType<Action>>>;
  /** True while at least one call has not settled. */
  readonly pending: Accessor<boolean>;
  /** The error of the most recent failed call, or `undefined`; a new call clears it. */
  readonly error: Accessor<unknown>;
  /** Clears `error`. Does not affect calls in flight. */
  reset(): void;
}

/**
 * Options of {@link useMutation}.
 *
 * @example
 * ```ts
 * import { type MutationRef, type QueryRef, type UseMutationOptions, useMutation } from "@shadow-js/convex";
 *
 * // Stand in for `api.tasks.list` and `api.tasks.toggle` from convex/_generated/api.
 * declare const listTasks: QueryRef;
 * declare const toggleTask: MutationRef;
 *
 * type Task = { _id: string; title: string; done: boolean };
 *
 * const options: UseMutationOptions<typeof toggleTask> = {
 *   optimisticUpdate: (store, args: { id: string }) => {
 *     const tasks: Task[] | undefined = store.getQuery(listTasks, {});
 *     if (tasks === undefined) return;
 *     const next = tasks.map((task) => (task._id === args.id ? { ...task, done: !task.done } : task));
 *     store.setQuery(listTasks, {}, next);
 *   },
 * };
 *
 * export function useToggleTask() {
 *   return useMutation(toggleTask, options);
 * }
 * ```
 * @since 1.0.0
 */
export interface UseMutationOptions<Mutation extends MutationRef> {
  /**
   * Applied to every call of the returned handle. Use `withOptimisticUpdate` for one variant. In
   * development builds the query results the update reads are frozen copies (change a copy, not
   * the result), and after the call succeeds each value the update wrote is compared with the
   * server's result: a difference other than `_id` and `_creationTime` logs a warning.
   */
  readonly optimisticUpdate?: OptimisticUpdateFor<Mutation>;
}

/** Counts in-flight calls and remembers the last failure. @internal */
interface CallTracker {
  readonly pending: Accessor<boolean>;
  readonly error: Accessor<unknown>;
  start(): void;
  settle(failure?: { readonly error: unknown }): void;
  reset(): void;
}

/** Creates a tracker; `provider` also counts the calls when given (mutations only). @internal */
function createCallTracker(provider: PendingCounter | null): CallTracker {
  const [inflight, setInflight] = useSignal(0);
  const [failure, setFailure] = useSignal<{ readonly error: unknown } | undefined>(undefined, {
    equals: false,
  });
  return {
    pending: () => inflight() > 0,
    error: () => failure()?.error,
    start(): void {
      batch(() => {
        setInflight((count) => count + 1);
        setFailure(undefined);
      });
      provider?.start();
    },
    settle(failed): void {
      batch(() => {
        setInflight((count) => count - 1);
        if (failed !== undefined) setFailure(failed);
      });
      provider?.settle();
    },
    reset(): void {
      setFailure(undefined);
    },
  };
}

/**
 * Runs one call and keeps the tracker in step with it. The counter goes up before the call and
 * down exactly once after it settles; a failure is recorded and then rethrown to the caller.
 * @internal
 */
function track(tracker: CallTracker, start: () => Promise<unknown>): Promise<unknown> {
  tracker.start();
  let pending: Promise<unknown>;
  try {
    pending = start();
  } catch (error) {
    pending = Promise.reject(error);
  }
  return pending.then(
    (result) => {
      tracker.settle();
      return result;
    },
    (error: unknown) => {
      tracker.settle({ error });
      throw error;
    },
  );
}

/** Builds a mutation handle over a client and a tracker. @internal */
function mutationHandle<Mutation extends MutationRef>(
  client: ConvexClientLike,
  mutation: Mutation,
  tracker: CallTracker,
  update: OptimisticUpdateFor<Mutation> | undefined,
): MutationHandle<Mutation> {
  const call = (
    ...args: OptionalRestArgs<Mutation>
  ): Promise<Awaited<FunctionReturnType<Mutation>>> => {
    const input: unknown = args[0] ?? {};
    if (!__DEV__ || update === undefined) {
      const options: MutationOptions | undefined =
        update === undefined ? undefined : { optimisticUpdate: update };
      return track(tracker, () => runMutation(client, mutation, input, options)) as Promise<
        Awaited<FunctionReturnType<Mutation>>
      >;
    }
    // Development: the update reads read-only copies and its writes are compared once settled.
    const writes: OptimisticWrite[] = [];
    const checked = checkedOptimisticUpdate<Record<string, Value>>(
      update as OptimisticUpdate<Record<string, Value>>,
      writes,
    );
    const pending = track(tracker, () =>
      runMutation(client, mutation, input, { optimisticUpdate: checked }),
    );
    return pending.then((result) => {
      verifySettled(client, writes);
      return result;
    }) as Promise<Awaited<FunctionReturnType<Mutation>>>;
  };
  return Object.defineProperties(call, {
    pending: { value: tracker.pending, enumerable: true },
    error: { value: tracker.error, enumerable: true },
    reset: { value: () => tracker.reset(), enumerable: true },
    withOptimisticUpdate: {
      value: (next: OptimisticUpdateFor<Mutation>) =>
        mutationHandle(client, mutation, tracker, next),
      enumerable: true,
    },
  }) as MutationHandle<Mutation>;
}

/**
 * Returns a callable for `mutation`. Its `pending`, `error` and `reset` describe its calls; a
 * rejected call rethrows its error after the state has been updated. Every call is also counted by
 * the provider's {@link usePendingMutations} until it settles. During server rendering without a
 * provider the hook does not throw, but its calls reject with an error saying that mutations run in
 * the browser.
 *
 * @param mutation A mutation reference, for example `api.tasks.add`.
 * @param options See {@link UseMutationOptions}.
 * @returns A {@link MutationHandle}.
 * @throws Error when there is no `ConvexProvider` above the component in the browser. The message
 * starts with `useMutation() must be used inside <ConvexProvider>`.
 * @example
 * ```tsx
 * import { type MutationRef, useMutation } from "@shadow-js/convex";
 *
 * // Stands in for `api.tasks.toggle` from convex/_generated/api.
 * declare const toggleTask: MutationRef;
 *
 * export function ToggleButton(props: { id: string }) {
 *   const toggle = useMutation(toggleTask);
 *   return (
 *     <button type="button" disabled={toggle.pending()} onClick={() => void toggle({ id: props.id })}>
 *       Toggle
 *     </button>
 *   );
 * }
 * ```
 * @see {@link useAction}
 * @since 1.0.0
 */
export function useMutation<Mutation extends MutationRef>(
  mutation: Mutation,
  options?: UseMutationOptions<Mutation>,
): MutationHandle<Mutation> {
  const scope = useConvexForCalls("useMutation");
  return mutationHandle(
    scope.client,
    mutation,
    createCallTracker(scope.pending),
    options?.optimisticUpdate,
  );
}

/**
 * Returns a callable for `action`, with the same `pending`, `error` and `reset` as
 * {@link useMutation}. Action calls are not counted by {@link usePendingMutations} and do not
 * guard page unload. During server rendering without a provider the hook does not throw, but its
 * calls reject with an error saying that actions run in the browser.
 *
 * @param action An action reference, for example `api.emails.send`.
 * @returns An {@link ActionHandle}.
 * @throws Error when there is no `ConvexProvider` above the component in the browser. The message
 * starts with `useAction() must be used inside <ConvexProvider>`.
 * @example
 * ```tsx
 * import { type ActionRef, useAction } from "@shadow-js/convex";
 *
 * // Stands in for `api.emails.send` from convex/_generated/api.
 * declare const sendEmail: ActionRef;
 *
 * export function ResendButton(props: { to: string }) {
 *   const send = useAction(sendEmail);
 *   const resend = async (): Promise<void> => {
 *     try {
 *       await send({ to: props.to });
 *     } catch {
 *       // send.error() holds the failure for the message below.
 *     }
 *   };
 *   return (
 *     <div>
 *       <button type="button" onClick={() => void resend()}>
 *         Resend
 *       </button>
 *       <p role="alert" hidden={send.error() === undefined}>
 *         The email was not sent.
 *       </p>
 *     </div>
 *   );
 * }
 * ```
 * @since 1.0.0
 */
export function useAction<Action extends ActionRef>(action: Action): ActionHandle<Action> {
  const client = useConvexForCalls("useAction").client;
  // Actions are not written data: they are not counted as pending and do not guard unload.
  const tracker = createCallTracker(null);
  const call = (
    ...args: OptionalRestArgs<Action>
  ): Promise<Awaited<FunctionReturnType<Action>>> => {
    const input: unknown = args[0] ?? {};
    return track(tracker, () => runAction(client, action, input)) as Promise<
      Awaited<FunctionReturnType<Action>>
    >;
  };
  return Object.defineProperties(call, {
    pending: { value: tracker.pending, enumerable: true },
    error: { value: tracker.error, enumerable: true },
    reset: { value: () => tracker.reset(), enumerable: true },
  }) as ActionHandle<Action>;
}
