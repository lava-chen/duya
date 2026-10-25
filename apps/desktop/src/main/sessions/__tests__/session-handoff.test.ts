/**
 * Session handoff — the Desktop's answer to the Host's optional
 * "open this session in the desktop app" capability.
 *
 * The window and the logger are replaced; what is under test is the contract
 * the Host sees: a handoff either reaches the renderer and brings the app
 * forward, or it reports why it could not.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeWindow {
  destroyed: boolean;
  minimized: boolean;
  restored: boolean;
  shown: boolean;
  focused: boolean;
  sent: { channel: string; payload: unknown }[];
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  webContents: { send(channel: string, payload: unknown): void };
}

const mocks = vi.hoisted(() => ({
  window: null as FakeWindow | null,
  warn: vi.fn(),
}));

vi.mock('../../core/window-manager', () => ({
  getMainWindow: () => mocks.window,
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() }),
  LogComponent: { Main: 'Main' },
}));

const { SESSION_HANDOFF_CHANNEL, createDesktopSessionHandoffApi, openSessionInDesktopApp } = await import(
  '../session-handoff'
);

function makeWindow(): FakeWindow {
  const fake: FakeWindow = {
    destroyed: false,
    minimized: false,
    restored: false,
    shown: false,
    focused: false,
    sent: [],
    isDestroyed: () => fake.destroyed,
    isMinimized: () => fake.minimized,
    restore: () => {
      fake.restored = true;
      fake.minimized = false;
    },
    show: () => {
      fake.shown = true;
    },
    focus: () => {
      fake.focused = true;
    },
    webContents: {
      send: (channel, payload) => {
        fake.sent.push({ channel, payload });
      },
    },
  };
  return fake;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.window = makeWindow();
});

describe('openSessionInDesktopApp', () => {
  it('tells the renderer to open the session and brings the app forward', () => {
    const result = openSessionInDesktopApp('session-1');

    expect(result).toEqual({ ok: true });
    expect(mocks.window?.sent).toEqual([
      { channel: SESSION_HANDOFF_CHANNEL, payload: { sessionId: 'session-1' } },
    ]);
    expect(mocks.window?.focused).toBe(true);
    expect(mocks.window?.shown).toBe(true);
  });

  it('restores a minimized window instead of leaving it in the taskbar', () => {
    mocks.window = makeWindow();
    mocks.window.minimized = true;

    openSessionInDesktopApp('session-1');

    expect(mocks.window?.restored).toBe(true);
  });

  it('refuses an empty session id', () => {
    const result = openSessionInDesktopApp('   ');

    expect(result.ok).toBe(false);
    expect(mocks.window?.sent).toHaveLength(0);
  });

  it('reports that there is no window to answer the handoff', () => {
    mocks.window = null;

    const result = openSessionInDesktopApp('session-1');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_window');
  });

  it('reports a destroyed window as no window', () => {
    mocks.window = makeWindow();
    mocks.window.destroyed = true;

    const result = openSessionInDesktopApp('session-1');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_window');
  });
});

describe('createDesktopSessionHandoffApi', () => {
  it('answers the capability shape the Host consumes', () => {
    const api = createDesktopSessionHandoffApi();

    expect(api.openInDesktopApp({ sessionId: 'session-2' })).toEqual({ ok: true });
    expect(mocks.window?.sent).toEqual([
      { channel: SESSION_HANDOFF_CHANNEL, payload: { sessionId: 'session-2' } },
    ]);
  });
});
