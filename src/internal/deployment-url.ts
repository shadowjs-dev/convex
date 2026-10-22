/** Hosts that are this machine: the local backend of `npx convex dev` listens on one of them. @internal */
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

/** True for a space or a control character: the URL parser drops some of them silently, so two readers could disagree. */
function hasUnsafeCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** A scheme followed by `//`: the parser also accepts `https:/x` and `https:x`, which this refuses. */
const SCHEME_AND_SLASHES = /^[a-z][a-z0-9+.-]*:\/\//iu;

/**
 * Checks a deployment URL before any client is built, on the server and in the browser. The token
 * travels in the same request as the call, so a plain `http:` URL would send it in clear text. Only
 * `https:` is accepted, and `http:` only for a loopback host.
 *
 * The client appends `/api/...` to the string it is given, so the string must name exactly one
 * origin, whatever parser reads it. The check therefore refuses anything two parsers could read
 * differently (a backslash, `https:/x`, whitespace inside, credentials, a query or a fragment) and
 * returns the canonical form the URL parser produces (lowercase scheme and host, no trailing
 * slash), which is what the client must be given. Outer whitespace, such as a newline at the end
 * of an environment variable, is trimmed.
 *
 * @param url The deployment URL the app passed in.
 * @returns The canonical URL: origin, plus the path when there is one, without a trailing slash.
 * @throws TypeError when the URL is empty, is not a URL, carries credentials, a query or a fragment,
 * or is not https (or loopback http). The message never contains the URL, which could hold credentials.
 * @internal
 */
export function checkDeploymentUrl(url: string): string {
  if (typeof url !== "string" || url === "") {
    throw new TypeError("The Convex deployment URL must be a non-empty string.");
  }
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // The parse error carries the raw input (`input`), which may hold credentials: not chained.
    throw new TypeError("The Convex deployment URL is not a valid URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError(
      "Must start with https:// (http:// is accepted only for localhost, 127.0.0.1 or [::1]). The Convex deployment URL must be an https URL.",
    );
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new TypeError(
      "The Convex deployment URL must use https. http is accepted only for localhost, 127.0.0.1 or [::1] (the local backend), because the token would travel in clear text.",
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TypeError(
      "The Convex deployment URL must not contain credentials (user:password@). Put the host alone.",
    );
  }
  if (hasUnsafeCharacter(trimmed) || trimmed.includes("\\") || !SCHEME_AND_SLASHES.test(trimmed)) {
    throw new TypeError(
      "The Convex deployment URL has a character or form that readers disagree on (a space, a backslash or a missing //). Write it as https://host.",
    );
  }
  if (trimmed.includes("?") || trimmed.includes("#")) {
    throw new TypeError(
      "The Convex deployment URL must not have a query or a fragment: the client appends its own paths.",
    );
  }
  const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/u, "");
  return `${parsed.origin}${path}`;
}
