/**
 * panel-window-manager.test.ts — the detached-window lifecycle.
 *
 * The behaviours worth pinning are the ones a user can see:
 *
 *   - the native X of a detached window RETURNS the panel to the main
 *     window instead of destroying it;
 *   - detaching the same pane twice focuses the existing window instead of
 *     forking the panel into two windows;
 *   - the always-on-top flag reaches the native window AND the persisted
 *     preference, so it survives the window closing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    static nextWebContentsId = 500;

    options: Record<string, unknown>;
    webContents: { id: number; send: ReturnType<typeof vi.fn> };
    listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    destroyed = false;
    alwaysOnTop = false;
    focused = false;
    loadedUrl: string | null = null;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      this.webContents = { id: FakeBrowserWindow.nextWebContentsId++, send: vi.fn() };
      FakeBrowserWindow.instances.push(this);
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
      return this;
    }

    once(event: string, listener: (...args: unknown[]) => void): this {
      const wrapper = (...args: unknown[]): void => {
        this.off(event, wrapper);
        listener(...args);
      };
      return this.on(event, wrapper);
    }

    off(event: string, listener: (...args: unknown[]) => void): this {
      const list = (this.listeners.get(event) ?? []).filter((entry) => entry !== listener);
      this.listeners.set(event, list);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    setAlwaysOnTop(value: boolean): void {
      this.alwaysOnTop = value;
    }

    isAlwaysOnTop(): boolean {
      return this.alwaysOnTop;
    }

    show(): void {}

    focus(): void {
      this.focused = true;
    }

    restore(): void {}

    isMinimized(): boolean {
      return false;
    }

    async loadURL(url: string): Promise<void> {
      this.loadedUrl = url;
    }

    /** Models Electron: `close` asks the listeners first, and a prevented
     *  close leaves the window alive. */
    close(): void {
      const event = {
        defaultPrevented: false,
        preventDefault: (): void => {
          event.defaultPrevented = true;
        },
      };
      this.emit('close', event);
      if (event.defaultPrevented) return;
      this.destroyed = true;
      this.emit('closed');
    }

    destroy(): void {
      this.destroyed = true;
      this.emit('closed');
    }
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    mainWindow: {
      webContents: { id: 1, send: vi.fn() },
      isDestroyed: (): boolean => false,
    },
    state: {
      panes: {} as Record<string, { pageId: string; alwaysOnTop: boolean }>,
    },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: mocks.BrowserWindow,
  app: { on: vi.fn(), getPath: (): string => '/tmp/duya-test' },
}));

vi.mock('../window-manager', () => ({
  getIconPath: (): string => '/tmp/duya-test/icon.png',
  getMainWindow: () => mocks.mainWindow,
  getRendererUrl: vi.fn(async (): Promise<string> => 'http://localhost:3000'),
}));

