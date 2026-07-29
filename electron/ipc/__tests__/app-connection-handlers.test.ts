/**
 * app-connection-handlers.test.ts — Plan 312 Phase 2.
 *
 * Mirrors the IPC-handler test pattern in
 * `electron/ipc/__tests__/git-handlers.test.ts`: mock `electron.ipcMain`
 * to capture channel handlers, mock the AppConnectionService singleton,
 * then drive each channel and assert the DTO envelope.
 *
 * Critical boundary assertions:
 *   - list/status return ONLY status DTOs (no token field leaks)
 *   - connect propagates structured errorCode on FlowError
 *   - disconnect triggers the reload hook
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    service: {
      list: vi.fn(),
      listByProvider: vi.fn(),
      getStatus: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      setReloadHook: vi.fn(),
    },
    captured: {
      handle: new Map<
        string,
        (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>
      >(),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      fn: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>,
    ) => {
      mocks.captured.handle.set(channel, fn);
    },
  },
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  LogComponent: {
    AppConnectionHandlers: 'AppConnectionHandlers',
  },
}));

vi.mock('../services/app-connections/app-connection-service', () => ({
  getAppConnectionService: () => mocks.service,
}));

import { registerAppConnectionHandlers } from '../app-connection-handlers';

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = mocks.captured.handle.get(channel);
  if (!fn) throw new Error(`No handler registered for ${channel}`);
  return fn({}, ...args);
}

describe('appConnection IPC handlers', () => {
  beforeEach(() => {
    mocks.captured.handle.clear();
    mocks.service.list.mockReset();
    mocks.service.getStatus.mockReset();
    mocks.service.connect.mockReset();
    mocks.service.disconnect.mockReset();
    mocks.service.setReloadHook.mockReset();
    registerAppConnectionHandlers();
  });

  it('installs reload hook on registration', () => {
    expect(mocks.service.setReloadHook).toHaveBeenCalledTimes(1);
    expect(typeof mocks.service.setReloadHook.mock.calls[0]![0]).toBe('function');
  });

  it('appConnection:list returns DTO array (no token fields)', async () => {
    mocks.service.list.mockReturnValue([
      {
        id: 'c1',
        provider: 'google',
        accountLabel: 'alice@example.com',
        accountId: 'sub-1',
        scopes: ['drive.read'],
        status: 'connected',
        expiresAt: 9999,
        lastError: null,
        createdAt: 1,
        updatedAt: 2,
      },
    ]);

    const res = (await invoke('appConnection:list')) as {
      success: boolean;
      data?: Array<Record<string, unknown>>;
    };

    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(1);
    // Hard boundary: token fields MUST NOT appear on the returned DTO.
    const dto = res.data![0]!;
    expect(dto.accessToken).toBeUndefined();
    expect(dto.refreshToken).toBeUndefined();
    expect(dto).toMatchObject({ id: 'c1', provider: 'google', status: 'connected' });
  });

  it('appConnection:status returns DTO for known id', async () => {
    mocks.service.getStatus.mockReturnValue({
      id: 'c1',
      provider: 'slack',
      accountLabel: 'bob',
      accountId: 'U1',
      scopes: [],
      status: 'disconnected',
      expiresAt: null,
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    });

    const res = (await invoke('appConnection:status', 'c1')) as {
      success: boolean;
      data?: { id: string };
      errorCode?: string;
    };
    expect(res.success).toBe(true);
    expect(res.data?.id).toBe('c1');
  });

  it('appConnection:status rejects missing connectionId', async () => {
    const res = (await invoke('appConnection:status', '')) as { success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/connectionId/);
  });

  it('appConnection:status on unknown id → connection_not_found errorCode', async () => {
    mocks.service.getStatus.mockReturnValue(null);
    const res = (await invoke('appConnection:status', 'ghost')) as {
      success: boolean;
      errorCode?: string;
    };
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('connection_not_found');
  });

  it('appConnection:connect rejects missing provider', async () => {
    const res = (await invoke('appConnection:connect', {})) as { success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/provider/);
  });

  it('appConnection:connect rejects unsupported provider', async () => {
    const res = (await invoke('appConnection:connect', { provider: 'facebook' })) as {
      success: boolean;
      errorCode?: string;
    };
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('unsupported_provider');
  });

  it('appConnection:connect success returns DTO (no token fields)', async () => {
    mocks.service.connect.mockResolvedValue({
      id: 'new',
      provider: 'google',
      accountLabel: 'a@b.com',
      accountId: 'sub',
      scopes: ['drive.read'],
      status: 'connected',
      expiresAt: 1234,
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    });

    const res = (await invoke('appConnection:connect', { provider: 'google', scopes: ['drive.read'] })) as {
      success: boolean;
      data?: Record<string, unknown>;
    };
    expect(res.success).toBe(true);
    expect(res.data?.accessToken).toBeUndefined();
    expect(res.data?.status).toBe('connected');
    expect(mocks.service.connect).toHaveBeenCalledWith('google', ['drive.read']);
  });

  it('appConnection:connect on FlowError returns structured errorCode', async () => {
    const err = Object.assign(new Error('invalid_grant: stale'), {
      code: 'invalid_grant',
      name: 'FlowError',
    });
    mocks.service.connect.mockRejectedValue(err);
    const res = (await invoke('appConnection:connect', { provider: 'slack' })) as {
      success: boolean;
      errorCode?: string;
      error?: string;
    };
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('invalid_grant');
    expect(res.error).toMatch(/invalid_grant/);
  });

  it('appConnection:disconnect success', async () => {
    mocks.service.disconnect.mockResolvedValue(true);
    const res = (await invoke('appConnection:disconnect', 'c1')) as {
      success: boolean;
      data?: { disconnected: boolean };
    };
    expect(res.success).toBe(true);
    expect(res.data?.disconnected).toBe(true);
    expect(mocks.service.disconnect).toHaveBeenCalledWith('c1');
  });

  it('appConnection:disconnect rejects missing connectionId', async () => {
    const res = (await invoke('appConnection:disconnect')) as { success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/connectionId/);
  });
});
