// biome-ignore-all lint/correctness/noUnusedVariables: the type aliases here are compile-time assertions; they are checked by tsc and never read at run time.
import type {
  PaginationStatus as ConvexPaginationStatus,
  OptimisticLocalStore,
  OptimisticUpdate,
} from "convex/browser";
import type { MutationRef, OptimisticUpdateFor, PaginationStatus } from "../src/index";
import { api } from "../test/support/refs";
import type { Equal, Expect } from "./api";

/*
 * Verification of the names used against convex 1.46 (the version the package is built with).
 * The four pagination statuses and the optimistic store methods must be exactly convex's.
 */

/** [C1] The four pagination statuses are the names convex's own client reports. */
export type PaginationStatusNames = Expect<Equal<PaginationStatus, ConvexPaginationStatus>>;
export type FourStatuses = Expect<
  Equal<PaginationStatus, "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted">
>;

/** [C1] The optimistic update receives convex's store, with getQuery and setQuery. */
type Store = OptimisticLocalStore;
export type StoreHasGetQuery = Expect<Store extends { getQuery: infer _Get } ? true : false>;
export type StoreHasSetQuery = Expect<Store extends { setQuery: infer _Set } ? true : false>;

/** [C1] An update written for a mutation's arguments is convex's OptimisticUpdate type. */
type AddUpdate = OptimisticUpdateFor<typeof api.tasks.add>;
export type UpdateIsConvexs = Expect<Equal<AddUpdate, OptimisticUpdate<{ title: string }>>>;

/** [C1] The mutation reference of the upload helper is the same MutationRef the hooks take. */
export const generate: MutationRef = api.files.generateUploadUrl;
