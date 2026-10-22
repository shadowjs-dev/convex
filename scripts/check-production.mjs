#!/usr/bin/env node
// Production checks for a Convex + Clerk app, run before a deploy. They read configuration only and never
// contact a network host: no Convex deployment, no Clerk frontend API and no Clerk backend is reached, so
// the check is safe to run in CI on a machine with production values and no internet access to them.
//
//   node scripts/check-production.mjs [--env-file <path>] [--auth-config <path>]
//
// Without --env-file the values come from the process environment. With it, the file is read as dotenv
// (KEY=value lines; `export`, comments and matching quotes are accepted). --auth-config names the file
// that holds `convex/auth.config.ts` (default `convex/auth.config.ts` in the working directory).
//
// Each check prints PASS or FAIL with its id. A failure names the variable or the rule, never the value:
// the values are secrets or the production addresses of the app, and a log must not hold them.
// Exit codes: 0 every check passes, 1 at least one check fails, 2 a usage error (bad arguments, a missing
// env file).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Variables the app must set in production. */
const REQUIRED = ["VITE_CONVEX_URL", "VITE_CLERK_PUBLISHABLE_KEY", "CLERK_JWT_ISSUER_DOMAIN"];
/** Variables the checks read; a value with stray whitespace or quotes is a configuration error. */
const CHECKED = [...REQUIRED, "CONVEX_DEPLOYMENT", "CLERK_SECRET_KEY"];
/** The Convex application id the auth config must name: the Clerk JWT template is called `convex`. */
const APPLICATION_ID = "convex";
/** Names of a browser-visible variable that look like a secret. */
const CLIENT_SECRET_NAME = /^(VITE_|PUBLIC_|NEXT_PUBLIC_)\w*(SECRET|PRIVATE|_SK_)/u;
const LIVE_PUBLISHABLE_KEY = /^pk_live_[A-Za-z0-9+/=_-]+$/u;
const PUBLISHABLE_KEY = /^pk_(?:test|live)_([A-Za-z0-9+/=_-]+)$/u;
/** A DNS name with at least two labels, the last one starting with a letter (Clerk's rule for a host). */
const DNS_HOST =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/iu;
const CONVEX_CLOUD_HOST = /^([a-z0-9-]+)\.convex\.cloud$/u;

/** Usage text, printed for --help and for a usage error. */
const USAGE = [
  "Usage: node scripts/check-production.mjs [--env-file <path>] [--auth-config <path>]",
  "Checks a production configuration without contacting any host.",
].join("\n");

/**
 * Reads a dotenv file: `KEY=value` lines, an optional `export`, `#` comments, and matching single or double
 * quotes around a value. Lines that are not pairs are skipped.
 * @param text The file's text.
 * @returns The variables in file order. Values are not printed anywhere by this module.
 */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (match === null) continue;
    out[match[1]] = unquote(match[2] ?? "");
  }
  return out;
}

