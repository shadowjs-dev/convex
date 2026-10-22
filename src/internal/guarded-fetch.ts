/**
 * What the guarded fetch enforces on one deployment.
 * @internal
 */
export interface FetchLimits {
  /** Milliseconds the whole exchange (request and reading the body) may take. */
  readonly timeoutMs: number;
  /** Bytes of response body that are accepted. */
  readonly maxResponseBytes: number;
}

/** Statuses a `Response` may not carry a body for. @internal */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** The URL a `fetch` input names, as a string. @internal */
function targetOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Reads a body, stopping as soon as it passes `limit` bytes or `signal` aborts. The declared
 * `content-length` is only a hint (it can be absent or wrong), so the bytes are counted as they
 * arrive. A real `fetch` errors the stream on abort; the race makes this hold for any body source.
 * @internal
 */
export async function readBoundedBytes(
  response: Response,
  limit: number,
  signal: AbortSignal = new AbortController().signal,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new RangeError("The response is larger than the allowed size.");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array(0);
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      // Reject first: canceling ends a pending read as "done", which must not look like a body.
      reject(signal.reason);
      reader.cancel(signal.reason).then(undefined, reject);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (let part = await Promise.race([reader.read(), aborted]); !part.done; ) {
      total += part.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new RangeError("The response is larger than the allowed size.");
      }
      chunks.push(part.value);
      part = await Promise.race([reader.read(), aborted]);
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Builds the `fetch` the HTTP caller hands to `ConvexHttpClient`. Every call it makes carries an
 * `Authorization` header, so this is the single place that decides where such a request may go and
 * what may come back:
 *
 * - the target must be on the deployment's origin (checked before `fetch` runs, so a bug in the
 *   client's URL building cannot send the token elsewhere);
 * - a redirect is an error (`redirect: "error"`): a 307 or 308 would otherwise re-send the
 *   arguments to the new location, and Convex's API never redirects;
 * - the exchange has a deadline that covers reading the body, not only the response headers;
 * - the body is read with a byte limit and handed on as a plain `Response`.
 *
 * @param baseUrl The canonical deployment URL ({@link checkDeploymentUrl}).
 * @param limits Deadline and size limit.
 * @param fetchImpl The `fetch` to wrap; the global one at call time by default.
 * @returns A `fetch`-shaped function for `ConvexHttpClient`'s `fetch` option.
 * @internal
 */
export function createGuardedFetch(
  baseUrl: string,
  limits: FetchLimits,
  fetchImpl?: typeof fetch,
): typeof fetch {
  const origin = new URL(baseUrl).origin;
  return async (input, init) => {
    let target: URL;
    try {
      target = new URL(targetOf(input));
    } catch {
      throw new TypeError("Refused a request to a URL that cannot be parsed.");
    }
    if (target.origin !== origin || target.username !== "" || target.password !== "") {
      // Neither URL nor headers go into the message: both can hold secrets.
      throw new TypeError(
        "Refused to send a Convex request to an origin other than the deployment.",
      );
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort(new DOMException("The Convex request timed out.", "TimeoutError"));
    }, limits.timeoutMs);
    const callerSignal = init?.signal;
    const signal =
      callerSignal === undefined || callerSignal === null
        ? deadline.signal
        : AbortSignal.any([deadline.signal, callerSignal]);
    try {
      const send = fetchImpl ?? globalThis.fetch;
      const response = await send(input, { ...init, redirect: "error", signal });
      const body = await readBoundedBytes(response, limits.maxResponseBytes, signal);
      const headers = new Headers(response.headers);
      // The bytes are already decoded and counted, so the encoding and length headers would lie.
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(NULL_BODY_STATUSES.has(response.status) ? null : body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}
