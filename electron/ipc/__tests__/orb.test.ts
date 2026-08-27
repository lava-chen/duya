/**
 * ipc/orb.ts — unit tests.
 *
 * Drives the IPC handlers with a fake ipcMain.handle so we can
 * exercise the contract without booting Electron. Verifies state
 * transitions + payload forwarding + the bridge from WakeService to
 * the orb BrowserWindow.
 *
 * Plan 453 Task E.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ipcMain: {
    handle: vi.fn(),
  },
  wakeService: {
    setState: vi.fn(),
    getState: vi.fn(() => 'DORMANT' as const),
    setPosition: vi.fn(),
    collapse: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  app: { isPackaged: false },
  globalShortcut: {
    register: vi.fn(() => true),
    unregisterAll: vi.fn(),
  },
  screen: {
    getPrimaryDisplay: vi.fn(() => ({
      id: 1,
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    })),
  },
}));

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
  BrowserWindow: mocks.BrowserWindow,
  app: mocks.app,
  globalShortcut: mocks.globalShortcut,
  screen: mocks.screen,
}));

vi.mock('../../services/wake', () => ({
  getWakeService: () => mocks.wakeService,
  OrbState: undefined,
}));

import {
  registerOrbHandlers,
  sendOrbChunk,
  sendOrbHide,
  sendOrbProgress,
  sendOrbResult,
  sendOrbShowLoading,
  setOrbWindowAccessor,
} from '../orb';

interface OrbWindowStub {
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Set up the handlers and capture them so we can call directly.
  registerOrbHandlers();
});

afterEach(() => {
  setOrbWindowAccessor(() => null);
});

function handlers(): Map<string, (...args: unknown[]) => unknown> {
  const out = new Map<string, (...args: unknown[]) => unknown>();
  for (const call of mocks.ipcMain.handle.mock.calls) {
    out.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
  }
  return out;
}

describe('orb IPC channel registration', () => {
  it('registers all expected channels', () => {
    const names = mocks.ipcMain.handle.mock.calls.map((c) => c[0]);
    expect(names).toEqual(
      expect.arrayContaining([
        'automation:orb:submit',
        'automation:orb:show-input',
        'automation:orb:insert-tab',
        'automation:orb:set-position',
        'automation:orb:state',
        'automation:orb:collapse',
      ]),
    );
  });
});

describe('automation:orb:submit', () => {
  it('transitions to LOADING and signals show-loading', async () => {
    const send = vi.fn();
    setOrbWindowAccessor(
      () => ({ isDestroyed: () => false, webContents: { send } }) as unknown as Electron.BrowserWindow,
    );

    const h = handlers().get('automation:orb:submit')!;
    const result = await h({}, { prompt: 'hello' });

    expect(result).toEqual({
      accepted: true,
      note: expect.stringContaining('wakeless'),
    });
    expect(send).toHaveBeenCalledWith(
      'automation:orb:show-loading',
      expect.objectContaining({ stage: 'thinking' }),
    );
  });
});

describe('automation:orb:show-input', () => {
  it('transitions state to INPUT', async () => {
    const h = handlers().get('automation:orb:show-input')!;
    const result = await h({});
    expect(result).toEqual({ ok: true });
  });
});

describe('automation:orb:insert-tab', () => {
  it('returns the not-implemented placeholder for now', async () => {
    const h = handlers().get('automation:orb:insert-tab')!;
    const result = await h({}, { text: 'sample' });
    expect(result).toEqual({
      ok: false,
      reason: 'not-implemented',
      note: expect.any(String),
    });
  });
});

describe('automation:orb:set-position', () => {
  it('forwards the position payload', async () => {
    const h = handlers().get('automation:orb:set-position')!;
    const result = await h({}, { x: 100, y: 200, displayId: 1 });
    expect(result).toEqual({ ok: true });
  });
});

describe('automation:orb:state', () => {
  it('returns the current state from wake service', async () => {
    mocks.wakeService.getState.mockReturnValueOnce('INPUT' as never);
    const h = handlers().get('automation:orb:state')!;
    const result = await h({});
    expect(result).toEqual({ state: 'INPUT' });
  });
});

describe('automation:orb:collapse', () => {
  it('invokes wakeService.collapse()', async () => {
    const h = handlers().get('automation:orb:collapse')!;
    const result = await h({});
    expect(result).toEqual({ ok: true });
  });
});

describe('sendOrb* helpers', () => {
  function withWindow(stub: OrbWindowStub): void {
    setOrbWindowAccessor(
      () => stub as unknown as Electron.BrowserWindow,
    );
  }

  it('sendOrbChunk routes to the orb window', () => {
    const send = vi.fn();
    withWindow({ isDestroyed: () => false, webContents: { send } });
    sendOrbChunk({ delta: 'hi', turnId: 't1' });
    expect(send).toHaveBeenCalledWith('automation:orb:chunk', {
      delta: 'hi',
      turnId: 't1',
    });
  });

  it('sendOrbProgress routes to the orb window', () => {
    const send = vi.fn();
    withWindow({ isDestroyed: () => false, webContents: { send } });
    sendOrbProgress({ stage: 'tool', label: 'calling Read' });
    expect(send).toHaveBeenCalledWith('automation:orb:update-progress', {
      stage: 'tool',
      label: 'calling Read',
    });
  });

  it('sendOrbShowLoading routes to the orb window', () => {
    const send = vi.fn();
    withWindow({ isDestroyed: () => false, webContents: { send } });
    sendOrbShowLoading({ stage: 'thinking' });
    expect(send).toHaveBeenCalledWith('automation:orb:show-loading', {
      stage: 'thinking',
    });
  });

  it('sendOrbResult routes to the orb window', () => {
    const send = vi.fn();
    withWindow({ isDestroyed: () => false, webContents: { send } });
    sendOrbResult({ turnId: 't1', text: 'done', finishedAt: '2026-01-01' });
    expect(send).toHaveBeenCalledWith('automation:orb:show-result', {
      turnId: 't1',
      text: 'done',
      finishedAt: '2026-01-01',
    });
  });

  it('sendOrbHide routes to the orb window', () => {
    const send = vi.fn();
    withWindow({ isDestroyed: () => false, webContents: { send } });
    sendOrbHide();
    expect(send).toHaveBeenCalledWith('automation:orb:hide');
  });

  it('does not throw when the orb window is destroyed', () => {
    setOrbWindowAccessor(
      () => ({ isDestroyed: () => true, webContents: { send: vi.fn() } }) as unknown as Electron.BrowserWindow,
    );
    expect(() => sendOrbChunk({ delta: 'x', turnId: 't' })).not.toThrow();
    expect(() => sendOrbHide()).not.toThrow();
  });

  it('does not throw when the accessor returns null', () => {
    setOrbWindowAccessor(() => null);
    expect(() => sendOrbResult({ turnId: 't', text: '', finishedAt: '' })).not.toThrow();
  });
});