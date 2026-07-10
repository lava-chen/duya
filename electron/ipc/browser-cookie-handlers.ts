/**
 * IPC handlers for cookie import and browser data management.
 */

import { ipcMain } from 'electron';
import { readBrowserCookies } from '../services/browser/cookie-importer.js';
import { writeCookiesToPartition, clearPartitionData } from '../services/browser/cookie-writer.js';
import { getLogger, LogComponent } from '../logging/logger.js';

const logger = getLogger();

export function registerBrowserCookieHandlers(): void {
  ipcMain.handle('browser:import-cookies', async (_event, browser: 'chrome' | 'edge') => {
    try {
      const { cookies, failed } = await readBrowserCookies(browser);
      const written = await writeCookiesToPartition(cookies);
      logger.info(
        `Cookie import complete: ${written} written, ${failed} failed`,
        {},
        LogComponent.BrowserDaemon,
      );
      return { ok: true, count: written, failed };
    } catch (err) {
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
