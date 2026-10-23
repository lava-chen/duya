/**
 * IPC handlers for cookie import and browser data management.
 */

import { ipcMain } from 'electron';
import {
  CookieDatabaseBusyError,
  readBrowserCookies,
} from '../services/browser/cookie-importer.js';
import { detectCookieProfiles } from '../services/browser/profile-detector.js';
import { writeCookiesToPartition, clearPartitionData } from '../services/browser/cookie-writer.js';
import { getLogger, LogComponent } from '../logging/logger.js';

const logger = getLogger();

export function registerBrowserCookieHandlers(): void {
  ipcMain.handle('browser:detect-cookie-profiles', (_event, browser: 'chrome' | 'edge') => {
    if (browser !== 'chrome' && browser !== 'edge') {
      return { ok: false, error: 'Unsupported browser' };
    }
    try {
      return { ok: true, profiles: detectCookieProfiles(browser) };
    } catch (err) {
      logger.error(
        `Cookie profile detection failed: ${err instanceof Error ? err.message : err}`,
        {},
        LogComponent.BrowserDaemon,
      );
      return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  });

  ipcMain.handle('browser:import-cookies', async (_event, browser: 'chrome' | 'edge', profile?: string) => {
    try {
      const { cookies, failed, unsupported } = await readBrowserCookies(browser, profile);

      if (unsupported > 0) {
        return { ok: false, count: 0, failed, unsupported, errorCode: 'APP_BOUND_COOKIE_UNSUPPORTED' as const };
      }

      const written = await writeCookiesToPartition(cookies);
      logger.info(
        `Cookie import complete: ${written} written, ${failed} failed, ${unsupported} unsupported`,
        {},
        LogComponent.BrowserDaemon,
      );
      return { ok: true, count: written, failed, unsupported };
    } catch (err) {
      if (err instanceof CookieDatabaseBusyError) {
        return { ok: false, errorCode: err.code };
      }
      logger.error(
        `Cookie import failed: ${err instanceof Error ? err.message : err}`,
        {},
        LogComponent.BrowserDaemon,
      );
      return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  });

  ipcMain.handle('browser:clear-browser-data', async () => {
    try {
      await clearPartitionData();
      logger.info('Browser partition data cleared', {}, LogComponent.BrowserDaemon);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  });
}
