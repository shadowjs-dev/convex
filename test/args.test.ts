import { describe, expect, it } from "vitest";
import { stableKey } from "../src/internal/args";

describe("stableKey", () => {
  it("[ARG-1] equal content with different key order gives the same key", () => {
    expect(stableKey({ b: 1, a: { y: "x", z: [1] } })).toBe(
      stableKey({ a: { z: [1], y: "x" }, b: 1 }),
    );
  });

  it("[ARG-2] different values give different keys", () => {
    expect(stableKey({ a: 1 })).not.toBe(stableKey({ a: 2 }));
    expect(stableKey({ a: "1" })).not.toBe(stableKey({ a: 1 }));
  });

  it("[ARG-3] array order matters", () => {
    expect(stableKey({ a: [1, 2] })).not.toBe(stableKey({ a: [2, 1] }));
  });

  it("[ARG-4] bigint and number are distinct", () => {
    expect(stableKey({ n: 1n })).not.toBe(stableKey({ n: 1 }));
  });

  it("[ARG-5] fields holding undefined are ignored, as Convex ignores them on the wire", () => {
    expect(stableKey({ a: 1, b: undefined })).toBe(stableKey({ a: 1 }));
  });

  it("[ARG-6] null, undefined, booleans and the empty string are all distinct", () => {
    const keys = [null, undefined, true, false, ""].map((value) => stableKey({ v: value }));
    expect(new Set(keys).size).toBe(5);
  });

  it("[ARG-7] strings containing delimiters do not collide with structure", () => {
    expect(stableKey({ a: 'x","b":"y' })).not.toBe(stableKey({ a: "x", b: "y" }));
    expect(stableKey(["a,b"])).not.toBe(stableKey(["a", "b"]));
  });

  it("[ARG-8] ArrayBuffers are keyed by their bytes", () => {
    const one = new Uint8Array([1, 2, 3]).buffer;
    const same = new Uint8Array([1, 2, 3]).buffer;
    const other = new Uint8Array([3, 2, 1]).buffer;
    expect(stableKey({ b: one })).toBe(stableKey({ b: same }));
    expect(stableKey({ b: one })).not.toBe(stableKey({ b: other }));
  });

  it("[ARG-9] a 50 000 level deep value is keyed without overflowing the stack", () => {
    let deep: unknown = 0;
    for (let i = 0; i < 49_999; i += 1) deep = [deep];
    expect(() => stableKey(deep)).not.toThrow();
    expect(stableKey(deep).length).toBeGreaterThan(49_999);
  });

  it("[ARG-10] a cyclic value is rejected with a RangeError instead of looping forever", () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(() => stableKey({ cycle })).toThrow(RangeError);
  });

  it("[ARG-11] an empty object and an empty array differ", () => {
    expect(stableKey({})).not.toBe(stableKey([]));
  });

  it("[ARGS-SKIP] fields named in skipFields are left out at every depth; other fields still count", () => {
    const skip = new Set(["_id"]);
    expect(stableKey({ _id: "a", n: { _id: 1, m: 2 } }, skip)).toBe(
      stableKey({ _id: "b", n: { m: 2 } }, skip),
    );
    expect(stableKey({ _id: "a", n: 1 }, skip)).not.toBe(stableKey({ _id: "a", n: 2 }, skip));
  });
});
