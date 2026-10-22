import {
  type FunctionReference,
  makeFunctionReference,
  type PaginationResult,
} from "convex/server";

/** A task document. */
export interface Task {
  readonly _id: string;
  readonly title: string;
  readonly done: boolean;
}

/** A message document. */
export interface Message {
  readonly _id: string;
  readonly body: string;
}

/** A hand-typed stand-in for the generated `api` object: the same shape `npx convex codegen` produces. */
export const api: {
  readonly tasks: {
    readonly list: FunctionReference<"query", "public", { done?: boolean }, Task[]>;
    readonly byId: FunctionReference<"query", "public", { id: string }, Task | null>;
    readonly count: FunctionReference<"query", "public", Record<string, never>, number>;
    readonly add: FunctionReference<"mutation", "public", { title: string }, string>;
    readonly clear: FunctionReference<"mutation", "public", Record<string, never>, null>;
  };
  readonly messages: {
    readonly page: FunctionReference<
      "query",
      "public",
      { channel: string; paginationOpts: { numItems: number; cursor: string | null } },
      PaginationResult<Message>
    >;
  };
  readonly emails: {
    readonly send: FunctionReference<"action", "public", { to: string }, boolean>;
  };
} = {
  tasks: {
    list: makeFunctionReference<"query", { done?: boolean }, Task[]>("tasks:list"),
    byId: makeFunctionReference<"query", { id: string }, Task | null>("tasks:byId"),
    count: makeFunctionReference<"query", Record<string, never>, number>("tasks:count"),
    add: makeFunctionReference<"mutation", { title: string }, string>("tasks:add"),
    clear: makeFunctionReference<"mutation", Record<string, never>, null>("tasks:clear"),
  },
  messages: {
    page: makeFunctionReference<
      "query",
      { channel: string; paginationOpts: { numItems: number; cursor: string | null } },
      PaginationResult<Message>
    >("messages:page"),
  },
  emails: {
    send: makeFunctionReference<"action", { to: string }, boolean>("emails:send"),
  },
};

/** Exact type equality, the usual conditional-type trick. */
export type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Compile-time assertion: fails to compile unless `T` is `true`. */
export type Expect<T extends true> = T;
