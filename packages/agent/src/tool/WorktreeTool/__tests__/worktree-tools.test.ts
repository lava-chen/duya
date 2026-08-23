/**
 * Integration tests for EnterWorktreeTool / ExitWorktreeTool (plan 441).
 *
 * Runs against real throwaway git repositories; the ToolUseContext mock
 * mirrors the live-getter wiring DuyaAgent installs so the tools are
 * exercised exactly the way the runtime drives them.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Vitest's forked pool exposes process.send (its own IPC channel) — without
// this mock the db client would write db:request frames into the pool
// protocol and crash the worker. Persistence is best-effort by contract.
vi.mock('../../../ipc/db-client.js', () => ({
  sessionDb: { update: vi.fn().mockResolvedValue(undefined) },
}));

import type { ToolResult, ToolUseContext, ToolUseContextOptions } from '../../../types.js';
import {
  ENTER_WORKTREE_TOOL_NAME,
  enterWorktreeTool,
  EXIT_WORKTREE_TOOL_NAME,
  exitWorktreeTool,
} from '../index.js';
import { getSessionWorktree } from '../../../worktree/worktree-session.js';
import { beginEnter, endEnter } from '../../../worktree/worktree-session.js';

const createdRepos: string[] = [];

afterEach(() => {
  while (createdRepos.length) {
    const dir = createdRepos.pop() as string;
    try {
      const listing = git(dir, 'worktree', 'list', '--porcelain');
      for (const line of listing.split('\n')) {
        if (line.startsWith('worktree ') && !line.startsWith(`worktree ${dir}`)) {
          try {
            git(dir, 'worktree', 'remove', '--force', line.slice('worktree '.length).trim());
          } catch {
            // Best effort.
          }
        }
      }
    } catch {
      // Not a repo anymore.
    }
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function gitOk(cwd: string, ...args: string[]): boolean {
  try {
    git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'duya-wt-tool-'));
  createdRepos.push(dir);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@duya.local');
  git(dir, 'config', 'user.name', 'Duya Test');
  writeFileSync(path.join(dir, 'a.txt'), 'init\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

interface ContextHarness {
  context: ToolUseContext;
  sessionId: string;
  /** Mirrors DuyaAgent's live workingDirectory (read by options getter). */
  state: { dir: string | undefined };
}

function makeContext(repoDir?: string): ContextHarness {
  const sessionId = randomUUID();
  const state: { dir: string | undefined } = { dir: repoDir };
  const context: ToolUseContext = {
    toolUseId: randomUUID(),
    abortController: new AbortController(),
    getAppState: () => ({}),
    setAppState: () => {},
    options: {
      tools: [],
      commands: [],
      mainLoopModel: 'test',
      mcpClients: [],
      sessionId,
      get workingDirectory() {
        return state.dir;
      },
    } as unknown as ToolUseContextOptions,
    setWorkingDirectory: (directory) => {
      state.dir = directory;
    },
  };
  return { context, sessionId, state };
}

async function run(
  tool: { execute: (input: Record<string, unknown>, wd?: string, ctx?: ToolUseContext) => Promise<ToolResult> },
  input: Record<string, unknown>,
  harness: ContextHarness,
): Promise<Record<string, unknown>> {
  const result = await tool.execute(input, undefined, harness.context);
  expect(result.error).toBeFalsy();
  return JSON.parse(result.result) as Record<string, unknown>;
}

