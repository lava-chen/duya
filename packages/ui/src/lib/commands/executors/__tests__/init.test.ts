/**
 * Executor tests for `/init` (init.ts).
 *
 * The command is driven through the domain executor directly: the shared
 * catalog does not name `init` yet, and what matters here is what the
 * command does with each outcome — in particular that it never says "done"
 * when the write did not happen.
 */

import { describe, expect, it, vi } from 'vitest';

import { INIT_EXECUTORS } from '../init';
import type { CommandContext, CommandResult } from '../../types';

function makeCtx(
  bridge: Partial<NonNullable<CommandContext['app']>>,
  sessionId: string | undefined,
): CommandContext {
  return {
    args: [],
    raw: '/init',
    app: {
      getSessionSnapshot: () => ({ sessionId }),
      ...bridge,
    } as CommandContext['app'],
  };
}

describe('/init executor', () => {
  it('refuses without a session — there is no repository root to write to', async () => {
    const initWorkspaceAgentsMd = vi.fn();
    const result = (await INIT_EXECUTORS.init(
      makeCtx({ initWorkspaceAgentsMd }, undefined),
    )) as CommandResult;

    expect(result.type).toBe('error');
    expect(initWorkspaceAgentsMd).not.toHaveBeenCalled();
  });

  it('refuses when the composer has no workspace channel', async () => {
    const result = (await INIT_EXECUTORS.init(makeCtx({}, 'session-1'))) as CommandResult;
    expect(result.type).toBe('error');
  });

  it('sends the session id, never a path', async () => {
    const initWorkspaceAgentsMd = vi.fn(async () => ({
      ok: true,
      path: 'E:\\repo\\AGENTS.md',
      created: true,
      upgraded: false,
      unchanged: false,
      version: 1,
    }));

    await INIT_EXECUTORS.init(makeCtx({ initWorkspaceAgentsMd }, 'session-1'));

    expect(initWorkspaceAgentsMd).toHaveBeenCalledWith('session-1');
  });

  it('reports a created file', async () => {
    const initWorkspaceAgentsMd = vi.fn(async () => ({
      ok: true,
      path: 'E:\\repo\\AGENTS.md',
      created: true,
      upgraded: false,
      unchanged: false,
      version: 1,
    }));

    const result = (await INIT_EXECUTORS.init(
      makeCtx({ initWorkspaceAgentsMd }, 'session-1'),
    )) as CommandResult;

    expect(result.type).toBe('text');
    expect(result.type === 'text' ? result.content : '').toContain('已创建');
  });

  it('says plainly that an existing current file was left alone', async () => {
    const initWorkspaceAgentsMd = vi.fn(async () => ({
      ok: true,
      path: 'E:\\repo\\AGENTS.md',
      created: false,
      upgraded: false,
      unchanged: true,
      version: 1,
    }));

    const result = (await INIT_EXECUTORS.init(
      makeCtx({ initWorkspaceAgentsMd }, 'session-1'),
    )) as CommandResult;

    expect(result.type).toBe('text');
    const content = result.type === 'text' ? result.content : '';
    expect(content).toContain('未改动');
    expect(content).not.toContain('已创建');
  });

  it('warns when a file without a duya marker was overwritten', async () => {
    const initWorkspaceAgentsMd = vi.fn(async () => ({
      ok: true,
      path: 'E:\\repo\\AGENTS.md',
      created: false,
      upgraded: true,
      unchanged: false,
      replacedUnmarked: true,
      version: 1,
    }));

    const result = (await INIT_EXECUTORS.init(
      makeCtx({ initWorkspaceAgentsMd }, 'session-1'),
    )) as CommandResult;

    expect(result.type).toBe('text');
    const content = result.type === 'text' ? result.content : '';
    expect(content).toContain('覆盖');
    expect(content).toContain('原内容已被替换');
  });

  it('turns a failed write into an error, with the reason', async () => {
    const initWorkspaceAgentsMd = vi.fn(async () => ({
      ok: false,
      created: false,
      upgraded: false,
      unchanged: false,
      version: 0,
      error: 'the session has no working directory',
    }));

    const result = (await INIT_EXECUTORS.init(
      makeCtx({ initWorkspaceAgentsMd }, 'session-1'),
    )) as CommandResult;

    expect(result.type).toBe('error');
    expect(result.type === 'error' ? result.message : '').toContain(
      'the session has no working directory',
    );
  });

  it('surfaces a thrown channel as an error, not as a crash', async () => {
    const initWorkspaceAgentsMd = vi.fn(async () => {
      throw new Error('channel exploded');
    });

    const result = (await INIT_EXECUTORS.init(
      makeCtx({ initWorkspaceAgentsMd }, 'session-1'),
    )) as CommandResult;

    expect(result.type).toBe('error');
    expect(result.type === 'error' ? result.message : '').toContain('channel exploded');
  });
});
