import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandSenderFacts } from '@duya/host/command-receipt';

const boundary = vi.hoisted(() => ({ dispatch: vi.fn(), getSessionContext: vi.fn() }));

vi.mock('../../cli/desktop-host-api', () => ({
  getDesktopProjectToolService: () => ({ dispatch: boundary.dispatch, getSessionContext: boundary.getSessionContext }),
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/duya-project-tool-test', getVersion: () => '0.0.0', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false },
}));

import { dispatchDbAction } from '../db-bridge';

afterEach(() => {
  boundary.dispatch.mockReset();
  boundary.getSessionContext.mockReset();
});

function sender(overrides: Partial<CommandSenderFacts> = {}): CommandSenderFacts {
  return {
    senderPid: 1234,
    registeredSessionId: 'coordinator-1',
    role: 'agent-server',
    ...overrides,
  };
}

describe('Desktop project tool dispatch', () => {
  it('ignores payload identity when assembling Session-bound project context', async () => {
    boundary.getSessionContext.mockResolvedValue(null);
    await dispatchDbAction('project:session-context', { sessionId: 'forged', projectId: 'other' }, sender());
    expect(boundary.getSessionContext).toHaveBeenCalledWith('coordinator-1');
    await expect(dispatchDbAction('project:session-context', {}, sender({ registeredSessionId: null }))).rejects.toThrow('trusted Session');
    expect(boundary.getSessionContext).toHaveBeenCalledTimes(1);
  });
  it('resolves the Coordinator from the transport-bound Session', async () => {
    boundary.dispatch.mockResolvedValue({ ok: true, snapshot: { project: { projectId: 'project-1' } } });

    const result = await dispatchDbAction(
      'project:tool',
      { action: 'get', payload: { limit: 5 } },
      sender(),
    );

    expect(boundary.dispatch).toHaveBeenCalledWith({
      action: 'get',
      payload: { limit: 5 },
      callerSessionId: 'coordinator-1',
    });
    expect(result).toMatchObject({ ok: true });
  });

  it('prefers the corroborated attempt over the process binding', async () => {
    boundary.dispatch.mockResolvedValue({ ok: true });

    await dispatchDbAction(
      'project:tool',
      { action: 'get' },
      sender({ registeredSessionId: null }),
      { sessionId: 'coordinator-2', runId: 'run-1', epoch: 0 },
    );

    expect(boundary.dispatch).toHaveBeenCalledWith(expect.objectContaining({ callerSessionId: 'coordinator-2' }));
  });

  it('refuses a request the transport did not bind to a Session', async () => {
    const result = await dispatchDbAction('project:tool', { action: 'get' }, sender({ registeredSessionId: null }));

    expect(result).toEqual({ ok: false, reason: 'project_tool_requires_caller' });
    expect(boundary.dispatch).not.toHaveBeenCalled();
  });

  it('refuses a non-object tool payload', async () => {
    const result = await dispatchDbAction('project:tool', { action: 'get', payload: ['limit', 5] }, sender());

    expect(result).toEqual({ ok: false, reason: 'invalid_payload' });
    expect(boundary.dispatch).not.toHaveBeenCalled();
  });
});