vi.mock('../panel-window-state', () => ({
  emptyPanelWindowState: () => ({ panes: {} }),
  loadPanelWindowState: () => mocks.state,
  savePanelWindowState: (state: { panes: Record<string, { pageId: string; alwaysOnTop: boolean }> }) => {
    mocks.state = state;
  },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => mocks.logger,
  LogComponent: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));

import {
  buildDetachedPanelUrl,
  getPanelWindowState,
  isTopLevelSenderFrame,
  openDetachedPanel,
  resetPanelWindowManagerForTests,
  resolvePanelCaller,
  returnPanelToMain,
  setPanelAlwaysOnTop,
} from '../panel-window-manager';

/** The window close is deferred by one tick; let it happen. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function lastWindow(): InstanceType<typeof mocks.BrowserWindow> {
  const win = mocks.BrowserWindow.instances[mocks.BrowserWindow.instances.length - 1];
  if (!win) throw new Error('no window was created');
  return win;
}

function sentEvents(): unknown[] {
  return mocks.mainWindow.webContents.send.mock.calls.map((call) => call[1]);
}

describe('panel-window-manager', () => {
  beforeEach(() => {
    resetPanelWindowManagerForTests();
    mocks.BrowserWindow.instances.length = 0;
    mocks.mainWindow.webContents.send.mockClear();
    mocks.state = { panes: {} };
    mocks.logger.warn.mockClear();
    mocks.logger.error.mockClear();
  });

  describe('buildDetachedPanelUrl', () => {
    it('carries the pane id and the panel page as query parameters', () => {
      expect(buildDetachedPanelUrl('http://localhost:3000', 'pane-1', 'terminal')).toBe(
        'http://localhost:3000/?duyaPanel=pane-1&duyaPanelPage=terminal',
      );
    });

    it('keeps the path of a packaged file:// renderer', () => {
      const url = buildDetachedPanelUrl('file:///app/dist/index.html', 'pane-1', 'terminal');
      expect(url).toBe('file:///app/dist/index.html?duyaPanel=pane-1&duyaPanelPage=terminal');
    });
  });

  describe('openDetachedPanel', () => {
    it('creates a window that knows which pane it hosts', async () => {
      const result = await openDetachedPanel({ paneId: 'pane-1', pageId: 'terminal', title: '终端' });

      expect(result.ok).toBe(true);
      expect(result.windowId).toBeDefined();

      const win = lastWindow();
      expect(win.options.title).toBe('终端');
      const webPreferences = win.options.webPreferences as {
        additionalArguments: string[];
        contextIsolation: boolean;
        nodeIntegration: boolean;
      };
      expect(webPreferences.additionalArguments).toContain('--duya-panel-id=pane-1');
      expect(webPreferences.additionalArguments).toContain('--duya-panel-page=terminal');
      expect(webPreferences.contextIsolation).toBe(true);
      expect(webPreferences.nodeIntegration).toBe(false);
      expect(win.loadedUrl).toContain('duyaPanel=pane-1');
    });

    it('focuses the existing window instead of forking the pane into two', async () => {
      await openDetachedPanel({ paneId: 'pane-1', pageId: 'terminal' });
      const second = await openDetachedPanel({ paneId: 'pane-1', pageId: 'terminal' });

      expect(second.alreadyOpen).toBe(true);
      expect(mocks.BrowserWindow.instances).toHaveLength(1);
      expect(lastWindow().focused).toBe(true);
    });

    it('announces the new window to the main window', async () => {
      await openDetachedPanel({ paneId: 'pane-1', pageId: 'terminal' });
      expect(sentEvents()).toContainEqual({
        type: 'opened',
        paneId: 'pane-1',
        windowId: lastWindow().webContents.id,
      });
    });
  });

  describe('the native close button', () => {
    it('returns the panel to the main window instead of destroying it', async () => {
      await openDetachedPanel({ paneId: 'pane-1', pageId: 'terminal' });
      const win = lastWindow();

      // The native X is a plain `close` request.
      win.close();
      await nextTick();

      expect(sentEvents()).toContainEqual({
        type: 'returned',
        paneId: 'pane-1',
        reason: 'native-close',
      });
      expect(getPanelWindowState('pane-1').detached).toBe(false);
      expect(win.destroyed).toBe(true);
    });

    it('leaves the pane in the layout: the state query reports it as docked', async () => {
      await openDetachedPanel({ paneId: 'pane-1', pageId: 'terminal' });
      lastWindow().close();
      await nextTick();

      expect(getPanelWindowState('pane-1')).toEqual({
        ok: true,
        paneId: 'pane-1',
        detached: false,
        alwaysOnTop: false,
      });
    });
  });

  describe('returnPanelToMain', () => {
    it('closes the window and reports the request as the reason', async () => {
      await openDetachedPanel({ paneId: 'pane-1', pageId: 'terminal' });
      const win = lastWindow();

      expect(returnPanelToMain('pane-1', 'requested')).toBe(true);
      await nextTick();

      expect(sentEvents()).toContainEqual({
        type: 'returned',
        paneId: 'pane-1',
        reason: 'requested',
      });
      expect(win.destroyed).toBe(true);
    });

    it('reports false for a pane that is not detached', () => {
      expect(returnPanelToMain('pane-9', 'requested')).toBe(false);
    });
  });

  describe('always on top', () => {
    it('applies the flag to the native window and persists it', async () => {
      await openDetachedPanel({ paneId: 'pane-1', pageId: 'terminal' });
      const win = lastWindow();

      expect(setPanelAlwaysOnTop('pane-1', true)).toEqual({
        ok: true,
        paneId: 'pane-1',
        alwaysOnTop: true,
      });
      expect(win.alwaysOnTop).toBe(true);
      expect(mocks.state.panes['pane-1']).toEqual({ pageId: 'terminal', alwaysOnTop: true });
      expect(sentEvents()).toContainEqual({
        type: 'always-on-top-changed',
        paneId: 'pane-1',
        alwaysOnTop: true,
      });
    });

    it('refuses a pane that is not detached', () => {
      expect(setPanelAlwaysOnTop('pane-9', true)).toEqual({
        ok: false,
        paneId: 'pane-9',
        error: 'panel is not detached',
      });
    });

    it('restores the persisted flag when the pane is detached again', async () => {
      mocks.state = { panes: { 'pane-1': { pageId: 'terminal', alwaysOnTop: true } } };
      resetPanelWindowManagerForTests();

      await openDetachedPanel({ paneId: 'pane-1', pageId: 'terminal' });
      expect(lastWindow().alwaysOnTop).toBe(true);
    });
  });

  describe('resolvePanelCaller', () => {
    it('recognises the main window', () => {
      expect(resolvePanelCaller({ id: 1 })).toEqual({ kind: 'main' });
    });

    it('recognises a detached window and the pane it hosts', async () => {
      await openDetachedPanel({ paneId: 'pane-1', pageId: 'terminal' });
      const win = lastWindow();

      expect(resolvePanelCaller({ id: win.webContents.id })).toEqual({
        kind: 'detached',
        paneId: 'pane-1',
      });
    });

    it('refuses an unknown sender', () => {
      expect(resolvePanelCaller({ id: 9999 })).toBeNull();
      expect(resolvePanelCaller(null)).toBeNull();
    });
  });

  describe('isTopLevelSenderFrame', () => {
    it('accepts the top frame of the sender', () => {
      expect(
        isTopLevelSenderFrame({ mainFrame: { routingId: 1 }, senderFrame: { routingId: 1 } }),
      ).toBe(true);
    });

    it('refuses a subframe, e.g. a webview guest', () => {
      expect(
        isTopLevelSenderFrame({ mainFrame: { routingId: 1 }, senderFrame: { routingId: 7 } }),
      ).toBe(false);
    });

    it('refuses a sender whose frame is unknown', () => {
      expect(isTopLevelSenderFrame({ mainFrame: { routingId: 1 } })).toBe(false);
      expect(isTopLevelSenderFrame(null)).toBe(false);
    });
  });
});
