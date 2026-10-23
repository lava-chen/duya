/**
 * gh-cli.ts — the only process boundary between Duya and the GitHub CLI.
 *
 * Plan 621 slice C is a *read-only* SCM observer. Everything that shells out to
 * `gh` goes through this module so three invariants live in exactly one place:
 *
 *   1. The executable is invoked with an ARGS ARRAY, never a shell string. A
 *      shell string is a quoting bug on every path containing a space (the
 *      Windows install dir is `C:\Program Files\GitHub CLI\gh.exe`) and would
 *      also let a branch name be reinterpreted as a flag.
 *   2. Every failed invocation becomes a typed `GhError` carrying a
 *      machine-readable `code` plus ONE sentence a user can act on — never a
 *      raw ENOENT or a stack trace. "gh is not installed" and "that PR does
 *      not exist" must not look the same to the caller.
 *   3. Tests inject their own `execFile`. Nothing here relies on `vi.mock`
 *      patching `node:child_process`, which is unreliable in this repo (see
 *      docs/development/testing.md).
 *
 * READ-ONLY BY CONTRACT: this directory must never grow a write command.
 * `packages/host/tests/scm/read-only-guard.test.ts` greps the source for
 * write-capable gh subcommands and any request-method override, and fails the
 * build when one appears.
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { statSync } from 'node:fs';
import * as path from 'node:path';

/** A hung `gh` must not hold a Host read open forever. */
export const GH_TIMEOUT_MS = 20_000;

/** `statusCheckRollup` on a busy PR is large; 8 MB matches the git helper. */
export const GH_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** Cap the diagnostic text we echo to a user; a stack of raw JSON helps nobody. */
const MAX_DETAIL_CHARS = 240;

export type GhErrorCode =
  | 'gh_not_found'
  | 'not_authenticated'
  | 'timeout'
  | 'not_found'
  | 'rate_limited'
  | 'invalid_json'
  | 'unknown';

/**
 * One `gh` failure, already translated. `message` is the user-facing sentence
 * (same shape as `WorktreeError`); `code` is what callers branch on.
 */
export class GhError extends Error {
  constructor(
    readonly code: GhErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GhError';
  }
}

const GH_NOT_FOUND_MESSAGE =
  'GitHub CLI (gh) was not found. Install it from https://cli.github.com and retry, or set DUYA_GH_PATH to the gh executable.';

const NOT_AUTHENTICATED_MESSAGE =
  'GitHub CLI is not signed in. Run "gh auth login" once, then retry.';

const NOT_FOUND_MESSAGE =
  'GitHub could not resolve that pull request. Check the repository name and the PR number.';

const RATE_LIMITED_MESSAGE =
  'GitHub API rate limit reached. Wait until the limit resets, then retry.';

const INVALID_JSON_MESSAGE =
  'GitHub CLI returned a response Duya could not read. Update gh to the latest version, then retry.';

export interface GhExecOptions {
  cwd?: string;
  timeout: number;
  windowsHide: boolean;
  encoding: 'utf8';
  maxBuffer: number;
}

export interface GhExecResult {
  stdout: string;
  stderr: string;
}

/**
 * The injected process primitive. Deliberately narrow: no shell, no stdio
 * plumbing, no writable input stream.
 */
export type GhExecFile = (
  file: string,
  args: string[],
  options: GhExecOptions,
) => Promise<GhExecResult>;

