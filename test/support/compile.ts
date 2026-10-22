import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "@shadow-js/compiler/javascript";

const dir = join(import.meta.dirname, "..", ".generated");

/**
 * Compiles `source` with the real compiler, writes it next to the tests and imports it, so the
 * result runs through the same module pipeline (aliases, TypeScript stripping) as user code.
 */
export async function load<T = Record<string, unknown>>(
  source: string,
  target: "dom" | "ssr" = "dom",
): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const result = compile(source, { filename: "case.tsx", generate: target });
  const name = `${createHash("sha1").update(`${target}:${source}`).digest("hex").slice(0, 12)}.ts`;
  const file = join(dir, name);
  writeFileSync(file, result.code);
  return (await import(/* @vite-ignore */ file)) as T;
}
