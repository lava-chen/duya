/**
 * electron/core/window-manager.webview.test.ts
 *
 * Wiring test for ISS-15.
 *
 * `webview-guard.test.ts` proves the floor is correct; it says nothing about
 * whether the main window actually installs it. That gap is exactly how the
 * ISS-30 reference adoption shipped five red tests, so this file asserts the
 * one load-bearing fact: a `will-attach-webview` listener is registered on the
 * main window's webContents, and applying it neutralises a hostile request.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const listeners: Record<string, (event: unknown, ...args: unknown[]) => void> = {};
  return {
    listeners,
    ctorOptions: null as Record<string, unknown> | null,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      time: vi.fn(() => () => {}),
    },
    channelManager: null,
  };
});

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getName: () => 'duya' },
  dialog: { showErrorBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  MessageChannelMain: class {
    port1 = {};
    port2 = {};
  },
  BrowserWindow: class {
    webContents = {
      id: 1,
      on: (event: string, fn: (event: unknown, ...args: unknown[]) => void) => {
        mocks.listeners[event] = fn;
      },
      setWindowOpenHandler: vi.fn(),
      getURL: () => 'http://localhost:3000/',
      postMessage: vi.fn(),
      openDevTools: vi.fn(),
    };
    constructor(options: Record<string, unknown>) {
      mocks.ctorOptions = options;
    }
    isDestroyed = () => false;
    isVisible = () => true;
    isMinimized = () => false;
    isMaximized = () => false;
    maximize = vi.fn();
    hide = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    restore = vi.fn();
    setBackgroundMaterial = vi.fn();
    getNormalBounds = () => ({ x: 0, y: 0, width: 1280, height: 860 });
    loadURL = vi.fn();
    on = vi.fn();
  },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => mocks.logger,
  initLogger: vi.fn(),
  LogComponent: new Proxy({}, { get: (_t, p) => String(p) }),
}));

vi.mock('../services/auto-start', () => ({ wasLaunchedAsHidden: () => false }));
vi.mock('../services/dev-detector', () => ({ getNodeExecutable: () => '/usr/bin/node' }));
vi.mock('./window-state', () => ({
  loadWindowState: () => null,
  saveWindowState: vi.fn(),
}));
vi.mock('../ipc/system-handlers', () => ({ isHttpUrl: () => true }));
vi.mock('../services/browser/daemon', () => ({ setMainWindow: vi.fn() }));
vi.mock('../messaging/port-manager', () => ({
  getChannelManager: () => mocks.channelManager,
}));
vi.mock('./bootstrap', () => ({
  isDev: false,
  isPreviewMode: false,
  isTestMode: false,
}));

import { createWindow, getMainWindow } from '../window-manager';

describe('createWindow wires the webview guard (ISS-15)', () => {
  beforeEach(() => {
    for (const key of Object.keys(mocks.listeners)) delete mocks.listeners[key];
    mocks.ctorOptions = null;
  });

  it('enables webviewTag on the main window', async () => {
    // The precondition for the whole issue. If this ever flips to false the
    // guard becomes dead code and should be removed with it.
    await createWindow();
    const prefs = mocks.ctorOptions?.webPreferences as Record<string, unknown>;
    expect(prefs.webviewTag).toBe(true);
  });

  it('registers a will-attach-webview listener on the main window', async () => {
    await createWindow();
    expect(typeof mocks.listeners['will-attach-webview']).toBe('function');
  });

  it('neutralises a renderer that asks for node integration in the guest', async () => {
    await createWindow();
    const webPreferences: Record<string, unknown> = { nodeIntegration: true, preload: '/tmp/evil.js' };
    mocks.listeners['will-attach-webview']?.({}, webPreferences, { src: 'https://evil.example' });

    expect(webPreferences.nodeIntegration).toBe(false);
    expect(webPreferences.preload).toBeUndefined();
  });

  it('leaves the app window itself on context isolation and no node', async () => {
    await createWindow();
    const prefs = mocks.ctorOptions?.webPreferences as Record<string, unknown>;
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
  });

  it('exposes the created window through getMainWindow', async () => {
    await createWindow();
    expect(getMainWindow()).not.toBeNull();
  });
});
