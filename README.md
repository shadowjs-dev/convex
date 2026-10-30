<p align="center"><img src="https://raw.githubusercontent.com/shadowjs-dev/convex/main/.github/banner.png" alt="ShadowJS" width="100%"></p>

# @shadow-js/convex

[![npm](https://img.shields.io/npm/v/@shadow-js/convex.svg)](https://www.npmjs.com/package/@shadow-js/convex)
[![CI](https://github.com/shadowjs-dev/convex/actions/workflows/ci.yml/badge.svg)](https://github.com/shadowjs-dev/convex/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](https://github.com/shadowjs-dev/convex/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-blue.svg)](https://www.typescriptlang.org/)

Convex for ShadowJS: a provider, live queries with Suspense and server rendering, mutations and
actions with pending state, paginated queries, and auth. Every hook runs on `@shadow-js/core`
signals, so a query result updates only the text or node that reads it.

The package takes `ConvexClient` and `ConvexHttpClient` from `convex` through small structural
interfaces, so the real clients plug in unchanged and a test can pass a fake. It has no runtime
dependency on Convex beyond the `convex` peer dependency (`>=1.31.0`, the first version whose
`ConvexHttpClient` accepts the `fetch` option the server helpers use). The production checker
(`npm run check:production -w @shadow-js/convex`) validates a production configuration without
contacting any host.

## Install

```sh
npm install @shadow-js/convex convex
```

`@shadow-js/core` is a peer dependency, and the components need `@shadow-js/web`.

## Example

Run `npx convex dev` once: it generates `convex/_generated/api`, the typed function references the
hooks take (`api.tasks.list`). The example below writes one reference by hand with
`makeFunctionReference`, which is what the generated file does under its types, and tests the
component against a fake client, so it needs no deployment.

```tsx title="src/tasks.tsx" run
import { useQuery } from "@shadow-js/convex";
import { For, Show } from "@shadow-js/web";
import { makeFunctionReference } from "convex/server";

export const listTasks = makeFunctionReference<"query", { done?: boolean }, string[]>("tasks:list");

export function Tasks() {
  const tasks = useQuery(listTasks, { done: false });
  return (
    <Show when={tasks()} fallback={<p>Loading</p>}>
      {(list) => (
        <ul>
          <For each={list()}>{(title) => <li>{title}</li>}</For>
        </ul>
      )}
    </Show>
  );
}
```

```tsx title="src/tasks.test.tsx" test
import { ConvexProvider, type ConvexClientLike } from "@shadow-js/convex";
import { render } from "@shadow-js/testing/dom";
import { describe, expect, it } from "vitest";
import { Tasks } from "./tasks";

describe("Tasks", () => {
  it("shows Loading, then the titles the server sends", () => {
    const deliver: Array<(value: never) => unknown> = [];
    const client: ConvexClientLike = {
      onUpdate: (_query, _args, callback) => {
        deliver.push(callback);
        return () => undefined;
      },
      mutation: () => Promise.reject(new Error("not used")),
      action: () => Promise.reject(new Error("not used")),
      setAuth: () => undefined,
    };

    const view = render(() => (
      <ConvexProvider client={client}>
        <Tasks />
      </ConvexProvider>
    ));
    expect(view.container.textContent).toBe("Loading");

    deliver[0]?.(["Write docs", "Ship it"] as never);
    expect(view.container.textContent).toBe("Write docsShip it");
  });
});
```

In the application, create the browser client once and provide it near the root:

```tsx title="src/main.tsx" typecheck
import { ConvexProvider, createConvexClient } from "@shadow-js/convex";
import { render } from "@shadow-js/web";
import { Tasks } from "./tasks";

const client = createConvexClient("https://happy-otter-123.convex.cloud");
const root = document.getElementById("app");
if (root === null) throw new Error("#app is missing");

render(
  () => (
    <ConvexProvider client={client}>
      <Tasks />
    </ConvexProvider>
  ),
  root,
);
```

## API

The package has one entry, `@shadow-js/convex`.

| Export | Description |
| --- | --- |
| `ConvexProvider` | Makes a client available to every hook in its children. |
| `createConvexClient(url, options?)` | Creates the browser `ConvexClient`; it connects when created. |
| `useConvex()` | Reads the client from the nearest provider. |
| `useQuery(query, args?, options?)` | Subscribes to a query. Returns an accessor with `status`, `isLoading` and `error`. `args` may be an object, `"skip"` or an accessor. |
| `useMutation(mutation, options?)` | A callable with `pending()`, `error()`, `reset()` and `withOptimisticUpdate(update)`. |
| `usePendingMutations()` | An accessor of the number of unsettled mutations under the provider. |
| `ConvexProvider` prop `unloadGuard` | Asks for confirmation before unload while a mutation is pending; `false` opts out. |
| `useUploadFile(generateUploadUrl)` | Uploads a `Blob` to file storage and resolves `{ storageId }`; accessors `pending`, `progress`, `error`; `reset()`. |
| `fetchQuery`, `fetchMutation`, `fetchAction` (`url`, ref, args, `{ token }`) | One HTTP call each for Dusk loaders and server functions; a new client per call. |
| `fromConvexValidator(validator)` | A Standard Schema over a `v.*` validator, for forms and server function input. |
| `useAction(action)` | A callable with `pending()`, `error()` and `reset()`. |
| `usePaginatedQuery(query, args, { initialNumItems })` | Accessors `results`, `status`, `isLoading`, `error` and `loadMore(n)`. |
| `ConvexProviderWithAuth`, `useConvexAuth` | Connect an auth provider to Convex and read the combined state as accessors. |
| `Authenticated`, `Unauthenticated`, `AuthLoading` | Show children by auth state. |
| `ServerConvexProvider`, `preloadQuery(http, query, args?)` | Server rendering: fetch queries once over HTTP and hand the values to the browser. |
| `ConvexClientLike`, `ConvexHttpClientLike` | The structural client interfaces to implement in a test. |
| `QueryResult`, `QueryStatus`, `UseQueryOptions`, `MutationHandle`, `ActionHandle`, `PaginatedQueryResult`, `AuthHookState` | Result and option types. |

## Notes

- Function references must be the classic `FunctionReference` shape the generated `api` uses. The
  `_future` shape is not accepted, because convex 1.20 does not have it.
- `ConvexClient` has no `clearAuth` of its own, so the auth provider calls the one on the base client
  behind it (`client.client`). Only a client with neither gets a registered fetcher that returns `null`.
- `Authenticated`, `Unauthenticated` and `AuthLoading` return a plain accessor, so a child
  component that calls a hook inside them does not see the provider's context. Put such children
  behind a `Show`, as the guide shows.
- `usePaginatedQuery` runs only in the browser and does not hold a Suspense boundary; `useQuery`
  does.

## Links

- [Clerk package](https://clerk.shadowjs.net): `clerkConvexAuth()` builds the `useAuth` hook for
  `ConvexProviderWithAuth`.
- Convex documentation: https://docs.convex.dev

## Dependencies

- Runtime: none.
- Peers: `convex` `>=1.31.0`: the client and server APIs (`convex/browser`, `convex/server`, `convex/values`) that the hooks wrap.
- Peers: `@shadow-js/core` `^1.0.3`: reactive state for the hooks.

## Types

- Names from the root: `ActionHandle`, `MutationHandle`, `PaginatedQueryResult`, `ConvexClientLike`.
- Type tests in `test-types/` are compile-time checks; `npm run typecheck:types` runs them.

## Support

- Node.js `>=22.12.0`. ESM only: use `import`; `require` is not supported.
- Browsers: current evergreen releases.
- Versioning: every `@shadow-js/*` package releases together at one version. Upgrade them as one set.
- Documentation: [ShadowJS documentation](https://shadowjs.net).

## Using, changing and contributing

- **Use the package** (a person or a coding agent that builds with it): this README, and [SKILL.md](SKILL.md), the short page an agent reads first.
- **Change the package** (fix a bug, add a feature): [AGENTS.md](AGENTS.md) says how the repository is laid out, how to implement and test a change, and how a pull request is reviewed. It is written for people and coding agents alike.
- **Take part**: [CONTRIBUTING.md](CONTRIBUTING.md) is the short guide; [SECURITY.md](SECURITY.md) is for vulnerabilities.
