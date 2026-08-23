/**
 * Regression tests for SubagentTool's isolation:'worktree' wiring (plan 440,
 * leak fix from the plan 441 audit): a foreground run that CRASHES must still
 * clean up its worktree — the old code only cleaned up on success.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Vitest's forked pool exposes process.send; the db client would corrupt the
// pool protocol without this mock (same rationale as worktree-tools.test).
vi.mock('../../../ipc/db-client.js', () => ({
  sessionDb: { create: vi.fn().mockResolvedValue(undefined), update: vi.fn().mockResolvedValue(undefined) },
  messageDb: { getBySession: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../../../process/worker-protocol.js', () => ({
  sendEvent: vi.fn(),
}));
const runAgentSyncMock = vi.fn();
const runAgentMock = vi.fn();
vi.mock('../runAgent.js', () => ({
  runAgentSync: (...args: unknown[]) => runAgentSyncMock(...args),
  runAgent: (...args: unknown[]) => runAgentMock(...args),
}));

import type { ToolResult, ToolUseContext, ToolUseContextOptions } from '../../../types.js';
import type { AgentDefinition } from '../loadAgentsDir.js';
import { subagentTool } from '../SubagentTool.js';

let repoDir = '';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function branchExists(branch: string): boolean {
  try {
    git(repoDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  repoDir = mkdtempSync(path.join(tmpdir(), 'duya-sub-wt-'));
  git(repoDir, 'init', '-b', 'main');
  git(repoDir, 'config', 'user.email', 'test@duya.local');
  git(repoDir, 'config', 'user.name', 'Duya Test');
  writeFileSync(path.join(repoDir, 'a.txt'), 'init\n');
  git(repoDir, 'add', '.');
  git(repoDir, 'commit', '-m', 'init');
});

afterEach(() => {
  try {
    const listing = git(repoDir, 'worktree', 'list', '--porcelain');
    for (const line of listing.split('\n')) {
      if (line.startsWith('worktree ') && !line.startsWith(`worktree ${repoDir}`)) {
        try {
          git(repoDir, 'worktree', 'remove', '--force', line.slice('worktree '.length).trim());
        } catch {
          // Best effort.
        }
      }
    }
  } catch {
    // Repo already gone.
  }
});

function makeContext(): ToolUseContext {
  const definition = {
    agentType: 'general-purpose',
    whenToUse: 'test agent',
  } as unknown as AgentDefinition;
  const sessionId = randomUUID();
  return {
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
      workingDirectory: repoDir,
      agentDefinitions: { activeAgents: [definition], allAgents: [definition] },
    } as unknown as ToolUseContextOptions,
  };
}

describe('SubagentTool isolation:worktree crash safety', () => {
  it('cleans up the worktree even when the sub-agent run throws', async () => {
    runAgentSyncMock.mockImplementation(async () => {
      throw new Error('agent exploded mid-run');
    });

    const result = await subagentTool.execute(
      {
        prompt: 'mutate files',
        subagent_type: 'general-purpose',
        name: 'leak-test',
        isolation: 'worktree',
        run_in_background: false,
      },
      undefined,
      makeContext(),
    );

    expect(result.error).toBe(true);
    expect(JSON.parse(result.result as string)).toMatchObject({
      error: expect.stringContaining('agent exploded'),
    });
    // The tree and its dedicated branch are gone despite the crash.
    expect(existsSync(path.join(repoDir, '.duya', 'worktrees', 'leak-test'))).toBe(false);
    expect(branchExists('duya-worktree/leak-test')).toBe(false);
  });

  it('keeps a dirty worktree when the crashed run had produced changes', async () => {
    let createdTreePath = '';
    runAgentSyncMock.mockImplementation(async (args: { toolUseContext?: ToolUseContext }) => {
      createdTreePath = args.toolUseContext?.options.workingDirectory ?? '';
      if (createdTreePath && createdTreePath !== repoDir) {
        writeFileSync(path.join(createdTreePath, 'a.txt'), 'crashed but real work\n');
      }
      throw new Error('agent exploded after writing');
    });

    const result: ToolResult = await subagentTool.execute(
      {
        prompt: 'mutate files',
        subagent_type: 'general-purpose',
        name: 'wip-crash',
        isolation: 'worktree',
        run_in_background: false,
      },
      undefined,
      makeContext(),
    );

    expect(result.error).toBe(true);
    expect(createdTreePath).toContain(path.join('.duya', 'worktrees'));
    expect(existsSync(createdTreePath)).toBe(true);
    expect(readFileSync(path.join(createdTreePath, 'a.txt'), 'utf8')).toBe(
      'crashed but real work\n',
    );
  });
});
