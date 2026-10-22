/**
 * Argument identity for reactive queries. Two argument objects with the same content must produce
 * the same key, so that an accessor returning a fresh but equal object does not resubscribe.
 * @internal
 */

/** A query's arguments as the hooks see them before typing. @internal */
export type ArgRecord = Record<string, unknown>;

/** Upper bound on the values one key may visit; protects against cyclic or huge arguments. */
const MAX_VISITS = 100_000;

/** One step of the iterative serializer: a value still to encode, or literal text. */
type Frame = { readonly t: "v"; readonly v: unknown } | { readonly t: "s"; readonly s: string };

/** True for objects that are plain records (not arrays, not ArrayBuffers). @internal */
export function isRecord(value: unknown): value is ArgRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function primitiveKey(value: unknown): string {
  if (value === undefined) return "u";
  if (value === null) return "n";
  if (value === true) return "T";
  if (value === false) return "F";
  if (typeof value === "number") return `d${String(value)}`;
  if (typeof value === "bigint") return `i${value.toString()}`;
  if (typeof value === "string") return `s${JSON.stringify(value)}`;
  return `o${typeof value}`;
}

/**
 * Encodes `value` so that equal content gives equal text, independent of object key order.
 * Object fields holding `undefined` are skipped, as Convex skips them on the wire, and so are the
 * fields named in `skipFields` at any depth. Iterative, so deep arguments cannot overflow the stack.
 * For example, `{ b: 1, a: [2] }` and `{ a: [2], b: 1 }` give the same key.
 *
 * @throws RangeError when the value has more than {@link MAX_VISITS} nodes (cyclic or huge).
 * @internal
 */
export function stableKey(value: unknown, skipFields?: ReadonlySet<string>): string {
  const out: string[] = [];
  const stack: Frame[] = [{ t: "v", v: value }];
  let visits = 0;
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    if (frame.t === "s") {
      out.push(frame.s);
      continue;
    }
    visits += 1;
    if (visits > MAX_VISITS) {
      throw new RangeError("Query arguments are too large or cyclic to be keyed.");
    }
    const current = frame.v;
    if (Array.isArray(current)) {
      const items: unknown[] = current;
      out.push("[");
      stack.push({ t: "s", s: "]" });
      for (let i = items.length - 1; i >= 0; i -= 1) {
        stack.push({ t: "v", v: items[i] });
        if (i > 0) stack.push({ t: "s", s: "," });
      }
    } else if (current instanceof ArrayBuffer) {
      out.push("x", Array.from(new Uint8Array(current)).join("."));
    } else if (isRecord(current)) {
      const keys = Object.keys(current)
        .filter((key) => current[key] !== undefined && skipFields?.has(key) !== true)
        .sort();
      out.push("{");
      stack.push({ t: "s", s: "}" });
      for (let i = keys.length - 1; i >= 0; i -= 1) {
        const key = keys[i];
        if (key === undefined) continue;
        stack.push({ t: "v", v: current[key] });
        stack.push({ t: "s", s: `${JSON.stringify(key)}:` });
        if (i > 0) stack.push({ t: "s", s: "," });
      }
    } else {
      out.push(primitiveKey(current));
    }
  }
  return out.join("");
}
