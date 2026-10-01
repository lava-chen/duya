/**
 * lazy-ipc.test.ts — lazy IPC group registration.
 *
 * Verifies that `registerLazyIpcHandlers` installs proxies without importing the
 * target module, loads it exactly once on first invoke, dispatches to the
 * captured listener, and handles failure / mis-declared channels safely.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  return {
    handlers,
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      mocks.handlers.set(channel, handler);
    },
  },
}));

// Path is relative to THIS test file, not to the module under test.
vi.mock('../../logging/logger', () => ({
  getLogger: () => mocks,
  LogComponent: { Main: 'Main' },
}));

import { registerLazyIpcHandlers, type IpcRegistrar } from '../lazy-ipc-registry';

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`no proxy registered for ${channel}`);
  return handler({}, ...args);
};

beforeEach(() => {
  mocks.handlers.clear();
  mocks.warn.mockClear();
});

describe('registerLazyIpcHandlers', () => {
  it('installs a proxy for every declared channel without loading the module', () => {
    const load = vi.fn();
    registerLazyIpcHandlers({ label: 'demo', channels: ['demo:a', 'demo:b'], load });

    expect([...mocks.handlers.keys()].sort()).toEqual(['demo:a', 'demo:b']);
    expect(load).not.toHaveBeenCalled();
  });

  it('loads the module on first invoke and dispatches to the captured listener', async () => {
    const load = vi.fn(async (register: IpcRegistrar) => {
      register('demo:a', async (_event, value) => `A:${String(value)}`);
    });
    registerLazyIpcHandlers({ label: 'demo', channels: ['demo:a'], load });

    expect(await invoke('demo:a', 7)).toBe('A:7');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('loads at most once across channels and repeated invokes', async () => {
    const load = vi.fn(async (register: IpcRegistrar) => {
      register('demo:a', async () => 'a');
      register('demo:b', async () => 'b');
    });
    registerLazyIpcHandlers({ label: 'demo', channels: ['demo:a', 'demo:b'], load });

    await invoke('demo:a');
    await invoke('demo:a');
    await invoke('demo:b');

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent first invokes into a single load', async () => {
    const load = vi.fn(async (register: IpcRegistrar) => {
      await Promise.resolve();
      register('demo:a', async () => 'loaded');
    });
    registerLazyIpcHandlers({ label: 'demo', channels: ['demo:a'], load });

    const [first, second] = await Promise.all([invoke('demo:a'), invoke('demo:a')]);

    expect([first, second]).toEqual(['loaded', 'loaded']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('propagates a load failure and retries on the next invoke', async () => {
    let attempt = 0;
    const load = vi.fn(async (register: IpcRegistrar) => {
      attempt += 1;
      if (attempt === 1) throw new Error('boom');
      register('demo:a', async () => 'recovered');
    });
    registerLazyIpcHandlers({ label: 'demo', channels: ['demo:a'], load });

    await expect(invoke('demo:a')).rejects.toThrow('boom');
    await expect(invoke('demo:a')).resolves.toBe('recovered');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('warns and fails the invoke when a declared channel is never registered', async () => {
    const load = vi.fn(async () => {});
    registerLazyIpcHandlers({ label: 'demo', channels: ['demo:a'], load });

    await expect(invoke('demo:a')).rejects.toThrow(/not registered/);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining('did not register "demo:a"'),
      expect.objectContaining({ channel: 'demo:a' }),
      'Main',
    );
  });

  it('registers undeclared channels for real instead of dropping them', async () => {
    const load = vi.fn(async (register: IpcRegistrar) => {
      register('demo:a', async () => 'a');
      register('demo:extra', async () => 'extra');
    });
    registerLazyIpcHandlers({ label: 'demo', channels: ['demo:a'], load });

    await invoke('demo:a');

    expect(await invoke('demo:extra')).toBe('extra');
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining('undeclared channel "demo:extra"'),
      expect.objectContaining({ channel: 'demo:extra' }),
      'Main',
    );
  });
});
