// biome-ignore-all lint/correctness/noUnusedVariables: the type aliases here are compile-time assertions; they are checked by tsc and never read at run time.
import type { ConvexClient, ConvexHttpClient } from "convex/browser";
import type { ConvexClientLike, ConvexHttpClientLike } from "../src/index";
import type { Equal, Expect } from "./api";

/*
 * The real clients must satisfy the structural interfaces the hooks depend on. Values are declared,
 * never constructed, so this file needs no deployment and opens no connection.
 */
declare const realClient: ConvexClient;
declare const realHttp: ConvexHttpClient;

export const clientIsLike: ConvexClientLike = realClient;
export const httpIsLike: ConvexHttpClientLike = realHttp;

/** The real client is accepted wherever a ConvexClientLike is expected, as a parameter too. */
export function takesLike(client: ConvexClientLike): ConvexClientLike {
  return client;
}
export const passedThrough: ConvexClientLike = takesLike(realClient);

export type ClientCheck = Expect<
  Equal<ConvexClientLike extends ConvexClient ? true : false, false>
>;
