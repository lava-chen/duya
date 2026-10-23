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
    mocks.writeCookiesToPartition.mockReset();
    registerBrowserCookieHandlers();
  });

  it('returns a structured busy result without exposing the source path', async () => {
    mocks.readBrowserCookies.mockRejectedValueOnce(new mocks.CookieDatabaseBusyError());
    const handler = mocks.handlers.get('browser:import-cookies');

    await expect(handler?.({}, 'chrome', 'Default')).resolves.toEqual({
      ok: false,
      errorCode: 'COOKIE_DATABASE_BUSY',
    });
  });

  it('reports app-bound cookies as unsupported without silently importing a partial set', async () => {
    mocks.readBrowserCookies.mockResolvedValueOnce({
      cookies: [{ name: 'plain', value: 'plain-value' }],
      failed: 0,
      unsupported: 3,
    });
    const handler = mocks.handlers.get('browser:import-cookies');

    await expect(handler?.({}, 'chrome', 'Default')).resolves.toEqual({
      ok: false,
      count: 0,
      failed: 0,
      unsupported: 3,
      errorCode: 'APP_BOUND_COOKIE_UNSUPPORTED',
    });
    expect(mocks.writeCookiesToPartition).not.toHaveBeenCalled();
  });
});