const defaultExecFile: GhExecFile = (file, args, options) =>
  new Promise((resolve, reject) => {
    nodeExecFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

function defaultIsFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export interface GhPathLookup {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Injectable so tests never need a real gh binary on disk. */
  isFile?: (candidate: string) => boolean;
}

/**
 * Directories the Windows installer and the common POSIX package managers use.
 * Only consulted when the PATH scan misses; PATH always wins.
 */
const WINDOWS_FALLBACK_SUBDIRS: readonly (readonly string[])[] = [
  ['GitHub CLI'],
  ['GitHubCLI'],
  ['Programs', 'GitHub CLI'],
  ['Programs', 'GitHubCLI'],
];

const POSIX_FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'] as const;

/**
 * Resolve the gh executable in a fixed order:
 *   `DUYA_GH_PATH` → PATH → well-known install directories → `gh_not_found`.
 *
 * The override is authoritative: if it is set but unusable we fail with a
 * message that names it, instead of silently falling back to a different gh.
 */
export function resolveGhPath(lookup: GhPathLookup = {}): string {
  const env = lookup.env ?? process.env;
  const platform = lookup.platform ?? process.platform;
  const isFile = lookup.isFile ?? defaultIsFile;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const delimiter = platform === 'win32' ? ';' : ':';
  const suffixes = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

  const override = env.DUYA_GH_PATH?.trim();
  if (override) {
    if (isFile(override)) return override;
    throw new GhError(
      'gh_not_found',
      `DUYA_GH_PATH points at "${override}", but no executable exists there. Fix the variable, or unset it so Duya can locate gh itself.`,
    );
  }

  const pathValue = env.PATH ?? env.Path ?? '';
  for (const dir of pathValue.split(delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const suffix of suffixes) {
      const candidate = join(trimmed, `gh${suffix}`);
      if (isFile(candidate)) return candidate;
    }
  }

  if (platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]) {
      if (!base) continue;
      for (const subdirs of WINDOWS_FALLBACK_SUBDIRS) {
        const candidate = join(base, ...subdirs, 'gh.exe');
        if (isFile(candidate)) return candidate;
      }
    }
  } else {
    for (const dir of POSIX_FALLBACK_DIRS) {
      const candidate = join(dir, 'gh');
      if (isFile(candidate)) return candidate;
    }
  }

  throw new GhError('gh_not_found', GH_NOT_FOUND_MESSAGE);
}

export interface GhRunOptions {
  cwd?: string;
}

export interface GhRunner {
  /** Resolve (and cache) the executable path. Throws GhError(`gh_not_found`). */
  resolvePath(): string;
  /** Run a read-only gh command and return stdout. */
  run(args: string[], options?: GhRunOptions): Promise<string>;
  /** Run gh, parse stdout as JSON, then narrow it with `parse`. */
  runJson<T>(
    args: string[],
    parse: (value: unknown) => T,
    options?: GhRunOptions,
  ): Promise<T>;
}

export interface GhRunnerDeps {
  /** Defaults to the real `execFile`. Tests inject a stub. */
  execFile?: GhExecFile;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isFile?: (candidate: string) => boolean;
  /** Overrides `resolveGhPath` wholesale, for tests that do not care about lookup. */
  resolvePath?: () => string;
  timeoutMs?: number;
}

export function createGhRunner(deps: GhRunnerDeps = {}): GhRunner {
  const exec = deps.execFile ?? defaultExecFile;
  const timeoutMs = deps.timeoutMs ?? GH_TIMEOUT_MS;
  let resolved: string | null = null;

  const resolvePath = (): string => {
    if (resolved !== null) return resolved;
    resolved = deps.resolvePath
      ? deps.resolvePath()
      : resolveGhPath({
          ...(deps.env ? { env: deps.env } : {}),
          ...(deps.platform ? { platform: deps.platform } : {}),
          ...(deps.isFile ? { isFile: deps.isFile } : {}),
        });
    return resolved;
  };

  const run = async (args: string[], options: GhRunOptions = {}): Promise<string> => {
    const ghPath = resolvePath();
    const execOptions: GhExecOptions = {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: GH_MAX_BUFFER_BYTES,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    };
    try {
      const { stdout } = await exec(ghPath, args, execOptions);
      return stdout;
    } catch (error) {
      throw classifyGhFailure(error, timeoutMs);
    }
  };

  const runJson = async <T>(
    args: string[],
    parse: (value: unknown) => T,
    options?: GhRunOptions,
  ): Promise<T> => {
    const stdout = await run(args, options);
    const value = parseGhJson(stdout);
    try {
      return parse(value);
    } catch (error) {
      if (error instanceof GhError) throw error;
      // A parser that throws anything else still means "the shape was wrong".
      throw new GhError('invalid_json', INVALID_JSON_MESSAGE);
    }
  };

  return { resolvePath, run, runJson };
}

