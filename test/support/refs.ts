import {
  type FunctionReference,
  makeFunctionReference,
  type PaginationResult,
} from "convex/server";

/** A task document as the tests model it. */
export interface Task {
  readonly _id: string;
  /** Set by the server on every document; optional because the optimistic tests write it by hand. */
  readonly _creationTime?: number;
  readonly title: string;
  readonly done: boolean;
}

/** A message document for the paginated tests. */
export interface Message {
  readonly _id: string;
  readonly body: string;
}

/**
 * Hand-written function references, shaped like the ones `npx convex codegen` generates. They are
 * built with `makeFunctionReference`, so `getFunctionName` returns the names used in the tests.
 */
export const api: {
  readonly tasks: {
    readonly list: FunctionReference<"query", "public", { done?: boolean }, Task[]>;
    readonly byId: FunctionReference<"query", "public", { id: string }, Task | null>;
    readonly count: FunctionReference<"query", "public", Record<string, never>, number>;
    readonly add: FunctionReference<"mutation", "public", { title: string }, string>;
    readonly toggle: FunctionReference<"mutation", "public", { id: string }, null>;
    readonly clear: FunctionReference<"mutation", "public", Record<string, never>, null>;
  };
  readonly messages: {
    readonly page: FunctionReference<
      "query",
      "public",
      {
        channel: string;
        paginationOpts: { numItems: number; cursor: string | null; endCursor?: string | null };
      },
      PaginationResult<Message>
    >;
  };
  readonly emails: {
    readonly send: FunctionReference<"action", "public", { to: string }, boolean>;
  };
  readonly files: {
    readonly generateUploadUrl: FunctionReference<
      "mutation",
      "public",
      Record<string, never>,
      string
    >;
  };
} = {
  tasks: {
    list: makeFunctionReference<"query", { done?: boolean }, Task[]>("tasks:list"),
    byId: makeFunctionReference<"query", { id: string }, Task | null>("tasks:byId"),
    count: makeFunctionReference<"query", Record<string, never>, number>("tasks:count"),
    add: makeFunctionReference<"mutation", { title: string }, string>("tasks:add"),
    toggle: makeFunctionReference<"mutation", { id: string }, null>("tasks:toggle"),
    clear: makeFunctionReference<"mutation", Record<string, never>, null>("tasks:clear"),
  },
  messages: {
    page: makeFunctionReference<
      "query",
      {
        channel: string;
        paginationOpts: { numItems: number; cursor: string | null; endCursor?: string | null };
      },
      PaginationResult<Message>
    >("messages:page"),
  },
  emails: {
    send: makeFunctionReference<"action", { to: string }, boolean>("emails:send"),
  },
  files: {
    generateUploadUrl: makeFunctionReference<"mutation", Record<string, never>, string>(
      "files:generateUploadUrl",
    ),
  },
};

/** Builds a page result the way a Convex paginated query returns it. */
export function pageOf(
  items: readonly Message[],
  continueCursor: string,
  isDone: boolean,
  extra: {
    splitCursor?: string | null;
    pageStatus?: "SplitRecommended" | "SplitRequired" | null;
  } = {},
): PaginationResult<Message> {
  return { page: [...items], continueCursor, isDone, ...extra };
}

/** Shorthand for a message. */
export function msg(id: string): Message {
  return { _id: id, body: `body ${id}` };
}

/** A task with the given id and done flag. */
export function task(id: string, done = false): Task {
  return { _id: id, title: `task ${id}`, done };
}
