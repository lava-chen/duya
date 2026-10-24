/**
 * packages/cli/src/tui/slash/diff.ts
 *
 * `/diff` — the session's working tree, as a patch, in the terminal.
 *
 * ## Where the patch comes from
 *
 * The Host exposes no file-level diff API, so this command runs `git` inside
 * the CLI process. That is the same move the clipboard helper in
 * `session-ops.ts` makes: the TUI is a Node process and can shell out. The
 * Desktop's `/diff` opens the code-review panel; this is the CLI's own
 * answer to the same question, and it answers it with text.
 *
 * ## The session's working directory, not the CLI's
 *
 * The patch has to describe the tree the SESSION works in. `ctx.session`
 * carries an opaque workspace reference on purpose — the public session
 * record never exposes a filesystem path — so the path is read from the
 * local session projection (`GET /v1/local/sessions/{id}`), the one route
 * that still carries it. `process.cwd()` is NOT a fallback here: it is
 * wherever the user happened to start the CLI, which is a different fact
 * from where the session works. When that projection cannot answer, this
 * command says so instead of diffing some other tree.
 *
 * ## Working tree, not one side of it
 *
 * `git diff HEAD` covers the staged and the unstaged changes to tracked
 * files, but it says nothing about files git does not track yet. Those are
 * listed separately (`git status --porcelain`) and each is diffed against
 * the null device, so a new file reads as a new file instead of vanishing
 * from the answer.
 *
 * ## Truncation is stated, never silent
 *
 * A patch can be larger than a terminal. The output stops at
 * {@link MAX_DIFF_LINES} lines and says how many lines there were, so a
 * truncated patch is never mistaken for the whole one.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { HostSessionHttpClient } from '@duya/host/http-client';
import type { TuiSlashCommandDef, TuiSlashContext } from './types.js';
import { describeError, hostErrorCode } from './shared.js';

/** Lines of patch this command prints before it truncates. */
const MAX_DIFF_LINES = 2000;

/** How long a single git invocation may take. */
const GIT_TIMEOUT_MS = 10_000;

/** How much git output a single invocation may produce. */
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * git's empty tree. A repository with no commits has no HEAD to diff
 * against, and this object is the only base that means "everything here is
 * new".
 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** What one git invocation produced. */
interface GitInvocation {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: NodeJS.ErrnoException | undefined;
}

/**
 * Run git in a directory.
 *
 * `spawnSync` rather than `execFileSync`: this command has to tell three
 * apart — git that is not installed, git that failed, and git that succeeded
 * with a non-zero status (`diff --no-index` reports "there are differences"
 * as exit 1, which is not a failure).
 */
function runGit(cwd: string, args: readonly string[]): GitInvocation {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    error: result.error === undefined ? undefined : result.error as NodeJS.ErrnoException,
  };
}

/** git's own first complaint, without the blank lines around it. */
function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return '';
}

/** Why a git invocation did not succeed, in one sentence. */
function gitFailure(args: readonly string[], invocation: GitInvocation): string {
  const command = `git ${args.join(' ')}`;
  const error = invocation.error;
  if (error !== undefined) {
    if (error.code === 'ENOENT') {
      return 'git is not installed or not on PATH, so the diff cannot be read. Install git and try again.';
    }
    if (error.code === 'ENOBUFS') {
      return `${command} produced more than ${MAX_GIT_OUTPUT_BYTES} bytes of output, which is more than this command reads.`;
    }
    if (error.code === 'ETIMEDOUT') {
      return `${command} did not finish within ${GIT_TIMEOUT_MS} ms.`;
    }
    return `${command} could not run: ${error.message}`;
  }
  const detail = firstLine(invocation.stderr);
  return `${command} failed (exit ${invocation.status ?? 'unknown'})${detail === '' ? '' : `: ${detail}`}`;
}

/**
 * The session's working directory, as the Host recorded it.
 *
 * `ctx.session` is the public session record and carries no path, so the
 * local session projection is the only place the path still exists. A Host
 * without that projection cannot answer, and that is a different answer
 * from "this session has no working directory".
 */
