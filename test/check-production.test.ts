import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkProduction,
  clerkHostFromKey,
  main,
  parseEnvFile,
} from "../scripts/check-production.mjs";

/*
 * The production checker validates the names, the deployment URL, the Clerk key and the issuer of a production setup
 * without contacting anything. These fixtures are synthetic: `clerk.example.com` and `happy-otter-123` are not real
 * deployments, and the secret key is a placeholder whose only meaning is its prefix.
 */

const HOST = "clerk.example.com";
const LIVE_KEY = `pk_live_${Buffer.from(`${HOST}$`).toString("base64")}`;
const GOOD_ENV: Readonly<Record<string, string>> = {
  VITE_CONVEX_URL: "https://happy-otter-123.convex.cloud",
  CONVEX_DEPLOYMENT: "prod:happy-otter-123",
  VITE_CLERK_PUBLISHABLE_KEY: LIVE_KEY,
  CLERK_JWT_ISSUER_DOMAIN: `https://${HOST}`,
  CLERK_SECRET_KEY: "sk_live_fixture",
};
const GOOD_AUTH = `export default {
  providers: [{ domain: process.env.CLERK_JWT_ISSUER_DOMAIN ?? "", applicationID: "convex" }],
};`;

/** The result of one check by its id. */
function checkOf(report: ReturnType<typeof checkProduction>, id: string) {
  const found = report.checks.find((check) => check.id === id);
  if (found === undefined) throw new Error(`no check ${id}`);
  return found;
}

