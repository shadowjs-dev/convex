import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const exact = (entries: [string, string][]) =>
  entries.map(([specifier, path]) => ({
    find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`),
    replacement: source(path),
  }));

// This repository's own packages are imported from source, so a test run needs no build.
const own: [string, string][] = [["@shadow-js/convex", "./src/index.ts"]];
// The other ShadowJS packages come from node_modules, as the build an app would get: the browser development build for DOM and unit
// tests, the server development build for server tests. Naming the files keeps every package on one build, so there is one copy of core.
const fromClient: [string, string][] = [
  [
    "@shadow-js/router/prefetch-report",
    "./node_modules/@shadow-js/router/dist/dev/features/prefetch-report.js",
  ],
  ["@shadow-js/testing/auto-cleanup", "./node_modules/@shadow-js/testing/dist/dev/auto-cleanup.js"],
  ["@shadow-js/compiler/javascript", "./node_modules/@shadow-js/compiler/dist/dev/javascript.js"],
  ["@shadow-js/web/jsx-dev-runtime", "./node_modules/@shadow-js/web/dist/prod/jsx-dev-runtime.js"],
  [
    "@shadow-js/router/transitions",
    "./node_modules/@shadow-js/router/dist/dev/features/transitions.js",
  ],
  [
    "@shadow-js/router/link-status",
    "./node_modules/@shadow-js/router/dist/dev/features/link-status.js",
  ],
  ["@shadow-js/testing/playwright", "./node_modules/@shadow-js/testing/dist/dev/playwright.js"],
  [
    "@shadow-js/router/announcer",
    "./node_modules/@shadow-js/router/dist/dev/features/announcer.js",
  ],
  [
    "@shadow-js/router/not-found",
    "./node_modules/@shadow-js/router/dist/dev/features/not-found.js",
  ],
  ["@shadow-js/testing/matchers", "./node_modules/@shadow-js/testing/dist/dev/matchers.js"],
  ["@shadow-js/router/blockers", "./node_modules/@shadow-js/router/dist/dev/features/blockers.js"],
  ["@shadow-js/router/prefetch", "./node_modules/@shadow-js/router/dist/dev/features/prefetch.js"],
  ["@shadow-js/router/relative", "./node_modules/@shadow-js/router/dist/dev/features/relative.js"],
  ["@shadow-js/web/jsx-runtime", "./node_modules/@shadow-js/web/dist/prod/jsx-runtime.js"],
  ["@shadow-js/router/loaders", "./node_modules/@shadow-js/router/dist/dev/features/loaders.js"],
  ["@shadow-js/router/filters", "./node_modules/@shadow-js/router/dist/dev/features/filters.js"],
  ["@shadow-js/router/pending", "./node_modules/@shadow-js/router/dist/dev/features/pending.js"],
  ["@shadow-js/testing/routes", "./node_modules/@shadow-js/testing/dist/dev/routes.js"],
  ["@shadow-js/router/scroll", "./node_modules/@shadow-js/router/dist/dev/features/scroll.js"],
  ["@shadow-js/router/errors", "./node_modules/@shadow-js/router/dist/dev/features/errors.js"],
  ["@shadow-js/router/search", "./node_modules/@shadow-js/router/dist/dev/features/search.js"],
  ["@shadow-js/core/extend", "./node_modules/@shadow-js/core/dist/dev/extend/index.js"],
  ["@shadow-js/router/core", "./node_modules/@shadow-js/router/dist/dev/core/index.js"],
  ["@shadow-js/router/vite", "./node_modules/@shadow-js/router/dist/vite/index.js"],
  ["@shadow-js/router/head", "./node_modules/@shadow-js/router/dist/dev/features/head.js"],
  ["@shadow-js/testing/dom", "./node_modules/@shadow-js/testing/dist/dev/dom.js"],
  ["@shadow-js/core/store", "./node_modules/@shadow-js/core/dist/dev/store/index.js"],
  ["@shadow-js/web/server", "./node_modules/@shadow-js/web/dist/dev/server.js"],
  ["@shadow-js/web/extend", "./node_modules/@shadow-js/web/dist/dev/extend.js"],
  ["@shadow-js/compiler", "./node_modules/@shadow-js/compiler/dist/dev/index.js"],
  ["@shadow-js/testing", "./node_modules/@shadow-js/testing/dist/dev/index.js"],
  ["@shadow-js/web/hmr", "./node_modules/@shadow-js/web/dist/dev/hmr.js"],
  ["@shadow-js/router", "./node_modules/@shadow-js/router/dist/dev/index.js"],
  ["@shadow-js/core", "./node_modules/@shadow-js/core/dist/dev/index.js"],
  ["@shadow-js/web", "./node_modules/@shadow-js/web/dist/dev/index.js"],
];
const fromServer: [string, string][] = [
  [
    "@shadow-js/router/prefetch-report",
    "./node_modules/@shadow-js/router/dist/dev/features/prefetch-report.js",
  ],
  ["@shadow-js/testing/auto-cleanup", "./node_modules/@shadow-js/testing/dist/dev/auto-cleanup.js"],
  ["@shadow-js/compiler/javascript", "./node_modules/@shadow-js/compiler/dist/dev/javascript.js"],
  ["@shadow-js/web/jsx-dev-runtime", "./node_modules/@shadow-js/web/dist/prod/jsx-dev-runtime.js"],
  [
    "@shadow-js/router/transitions",
    "./node_modules/@shadow-js/router/dist/dev/features/transitions.js",
  ],
  [
    "@shadow-js/router/link-status",
    "./node_modules/@shadow-js/router/dist/dev/features/link-status.js",
  ],
  ["@shadow-js/testing/playwright", "./node_modules/@shadow-js/testing/dist/dev/playwright.js"],
  [
    "@shadow-js/router/announcer",
    "./node_modules/@shadow-js/router/dist/dev/features/announcer.js",
  ],
  [
    "@shadow-js/router/not-found",
    "./node_modules/@shadow-js/router/dist/dev/features/not-found.js",
  ],
  ["@shadow-js/testing/matchers", "./node_modules/@shadow-js/testing/dist/dev/matchers.js"],
  ["@shadow-js/router/blockers", "./node_modules/@shadow-js/router/dist/dev/features/blockers.js"],
  ["@shadow-js/router/prefetch", "./node_modules/@shadow-js/router/dist/dev/features/prefetch.js"],
  ["@shadow-js/router/relative", "./node_modules/@shadow-js/router/dist/dev/features/relative.js"],
  ["@shadow-js/web/jsx-runtime", "./node_modules/@shadow-js/web/dist/prod/jsx-runtime.js"],
  ["@shadow-js/router/loaders", "./node_modules/@shadow-js/router/dist/dev/features/loaders.js"],
  ["@shadow-js/router/filters", "./node_modules/@shadow-js/router/dist/dev/features/filters.js"],
  ["@shadow-js/router/pending", "./node_modules/@shadow-js/router/dist/dev/features/pending.js"],
  ["@shadow-js/testing/routes", "./node_modules/@shadow-js/testing/dist/dev/routes.js"],
  ["@shadow-js/router/scroll", "./node_modules/@shadow-js/router/dist/dev/features/scroll.js"],
  ["@shadow-js/router/errors", "./node_modules/@shadow-js/router/dist/dev/features/errors.js"],
  ["@shadow-js/router/search", "./node_modules/@shadow-js/router/dist/dev/features/search.js"],
  ["@shadow-js/core/extend", "./node_modules/@shadow-js/core/dist/server-dev/extend/index.js"],
  ["@shadow-js/router/core", "./node_modules/@shadow-js/router/dist/dev/core/index.js"],
  ["@shadow-js/router/vite", "./node_modules/@shadow-js/router/dist/vite/index.js"],
  ["@shadow-js/router/head", "./node_modules/@shadow-js/router/dist/dev/features/head.js"],
  ["@shadow-js/testing/dom", "./node_modules/@shadow-js/testing/dist/dev/dom.js"],
  ["@shadow-js/core/store", "./node_modules/@shadow-js/core/dist/server-dev/store/index.js"],
  ["@shadow-js/web/server", "./node_modules/@shadow-js/web/dist/server-dev/server.js"],
  ["@shadow-js/web/extend", "./node_modules/@shadow-js/web/dist/server-dev/extend.js"],
  ["@shadow-js/compiler", "./node_modules/@shadow-js/compiler/dist/dev/index.js"],
  ["@shadow-js/testing", "./node_modules/@shadow-js/testing/dist/dev/index.js"],
  ["@shadow-js/web/hmr", "./node_modules/@shadow-js/web/dist/dev/hmr.js"],
  ["@shadow-js/router", "./node_modules/@shadow-js/router/dist/dev/index.js"],
  ["@shadow-js/core", "./node_modules/@shadow-js/core/dist/server-dev/index.js"],
  ["@shadow-js/web", "./node_modules/@shadow-js/web/dist/server-dev/index.js"],
];

const define = { __DEV__: "true", __SERVER__: "false", __TEST__: "true", __VERSION__: '"0.0.0"' };
const serverDefine = { ...define, __SERVER__: "true" };
// Matched against the file path, not the specifier: every ShadowJS package in node_modules goes through Vite, so they all share one copy of core.
const inline = {
  deps: { inline: [/[/]node_modules[/]@shadow-js[/]/, /[/]node_modules[/]create-shadow-app[/]/] },
};
const client = { alias: exact([...own, ...fromClient]) };
const serverSide = { alias: exact([...own, ...fromServer]) };

export default defineConfig({
  test: {
    // A snapshot that is missing fails the test; it is never written silently.
    snapshotOptions: { updateSnapshot: "none" },
    projects: [
      {
        define,
        resolve: client,
        test: {
          name: "unit",
          environment: "node",
          server: inline,
          testTimeout: 30_000,
          hookTimeout: 30_000,
          include: ["test/**/*.test.ts"],
          exclude: [
            "**/*.dom.test.ts",
            "**/*.server.test.ts",
            "**/*.gc.test.ts",
            "**/*.perf.test.ts",
            "**/*.dist.test.ts",
            "**/node_modules/**",
          ],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
      {
        define,
        resolve: client,
        test: {
          name: "dom",
          environment: "happy-dom",
          server: inline,
          testTimeout: 30_000,
          include: ["test/**/*.dom.test.ts"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
      {
        define: serverDefine,
        resolve: serverSide,
        test: {
          name: "server",
          environment: "node",
          server: inline,
          include: ["test/**/*.server.test.ts"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
      {
        define,
        resolve: client,
        test: {
          name: "perf",
          environment: "happy-dom",
          server: inline,
          // Wall-clock budgets run alone, in their own invocation, so parallel correctness tests do not consume their frame.
          include: ["test/**/*.perf.test.ts"],
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 30_000,
          setupFiles: ["./vitest.setup.ts"],
        },
      },
      {
        define,
        resolve: client,
        test: {
          name: "gc",
          environment: "node",
          server: inline,
          include: ["test/**/*.gc.test.ts"],
          execArgv: ["--expose-gc"],
          pool: "forks",
        },
      },
    ],
  },
});
