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
    on: vi.fn(),
  },
  wakeService: {
    setState: vi.fn(),
    getState: vi.fn(() => 'DORMANT' as const),
    setPosition: vi.fn(),
    collapse: vi.fn(),
    markWakelessTurnActive: vi.fn(),
    clearWakelessTurnActive: vi.fn(),
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
  // No-op: the real one dynamically imports the agent dist bundle, which
  // unit tests don't load. Handlers only need it to be callable.
  armOSContextBridge: () => {},
  OrbState: undefined,
}));

vi.mock('../../services/orb-wakeless-chat', () => ({
  startWakelessChat: vi.fn(async () => ({
    accepted: true,
    sessionId: 'wakeless-00000000-0000-4000-8000-000000000000',
  })),
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

    // Plan 453 Task G: the handler now delegates to
    // startWakelessChat which returns { accepted, sessionId, note }.
    // We only assert the parts the renderer relies on.
    expect(result.accepted).toBe(true);
    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId).toMatch(/^wakeless-[0-9a-f-]{36}$/i);
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
  it('delegates to the Insert Tab service and returns the structured result', async () => {
    // Plan 453 Task I: the handler now delegates to
    // insertTabToFocusedField. In test env OSContextBridge is
    // disabled by default → service returns ok:false +
    // 'os-context-bridge-disabled'. We assert the rejection reason
    // rather than the happy path because nut.js + the agent
    // bridge are not available in the unit test sandbox.
    const h = handlers().get('automation:orb:insert-tab')!;
    const result = await h({}, { text: 'sample' });
    expect(result.ok).toBe(false);
    expect([
      'os-context-bridge-disabled',
      'no-os-context-snapshot',
      'focused-field-redacted',
      'no-focused-entity',
      'unsupported-focused-entity-kind:File',
      'unsupported-focused-entity-kind:Document',
      'nut-js-load-failed',
      'nut-type-failed',
    ]).toContain(result.reason);
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

  it('sendOrbResult routes to the orb window in an active state', () => {
    const send = vi.fn();
    withWindow({ isDestroyed: () => false, webContents: { send } });
    mocks.wakeService.getState.mockReturnValue('INPUT' as never);
    sendOrbResult({ turnId: 't1', text: 'done', finishedAt: '2026-01-01' });
    expect(send).toHaveBeenCalledWith('automation:orb:show-result', {
      turnId: 't1',
      text: 'done',
      finishedAt: '2026-01-01',
    });
  });

  it('sendOrbResult badges the ball while DORMANT (notify-result, no card)', () => {
    const send = vi.fn();
    withWindow({ isDestroyed: () => false, webContents: { send } });
    mocks.wakeService.getState.mockReturnValue('DORMANT' as never);
    sendOrbResult({ turnId: 't1', text: 'done', finishedAt: '2026-01-01' });
    expect(send).toHaveBeenCalledWith('automation:orb:notify-result', {
      turnId: 't1',
      text: 'done',
      finishedAt: '2026-01-01',
    });
    expect(send).not.toHaveBeenCalledWith(
      'automation:orb:show-result',
      expect.anything(),
    );
  });

  it('open-result handler grows the window to RESULT', async () => {
    const handler = mocks.ipcMain.handle.mock.calls.find(
      (c) => c[0] === 'automation:orb:open-result',
    )?.[1] as (() => Promise<unknown>) | undefined;
    expect(handler).toBeDefined();
    await expect(handler!()).resolves.toEqual({ ok: true });
    expect(mocks.wakeService.setState).toHaveBeenCalledWith('RESULT');
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