async function sessionWorkingDirectory(
  ctx: TuiSlashContext,
): Promise<
  { readonly ok: true; readonly workingDirectory: string }
  | { readonly ok: false; readonly message: string }
> {
  let session: Awaited<ReturnType<HostSessionHttpClient['readLocalSession']>>;
  try {
    session = await ctx.client.readLocalSession(ctx.session.id, { includeAllSessions: true });
  } catch (error) {
    if (hostErrorCode(error) === 'local_session_projection_unavailable') {
      return {
        ok: false,
        message: 'This Host does not expose the session\'s working directory, so /diff cannot tell which tree to read.',
      };
    }
    return {
      ok: false,
      message: `Could not read the session's working directory: ${describeError(error)}`,
    };
  }
  if (session === null) {
    return {
      ok: false,
      message: `Session ${ctx.session.id} is not on this Host, so there is no working tree to diff.`,
    };
  }
  const workingDirectory = typeof session.workingDirectory === 'string' ? session.workingDirectory : '';
  if (workingDirectory.trim() === '') {
    return {
      ok: false,
      message: 'This session has no working directory, so there is no working tree to diff.',
    };
  }
  return { ok: true, workingDirectory };
}

/**
 * The untracked files git reports, relative to the repository root.
 *
 * `--untracked-files=all` lists the files themselves rather than the
 * directories that contain them: the patch below is produced per file, so a
 * directory entry would hide the files inside it.
 */
function untrackedFiles(statusOutput: string): string[] {
  const files: string[] = [];
  for (const entry of statusOutput.split('\0')) {
    if (!entry.startsWith('?? ')) continue;
    const file = entry.slice(3);
    if (file !== '') files.push(file);
  }
  return files;
}

/**
 * The base the tracked changes are diffed against.
 *
 * `HEAD` when the repository has one. A repository with no commits has no
 * HEAD, and the empty tree is the honest base for it. A repository that HAS
 * commits but whose HEAD does not resolve is a broken repository, not an
 * empty one, and it is reported rather than papered over.
 */
function diffBase(cwd: string): { readonly base: string } | { readonly error: string } {
  const head = runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.error === undefined && head.status === 0 && head.stdout.trim() !== '') {
    return { base: 'HEAD' };
  }
  const commits = runGit(cwd, ['rev-list', '--all', '--max-count=1']);
  if (commits.error === undefined && commits.status === 0 && commits.stdout.trim() !== '') {
    return {
      error: `This repository has commits but HEAD does not resolve to one, so there is no base to diff against.`,
    };
  }
  return { base: EMPTY_TREE };
}

/** One block of patch text, with the label that says what it is. */
interface DiffSection {
  readonly label: string | null;
  readonly body: string;
}

