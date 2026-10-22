/**
 * panel-window-handlers.test.ts — the `panel-window:*` IPC contract.
 *
 * Two things are pinned here:
 *
 *   - the payloads are validated before they reach the window layer, and a
 *     rejected payload produces an explicit error envelope rather than a
 *     silent success;
 *   - a detached window may only address the pane it hosts. A panel
 *     floating in its own window has no business re-docking another panel.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  captured: {
    handle: new Map<string, (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>>(),
  },
  manager: {
    openDetachedPanel: vi.fn(async (request: { paneId: string; pageId: string; title?: string }) => ({
      ok: true,
      paneId: request.paneId,
      windowId: 77,
    })),
    returnPanelToMain: vi.fn((_paneId: string, _reason: string) => true),
    setPanelAlwaysOnTop: vi.fn((paneId: string, alwaysOnTop: boolean) => ({
      ok: true,
      paneId,
      alwaysOnTop,
    })),
    getPanelWindowState: vi.fn((paneId: string) => ({
      ok: true,
      paneId,
      detached: true,
      alwaysOnTop: false,
    })),
    resolvePanelCaller: vi.fn((): { kind: 'main' } | { kind: 'detached'; paneId: string } | null => ({
      kind: 'main',
    })),
    isTopLevelSenderFrame: vi.fn(() => true),
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>) => {
      mocks.captured.handle.set(channel, fn);
    },
  },
}));

vi.mock('../../core/panel-window-manager', () => mocks.manager);

vi.mock('../../logging/logger', () => ({
  getLogger: () => mocks.logger,
  LogComponent: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));

import { registerPanelWindowHandlers } from '../panel-window-handlers';

async function invokeHandler(channel: string, payload: unknown): Promise<unknown> {
  const handler = mocks.captured.handle.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  const event = {
    sender: { id: 1, mainFrame: { routingId: 1 } },
    senderFrame: { routingId: 1 },
  };
  return await handler(event, payload);
}

describe('panel-window-handlers', () => {
  beforeEach(() => {
    mocks.captured.handle.clear();
    mocks.manager.openDetachedPanel.mockClear();
    mocks.manager.returnPanelToMain.mockClear();
    mocks.manager.setPanelAlwaysOnTop.mockClear();
    mocks.manager.getPanelWindowState.mockClear();
    mocks.manager.resolvePanelCaller.mockReset();
    mocks.manager.resolvePanelCaller.mockReturnValue({ kind: 'main' });
    mocks.manager.isTopLevelSenderFrame.mockReset();
    mocks.manager.isTopLevelSenderFrame.mockReturnValue(true);
    mocks.logger.warn.mockClear();
    mocks.logger.error.mockClear();
    registerPanelWindowHandlers();
  });

  describe('panel-window:open', () => {
    it('detaches the pane the main window asked for', async () => {
      const result = await invokeHandler('panel-window:open', {
        paneId: 'pane-1',
        pageId: 'terminal',
        title: '终端',
      });

      expect(mocks.manager.openDetachedPanel).toHaveBeenCalledWith({
        paneId: 'pane-1',
        pageId: 'terminal',
        title: '终端',
      });
      expect(result).toEqual({ ok: true, paneId: 'pane-1', windowId: 77 });
    });

    it('refuses a detached window: only the main window owns the layout', async () => {
      mocks.manager.resolvePanelCaller.mockReturnValue({ kind: 'detached', paneId: 'pane-1' });

      const result = await invokeHandler('panel-window:open', {
        paneId: 'pane-2',
        pageId: 'terminal',
      });

      expect(result).toEqual({ ok: false, error: 'only the main window may detach a panel' });
      expect(mocks.manager.openDetachedPanel).not.toHaveBeenCalled();
    });

    it('rejects a malformed payload without touching the window layer', async () => {
      const result = await invokeHandler('panel-window:open', { paneId: '', pageId: 'terminal' });

      expect(result).toMatchObject({ ok: false });
      expect(mocks.manager.openDetachedPanel).not.toHaveBeenCalled();
    });

    it('refuses an unknown sender', async () => {
      mocks.manager.resolvePanelCaller.mockReturnValue(null);

      const result = await invokeHandler('panel-window:open', {
        paneId: 'pane-1',
        pageId: 'terminal',
      });

      expect(result).toEqual({ ok: false, error: 'untrusted sender' });
      expect(mocks.manager.openDetachedPanel).not.toHaveBeenCalled();
    });

    it('refuses a sender that is not the top frame of its window', async () => {
      mocks.manager.isTopLevelSenderFrame.mockReturnValue(false);

      const result = await invokeHandler('panel-window:open', {
        paneId: 'pane-1',
        pageId: 'terminal',
      });

      expect(result).toEqual({ ok: false, error: 'untrusted sender' });
      expect(mocks.manager.openDetachedPanel).not.toHaveBeenCalled();
    });
  });

  describe('panel-window:close', () => {
    it('returns the pane to the main window', async () => {
      const result = await invokeHandler('panel-window:close', { paneId: 'pane-1' });

      expect(mocks.manager.returnPanelToMain).toHaveBeenCalledWith('pane-1', 'requested');
      expect(result).toEqual({ ok: true, paneId: 'pane-1' });
    });

    it('lets a detached window return its own panel', async () => {
      mocks.manager.resolvePanelCaller.mockReturnValue({ kind: 'detached', paneId: 'pane-1' });

      const result = await invokeHandler('panel-window:close', { paneId: 'pane-1' });

      expect(mocks.manager.returnPanelToMain).toHaveBeenCalledWith('pane-1', 'requested');
      expect(result).toEqual({ ok: true, paneId: 'pane-1' });
    });

    it('refuses a detached window that tries to return a different panel', async () => {
      mocks.manager.resolvePanelCaller.mockReturnValue({ kind: 'detached', paneId: 'pane-1' });

      const result = await invokeHandler('panel-window:close', { paneId: 'pane-2' });

      expect(result).toEqual({
        ok: false,
        error: 'a detached window may only return its own panel',
      });
      expect(mocks.manager.returnPanelToMain).not.toHaveBeenCalled();
    });
  });

  describe('panel-window:set-always-on-top', () => {
    it('pins the detached window', async () => {
      const result = await invokeHandler('panel-window:set-always-on-top', {
        paneId: 'pane-1',
        alwaysOnTop: true,
      });

      expect(mocks.manager.setPanelAlwaysOnTop).toHaveBeenCalledWith('pane-1', true);
      expect(result).toEqual({ ok: true, paneId: 'pane-1', alwaysOnTop: true });
    });

    it('refuses a detached window that tries to pin a different panel', async () => {
      mocks.manager.resolvePanelCaller.mockReturnValue({ kind: 'detached', paneId: 'pane-1' });

      const result = await invokeHandler('panel-window:set-always-on-top', {
        paneId: 'pane-2',
        alwaysOnTop: true,
      });

      expect(result).toEqual({
        ok: false,
        error: 'a detached window may only pin its own panel',
      });
      expect(mocks.manager.setPanelAlwaysOnTop).not.toHaveBeenCalled();
    });

    it('rejects a non-boolean flag', async () => {
      const result = await invokeHandler('panel-window:set-always-on-top', {
        paneId: 'pane-1',
        alwaysOnTop: 'yes',
      });

      expect(result).toMatchObject({ ok: false });
      expect(mocks.manager.setPanelAlwaysOnTop).not.toHaveBeenCalled();
    });
  });

  describe('panel-window:get-state', () => {
    it('reports whether the pane is detached', async () => {
      const result = await invokeHandler('panel-window:get-state', { paneId: 'pane-1' });

      expect(mocks.manager.getPanelWindowState).toHaveBeenCalledWith('pane-1');
      expect(result).toEqual({ ok: true, paneId: 'pane-1', detached: true, alwaysOnTop: false });
    });

    it('refuses a detached window that tries to read another panel', async () => {
      mocks.manager.resolvePanelCaller.mockReturnValue({ kind: 'detached', paneId: 'pane-1' });

      const result = await invokeHandler('panel-window:get-state', { paneId: 'pane-2' });

      expect(result).toEqual({
        ok: false,
        error: 'a detached window may only read its own panel state',
      });
      expect(mocks.manager.getPanelWindowState).not.toHaveBeenCalled();
    });
  });
});
