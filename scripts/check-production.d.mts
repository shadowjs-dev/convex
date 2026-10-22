/**
 * Types of `check-production.mjs`, the production checker for a Convex and Clerk app. The module reads
 * configuration only and never contacts a network host.
 * @packageDocumentation
 */

/** One production check: its id (`ENV-01` ...), what it verifies, whether it passed and why it failed. */
export interface ProductionCheck {
  /** The check id, for example `URL-01`. */
  readonly id: string;
  /** What the check verifies, in one line. */
  readonly name: string;
  /** True when the check passed. */
  readonly ok: boolean;
  /** `ok` when the check passed; otherwise the rule or the variable name that failed, never a value. */
  readonly detail: string;
}

/** The result of {@link checkProduction}. */
export interface ProductionReport {
  /** True when every check passed. */
  readonly ok: boolean;
  /** Every check, in the order it runs. */
  readonly checks: readonly ProductionCheck[];
}

/** The inputs of {@link checkProduction}. */
export interface ProductionInput {
  /** The variables to check, by name. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The text of `convex/auth.config.ts`, or `undefined` when the file was not found. */
  readonly authConfig: string | undefined;
}

/** The side effects the command uses, so a test can run it without a file system or a terminal. */
export interface CheckerIo {
  /** The variables of the process, used when no env file is given. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Reads a file as text, or returns `undefined` when it does not exist. */
  readonly readFile: (path: string) => string | undefined;
  /** Writes one line of output. */
  readonly write: (line: string) => void;
}

/**
 * Reads a dotenv file: `KEY=value` lines, optional `export`, `#` comments and matching quotes.
 * @param text The file's text.
 * @returns The variables in file order.
 */
export function parseEnvFile(text: string): Record<string, string>;

/**
 * The frontend API host a Clerk publishable key names.
 * @param key A `pk_test_` or `pk_live_` key.
 * @returns The lowercase host, or `undefined` for another shape or a host that is not a DNS name.
 */
export function clerkHostFromKey(key: string): string | undefined;

/**
 * Runs every production check over the given values. Pure: no file, no network and no printing.
 * @param input The variables and the auth config text.
 * @returns The report: `ok` and the checks in order.
 */
export function checkProduction(input: ProductionInput): ProductionReport;

/**
 * Runs the command over the given arguments and side effects.
 * @param argv The arguments after the script name: `--env-file <path>` and `--auth-config <path>`.
 * @param io The environment, the file reader and the writer.
 * @returns 0 when every check passes, 1 when one fails, 2 for a usage error.
 */
export function main(argv: readonly string[], io: CheckerIo): number;
