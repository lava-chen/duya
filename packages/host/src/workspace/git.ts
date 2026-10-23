/**
 * Minimal git runner for the workspace layer.
 *
 * Every call uses `execFile` with an argument array. A shell string would be a
 * quoting bug on every Windows path containing a space, and a path is exactly
 * what these commands pass around. It also keeps `git` from interpreting a
 * branch name, ref or path as an option.
 */

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** git invocations are local; 30s covers a large worktree checkout. */
const GIT_TIMEOUT_MS = 30_000;

/** Cap the stderr text echoed upward so a hook's noise cannot flood a receipt. */
const MAX_GIT_ERROR_CHARS = 400;

/** 8 MiB fits `worktree list` / `for-each-ref` output for any realistic repo. */
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    // The explicit encoding avoids mojibake in a path we then use as a cwd.
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout;
}

/** Same as `git`, but returns null instead of throwing. Use for "does it exist" probes. */
export async function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

function readStderr(err: unknown): string {
  if (typeof err !== 'object' || err === null || !('stderr' in err)) return '';
  const value = (err as { stderr?: unknown }).stderr;
  return typeof value === 'string' ? value : '';
}

/** First non-empty line of a git failure, trimmed to a receipt-safe length. */
export function describeGitFailure(err: unknown): string {
  const line = readStderr(err).split('\n').find((entry) => entry.trim().length > 0) ?? '';
  return line.trim().slice(0, MAX_GIT_ERROR_CHARS);
}

/** Human-readable message for an unknown thrown value, without `String(object)`. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Absolute path of a git path name. Pass the arguments after `rev-parse`,
 * e.g. `['--git-dir']` or `['--git-path', 'codex-thread.json']`.
 *
 * `--path-format=absolute` needs git 2.31+. Older builds are still common on
 * CI images, so fall back to resolving the relative answer against `root` —
 * `--git-path` is documented as relative to the current directory.
 */
export async function gitPathAbsolute(root: string, args: string[]): Promise<string | null> {
  const absolute = await gitOrNull(root, ['rev-parse', '--path-format=absolute', ...args]);
  const trimmedAbsolute = absolute?.trim();
  if (trimmedAbsolute) return trimmedAbsolute;

  const relative = await gitOrNull(root, ['rev-parse', ...args]);
  const trimmedRelative = relative?.trim();
  if (trimmedRelative) return path.resolve(root, trimmedRelative);
  return null;
}
