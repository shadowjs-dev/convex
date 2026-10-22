import type { GenericValidator } from "convex/values";

/**
 * The Standard Schema v1 interface (https://standardschema.dev), declared here so the package has
 * no dependency on a schema library. Forms and server functions accept any object with this shape.
 *
 * @example
 * ```ts
 * import type { StandardSchemaV1 } from "@shadow-js/convex";
 *
 * export const nonEmpty: StandardSchemaV1<string> = {
 *   "~standard": {
 *     version: 1,
 *     vendor: "example",
 *     validate: (value) =>
 *       typeof value === "string" && value !== ""
 *         ? { value }
 *         : { issues: [{ message: "Enter a title.", path: [] }] },
 *   },
 * };
 * ```
 * @see {@link fromConvexValidator}
 * @since 1.0.0
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** The schema's properties, under the key every Standard Schema library uses. */
  readonly "~standard": StandardProps<Input, Output>;
}

/**
 * The `~standard` member of a {@link StandardSchemaV1}.
 *
 * @example
 * ```ts
 * import type { StandardProps, StandardSchemaV1 } from "@shadow-js/convex";
 *
 * function vendorOf(schema: StandardSchemaV1): string {
 *   const props: StandardProps<unknown, unknown> = schema["~standard"];
 *   return `${props.vendor} (Standard Schema v${props.version})`;
 * }
 *
 * vendorOf({ "~standard": { version: 1, vendor: "example", validate: (value) => ({ value }) } });
 * ```
 * @since 1.0.0
 */
export interface StandardProps<Input, Output> {
  /** The version of the Standard Schema specification: always `1`. */
  readonly version: 1;
  /** The library that made the schema. `"convex"` for {@link fromConvexValidator}. */
  readonly vendor: string;
  /** Checks one value and returns its {@link StandardResult}. */
  readonly validate: (value: unknown) => StandardResult<Output>;
  /**
   * Type-only carrier of the input and output types, for inference; never set at runtime by
   * {@link fromConvexValidator}.
   */
  readonly types?: { readonly input: Input; readonly output: Output } | undefined;
}

/**
 * The result of validating one value: `{ value }` when it passes, `{ issues }` when it does not.
 * Check for `issues` to tell them apart.
 *
 * @example
 * ```ts
 * import type { StandardResult } from "@shadow-js/convex";
 *
 * function firstProblem(result: StandardResult<unknown>): string | undefined {
 *   return result.issues === undefined ? undefined : result.issues[0]?.message;
 * }
 *
 * firstProblem({ issues: [{ message: "Expected a string.", path: ["title"] }] });
 * ```
 * @since 1.0.0
 */
export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardIssue[] };

/**
 * One problem found in a value.
 *
 * @example
 * ```ts
 * import type { StandardIssue } from "@shadow-js/convex";
 *
 * function describe(issue: StandardIssue): string {
 *   const where = issue.path === undefined || issue.path.length === 0 ? "value" : issue.path.join(".");
 *   return `${where}: ${issue.message}`;
 * }
 *
 * describe({ message: "Expected a boolean.", path: ["tasks", 0, "done"] });
 * ```
 * @since 1.0.0
 */
export interface StandardIssue {
  /** A sentence that says what is wrong, for example `"Expected a string."`. */
  readonly message: string;
  /**
   * The list of keys and indexes from the root to the bad part; empty for a problem with the
   * whole value. Optional in the specification; {@link fromConvexValidator} always sets it.
   */
  readonly path?: readonly PropertyKey[] | undefined;
}

/** One piece of work for the walk: a validator, the value it checks, and where the value sits. @internal */
interface Task {
  readonly validator: GenericValidator;
  readonly value: unknown;
  readonly path: readonly PropertyKey[];
}

/** The int64 range Convex stores: a signed 64-bit integer. @internal */
const INT64_MIN = -(2n ** 63n);
/** The largest int64 value. @internal */
const INT64_MAX = 2n ** 63n - 1n;

