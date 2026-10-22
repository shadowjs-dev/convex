import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createConvexClient } from "../src/client";
import { fetchQuery } from "../src/fetch";
import { checkDeploymentUrl } from "../src/internal/deployment-url";
import { api } from "./support/refs";

/**
 * SEC2-CONVEX-01..: the deployment URL. The invariant is that a token is only ever sent to the one
 * origin the app configured, so every spelling that could make two parsers disagree about the host
 * is refused, and what is accepted is returned in its canonical form.
 */

const SEED = 20260610;

/** Every error message and `cause` message of a thrown value, joined. */
function chainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message, JSON.stringify(Object.entries(current)));
      current = current.cause;
    } else {
      parts.push(String(current));
      current = undefined;
    }
  }
  return parts.join("\n");
}

function rejection(url: string): unknown {
  try {
    checkDeploymentUrl(url);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("SEC2-CONVEX deployment URL", () => {
  it("SEC2-CONVEX-01 refuses userinfo and never echoes the credentials in the error or its cause", () => {
    for (const url of [
      "https://user:hunter2@happy-otter-123.convex.cloud",
      "https://hunter2@happy-otter-123.convex.cloud",
      "https://happy-otter-123.convex.cloud@evil.example",
      "https://:hunter2@happy-otter-123.convex.cloud",
      "http://localhost:3210@evil.example",
    ]) {
      const error = rejection(url);
      expect(error, url).toBeInstanceOf(TypeError);
      expect(chainText(error), url).not.toContain("hunter2");
    }
  });

  it("SEC2-CONVEX-02 an unparseable URL does not carry the raw input in the error chain", () => {
    const error = rejection("https://user:hunter2@");
    expect(error).toBeInstanceOf(TypeError);
    expect(chainText(error)).not.toContain("hunter2");
  });

  it("SEC2-CONVEX-03 an uppercase scheme is accepted and returned in canonical lowercase", () => {
    expect(checkDeploymentUrl("HTTPS://Happy-Otter-123.convex.cloud")).toBe(
      "https://happy-otter-123.convex.cloud",
    );
    expect(() => checkDeploymentUrl("HTTP://happy-otter-123.convex.cloud")).toThrow(
      /must use https/,
    );
  });

  it("SEC2-CONVEX-04 outer whitespace is trimmed, interior whitespace and control characters are refused", () => {
    expect(checkDeploymentUrl("  https://happy-otter-123.convex.cloud\n")).toBe(
      "https://happy-otter-123.convex.cloud",
    );
    for (const url of [
      "https://happy-otter-123.convex.cloud /x",
      "https://happy\totter.convex.cloud",
      "https://happy-otter\n.convex.cloud",
      "https://happy-otter\u0000.convex.cloud",
    ]) {
      expect(rejection(url), JSON.stringify(url)).toBeInstanceOf(TypeError);
    }
  });

  it("SEC2-CONVEX-05 a scheme without two slashes and backslash hosts are refused", () => {
    for (const url of [
      "https:/happy-otter-123.convex.cloud",
      "https:happy-otter-123.convex.cloud",
      "https:\\\\happy-otter-123.convex.cloud",
      "https://happy-otter-123.convex.cloud\\@evil.example",
      "https:\\/happy-otter-123.convex.cloud",
    ]) {
      expect(rejection(url), url).toBeInstanceOf(TypeError);
    }
  });

  it("SEC2-CONVEX-06 refuses a query or a fragment in the base URL, even an empty one", () => {
    for (const url of [
      "https://happy-otter-123.convex.cloud?next=1",
      "https://happy-otter-123.convex.cloud/?",
      "https://happy-otter-123.convex.cloud#frag",
      "https://happy-otter-123.convex.cloud/#",
    ]) {
      expect(rejection(url), url).toBeInstanceOf(TypeError);
    }
  });

  it("SEC2-CONVEX-07 a path is kept in canonical form: dot segments collapse, the trailing slash goes", () => {
    expect(checkDeploymentUrl("https://happy-otter-123.convex.cloud/")).toBe(
      "https://happy-otter-123.convex.cloud",
    );
    expect(checkDeploymentUrl("https://example.com/convex/")).toBe("https://example.com/convex");
    expect(checkDeploymentUrl("https://example.com/a/../b/./c")).toBe("https://example.com/b/c");
  });

  it("SEC2-CONVEX-08 http is accepted only for the real loopback hosts; mapped and look-alike hosts are refused", () => {
    for (const url of [
      "http://[::ffff:127.0.0.1]:3210",
      "http://[::ffff:7f00:1]:3210",
      "http://localhost.evil.com",
      "http://127.0.0.1.nip.io",
      "http://127.0.0.1.evil.com:3210",
      "http://0.0.0.0:3210",
      "http://[::]:3210",
      "http://localhost.:3210",
      "http://1.1.1.1:3210",
    ]) {
      expect(rejection(url), url).toBeInstanceOf(TypeError);
    }
    for (const url of ["http://localhost:3210", "http://127.0.0.1:3210", "http://[::1]:3210"]) {
      expect(checkDeploymentUrl(url), url).toBe(url);
    }
    expect(checkDeploymentUrl("http://[0:0:0:0:0:0:0:1]:3210")).toBe("http://[::1]:3210");
  });

  it("SEC2-CONVEX-09 the helpers send the canonical URL to the client builder, so no parser differential remains", async () => {
    const urls: string[] = [];
    const createClient = (url: string) => {
      urls.push(url);
      return {
        setAuth: () => undefined,
        query: async () => "ok",
        mutation: async () => "ok",
        action: async () => "ok",
      };
    };
    await fetchQuery(
      "  HTTPS://Happy-Otter-123.convex.cloud/ ",
      api.tasks.list,
      {},
      { createClient },
    );
    expect(urls).toEqual(["https://happy-otter-123.convex.cloud"]);
  });

  it("SEC2-CONVEX-10 the browser client builder applies the same refusals", () => {
    for (const url of [
      "https://user:hunter2@happy-otter-123.convex.cloud",
      "https://happy-otter-123.convex.cloud?x=1",
      "http://[::ffff:127.0.0.1]:3210",
    ]) {
      expect(() => createConvexClient(url, { disabled: true }), url).toThrow(TypeError);
    }
    // An uppercase scheme is accepted (and canonicalized before the client sees it).
    expect(() =>
      createConvexClient("HTTPS://Happy-Otter-123.convex.cloud/", { disabled: true }),
    ).not.toThrow();
  });

  it("SEC2-CONVEX-11 fuzz: whatever is accepted is a canonical URL with no userinfo, query or fragment, on the host the input named", () => {
    const scheme = fc.constantFrom("https", "HTTPS", "http", "HtTp", "ws", "ftp", "https:", "");
    const sep = fc.constantFrom("://", ":/", ":\\\\", "//", ":", ":///");
    const userinfo = fc.constantFrom("", "u@", "u:p@", "@", ":@", "good.example@", "a\\@");
    const host = fc.constantFrom(
      "good.example",
      "GOOD.example",
      "localhost",
      "127.0.0.1",
      "[::1]",
      "[::ffff:127.0.0.1]",
      "localhost.evil.com",
      "good.example\\evil.example",
      "good.example\tevil",
      "127.1",
      "0x7f.1",
    );
    const suffix = fc.constantFrom(
      "",
      "/",
      ":3210",
      "/p",
      "/p/",
      "?q",
      "#f",
      "/..",
      "/%2e%2e/x",
      "//evil.example",
      "\\evil.example",
      "/p?q#f",
    );
    const pad = fc.constantFrom("", " ", "\n", "\t ");
    fc.assert(
      fc.property(pad, scheme, sep, userinfo, host, suffix, pad, (p1, s, sp, u, h, x, p2) => {
        const input = `${p1}${s}${sp}${u}${h}${x}${p2}`;
        let accepted: string;
        try {
          accepted = checkDeploymentUrl(input);
        } catch (error) {
          expect(error).toBeInstanceOf(TypeError);
          return;
        }
        const parsed = new URL(accepted);
        expect(parsed.username).toBe("");
        expect(parsed.password).toBe("");
        expect(parsed.search).toBe("");
        expect(parsed.hash).toBe("");
        expect(accepted).not.toMatch(/[\\\s]/);
        expect(parsed.protocol === "https:" || parsed.protocol === "http:").toBe(true);
        // Appending an API path (what the Convex client does) cannot leave the origin.
        expect(new URL(`${accepted}/api/query`).origin).toBe(parsed.origin);
        // Idempotent: checking the canonical form changes nothing.
        expect(checkDeploymentUrl(accepted)).toBe(accepted);
        // http only ever reaches a loopback host.
        if (parsed.protocol === "http:") {
          expect(["localhost", "127.0.0.1", "[::1]"]).toContain(parsed.hostname);
        }
        // The host is the one the trimmed input named (no backslash or userinfo reinterpretation).
        expect(parsed.origin).toBe(new URL(input.trim()).origin);
      }),
      { seed: SEED, numRuns: 600 },
    );
  });
});
