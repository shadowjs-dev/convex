# Changelog

## 1.0.3

### Fixed

- A test now locks in that `ConvexProviderWithAuth` registers again when the auth hook's `fetchAccessToken` changes identity (the contract `ConvexProviderWithClerk` relies on to switch accounts and organizations); no runtime change.

## 1.0.2

### Fixed

- `usePaginatedQuery` clears `error()` when the failed page delivers a result again, instead of keeping the error for the life of the hook.
- `usePaginatedQuery` reports `LoadingMore`, not `LoadingFirstPage`, while a further page loads after an empty first page.
- `ConvexProviderWithAuth` no longer stays loading for good when the auth hook reports loading again while the registered token is unchanged.
- `useUploadFile`'s `progress` follows the latest upload and stays defined while another upload is still running.

## 1.0.1

### Changed

- Released at 1.0.1 with the other packages, which share one version. No change to this package.

## 1.0.0

### Added

- Reactive Convex query subscriptions, pagination, mutations and actions.
- Provider and authentication integration with owner-managed subscription cleanup.
- Server-rendering and hydration support for query data.

### Fixed

- Declare the Testing development dependency so workspace typechecking waits for its declarations to build.