describe(ENTER_WORKTREE_TOOL_NAME, () => {
  it('creates a worktree, switches the live directory, and registers the session', async () => {
    const repoDir = makeRepo();
    const h = makeContext(repoDir);

    const out = await run(enterWorktreeTool, { name: 'session-task' }, h);

    expect(out.outcome).toBe('entered');
    const worktree = out.worktree as { path: string; branch: string };
    expect(existsSync(worktree.path)).toBe(true);
    expect(h.state.dir).toBe(worktree.path);
    expect(h.context.options.workingDirectory).toBe(worktree.path);
    expect(getSessionWorktree(h.sessionId)?.handle.path).toBe(worktree.path);
    expect(gitOk(repoDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${worktree.branch}`)).toBe(true);
    expect(out.previous_working_directory).toBe(repoDir);
  });

  it('requires a session id and a settable directory', async () => {
    const repoDir = makeRepo();
    const noSession = makeContext(repoDir);
    delete (noSession.context.options as { sessionId?: string }).sessionId;
    const res1 = await enterWorktreeTool.execute({}, undefined, noSession.context);
    expect(res1.error).toBe(true);

    const noSetter = makeContext(repoDir);
    delete (noSetter.context as { setWorkingDirectory?: unknown }).setWorkingDirectory;
    const res2 = await enterWorktreeTool.execute({}, undefined, noSetter.context);
    expect(res2.error).toBe(true);
  });

  it('refuses a second enter while already inside one', async () => {
    const repoDir = makeRepo();
    const h = makeContext(repoDir);
    const first = await run(enterWorktreeTool, {}, h);
    const firstPath = (first.worktree as { path: string }).path;

    const result = await enterWorktreeTool.execute({ name: 'other' }, undefined, h.context);
    expect(result.error).toBe(true);
    const parsed = JSON.parse(result.result) as { outcome: string };
    expect(parsed.outcome).toBe('already_in_worktree');

    // The original tree stays authoritative.
    expect(h.state.dir).toBe(firstPath);
  });

  it('fails explicitly in a non-repo instead of silently degrading', async () => {
    const notARepo = mkdtempSync(path.join(tmpdir(), 'duya-not-repo-tool-'));
    const h = makeContext(notARepo);
    const result = await enterWorktreeTool.execute({}, undefined, h.context);
    expect(result.error).toBe(true);
    expect(JSON.parse(result.result)).toMatchObject({ outcome: 'create_failed' });
    expect(h.state.dir).toBe(notARepo);
  });
});

describe(EXIT_WORKTREE_TOOL_NAME, () => {
  it("keep restores the previous directory and retains tree + branch", async () => {
    const repoDir = makeRepo();
    const h = makeContext(repoDir);
    const entered = await run(enterWorktreeTool, { name: 'precious' }, h);
    const wt = entered.worktree as { path: string; branch: string };

    const out = await run(exitWorktreeTool, { action: 'keep' }, h);

    expect(out.outcome).toBe('kept');
    expect(out.dirty).toBe(false);
    expect(h.state.dir).toBe(repoDir);
    expect(getSessionWorktree(h.sessionId)).toBeUndefined();
    expect(existsSync(wt.path)).toBe(true);
    expect(gitOk(repoDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${wt.branch}`)).toBe(true);
  });

  it('remove deletes a clean tree and branch and restores the directory', async () => {
    const repoDir = makeRepo();
    const h = makeContext(repoDir);
    const entered = await run(enterWorktreeTool, { name: 'disposable' }, h);
    const wt = entered.worktree as { path: string; branch: string };

    const out = await run(exitWorktreeTool, { action: 'remove' }, h);

    expect(out.outcome).toBe('removed');
    expect(h.state.dir).toBe(repoDir);
    expect(existsSync(wt.path)).toBe(false);
    expect(gitOk(repoDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${wt.branch}`)).toBe(false);
  });

  it('refuses to remove a dirty tree unless forced, staying inside', async () => {
    const repoDir = makeRepo();
    const h = makeContext(repoDir);
    const entered = await run(enterWorktreeTool, { name: 'wip' }, h);
    const wt = entered.worktree as { path: string; branch: string };
    writeFileSync(path.join(wt.path, 'a.txt'), 'real work\n');

    const refused = await exitWorktreeTool.execute(
      { action: 'remove' },
      undefined,
      h.context,
    );
    expect(refused.error).toBe(true);
    expect(JSON.parse(refused.result)).toMatchObject({ outcome: 'refused_dirty' });
    // Refusal leaves the session inside the tree — nothing changed.
    expect(h.state.dir).toBe(wt.path);
    expect(existsSync(wt.path)).toBe(true);

    const forced = await run(exitWorktreeTool, { action: 'remove', force: true }, h);
    expect(forced.outcome).toBe('removed');
    expect(h.state.dir).toBe(repoDir);
    expect(existsSync(wt.path)).toBe(false);
  });

  it('errors when the session never entered a worktree', async () => {
    const repoDir = makeRepo();
    const h = makeContext(repoDir);
    const result = await exitWorktreeTool.execute({}, undefined, h.context);
    expect(result.error).toBe(true);
    expect(JSON.parse(result.result)).toMatchObject({ outcome: 'not_in_worktree' });
  });

  it('defaults to keep when action is omitted', async () => {
    const repoDir = makeRepo();
    const h = makeContext(repoDir);
    const entered = await run(enterWorktreeTool, { name: 'default-keep' }, h);
    const wt = entered.worktree as { path: string };

    const out = await run(exitWorktreeTool, {}, h);
    expect(out.outcome).toBe('kept');
    expect(existsSync(wt.path)).toBe(true);
    expect(h.state.dir).toBe(repoDir);
  });
});

describe('enter reservation (concurrency guard)', () => {
  it('serializes overlapping enters on the synchronous slot', () => {
    const sessionId = randomUUID();
    expect(beginEnter(sessionId)).toBe(true);
    expect(beginEnter(sessionId)).toBe(false);
    endEnter(sessionId);
    expect(beginEnter(sessionId)).toBe(true);
    endEnter(sessionId);
  });

  it('refuses while a session is registered, allows again after exit', async () => {
    const repoDir = makeRepo();
    const h = makeContext(repoDir);
    await run(enterWorktreeTool, {}, h);
    expect(beginEnter(h.sessionId)).toBe(false);

    await run(exitWorktreeTool, { action: 'keep' }, h);
    expect(beginEnter(h.sessionId)).toBe(true);
    endEnter(h.sessionId);
  });
});
