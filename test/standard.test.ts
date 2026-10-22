import { v } from "convex/values";
import { describe, expect, it } from "vitest";
import { fromConvexValidator, type StandardIssue, type StandardSchemaV1 } from "../src/standard";

/** Validates `value` and returns the issues (empty when it passes). */
function issuesOf(schema: StandardSchemaV1, value: unknown): readonly StandardIssue[] {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) throw new Error("the bridge validates synchronously");
  return result.issues ?? [];
}

describe("fromConvexValidator: Standard Schema over v.* validators", () => {
  it("[STD-1] the schema is a Standard Schema v1 object with the vendor convex", () => {
    const schema = fromConvexValidator(v.string());
    expect(schema["~standard"].version).toBe(1);
    expect(schema["~standard"].vendor).toBe("convex");
  });

  it("[STD-2] a passing value returns { value } and a failing one returns issues", () => {
    const schema = fromConvexValidator(v.string());
    expect(schema["~standard"].validate("ok")).toEqual({ value: "ok" });
    expect(issuesOf(schema, 42)).toEqual([{ message: "Expected a string.", path: [] }]);
  });

  it("[STD-3] an object reports each bad field with its path, and rejects fields the validator does not have", () => {
    const schema = fromConvexValidator(v.object({ title: v.string(), done: v.boolean() }));
    expect(issuesOf(schema, { title: "a", done: true })).toEqual([]);
    expect(issuesOf(schema, { title: 1, done: "no" })).toEqual([
      { message: "Expected a string.", path: ["title"] },
      { message: "Expected a boolean.", path: ["done"] },
    ]);
    expect(issuesOf(schema, { title: "a", done: true, extra: 1 })).toEqual([
      { message: 'Unexpected field "extra".', path: ["extra"] },
    ]);
  });

  it("[STD-4] optional fields may be missing or undefined; required ones report Required", () => {
    const schema = fromConvexValidator(v.object({ note: v.optional(v.string()), id: v.string() }));
    expect(issuesOf(schema, { id: "x" })).toEqual([]);
    expect(issuesOf(schema, { id: "x", note: undefined })).toEqual([]);
    expect(issuesOf(schema, { note: "n" })).toEqual([
      { message: "Required value is missing.", path: ["id"] },
    ]);
  });

  it("[STD-5] arrays validate each element and report its index", () => {
    const schema = fromConvexValidator(v.array(v.float64()));
    expect(issuesOf(schema, [1, 2.5])).toEqual([]);
    expect(issuesOf(schema, [1, "2"])).toEqual([{ message: "Expected a number.", path: [1] }]);
  });

  it("[STD-6] a union passes when one member passes, and reports one issue when none does", () => {
    const schema = fromConvexValidator(v.union(v.literal("draft"), v.literal("published")));
    expect(issuesOf(schema, "draft")).toEqual([]);
    expect(issuesOf(schema, "archived")).toEqual([
      { message: "Value does not match any member of the union.", path: [] },
    ]);
  });

  it("[STD-7] int64 takes a bigint within the signed 64-bit range; null, bytes and id are checked by kind", () => {
    expect(issuesOf(fromConvexValidator(v.int64()), 5n)).toEqual([]);
    expect(issuesOf(fromConvexValidator(v.int64()), 5)).toEqual([
      { message: "Expected a bigint.", path: [] },
    ]);
    expect(issuesOf(fromConvexValidator(v.int64()), 2n ** 63n)).toEqual([
      { message: "The bigint is outside the int64 range.", path: [] },
    ]);
    expect(issuesOf(fromConvexValidator(v.null()), null)).toEqual([]);
    expect(issuesOf(fromConvexValidator(v.null()), undefined)).toEqual([
      { message: "Required value is missing.", path: [] },
    ]);
    expect(issuesOf(fromConvexValidator(v.bytes()), new ArrayBuffer(2))).toEqual([]);
    expect(issuesOf(fromConvexValidator(v.bytes()), "x")).toEqual([
      { message: "Expected bytes (an ArrayBuffer).", path: [] },
    ]);
    expect(issuesOf(fromConvexValidator(v.id("tasks")), "k57abc")).toEqual([]);
  });

  it("[STD-8] a record checks its keys and its values", () => {
    const schema = fromConvexValidator(v.record(v.string(), v.number()));
    expect(issuesOf(schema, { a: 1 })).toEqual([]);
    expect(issuesOf(schema, { a: "1" })).toEqual([{ message: "Expected a number.", path: ["a"] }]);
  });

  it("[STD-9] v.any accepts every defined value; a deeply nested value does not overflow the stack", () => {
    expect(issuesOf(fromConvexValidator(v.any()), { anything: [1, "x", null] })).toEqual([]);
    let deep: unknown = "leaf";
    for (let level = 0; level < 20_000; level += 1) deep = [deep];
    const schema = fromConvexValidator(v.array(v.any()));
    expect(issuesOf(schema, [deep])).toEqual([]);
  });

  it("[STD-10] the inferred output type is the validator's type (checked by tsc in test-types)", () => {
    const schema = fromConvexValidator(v.object({ title: v.string() }));
    const result = schema["~standard"].validate({ title: "t" });
    expect(result).toEqual({ value: { title: "t" } });
  });
});
