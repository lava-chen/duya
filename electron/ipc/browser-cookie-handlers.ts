/**
 * IPC handlers for cookie import and browser data management.
 */

import { ipcMain } from 'electron';
import {
  CookieDatabaseBusyError,
  mapLiveBrowserCookies,
  readBrowserCookies,
} from '../services/browser/cookie-importer.js';
import { writeCookiesToPartition, clearPartitionData } from '../services/browser/cookie-writer.js';
import { exportLiveExtensionCookies } from '../services/browser/daemon.js';
import { getLogger, LogComponent } from '../logging/logger.js';

const logger = getLogger();

export function registerBrowserCookieHandlers(): void {
  ipcMain.handle('browser:import-cookies', async (_event, browser: 'chrome' | 'edge', profile?: string) => {
    try {
      const { cookies, failed, unsupported } = await readBrowserCookies(browser, profile);

      // App-bound (v20) cookies cannot be decrypted from the SQLite file directly.
      // When any are present, prefer a live export from the connected browser
      // extension, which returns already-decrypted values without closing Chrome.
      if (unsupported > 0) {
        try {
          const liveExport = await exportLiveExtensionCookies();
          if (liveExport.browser !== browser) {
            throw new Error(`Connected extension belongs to ${liveExport.browser}, not ${browser}`);
          }
          const liveCookies = mapLiveBrowserCookies(liveExport.cookies);
          const written = await writeCookiesToPartition(liveCookies);
          logger.info(
            `Cookie import completed through the connected ${browser} extension: ${written} written`,
            {},
            LogComponent.BrowserDaemon,
          );
          return { ok: true, count: written, failed: 0, unsupported: 0, source: 'extension' as const };
        } catch (liveImportError) {
          logger.warn(
            `App-bound cookie import deferred because live export is unavailable: ${liveImportError instanceof Error ? liveImportError.message : liveImportError}`,
            {},
            LogComponent.BrowserDaemon,
          );
          const written = await writeCookiesToPartition(cookies);
          return {
            ok: true,
            count: written,
            failed,
            unsupported,
            errorCode: 'APP_BOUND_EXTENSION_UNAVAILABLE' as const,
          };
        }
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
        try {
          const liveExport = await exportLiveExtensionCookies();
          if (liveExport.browser !== browser) {
            throw new Error(`Connected extension belongs to ${liveExport.browser}, not ${browser}`);
          }
          const cookies = mapLiveBrowserCookies(liveExport.cookies);
          const written = await writeCookiesToPartition(cookies);
          logger.info(
            `Cookie import completed through the connected ${browser} extension: ${written} written`,
            {},
            LogComponent.BrowserDaemon,
          );
          return { ok: true, count: written, failed: 0, unsupported: 0, source: 'extension' as const };
        } catch (liveImportError) {
          logger.warn(
            `Cookie import deferred because the source browser database is busy and live export is unavailable: ${liveImportError instanceof Error ? liveImportError.message : liveImportError}`,
            {},
            LogComponent.BrowserDaemon,
          );
        }
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
