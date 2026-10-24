/**
 * packages/cli/src/tui/slash/__tests__/diff.test.ts
 *
 * `/diff` — the working tree patch, read from a REAL git repository.
 *
 * ## Why a real repository and not a mocked `execFileSync`
 *
 * The whole point of this command is that it asks git for the truth: which
 * files are untracked, what the patch against HEAD looks like, what git
 * says when it fails. A mock would encode this file's own beliefs about
 * git's output, so a wrong belief would pass. Every case here therefore
 * builds a repository in a temporary directory, commits it, edits it, and
 * lets the real `git` answer.
 *
 * ## What these cases pin
 *
 *  1. The patch names the tracked change AND the untracked file. A diff
 *     that only reads `git diff HEAD` silently drops every new file, which
 *     is the failure codex's `/diff` explicitly does not have.
 *
 *  2. A path argument narrows the patch instead of being ignored.
 *
 *  3. Refusals are refusals: no session, no working directory, and a
 *     directory that is not a repository each produce a message that says
 *     what is missing. None of them falls back to some other directory.
 *
 *  4. A truncated patch says that it was truncated. A patch that stops at
 *     the cap without saying so reads as the whole change.
 *
 *  5. A git failure is reported with git's own words, not as a stack
 *     trace.
 *
 * The handler is called directly rather than through the registry: the
 * registry entry is another writer's file, and a test that depended on it
 * would fail here for a reason that has nothing to do with this command.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostSessionHttpClient } from '@duya/host/http-client';

import { DIFF_COMMANDS } from '../diff.js';
import type { TuiSlashContext, TuiSlashHost } from '../types.js';

const SESSION_ID = 's-diff-1';

/** The line cap the command applies. Mirrors MAX_DIFF_LINES in diff.ts. */
const MAX_DIFF_LINES = 2000;

const COMMAND = DIFF_COMMANDS[0];
if (COMMAND === undefined) throw new Error('the diff command is not exported');

// ───────────────────────────── fixtures ─────────────────────────────

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory === undefined) continue;
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best-effort: on Windows the git child process can still hold a handle
      // for a moment after it exits.
    }
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'duya-cli-diff-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** Run git for the fixture's own setup, and fail loudly if it does not work. */
function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
  }
}

/** A repository with one committed file, so HEAD exists. */
function committedRepository(): string {
  const directory = temporaryDirectory();
  git(directory, ['init', '-q']);
  writeFileSync(join(directory, 'a.txt'), 'one\n');
  git(directory, ['add', 'a.txt']);
  git(directory, [
    '-c', 'user.email=test@example.com',
    '-c', 'user.name=Test',
    'commit', '-q', '-m', 'init',
  ]);
  return directory;
}

interface Harness {
  readonly notices: string[];
  readonly errors: string[];
  readonly output: string;
}

/**
 * Run `/diff` against a client whose local session projection answers with
 * `session` (or fails with `readError`).
 */
async function run(options: {
  readonly session?: unknown;
  readonly readError?: Error;
  readonly args?: string;
  readonly busy?: boolean;
}): Promise<Harness> {
  const notices: string[] = [];
  const errors: string[] = [];
  const client = {
    readLocalSession: vi.fn(async () => {
      if (options.readError !== undefined) throw options.readError;
      return options.session ?? null;
    }),
  } as unknown as HostSessionHttpClient;
  const tui: TuiSlashHost = {
    printNotice: (text) => { notices.push(text); },
    printError: (text) => { errors.push(text); },
    choose: async () => null,
  };
  const ctx = {
    client,
    session: { id: SESSION_ID },
    tui,
    busy: options.busy ?? false,
  } as unknown as TuiSlashContext;

  await COMMAND.run(ctx, options.args ?? '');

  return { notices, errors, output: notices.join('\n') };
}

/** A local session record carrying the working directory. */
function sessionIn(workingDirectory: string): unknown {
  return { id: SESSION_ID, workingDirectory };
}

// ───────────────────────────── cases ─────────────────────────────