const DIFF_COMMAND: TuiSlashCommandDef = {
  name: 'diff',
  argsHint: '[path]',
  description: 'Show the working tree diff (including untracked files)',
  group: 'Session info',
  async run(ctx: TuiSlashContext, args: string) {
    const filter = args.trim();

    const resolved = await sessionWorkingDirectory(ctx);
    if (!resolved.ok) {
      ctx.tui.printError(resolved.message);
      return { kind: 'handled' };
    }
    const workingDirectory = resolved.workingDirectory;
    if (!existsSync(workingDirectory)) {
      ctx.tui.printError(`The session's working directory does not exist: ${workingDirectory}`);
      return { kind: 'handled' };
    }

    // The repository root, so the patch and the untracked paths below speak
    // the same language: paths relative to the root. git reports the root
    // with forward slashes; the display uses this platform's separator.
    const toplevelArgs = ['rev-parse', '--show-toplevel'];
    const toplevel = runGit(workingDirectory, toplevelArgs);
    if (toplevel.error !== undefined) {
      ctx.tui.printError(gitFailure(toplevelArgs, toplevel));
      return { kind: 'handled' };
    }
    if (toplevel.status !== 0) {
      const detail = firstLine(toplevel.stderr);
      ctx.tui.printError(
        `Not a git repository: ${workingDirectory}${detail === '' ? '' : ` — ${detail}`}`,
      );
      return { kind: 'handled' };
    }
    const repoRoot = toplevel.stdout.trim();
    if (repoRoot === '') {
      ctx.tui.printError(`Not a git repository: ${workingDirectory}`);
      return { kind: 'handled' };
    }
    const repoPath = resolve(repoRoot);

    const base = diffBase(workingDirectory);
    if ('error' in base) {
      ctx.tui.printError(base.error);
      return { kind: 'handled' };
    }

    const statusArgs = ['status', '--porcelain=v1', '-z', '--untracked-files=all'];
    if (filter !== '') statusArgs.push('--', filter);
    const status = runGit(workingDirectory, statusArgs);
    if (status.error !== undefined || status.status !== 0) {
      ctx.tui.printError(gitFailure(statusArgs, status));
      return { kind: 'handled' };
    }

    const diffArgs = ['diff', '--no-color', '--no-ext-diff', base.base];
    if (filter !== '') diffArgs.push('--', filter);
    const tracked = runGit(workingDirectory, diffArgs);
    if (tracked.error !== undefined || tracked.status !== 0) {
      ctx.tui.printError(gitFailure(diffArgs, tracked));
      return { kind: 'handled' };
    }

    const sections: DiffSection[] = [];
    if (tracked.stdout.trim() !== '') {
      sections.push({ label: null, body: tracked.stdout });
    }

    // Untracked files are diffed against the null device, one file at a
    // time. `--no-index` reports "there are differences" as exit 1, so
    // only a non-empty body counts as a patch that was produced.
    const notes: string[] = [];
    for (const file of untrackedFiles(status.stdout)) {
      if (!existsSync(join(repoPath, file))) {
        notes.push(`Skipped ${file}: it is no longer on disk.`);
        continue;
      }
      const untrackedArgs = ['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', file];
      const untracked = runGit(repoPath, untrackedArgs);
      if (untracked.error !== undefined || (untracked.status !== 0 && untracked.status !== 1)) {
        notes.push(`Skipped ${file}: ${gitFailure(untrackedArgs, untracked)}`);
        continue;
      }
      if (untracked.stdout.trim() === '') {
        const detail = firstLine(untracked.stderr);
        notes.push(`Skipped ${file}: ${detail === '' ? 'git produced no patch for it.' : detail}`);
        continue;
      }
      sections.push({ label: `Untracked file: ${file}`, body: untracked.stdout });
    }

    const lines: string[] = [];
    for (const section of sections) {
      if (section.label !== null) lines.push(section.label);
      const body = section.body.replace(/\r?\n$/u, '');
      for (const line of body.split(/\r?\n/u)) lines.push(line);
    }

    if (lines.length === 0) {
      ctx.tui.printNotice(`No changes in the working tree (${repoPath}).`);
      for (const note of notes) ctx.tui.printNotice(note);
      return { kind: 'handled' };
    }

    const header = filter === ''
      ? `Working tree diff — ${repoPath}`
      : `Working tree diff — ${repoPath} (only "${filter}")`;
    ctx.tui.printNotice(header);
    const shown = lines.length > MAX_DIFF_LINES ? lines.slice(0, MAX_DIFF_LINES) : lines;
    for (const line of shown) ctx.tui.printNotice(line);
    if (lines.length > MAX_DIFF_LINES) {
      ctx.tui.printNotice(
        `… diff truncated: ${MAX_DIFF_LINES} of ${lines.length} lines shown. Narrow it with /diff <path>.`,
      );
    }
    for (const note of notes) ctx.tui.printNotice(note);
    return { kind: 'handled' };
  },
};

export const DIFF_COMMANDS: readonly TuiSlashCommandDef[] = [DIFF_COMMAND];
