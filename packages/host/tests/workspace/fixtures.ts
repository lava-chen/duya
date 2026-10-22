/**
 * Shared fixtures for the workspace suites.
 *
 * Every test builds its own throwaway repository under the OS temp directory
 * and points `DUYA_APP_DATA_PATH` at another throwaway directory, so nothing
 * here reads or writes the developer's real `~/.duya`.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Canonical temp directory. `git rev-parse` reports fully resolved paths, and
 * on Windows the temp root is often reached through an 8.3 short name, so the
 * fixture must be canonical before it is compared with git's answer.
 */
export function tempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export interface RepoOptions {
  /** Content of a committed `.gitignore`, when the case needs ignored files. */
  gitignore?: string;
  /** Extra committed subdirectory, for the "sourceCwd is a subdirectory" case. */
  subdirectory?: string;
}

export function makeRepo(options: RepoOptions = {}): string {
  const dir = tempDir('duya-checkout-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@duya.local');
  git(dir, 'config', 'user.name', 'duya test');
  writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  if (options.gitignore !== undefined) {
    writeFileSync(path.join(dir, '.gitignore'), options.gitignore);
  }
  if (options.subdirectory !== undefined) {
    const nested = path.join(dir, options.subdirectory);
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, 'README.md'), '# nested\n');
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

/** Point checkout storage at a throwaway root; returns a restore callback. */
export function useIsolatedDataRoot(): () => void {
  const previous = process.env.DUYA_APP_DATA_PATH;
  const root = tempDir('duya-checkout-data-');
  process.env.DUYA_APP_DATA_PATH = root;
  return () => {
    if (previous === undefined) delete process.env.DUYA_APP_DATA_PATH;
    else process.env.DUYA_APP_DATA_PATH = previous;
  };
}

/** Keep git's upward repository discovery from escaping a non-repository fixture. */
export function withCeiling<T>(directory: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(directory);
  return run().finally(() => {
    if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previous;
  });
}
