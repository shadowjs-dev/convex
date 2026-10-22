/**
 * Convex for ShadowJS: a provider, reactive queries with Suspense and server rendering, mutations
 * and actions with pending state, paginated queries, and auth.
 *
 * Every hook is built on `@shadow-js/core` primitives. The Convex client is taken through the
 * structural types {@link ConvexClientLike} and {@link ConvexHttpClientLike}, so the real
 * `ConvexClient` and `ConvexHttpClient` plug in unchanged and tests can use a fake.
 *
 * @packageDocumentation
 * @since 1.0.0
 */

export {
  Authenticated,
  AuthLoading,
  ConvexProviderWithAuth,
  type ConvexProviderWithAuthProps,
  Unauthenticated,
  useConvexAuth,
} from "./auth";
export {
  ConvexProvider,
  type ConvexProviderProps,
  createConvexClient,
  ServerConvexProvider,
  type ServerConvexProviderProps,
  useConvex,
  usePendingMutations,
} from "./client";
export {
  type ConvexHttpCallerLike,
  createHttpCaller,
  fetchAction,
  fetchMutation,
  fetchQuery,
  type ServerCallOptions,
} from "./fetch";
export {
  type ActionHandle,
  type MutationHandle,
  type UseMutationOptions,
  useAction,
  useMutation,
} from "./mutation";
export {
  type PageItem,
  type PaginatedArgsInput,
  type PaginatedQueryOptions,
  type PaginatedQueryResult,
  usePaginatedQuery,
} from "./paginated";
export {
  type PreloadedQuery,
  preloadQuery,
  type QueryArgsInput,
  type QueryResult,
  type QueryStatus,
  type UseQueryOptions,
  useQuery,
} from "./query";
export {
  fromConvexValidator,
  type StandardIssue,
  type StandardProps,
  type StandardResult,
  type StandardSchemaV1,
} from "./standard";
export type {
  ActionRef,
  AuthHookState,
  AuthTokenFetcherLike,
  ConvexAuthState,
  ConvexClientLike,
  ConvexHttpClientLike,
  MutationRef,
  OptimisticUpdateFor,
  PaginationStatus,
  QueryRef,
} from "./types";
export {
  type UploadedFile,
  type UploadFileHandle,
  type UploadOptions,
  type UploadProgress,
  useUploadFile,
} from "./upload";
