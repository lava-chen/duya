/**
 * wake.ts — unit tests.
 *
 * The wake service talks to Electron's globalShortcut + BrowserWindow
 * APIs. We mock both with fakes so we can exercise the state machine
 * + position persistence + listener contract without spawning a real
 * window.
 *
 * Plan 453 Task E.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks (must be set before module import).
const mocks = vi.hoisted(() => {
  return {
    globalShortcut: {
      register: vi.fn(() => true),
      unregisterAll: vi.fn(),
    },
    BrowserWindow: vi.fn(),
    screen: {
      getPrimaryDisplay: vi.fn(() => ({
        id: 1,
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      })),
    },
    app: { isPackaged: false },
    loadURL: vi.fn(),
  };
});

vi.mock('electron', () => ({
  globalShortcut: mocks.globalShortcut,
  BrowserWindow: mocks.BrowserWindow,
  screen: mocks.screen,
  app: mocks.app,
}));

import {
  __resetWakeService,
  defaultOrbPosition,
  initializeWakeService,
  getWakeService,
  type OrbState,
} from '../wake';

class FakeBrowserWindow {
  destroyed = false;
  bounds: { x: number; y: number; width: number; height: number } = {
    x: 0,
    y: 0,
    width: 50,
    height: 50,
  };
  visible = false;
  webContents = {
    send: vi.fn(),
  };
  listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  on(event: string, listener: (...args: unknown[]) => void): void {
    (this.listeners[event] ??= []).push(listener);
  }
  once(event: string, listener: (...args: unknown[]) => void): void {
    this.on(event, listener);
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isMinimized(): boolean {
    return false;
  }
  show(): void {
    this.visible = true;
  }
  restore(): void {}
  focus(): void {}
  setBounds(next: { x: number; y: number; width: number; height: number }): void {
    this.bounds = { ...next };
  }
  loadURL(url: string): Promise<void> {
    mocks.loadURL(url);
    return Promise.resolve();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.globalShortcut.register.mockReturnValue(true);
  mocks.BrowserWindow.mockImplementation(() => new FakeBrowserWindow() as unknown as Electron.BrowserWindow);
  __resetWakeService();
});

afterEach(() => {
  __resetWakeService();
});

describe('WakeService initialize', () => {
  it('registers the default shortcut', () => {
    initializeWakeService({});
    expect(mocks.globalShortcut.register).toHaveBeenCalledTimes(1);
    expect(mocks.globalShortcut.register).toHaveBeenCalledWith(
      'CommandOrControl+Shift+Space',
      expect.any(Function),
    );
  });

  it('honors a custom default shortcut', () => {
    initializeWakeService({ defaultShortcut: 'Alt+F1' });
    expect(mocks.globalShortcut.register).toHaveBeenCalledWith(
      'Alt+F1',
      expect.any(Function),
    );
  });

  it('does not throw when register returns false (conflict)', () => {
    mocks.globalShortcut.register.mockReturnValueOnce(false);
    expect(() => initializeWakeService({})).not.toThrow();
  });

  it('does not throw when register throws', () => {
    mocks.globalShortcut.register.mockImplementationOnce(() => {
      throw new Error('platform error');
    });
    expect(() => initializeWakeService({})).not.toThrow();
  });

  it('doubleTap mode registers a single key and intercepts the callback', () => {
    const wake = initializeWakeService({
      defaultShortcut: 'Shift+=',
      doubleTap: true,
      doubleTapWindowMs: 500,
    });
    expect(mocks.globalShortcut.register).toHaveBeenCalledWith(
      'Shift+=',
      expect.any(Function),
    );
    // The callback registered with globalShortcut is NOT the
    // wake() entry point — it's the double-tap detector.
    const registeredCallback = (mocks.globalShortcut.register.mock
      .calls[0] as unknown as [string, () => void])[1];
    // First press alone should not wake the orb.
    const stateBefore = wake.getState();
    registeredCallback();
    expect(wake.getState()).toBe(stateBefore);
  });
});

describe('WakeService wake/collapse', () => {
  it('starts in DORMANT', () => {
    const wake = initializeWakeService({});
    expect(wake.getState()).toBe('DORMANT');
  });

  it('wake() from DORMANT transitions to INPUT and creates the window', () => {
    const wake = initializeWakeService({});
    wake.wake();

    expect(wake.getState()).toBe('INPUT');
    expect(mocks.BrowserWindow).toHaveBeenCalledTimes(1);
    const win = wake.getOrbWindow() as unknown as FakeBrowserWindow;
    expect(win).not.toBeNull();
    expect(win.webContents.send).toHaveBeenCalledWith(
      'automation:orb:show-input',
    );
  });

  it('wake() from INPUT focuses but does not reset', () => {
    const wake = initializeWakeService({});
    wake.wake();
    const win = wake.getOrbWindow() as unknown as FakeBrowserWindow;
    const calls = win.webContents.send.mock.calls.length;

    wake.wake(); // second wake
    expect(wake.getState()).toBe('INPUT');
    expect(win.webContents.send.mock.calls.length).toBe(calls);
  });

  it('collapse() returns to DORMANT and sends hide', () => {
    const wake = initializeWakeService({});
    wake.wake();
    wake.collapse();

    expect(wake.getState()).toBe('DORMANT');
    const win = wake.getOrbWindow() as unknown as FakeBrowserWindow;
    expect(win.webContents.send).toHaveBeenCalledWith(
      'automation:orb:hide',
    );
  });

  it('collapse() from DORMANT is a no-op', () => {
    const wake = initializeWakeService({});
    wake.collapse();
    expect(wake.getState()).toBe('DORMANT');
  });

  it('setState transitions fire onStateChange listeners', () => {
    const wake = initializeWakeService({});
    const received: OrbState[] = [];
    wake.onStateChange((s) => received.push(s));

    wake.wake(); // → INPUT
    wake.setState('LOADING');
    wake.setState('RESULT');
    wake.collapse(); // → DORMANT

    expect(received).toEqual(['INPUT', 'LOADING', 'RESULT', 'DORMANT']);
  });

  it('setState to the same state is a no-op (no broadcast)', () => {
    const wake = initializeWakeService({});
    const received: OrbState[] = [];
    wake.onStateChange((s) => received.push(s));
    wake.setState('DORMANT');
    expect(received).toEqual([]);
  });
});

describe('WakeService position', () => {
  it('defaults to a sensible on-screen position via defaultOrbPosition()', () => {
    expect(defaultOrbPosition()).toEqual({
      x: 20,
      y: 20,
      displayId: 1,
    });
  });

  it('setPosition updates the orb bounds after wake', () => {
    const wake = initializeWakeService({});
    wake.setPosition({ x: 500, y: 300, displayId: 2 });
    wake.wake();
    const win = wake.getOrbWindow() as unknown as FakeBrowserWindow;
    // INPUT width 280, position 500/300.
    expect(win.bounds).toEqual({ x: 500, y: 300, width: 280, height: 100 });
  });

  it('getPosition returns a copy', () => {
    const wake = initializeWakeService({});
    wake.setPosition({ x: 100, y: 100, displayId: 0 });
    const p = wake.getPosition();
    p.x = 999;
    expect(wake.getPosition().x).toBe(100);
  });
});

describe('getWakeService', () => {
  it('throws before initialization', () => {
    expect(() => getWakeService()).toThrow();
  });

  it('returns the initialized singleton', () => {
    const wake = initializeWakeService({});
    expect(getWakeService()).toBe(wake);
  });
});

describe('WakeService double-tap detection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function getRegisteredCallback(): () => void {
    const calls = mocks.globalShortcut.register.mock.calls as unknown as Array<
      [string, (() => void) | undefined]
    >;
    const last = calls[calls.length - 1];
    return last?.[1] ?? (() => undefined);
  }

  it('fires wake on the second press within the window', () => {
    const wake = initializeWakeService({
      defaultShortcut: 'Shift+=',
      doubleTap: true,
      doubleTapWindowMs: 500,
    });
    const cb = getRegisteredCallback();

    // First press: nothing.
    cb();
    expect(wake.getState()).toBe('DORMANT');

    // Advance just under the window; second press should fire.
    vi.advanceTimersByTime(200);
    cb();
    expect(wake.getState()).toBe('INPUT');
  });

  it('does not fire when the second press is outside the window', () => {
    const wake = initializeWakeService({
      defaultShortcut: 'Shift+=',
      doubleTap: true,
      doubleTapWindowMs: 500,
    });
    const cb = getRegisteredCallback();

    cb();
    vi.advanceTimersByTime(800);
    cb();
    // The second press resets the counter; only the next press
    // (within 500ms of this one) would fire.
    expect(wake.getState()).toBe('DORMANT');
  });

  it('resets the press counter via the auto-reset timer', () => {
    const wake = initializeWakeService({
      defaultShortcut: 'Shift+=',
      doubleTap: true,
      doubleTapWindowMs: 500,
    });
    const cb = getRegisteredCallback();

    cb();
    // Wait long enough for the auto-reset (windowMs + 50ms).
    vi.advanceTimersByTime(700);
    // Now a single press should NOT fire (counter reset).
    cb();
    expect(wake.getState()).toBe('DORMANT');
  });
});