/** Most issues one validation reports; the rest of a huge wrong input is not walked. @internal */
const MAX_ISSUES = 100;

/** Longest part of a field name quoted in a message. @internal */
const MAX_QUOTED_KEY = 48;

/**
 * Plain data objects only: the Object prototype, none, or the Object prototype of another realm
 * (whose own prototype is null). A Date, Map, Set, typed array or class instance has no own
 * enumerable keys that describe it, so it would pass `v.object({})` and then fail in the deployment.
 * @internal
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    prototype === null ||
    prototype === Object.prototype ||
    Object.getPrototypeOf(prototype) === null
  );
}

/**
 * Quotes a field name for a message: escaped (a newline cannot forge a log line) and cut (a huge
 * key cannot flood one). The full name stays in `path`, where the caller needs it.
 * @internal
 */
function quoteKey(key: string): string {
  const cut = key.length > MAX_QUOTED_KEY ? `${key.slice(0, MAX_QUOTED_KEY)}...` : key;
  return JSON.stringify(cut);
}

/** Writes an expected literal; a bigint has no JSON form. @internal */
function describeLiteral(value: unknown): string {
  return typeof value === "bigint" ? `${value}n` : JSON.stringify(value);
}

/**
 * The kind of a validator, read outside the switch in {@link collectIssues}. The fail-closed default
 * branch of that switch names an unknown kind through this helper, which keeps the message compiling
 * when a convex version narrows the kinds (the branch's validator is `never` there).
 * @internal
 */
function kindOf(validator: GenericValidator): string {
  return validator.kind;
}

/**
 * Checks one value against one validator and returns the problems. The walk over the value is
 * iterative (a stack of tasks), so a value nested thousands of levels deep cannot overflow the
 * stack. A union checks each member with its own walk; the depth of unions is set by the validator
 * the developer wrote, not by the input.
 * @internal
 */
function collectIssues(
  root: GenericValidator,
  rootValue: unknown,
  limit: number = MAX_ISSUES,
): StandardIssue[] {
  const issues: StandardIssue[] = [];
  const stack: Task[] = [{ validator: root, value: rootValue, path: [] }];
  for (let task = stack.pop(); task !== undefined; task = stack.pop()) {
    if (issues.length >= limit) {
      // Stopped early: the value is invalid either way, and the rest is not worth the memory.
      if (limit === MAX_ISSUES) issues.push({ message: "More problems were found.", path: [] });
      break;
    }
    const { validator, value, path } = task;
    if (value === undefined) {
      if (validator.isOptional !== "optional") {
        issues.push({ message: "Required value is missing.", path });
      }
      continue;
    }
    switch (validator.kind) {
      case "string":
        if (typeof value !== "string") issues.push({ message: "Expected a string.", path });
        break;
      case "float64":
        if (typeof value !== "number") issues.push({ message: "Expected a number.", path });
        break;
      case "boolean":
        if (typeof value !== "boolean") issues.push({ message: "Expected a boolean.", path });
        break;
      case "null":
        if (value !== null) issues.push({ message: "Expected null.", path });
        break;
      case "int64":
        if (typeof value !== "bigint") {
          issues.push({ message: "Expected a bigint.", path });
        } else if (value < INT64_MIN || value > INT64_MAX) {
          issues.push({ message: "The bigint is outside the int64 range.", path });
        }
        break;
      case "bytes":
        if (!(value instanceof ArrayBuffer)) {
          issues.push({ message: "Expected bytes (an ArrayBuffer).", path });
        }
        break;
      case "id":
        if (typeof value !== "string") issues.push({ message: "Expected an id string.", path });
        break;
      case "any":
        break;
      case "literal":
        if (value !== validator.value) {
          issues.push({ message: `Expected ${describeLiteral(validator.value)}.`, path });
        }
        break;
      case "array":
        if (!Array.isArray(value)) {
          issues.push({ message: "Expected an array.", path });
          break;
        }
        for (let index = value.length - 1; index >= 0; index -= 1) {
          stack.push({ validator: validator.element, value: value[index], path: [...path, index] });
        }
        break;
      case "object": {
        if (!isPlainObject(value)) {
          issues.push({ message: "Expected an object.", path });
          break;
        }
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(validator.fields, key) && value[key] !== undefined) {
            issues.push({
              message: `Unexpected field ${quoteKey(key)}.`,
              path: [...path, key],
            });
          }
        }
        // Pushed in reverse so the fields are checked, and reported, in declaration order.
        const fieldNames = Object.keys(validator.fields);
        for (let index = fieldNames.length - 1; index >= 0; index -= 1) {
          const name = fieldNames[index];
          if (name === undefined) continue;
          const fieldValidator = validator.fields[name];
          if (fieldValidator === undefined) continue;
          const fieldValue = Object.hasOwn(value, name) ? value[name] : undefined;
          stack.push({ validator: fieldValidator, value: fieldValue, path: [...path, name] });
        }
        break;
      }
      case "record": {
        if (!isPlainObject(value)) {
          issues.push({ message: "Expected an object.", path });
          break;
        }
        for (const key of Object.keys(value)) {
          stack.push({ validator: validator.key, value: key, path: [...path, key] });
          stack.push({ validator: validator.value, value: value[key], path: [...path, key] });
        }
        break;
      }
      case "union": {
        const matches = validator.members.some(
          (member: GenericValidator) => collectIssues(member, value, 1).length === 0,
        );
        if (!matches) {
          issues.push({ message: "Value does not match any member of the union.", path });
        }
        break;
      }
      default:
        // A validator kind this bridge does not know fails closed: the value is not accepted.
        issues.push({
          message: `Unsupported validator kind "${kindOf(validator)}".`,
          path,
        });
    }
  }
  return issues;
}

