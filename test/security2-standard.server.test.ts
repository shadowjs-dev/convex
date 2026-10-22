import { type GenericValidator, v } from "convex/values";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fromConvexValidator, type StandardIssue } from "../src/standard";

/**
 * SEC2-CONVEX-5x: the Standard Schema bridge. Validation errors reach users, logs and framework
 * error pages, so an issue must say what is wrong without echoing the rejected value, a stack, a
 * path on disk or the schema's internals, and it must never throw instead of returning issues.
 */

const SEED = 20260611;
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.SECRETPAYLOAD.SECRETSIGNATURE";

function issuesOf(validator: GenericValidator, value: unknown): readonly StandardIssue[] {
  const result = fromConvexValidator(validator)["~standard"].validate(value);
  return result.issues ?? [];
}

function text(issues: readonly StandardIssue[]): string {
  return JSON.stringify(issues, (_key, value: unknown) =>
    typeof value === "bigint" ? `${value}n` : value,
  );
}

describe("SEC2-CONVEX standard schema bridge", () => {
  it("SEC2-CONVEX-50 a rejected value is never echoed: a token in a wrong-typed leaf is absent from the issues", () => {
    const schema = v.object({
      name: v.string(),
      count: v.float64(),
      flag: v.boolean(),
      nothing: v.null(),
      big: v.int64(),
      tags: v.array(v.string()),
      pick: v.union(v.literal("a"), v.literal("b")),
      lit: v.literal("fixed"),
      bag: v.record(v.string(), v.float64()),
    });
    const input = {
      name: { value: TOKEN },
      count: TOKEN,
      flag: TOKEN,
      nothing: TOKEN,
      big: TOKEN,
      tags: [TOKEN, 1],
      pick: TOKEN,
      lit: TOKEN,
      bag: { ok: TOKEN },
    };
    const issues = issuesOf(schema, input);
    expect(issues.length).toBeGreaterThan(5);
    expect(text(issues)).not.toContain("SECRET");
  });

  it("SEC2-CONVEX-51 an issue carries only message and path, with short generic messages", () => {
    const issues = issuesOf(v.object({ a: v.string(), b: v.array(v.object({ c: v.float64() })) }), {
      a: 1,
      b: [{ c: "x" }, 3],
      z: 1,
    });
    for (const issue of issues) {
      expect(Object.keys(issue).sort()).toEqual(["message", "path"]);
      expect(issue.message.length).toBeLessThan(120);
      expect(issue.message).not.toMatch(/\bat \S+:\d+|node_modules|\/Users\/|file:\/\/|Error:/);
    }
  });

  it("SEC2-CONVEX-52 an unexpected key is quoted, truncated and escaped in the message, so it cannot forge a log line or flood one", () => {
    const hostile = `evil\nINFO forged log line ${"k".repeat(5000)}`;
    const issues = issuesOf(v.object({}), { [hostile]: 1 });
    expect(issues.length).toBe(1);
    const message = issues[0]?.message ?? "";
    expect(message).not.toContain("\n");
    expect(message.length).toBeLessThan(120);
  });

  it("SEC2-CONVEX-53 a bigint literal that does not match returns an issue instead of throwing", () => {
    let issues: readonly StandardIssue[] = [];
    expect(() => {
      issues = issuesOf(v.literal(10n), 11n);
    }).not.toThrow();
    expect(issues.length).toBe(1);
    expect(issues[0]?.message).toBe("Expected 10n.");
    expect(issuesOf(v.literal(10n), 10n)).toEqual([]);
    expect(issuesOf(v.object({ k: v.literal(1n) }), { k: "x" }).length).toBe(1);
  });

  it("SEC2-CONVEX-54 objects that are not plain (Date, Map, Set, class instances, typed arrays) are rejected as objects", () => {
    class Box {
      readonly secret = 1;
    }
    for (const value of [new Date(), new Map(), new Set(), new Uint8Array(0), new Box()]) {
      expect(issuesOf(v.object({}), value).length, Object.prototype.toString.call(value)).toBe(1);
      expect(issuesOf(v.record(v.string(), v.any()), value).length).toBe(1);
    }
    // A null-prototype object and one parsed from JSON are plain.
    expect(
      issuesOf(v.object({ a: v.string() }), Object.assign(Object.create(null), { a: "x" })),
    ).toEqual([]);
    expect(issuesOf(v.object({ a: v.string() }), JSON.parse('{"a":"x"}'))).toEqual([]);
  });

  it("SEC2-CONVEX-55 the number of issues is bounded for a huge wrong input", () => {
    const issues = issuesOf(v.array(v.string()), new Array<number>(50_000).fill(1));
    expect(issues.length).toBeLessThanOrEqual(101);
    expect(issues.length).toBeGreaterThan(0);
  });

  it("SEC2-CONVEX-56 a __proto__ key from JSON is an unexpected field, not a way to reach the prototype", () => {
    const input: unknown = JSON.parse('{"a":"x","__proto__":{"polluted":true}}');
    const issues = issuesOf(v.object({ a: v.string() }), input);
    expect(issues.length).toBe(1);
    expect(issues[0]?.path).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("SEC2-CONVEX-57 fuzz: validate never throws, issues stay small, and a marker string value is never echoed", () => {
    const leaf = fc.oneof(
      fc.constant("SECRETMARKER-1f9a"),
      fc.string(),
      fc.double(),
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
      fc.bigInt(),
    );
    const value: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
      node: fc.oneof(
        { depthSize: "small", maxDepth: 4 },
        leaf,
        fc.array(tie("node"), { maxLength: 4 }),
        fc.dictionary(fc.string({ maxLength: 6 }), tie("node"), { maxKeys: 4 }),
      ),
    })).node;
    const validators: GenericValidator[] = [
      v.string(),
      v.float64(),
      v.int64(),
      v.literal(7n),
      v.literal("lit"),
      v.array(v.string()),
      v.object({ a: v.string(), b: v.optional(v.array(v.float64())) }),
      v.record(v.string(), v.boolean()),
      v.union(v.string(), v.object({ a: v.float64() }), v.array(v.int64())),
      v.id("tasks"),
      v.bytes(),
      v.any(),
    ];
    fc.assert(
      fc.property(fc.constantFrom(...validators), value, (validator, input) => {
        const result = fromConvexValidator(validator)["~standard"].validate(input);
        for (const issue of result.issues ?? []) {
          expect(Object.keys(issue).sort()).toEqual(["message", "path"]);
          expect(issue.message.length).toBeLessThan(160);
          // A value is never echoed. A key may be (quoted), but a key is not "SECRETMARKER" here.
          const asValue = text([{ message: issue.message, path: [] }]);
          expect(asValue).not.toContain("SECRETMARKER");
        }
      }),
      { seed: SEED, numRuns: 1500 },
    );
  });
});