/** Removes one pair of matching quotes around a value. */
function unquote(value) {
  const first = value.charAt(0);
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * The frontend API host a Clerk publishable key names: the base64 after `pk_test_` or `pk_live_` decodes to
 * `<host>$`. Returns `undefined` when the key has another shape or the host is not a DNS name (an IP address,
 * a port, a path or userinfo).
 * @param key The publishable key.
 * @returns The lowercase host, for example `clerk.example.com`, or `undefined`.
 */
export function clerkHostFromKey(key) {
  const match = PUBLISHABLE_KEY.exec(key);
  if (match === null) return undefined;
  const decoded = Buffer.from(match[1] ?? "", "base64").toString("utf8");
  if (!decoded.endsWith("$")) return undefined;
  const host = decoded.slice(0, -1);
  return DNS_HOST.test(host) ? host.toLowerCase() : undefined;
}

/** Parses a URL, or returns `undefined` for a value that is not one. */
function parseUrl(text) {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

/** The value of a variable when it is set and not blank, otherwise `undefined`. */
function readValue(env, name) {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Runs every production check over the given values. Pure: no file, no network, no printing.
 * @param input `env`: the variables (name to value); `authConfig`: the text of `convex/auth.config.ts`, or
 *   `undefined` when the file was not found.
 * @returns `ok` (every check passes) and the checks in order, each with `id`, `name`, `ok` and `detail`.
 */
export function checkProduction(input) {
  const env = input.env;
  const checks = [];
  const add = (id, name, ok, detail) => {
    checks.push({ id, name, ok, detail: ok ? "ok" : detail });
  };

  // ENV-01: the required variables are set.
  const missing = REQUIRED.filter((name) => readValue(env, name) === undefined);
  add(
    "ENV-01",
    "required variables are set",
    missing.length === 0,
    `not set: ${missing.join(", ")}`,
  );

  // ENV-02: no browser-visible variable carries a secret.
  const exposed = Object.keys(env).filter(
    (name) => readValue(env, name) !== undefined && CLIENT_SECRET_NAME.test(name),
  );
  add(
    "ENV-02",
    "no browser-visible variable is named like a secret",
    exposed.length === 0,
    `browser-visible and secret-named: ${exposed.join(", ")}`,
  );

  // ENV-03: the checked values have no stray whitespace and no quotes (a common copy-paste error).
  const dirty = CHECKED.filter((name) => {
    const value = readValue(env, name);
    return value !== undefined && (value !== value.trim() || /^["']|["']$/u.test(value));
  });
  add(
    "ENV-03",
    "values have no surrounding whitespace or quotes",
    dirty.length === 0,
    `stray whitespace or quotes in: ${dirty.join(", ")}`,
  );

  // URL-01: the Convex deployment URL is https://<name>.convex.cloud, and nothing else.
  const rawUrl = readValue(env, "VITE_CONVEX_URL");
  const url = rawUrl === undefined ? undefined : parseUrl(rawUrl);
  const deploymentName = url === undefined ? undefined : deploymentNameOf(url, rawUrl ?? "");
  add(
    "URL-01",
    "VITE_CONVEX_URL is https://<name>.convex.cloud with no path, query, port or credentials",
    deploymentName !== undefined,
    "VITE_CONVEX_URL is not a production Convex cloud URL (https, *.convex.cloud, no path, query, fragment, port or credentials)",
  );

  // URL-02: CONVEX_DEPLOYMENT, when set, is a prod: deployment with the same name as the URL.
  // When CONVEX_DEPLOYMENT is not set the name comparison is skipped; the URL-01 shape check still applies.
  const deployment = readValue(env, "CONVEX_DEPLOYMENT");
  let deploymentOk = true;
  let deploymentDetail = "ok";
  if (deployment !== undefined) {
    const match = /^prod:([a-z0-9-]+)$/u.exec(deployment);
    if (match === null) {
      deploymentOk = false;
      deploymentDetail = "CONVEX_DEPLOYMENT must be a prod: deployment (dev: is for development)";
    } else if (deploymentName === undefined) {
      deploymentOk = false;
      deploymentDetail = "cannot compare with VITE_CONVEX_URL, which is not valid";
    } else if (match[1] !== deploymentName) {
      deploymentOk = false;
      deploymentDetail = "CONVEX_DEPLOYMENT names a different deployment than VITE_CONVEX_URL";
    }
  }
  add(
    "URL-02",
    "CONVEX_DEPLOYMENT, when set, is the production deployment of VITE_CONVEX_URL",
    deploymentOk,
    deploymentDetail,
  );

  // KEY-01: the Clerk key is a live key with a valid frontend API host.
  const key = readValue(env, "VITE_CLERK_PUBLISHABLE_KEY");
  const host = key === undefined ? undefined : clerkHostFromKey(key);
  const keyOk = key !== undefined && LIVE_PUBLISHABLE_KEY.test(key) && host !== undefined;
  add(
    "KEY-01",
    "VITE_CLERK_PUBLISHABLE_KEY is a live (pk_live_) key with a valid frontend API host",
    keyOk,
    key?.startsWith("pk_test_") === true
      ? "production needs a live key (pk_live_), not a development key (pk_test_)"
      : "VITE_CLERK_PUBLISHABLE_KEY is not a valid live publishable key",
  );

  // ISS-01: the issuer Convex trusts is exactly the frontend API of the key.
  const issuer = readValue(env, "CLERK_JWT_ISSUER_DOMAIN");
  const expectedIssuer = host === undefined ? undefined : `https://${host}`;
  add(
    "ISS-01",
    "CLERK_JWT_ISSUER_DOMAIN is https:// plus the frontend API host of the publishable key",
    issuer !== undefined && expectedIssuer !== undefined && issuer === expectedIssuer,
    "CLERK_JWT_ISSUER_DOMAIN does not equal https:// plus the frontend API host of VITE_CLERK_PUBLISHABLE_KEY (no trailing slash, no path)",
  );

  // AUTH-01: convex/auth.config.ts trusts the `convex` application, with the same issuer.
  add(...authCheck(input.authConfig, issuer));

  // SEC-01: a live secret key, when one is set. The checker does not need it; the value is never printed.
  const secret = readValue(env, "CLERK_SECRET_KEY");
  add(
    "SEC-01",
    "CLERK_SECRET_KEY, when set, is a live (sk_live_) key",
    secret === undefined || secret.startsWith("sk_live_"),
    "CLERK_SECRET_KEY must be a live key (sk_live_) in production",
  );

  return { ok: checks.every((check) => check.ok), checks };
}

/** The `<name>` of an https://<name>.convex.cloud URL with no path, query, fragment, port or credentials. */
function deploymentNameOf(url, raw) {
  if (url.protocol !== "https:") return undefined;
  if (url.port !== "" || url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "") return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  if (raw !== raw.trim() || raw.includes("\\")) return undefined;
  const match = CONVEX_CLOUD_HOST.exec(url.hostname);
  return match === null ? undefined : match[1];
}

/** AUTH-01 as a check tuple: the application id, and a literal issuer when the config has one. */
function authCheck(authConfig, issuer) {
  const name = "convex/auth.config.ts names the convex application and the Clerk issuer";
  if (authConfig === undefined) {
    return [
      "AUTH-01",
      name,
      false,
      "convex/auth.config.ts was not found (pass --auth-config <path>)",
    ];
  }
  const app = /applicationID:\s*["']([^"']*)["']/u.exec(authConfig);
  if (app === null || app[1] !== APPLICATION_ID) {
    return ["AUTH-01", name, false, `applicationID must be "${APPLICATION_ID}"`];
  }
  const literal = /domain:\s*["']([^"']*)["']/u.exec(authConfig);
  if (literal !== null) {
    const ok = issuer !== undefined && literal[1] === issuer;
    return [
      "AUTH-01",
      name,
      ok,
      "the literal domain of auth.config.ts differs from CLERK_JWT_ISSUER_DOMAIN",
    ];
  }
  const reads = /domain:\s*process\.env\.CLERK_JWT_ISSUER_DOMAIN\b/u.test(authConfig);
  return [
    "AUTH-01",
    name,
    reads,
    "auth.config.ts must read domain from process.env.CLERK_JWT_ISSUER_DOMAIN or hold the issuer",
  ];
}

/**
 * Parses the command line into the env file and auth config paths.
 * @returns `undefined` for a usage error, otherwise the options.
 */
function parseArguments(argv) {
  let envFile;
  let authConfig = "convex/auth.config.ts";
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--env-file" || flag === "--auth-config") {
      if (value === undefined || value.startsWith("--")) return undefined;
      if (flag === "--env-file") envFile = value;
      else authConfig = value;
      index += 1;
    } else {
      return undefined;
    }
  }
  return { envFile, authConfig };
}

/**
 * Runs the command: reads the inputs through `io`, prints one line per check, and returns the exit code.
 * @param argv The arguments after the script name.
 * @param io `env` (variables), `readFile(path)` (the text, or `undefined` when the file is missing) and
 *   `write(line)`.
 * @returns 0 when every check passes, 1 when one fails, 2 for a usage error.
 */
export function main(argv, io) {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.write(USAGE);
    return 0;
  }
  const options = parseArguments(argv);
  if (options === undefined) {
    io.write(USAGE);
    return 2;
  }
  let env = io.env;
  if (options.envFile !== undefined) {
    const text = io.readFile(options.envFile);
    if (text === undefined) {
      io.write("The env file could not be read.");
      return 2;
    }
    env = parseEnvFile(text);
  }
  const report = checkProduction({ env, authConfig: io.readFile(options.authConfig) });
  for (const check of report.checks) {
    io.write(
      `${check.ok ? "PASS" : "FAIL"} ${check.id} ${check.name}${check.ok ? "" : `: ${check.detail}`}`,
    );
  }
  io.write(report.ok ? "Production checks: all pass." : "Production checks: see the FAIL lines.");
  return report.ok ? 0 : 1;
}

/** Reads a file, or returns `undefined` when it does not exist. Other errors are thrown. */
function readOptional(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), {
    env: process.env,
    readFile: readOptional,
    write: (line) => {
      console.log(line);
    },
  });
}