describe("the production checker", () => {
  it("[CPC-01] a complete production setup passes every check", () => {
    const report = checkProduction({ env: GOOD_ENV, authConfig: GOOD_AUTH });
    expect(report.checks.map((check) => check.id)).toEqual([
      "ENV-01",
      "ENV-02",
      "ENV-03",
      "URL-01",
      "URL-02",
      "KEY-01",
      "ISS-01",
      "AUTH-01",
      "SEC-01",
    ]);
    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("[CPC-02] a development key (pk_test_) fails KEY-01 in a production setup", () => {
    const testKey = `pk_test_${Buffer.from(`${HOST}$`).toString("base64")}`;
    const report = checkProduction({
      env: { ...GOOD_ENV, VITE_CLERK_PUBLISHABLE_KEY: testKey },
      authConfig: GOOD_AUTH,
    });
    expect(report.ok).toBe(false);
    expect(checkOf(report, "KEY-01").ok).toBe(false);
  });

  it("[CPC-03] an issuer that is not the frontend API host of the key fails ISS-01, and the detail does not echo either value", () => {
    const report = checkProduction({
      env: { ...GOOD_ENV, CLERK_JWT_ISSUER_DOMAIN: "https://other.example.org" },
      authConfig: GOOD_AUTH,
    });
    const issuer = checkOf(report, "ISS-01");
    expect(issuer.ok).toBe(false);
    expect(issuer.detail).not.toContain("other.example.org");
    expect(issuer.detail).not.toContain(HOST);
  });

  it("[CPC-04] a deployment URL that is not https, has a path or query, or has stray whitespace fails URL-01", () => {
    const bad = [
      "http://happy-otter-123.convex.cloud",
      "https://happy-otter-123.convex.site",
      "https://happy-otter-123.convex.cloud/api",
      "https://happy-otter-123.convex.cloud?x=1",
      "https://user:pass@happy-otter-123.convex.cloud",
      "https://happy-otter-123.example.com",
      "https://happy-otter-123.convex.cloud\n",
      '"https://happy-otter-123.convex.cloud"',
    ];
    for (const url of bad) {
      const report = checkProduction({
        env: { ...GOOD_ENV, VITE_CONVEX_URL: url },
        authConfig: GOOD_AUTH,
      });
      expect(checkOf(report, "URL-01").ok, `URL ${JSON.stringify(url)}`).toBe(false);
    }
  });

  it("[CPC-05] a development deployment, or a deployment name that is not the URL's name, fails URL-02", () => {
    const dev = checkProduction({
      env: { ...GOOD_ENV, CONVEX_DEPLOYMENT: "dev:happy-otter-123" },
      authConfig: GOOD_AUTH,
    });
    expect(checkOf(dev, "URL-02").ok).toBe(false);
    const other = checkProduction({
      env: { ...GOOD_ENV, CONVEX_DEPLOYMENT: "prod:calm-fox-9" },
      authConfig: GOOD_AUTH,
    });
    expect(checkOf(other, "URL-02").ok).toBe(false);
  });

  it("[CPC-06] a secret under a client-visible VITE_ name fails ENV-02", () => {
    const report = checkProduction({
      env: { ...GOOD_ENV, VITE_CLERK_SECRET_KEY: "sk_live_fixture" },
      authConfig: GOOD_AUTH,
    });
    expect(checkOf(report, "ENV-02").ok).toBe(false);
  });

  it("[CPC-07] an auth config that names another application, or another literal issuer, fails AUTH-01; a missing file fails too", () => {
    const otherApp = checkProduction({
      env: GOOD_ENV,
      authConfig: GOOD_AUTH.replace('"convex"', '"other-app"'),
    });
    expect(checkOf(otherApp, "AUTH-01").ok).toBe(false);

    const literal = checkProduction({
      env: GOOD_ENV,
      authConfig: `export default { providers: [{ domain: "https://elsewhere.example.org", applicationID: "convex" }] };`,
    });
    expect(checkOf(literal, "AUTH-01").ok).toBe(false);

    const missing = checkProduction({ env: GOOD_ENV, authConfig: undefined });
    expect(checkOf(missing, "AUTH-01").ok).toBe(false);
    expect(checkOf(missing, "AUTH-01").detail).toContain("auth.config");
  });

  it("[CPC-08] a secret key that is not live fails SEC-01, and its value is never in the report", () => {
    const report = checkProduction({
      env: { ...GOOD_ENV, CLERK_SECRET_KEY: "sk_test_fixture" },
      authConfig: GOOD_AUTH,
    });
    expect(checkOf(report, "SEC-01").ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain("sk_test_fixture");
  });

  it("[CPC-09] a failing report never prints any value of the environment", () => {
    const report = checkProduction({
      env: { ...GOOD_ENV, VITE_CONVEX_URL: "http://happy-otter-123.convex.cloud/secret-path" },
      authConfig: GOOD_AUTH.replace('"convex"', '"other"'),
    });
    const text = JSON.stringify(report);
    expect(text).not.toContain("secret-path");
    expect(text).not.toContain(LIVE_KEY);
    expect(text).not.toContain(GOOD_ENV["CLERK_SECRET_KEY"] ?? "");
  });

  it("[CPC-10] the key's frontend API host is decoded, and a host that is not a DNS name is refused", () => {
    expect(clerkHostFromKey(LIVE_KEY)).toBe(HOST);
    const ip = `pk_live_${Buffer.from("127.0.0.1$").toString("base64")}`;
    expect(clerkHostFromKey(ip)).toBeUndefined();
    const withPort = `pk_live_${Buffer.from("clerk.example.com:443$").toString("base64")}`;
    expect(clerkHostFromKey(withPort)).toBeUndefined();
    expect(clerkHostFromKey("not-a-key")).toBeUndefined();
  });

  it("[CPC-11] parseEnvFile reads KEY=value lines, comments, export and quotes, and skips the rest", () => {
    const parsed = parseEnvFile(
      [
        "# production",
        "export VITE_CONVEX_URL=https://happy-otter-123.convex.cloud",
        'CLERK_JWT_ISSUER_DOMAIN="https://clerk.example.com"',
        "not a pair",
        "",
      ].join("\n"),
    );
    expect(parsed["VITE_CONVEX_URL"]).toBe("https://happy-otter-123.convex.cloud");
    expect(parsed["CLERK_JWT_ISSUER_DOMAIN"]).toBe("https://clerk.example.com");
    expect(Object.keys(parsed)).toEqual(["VITE_CONVEX_URL", "CLERK_JWT_ISSUER_DOMAIN"]);
  });

  it("[CPC-12] the command exits 0 for a good setup, 1 for a failing one, and 2 for a usage error", () => {
    const lines: string[] = [];
    const io = (files: Record<string, string>) => ({
      env: {},
      readFile: (path: string): string | undefined => files[path],
      write: (line: string): void => {
        lines.push(line);
      },
    });
    const envFile = Object.entries(GOOD_ENV)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    expect(
      main(
        ["--env-file", "prod.env", "--auth-config", "auth.config.ts"],
        io({ "prod.env": envFile, "auth.config.ts": GOOD_AUTH }),
      ),
    ).toBe(0);
    expect(
      main(
        ["--env-file", "prod.env", "--auth-config", "auth.config.ts"],
        io({ "prod.env": envFile.replace("prod:", "dev:"), "auth.config.ts": GOOD_AUTH }),
      ),
    ).toBe(1);
    expect(main(["--env-file"], io({}))).toBe(2);
    expect(main(["--env-file", "missing.env"], io({}))).toBe(2);
    expect(lines.join("\n")).not.toContain(LIVE_KEY);
    expect(lines.join("\n")).not.toContain("sk_live_fixture");
  });

  it("[CPC-13] the checker never contacts a network: its source has no fetch, http, https, net, dns or tls", () => {
    const source = readFileSync(
      new URL("../scripts/check-production.mjs", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    expect(source).not.toMatch(/from\s+["'](node:)?(http|https|net|dns|tls)["']/u);
    expect(source).not.toMatch(/\bnode:(http|https|net|dns|tls)\b/u);
  });
});
