---
name: shadowjs-convex
description: "Work with @shadow-js/convex. Use Convex from your app with live queries, mutations, pagination, auth and server rendering. Use when a project imports it, or when asked to add, configure or debug it."
---

# @shadow-js/convex

Version 1.0.3. Use Convex from your app with live queries, mutations, pagination, auth and server rendering.

## Where to read more

- @shadow-js/convex: https://convex.shadowjs.net
- Source and issues: https://github.com/shadowjs-dev/convex
- The package README is the full reference for options and behavior; read it before changing a configuration.

## Install

```sh
npm install @shadow-js/convex convex @shadow-js/core
```

## Peer dependencies

| Package | Range | Required |
| --- | --- | --- |
| `convex` | `>=1.31.0` | yes |
| `@shadow-js/core` | `^1.0.3` | yes |

## Import paths

Import only from these paths. Never from `dist` or `src`: files that are not listed here are private and change without notice.

- `@shadow-js/convex`

## Quick start

```tsx
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

## Working rules

- Run `npm run check` before proposing a change; it lints, builds, type-checks and tests.
- Keep a public change documented: TSDoc on every exported symbol, and a CHANGELOG entry.
- To change this repository rather than use the package, read AGENTS.md: the layout, the commands, the rules and how a pull request is reviewed.
