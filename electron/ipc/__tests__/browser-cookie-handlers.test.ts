import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class CookieDatabaseBusyError extends Error {
    readonly code = 'COOKIE_DATABASE_BUSY';

    constructor() {
      super('The browser cookie database is currently in use.');
    }
  }

  return {
    CookieDatabaseBusyError,
    readBrowserCookies: vi.fn(),
    mapLiveBrowserCookies: vi.fn(),
    exportLiveExtensionCookies: vi.fn(),
    writeCookiesToPartition: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>>(),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>) => {
      mocks.handlers.set(channel, handler);
    },
  },
}));

vi.mock('../../services/browser/cookie-importer', () => ({
  CookieDatabaseBusyError: mocks.CookieDatabaseBusyError,
  readBrowserCookies: mocks.readBrowserCookies,
  mapLiveBrowserCookies: mocks.mapLiveBrowserCookies,
}));

vi.mock('../../services/browser/daemon', () => ({
  exportLiveExtensionCookies: mocks.exportLiveExtensionCookies,
}));

vi.mock('../../services/browser/cookie-writer', () => ({
  writeCookiesToPartition: mocks.writeCookiesToPartition,
  clearPartitionData: vi.fn(),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => mocks.logger,
  LogComponent: new Proxy({}, { get: (_target, property) => String(property) }),
}));

import { registerBrowserCookieHandlers } from '../browser-cookie-handlers';

describe('browser cookie IPC handlers', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.readBrowserCookies.mockReset();
    mocks.mapLiveBrowserCookies.mockReset();
    mocks.exportLiveExtensionCookies.mockReset();
    mocks.writeCookiesToPartition.mockReset();
    mocks.logger.warn.mockReset();
    registerBrowserCookieHandlers();
  });

  it('returns a structured busy result without exposing the source path', async () => {
    mocks.readBrowserCookies.mockRejectedValueOnce(new mocks.CookieDatabaseBusyError());
    const handler = mocks.handlers.get('browser:import-cookies');

    await expect(handler?.({}, 'chrome', 'Default')).resolves.toEqual({
      ok: false,
      errorCode: 'COOKIE_DATABASE_BUSY',
    });
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
  });

  it('imports from the verified extension when the browser database is locked', async () => {
    mocks.readBrowserCookies.mockRejectedValueOnce(new mocks.CookieDatabaseBusyError());
    mocks.exportLiveExtensionCookies.mockResolvedValueOnce({ browser: 'chrome', cookies: [{ name: 'sid' }] });
    mocks.mapLiveBrowserCookies.mockReturnValueOnce([{ name: 'sid', value: 'value' }]);
    mocks.writeCookiesToPartition.mockResolvedValueOnce(1);
    const handler = mocks.handlers.get('browser:import-cookies');

    await expect(handler?.({}, 'chrome', 'Default')).resolves.toEqual({
      ok: true,
      count: 1,
      failed: 0,
      unsupported: 0,
      source: 'extension',
    });
  });

  it('uses the extension for app-bound cookies when the extension is connected', async () => {
    mocks.readBrowserCookies.mockResolvedValueOnce({
      cookies: [{ name: 'plain', value: 'plain-value' }],
      failed: 0,
      unsupported: 3,
    });
    mocks.exportLiveExtensionCookies.mockResolvedValueOnce({ browser: 'chrome', cookies: [{ name: 'sid' }] });
    mocks.mapLiveBrowserCookies.mockReturnValueOnce([{ name: 'sid', value: 'value' }]);
    mocks.writeCookiesToPartition.mockResolvedValueOnce(1);
    const handler = mocks.handlers.get('browser:import-cookies');

    await expect(handler?.({}, 'chrome', 'Default')).resolves.toEqual({
      ok: true,
      count: 1,
      failed: 0,
      unsupported: 0,
      source: 'extension',
    });
    expect(mocks.writeCookiesToPartition).toHaveBeenCalledWith([{ name: 'sid', value: 'value' }]);
  });

  it('falls back to decryptable cookies when app-bound cookies exist but the extension is unavailable', async () => {
    mocks.readBrowserCookies.mockResolvedValueOnce({
      cookies: [{ name: 'plain', value: 'plain-value' }],
      failed: 0,
      unsupported: 3,
    });
    mocks.exportLiveExtensionCookies.mockRejectedValueOnce(new Error('Browser extension is not connected'));
    mocks.writeCookiesToPartition.mockResolvedValueOnce(1);
    const handler = mocks.handlers.get('browser:import-cookies');

    await expect(handler?.({}, 'chrome', 'Default')).resolves.toEqual({
      ok: true,
      count: 1,
      failed: 0,
      unsupported: 3,
      errorCode: 'APP_BOUND_EXTENSION_UNAVAILABLE',
    });
    expect(mocks.writeCookiesToPartition).toHaveBeenCalledWith([{ name: 'plain', value: 'plain-value' }]);
  });

  it('falls back to decryptable cookies when the connected extension belongs to a different browser', async () => {
    mocks.readBrowserCookies.mockResolvedValueOnce({
      cookies: [{ name: 'plain', value: 'plain-value' }],
      failed: 0,
      unsupported: 2,
    });
    mocks.exportLiveExtensionCookies.mockResolvedValueOnce({ browser: 'edge', cookies: [{ name: 'sid' }] });
    mocks.writeCookiesToPartition.mockResolvedValueOnce(1);
    const handler = mocks.handlers.get('browser:import-cookies');

    await expect(handler?.({}, 'chrome', 'Default')).resolves.toEqual({
      ok: true,
      count: 1,
      failed: 0,
      unsupported: 2,
      errorCode: 'APP_BOUND_EXTENSION_UNAVAILABLE',
    });
  });
});