/**
 * Builds a Standard Schema from a Convex validator (`v.object({...})`, `v.array(...)`, ...), so the
 * same definition can check a form, a Dusk server function's input, or a value read from a request.
 * The check follows the rules Convex applies to function arguments: required fields, optional
 * fields, no fields the validator does not declare, and the value kinds of each `v.*` validator.
 * Objects must be plain data objects (a `Date`, `Map` or class instance is refused), and
 * `v.int64()` takes a `bigint` within the signed 64-bit range.
 *
 * Limits: `v.id(table)` only checks that the value is a string (the table is not checked); `v.any()`
 * accepts every defined value; `v.bytes()` checks for an `ArrayBuffer`, not its size. Convex limits
 * on size and nesting depth are not applied here, so a value the bridge accepts can still be
 * rejected by the deployment. One validation reports at most 100 issues, followed by a last issue
 * `"More problems were found."` when it stopped early. A validator kind the bridge does not know
 * is reported as an issue, not accepted.
 *
 * @param validator A validator from `convex/values`.
 * @returns A {@link StandardSchemaV1} with vendor `"convex"` whose `validate` is synchronous.
 * @example
 * ```ts
 * import { fromConvexValidator } from "@shadow-js/convex";
 *
 * // Stands in for `v.object({ title: v.string(), done: v.boolean() })` from convex/values.
 * declare const taskValidator: Parameters<typeof fromConvexValidator>[0];
 *
 * const taskSchema = fromConvexValidator(taskValidator);
 *
 * export function readTask(input: unknown) {
 *   const result = taskSchema["~standard"].validate(input);
 *   if (result.issues !== undefined) {
 *     throw new TypeError(result.issues.map((issue) => issue.message).join(" "));
 *   }
 *   return result.value;
 * }
 * ```
 * @since 1.0.0
 */
export function fromConvexValidator<V extends GenericValidator>(
  validator: V,
): StandardSchemaV1<V["type"], V["type"]> {
  return {
    "~standard": {
      version: 1,
      vendor: "convex",
      validate(value: unknown): StandardResult<V["type"]> {
        const issues = collectIssues(validator, value);
        if (issues.length > 0) return { issues };
        return { value: value as V["type"] };
      },
    },
  };
}
