// biome-ignore-all lint/correctness/noUnusedVariables: the type aliases here are compile-time assertions; they are checked by tsc and never read at run time.
import type { ConvexClient } from "convex/browser";
import type { PaginationResult } from "convex/server";
import {
  type ActionHandle,
  type AuthHookState,
  type ConvexAuthState,
  type ConvexClientLike,
  createConvexClient,
  type MutationHandle,
  type PageItem,
  type PaginatedArgsInput,
  type PaginatedQueryResult,
  type PreloadedQuery,
  preloadQuery,
  type QueryResult,
  type QueryStatus,
  useAction,
  useConvexAuth,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "../src/index";
import { api, type Equal, type Expect, type Message, type Task } from "./api";

/*
 * Every check below is a type-level assertion inside a function that is never called: the file is
 * only compiled, never run. A failed `Expect` or an unexpected `@ts-expect-error` is a compile error.
 */

function queries(flag: () => boolean, done: () => boolean): void {
  const tasks = useQuery(api.tasks.list, { done: false });
  type Check1 = Expect<Equal<typeof tasks, QueryResult<Task[]>>>;
  type Check2 = Expect<Equal<ReturnType<typeof tasks>, Task[] | undefined>>;
  type Check3 = Expect<Equal<typeof tasks.status, QueryStatus>>;
  type Check4 = Expect<Equal<typeof tasks.isLoading, boolean>>;
  type Check5 = Expect<Equal<typeof tasks.error, unknown>>;

  const byIdRow = useQuery(api.tasks.byId, { id: "a" });
  type Check6 = Expect<Equal<ReturnType<typeof byIdRow>, Task | null | undefined>>;

  const counted = useQuery(api.tasks.count);
  type Check7 = Expect<Equal<ReturnType<typeof counted>, number | undefined>>;

  const allTasks = useQuery(api.tasks.list, {});
  type Check8 = Expect<Equal<ReturnType<typeof allTasks>, Task[] | undefined>>;

  const reactive = useQuery(api.tasks.list, () => (flag() ? "skip" : { done: done() }));
  type Check9 = Expect<Equal<ReturnType<typeof reactive>, Task[] | undefined>>;

  const skipped = useQuery(api.tasks.list, "skip");
  type Check10 = Expect<Equal<ReturnType<typeof skipped>, Task[] | undefined>>;

  const throwing = useQuery(api.tasks.list, {}, { throwOnError: true, keepPreviousData: true });
  type Check11 = Expect<Equal<typeof throwing, QueryResult<Task[]>>>;

  const preloaded = useQuery(api.tasks.list, {}, { preload: () => Promise.resolve([]) });
  type Check12 = Expect<Equal<typeof preloaded, QueryResult<Task[]>>>;

  // Negative cases: each line must be rejected by the compiler.
  // @ts-expect-error the argument has the wrong type
  useQuery(api.tasks.list, { done: "no" });
  // @ts-expect-error an argument the query does not declare
  useQuery(api.tasks.list, { done: false, extra: 1 });
  // @ts-expect-error a query that takes an id needs one
  useQuery(api.tasks.byId, {});
  // @ts-expect-error the preload must return the query's own type
  useQuery(api.tasks.list, {}, { preload: () => Promise.resolve(3) });
}

function mutations(): void {
  const add = useMutation(api.tasks.add);
  type Check1 = Expect<Equal<typeof add, MutationHandle<typeof api.tasks.add>>>;
  const created = add({ title: "x" });
  type Check2 = Expect<Equal<typeof created, Promise<string>>>;
  type Check3 = Expect<Equal<ReturnType<typeof add.pending>, boolean>>;
  type Check4 = Expect<Equal<ReturnType<typeof add.error>, unknown>>;

  const clear = useMutation(api.tasks.clear);
  void clear();

  const optimistic = add.withOptimisticUpdate((store, args) => {
    const title: string = args.title;
    void title;
    void store;
  });
  type Check5 = Expect<Equal<typeof optimistic, MutationHandle<typeof api.tasks.add>>>;

  // @ts-expect-error the mutation takes a title
  add({});
  // @ts-expect-error the mutation takes a title as a string
  add({ title: 5 });
  // @ts-expect-error a plain mutation has no id argument
  add({ title: "x", id: "y" });
}

function actions(): void {
  const send = useAction(api.emails.send);
  type Check1 = Expect<Equal<typeof send, ActionHandle<typeof api.emails.send>>>;
  const result = send({ to: "a@b.c" });
  type Check2 = Expect<Equal<typeof result, Promise<boolean>>>;
  // @ts-expect-error the action needs a recipient
  send({});
}

function paginated(channel: () => string): void {
  const list = usePaginatedQuery(
    api.messages.page,
    { channel: "general" },
    { initialNumItems: 20 },
  );
  type Check1 = Expect<
    Equal<typeof list, PaginatedQueryResult<PageItem<PaginationResult<Message>>>>
  >;
  type Check2 = Expect<Equal<ReturnType<typeof list.results>, Message[]>>;
  type Check3 = Expect<
    Equal<
      ReturnType<typeof list.status>,
      "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted"
    >
  >;
  type Check4 = Expect<Equal<ReturnType<typeof list.isLoading>, boolean>>;
  type Check5 = Expect<Equal<ReturnType<typeof list.loadMore>, boolean>>;
  const moreAdded: boolean = list.loadMore(10);
  void moreAdded;

  const dynamic = usePaginatedQuery(api.messages.page, () => ({ channel: channel() }), {
    initialNumItems: 5,
  });
  type Check6 = Expect<Equal<ReturnType<typeof dynamic.results>, Message[]>>;

  type PagedArgs = PaginatedArgsInput<typeof api.messages.page>;
  // @ts-expect-error the paginationOpts are supplied by the hook, not by the caller
  const withOpts: PagedArgs = { channel: "a", paginationOpts: { numItems: 1, cursor: null } };
  void withOpts;
  type Check7 = Expect<Equal<PageItem<number>, never>>;
}

async function loaders(): Promise<void> {
  const loaded = await preloadQuery({ query: async () => [] } as never, api.tasks.list, {
    done: true,
  });
  type Check1 = Expect<Equal<typeof loaded, PreloadedQuery<Task[]>>>;
  type Check2 = Expect<Equal<typeof loaded.token, string>>;
}

function auth(): void {
  const state = useConvexAuth();
  type Check1 = Expect<Equal<typeof state, ConvexAuthState>>;
  type Check2 = Expect<Equal<ReturnType<typeof state.isLoading>, boolean>>;
  type Check3 = Expect<Equal<ReturnType<typeof state.isAuthenticated>, boolean>>;

  const hook: () => AuthHookState = () => ({
    isLoading: false,
    isAuthenticated: false,
    fetchAccessToken: () => Promise.resolve(null),
  });
  type Check4 = Expect<Equal<ReturnType<typeof hook>, AuthHookState>>;
}

function clients(): void {
  const created = createConvexClient("https://happy-otter-123.convex.cloud");
  type Check1 = Expect<Equal<typeof created, ConvexClient>>;
  const asLike: ConvexClientLike = created;
  void asLike;
}