describe('/diff', () => {
  it('shows the tracked change in the working tree', async () => {
    const directory = committedRepository();
    writeFileSync(join(directory, 'a.txt'), 'one\ntwo\n');

    const { output, errors } = await run({ session: sessionIn(directory) });

    expect(errors).toEqual([]);
    expect(output).toContain('diff --git a/a.txt b/a.txt');
    expect(output).toContain('+two');
  });

  it('shows a staged change as well as an unstaged one', async () => {
    const directory = committedRepository();
    writeFileSync(join(directory, 'a.txt'), 'one\nstaged\n');
    git(directory, ['add', 'a.txt']);
    writeFileSync(join(directory, 'a.txt'), 'one\nstaged\nunstaged\n');

    const { output, errors } = await run({ session: sessionIn(directory) });

    expect(errors).toEqual([]);
    // `git diff HEAD` is the working tree against HEAD: both changes show.
    expect(output).toContain('+staged');
    expect(output).toContain('+unstaged');
  });

  it('includes untracked files, which git diff HEAD alone would drop', async () => {
    const directory = committedRepository();
    writeFileSync(join(directory, 'b.txt'), 'brand new\n');

    const { output, errors } = await run({ session: sessionIn(directory) });

    expect(errors).toEqual([]);
    expect(output).toContain('Untracked file: b.txt');
    expect(output).toContain('+brand new');
  });

  it('narrows the patch to the path it was given', async () => {
    const directory = committedRepository();
    writeFileSync(join(directory, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(directory, 'b.txt'), 'other\n');

    const { output, errors } = await run({ session: sessionIn(directory), args: 'a.txt' });

    expect(errors).toEqual([]);
    expect(output).toContain('diff --git a/a.txt b/a.txt');
    // The other file is not in the patch, and the header says what was asked.
    expect(output).not.toContain('b.txt');
    expect(output).toContain('only "a.txt"');
  });

  it('narrows the patch to an untracked file too', async () => {
    const directory = committedRepository();
    writeFileSync(join(directory, 'b.txt'), 'brand new\n');

    const { output, errors } = await run({ session: sessionIn(directory), args: 'b.txt' });

    expect(errors).toEqual([]);
    expect(output).toContain('Untracked file: b.txt');
    expect(output).toContain('+brand new');
  });

  it('diffs against the empty tree in a repository that has no commits', async () => {
    const directory = temporaryDirectory();
    git(directory, ['init', '-q']);
    writeFileSync(join(directory, 'first.txt'), 'the first file\n');
    git(directory, ['add', 'first.txt']);

    const { output, errors } = await run({ session: sessionIn(directory) });

    expect(errors).toEqual([]);
    // There is no HEAD to diff against, so everything reads as new.
    expect(output).toContain('new file mode');
    expect(output).toContain('+the first file');
  });

  it('works while a turn is streaming, because a diff is a read', async () => {
    const directory = committedRepository();
    writeFileSync(join(directory, 'a.txt'), 'one\ntwo\n');

    const { output, errors } = await run({ session: sessionIn(directory), busy: true });

    expect(errors).toEqual([]);
    expect(output).toContain('+two');
  });

  it('refuses when the session is not on this Host', async () => {
    const { output, errors } = await run({ session: null });

    expect(output).toEqual('');
    expect(errors.join('\n')).toContain(`Session ${SESSION_ID} is not on this Host`);
  });

  it('refuses when the session has no working directory', async () => {
    const { output, errors } = await run({ session: sessionIn('') });

    expect(output).toEqual('');
    expect(errors.join('\n')).toContain('no working directory');
  });

  it('says the Host cannot answer when it does not expose the working directory', async () => {
    const error = Object.assign(new Error('Duya Host request failed (404: local_session_projection_unavailable)'), {
      status: 404,
      code: 'local_session_projection_unavailable',
    });
    const { output, errors } = await run({ readError: error });

    expect(output).toEqual('');
    expect(errors.join('\n')).toContain('does not expose the session');
  });

  it('reports a directory that is not a git repository', async () => {
    const directory = temporaryDirectory();

    const { output, errors } = await run({ session: sessionIn(directory) });

    expect(output).toEqual('');
    expect(errors.join('\n')).toContain('Not a git repository');
  });

  it('reports a git failure with git\'s own words', async () => {
    const directory = committedRepository();
    // A corrupt index: git can still find the repository, but every command
    // that reads the index fails.
    writeFileSync(join(directory, '.git', 'index'), 'not an index');

    const { output, errors } = await run({ session: sessionIn(directory) });

    expect(output).toEqual('');
    expect(errors.join('\n')).toContain('git status');
    expect(errors.join('\n')).toContain('exit 128');
    // git's own complaint travels with it — no stack trace, no paraphrase.
    expect(errors.join('\n')).toContain('index');
  });

  it('says when git is not installed rather than failing silently', async () => {
    const directory = committedRepository();
    const originalPath = process.env['PATH'];
    try {
      process.env['PATH'] = '';
      const { output, errors } = await run({ session: sessionIn(directory) });

      expect(output).toEqual('');
      expect(errors.join('\n')).toContain('git is not installed or not on PATH');
    } finally {
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
    }
  });

  it('truncates a very large patch and says that it did', async () => {
    const directory = temporaryDirectory();
    git(directory, ['init', '-q']);
    const lines = Array.from({ length: 2500 }, (_, index) => `line ${index}`);
    writeFileSync(join(directory, 'big.txt'), `${lines.join('\n')}\n`);
    git(directory, ['add', 'big.txt']);
    git(directory, [
      '-c', 'user.email=test@example.com',
      '-c', 'user.name=Test',
      'commit', '-q', '-m', 'init',
    ]);
    writeFileSync(join(directory, 'big.txt'), `${lines.map((line) => `${line} changed`).join('\n')}\n`);

    const { notices, errors } = await run({ session: sessionIn(directory) });

    expect(errors).toEqual([]);
    // One header, the capped patch, and the truncation notice.
    expect(notices.length).toBe(MAX_DIFF_LINES + 2);
    expect(notices[notices.length - 1]).toContain('truncated');
    expect(notices[notices.length - 1]).toContain('Narrow it with /diff');
  });

  it('says there is nothing to show when the working tree is clean', async () => {
    const directory = committedRepository();

    const { output, errors } = await run({ session: sessionIn(directory) });

    expect(errors).toEqual([]);
    expect(output).toContain('No changes in the working tree');
  });
});