/**
 * `JSON.parse` with a typed failure. `unknown` out, never `any`: every caller
 * must narrow the shape it expects (see `parsePrView` / `parsePrList`).
 */
export function parseGhJson(stdout: string): unknown {
  try {
    const value: unknown = JSON.parse(stdout);
    return value;
  } catch {
    throw new GhError('invalid_json', INVALID_JSON_MESSAGE);
  }
}

/**
 * Read one field from an unknown JSON value without an `any` cast. Returns
 * `undefined` for anything that is not an object, so callers can validate.
 */
export function readJsonField(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  const value: unknown = Reflect.get(source, key);
  return value;
}

interface SpawnFailureFields {
  code: unknown;
  killed: unknown;
  signal: unknown;
  stderr: unknown;
  message: unknown;
}

function readSpawnFailure(error: unknown): SpawnFailureFields {
  return {
    code: readJsonField(error, 'code'),
    killed: readJsonField(error, 'killed'),
    signal: readJsonField(error, 'signal'),
    stderr: readJsonField(error, 'stderr'),
    message: readJsonField(error, 'message'),
  };
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** First non-empty line of the diagnostic text, trimmed to a usable length. */
function firstDetailLine(raw: string): string {
  const line = raw
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return (line ?? '').slice(0, MAX_DETAIL_CHARS);
}

/**
 * Translate a child_process rejection into a GhError.
 *
 * Detection order matters. A timeout can surface with empty stderr, so it is
 * checked before the text heuristics; a rate-limit response is a 403 whose body
 * also says "rate limit", so rate limiting is checked before generic auth.
 */
function classifyGhFailure(error: unknown, timeoutMs: number): GhError {
  if (error instanceof GhError) return error;

  const failure = readSpawnFailure(error);
  const stderr = asText(failure.stderr);
  const message = asText(failure.message);
  const haystack = `${stderr}\n${message}`.toLowerCase();
  const detail = firstDetailLine(stderr) || firstDetailLine(message);

  // The binary disappeared between resolution and spawn. Same user action as
  // "never installed", so it is the same code — never a bare ENOENT.
  if (failure.code === 'ENOENT') return new GhError('gh_not_found', GH_NOT_FOUND_MESSAGE);

  if (failure.code === 'ETIMEDOUT' || failure.killed === true || failure.signal === 'SIGTERM') {
    return new GhError(
      'timeout',
      `GitHub CLI did not answer within ${Math.round(timeoutMs / 1000)} seconds. Check the network connection, then retry.`,
    );
  }

  if (/rate limit|secondary rate|abuse detection/.test(haystack)) {
    return new GhError('rate_limited', RATE_LIMITED_MESSAGE);
  }

  // Exit code 4 is gh's documented "authentication required" (gh help exit-codes).
  if (
    failure.code === 4 ||
    /gh auth login|not logged into any github hosts|requires authentication|bad credentials|http 401/.test(
      haystack,
    )
  ) {
    return new GhError('not_authenticated', NOT_AUTHENTICATED_MESSAGE);
  }

  if (
    /could not resolve to a pullrequest|no pull requests found|no open pull requests|http 404|not found/.test(
      haystack,
    )
  ) {
    return new GhError('not_found', NOT_FOUND_MESSAGE);
  }

  return new GhError(
    'unknown',
    `GitHub CLI failed: ${detail || 'no diagnostic output'}`,
  );
}
