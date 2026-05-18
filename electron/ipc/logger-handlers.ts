/**
 * ipc/logger-handlers.ts - Logger-related IPC handlers
 */

import { ipcMain } from 'electron';
import { getLogger, LogComponent } from '../logging/logger';

export function registerLoggerHandlers(): void {
  const logger = getLogger();

  ipcMain.handle('logger:export', async () => {
    try {
      const logs = logger.exportLogs();
      return { success: true, logs };
    } catch (error) {
      logger.error('Failed to export logs', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('logger:export-to-file', async (_event, targetPath: string) => {
    try {
      if (!targetPath || typeof targetPath !== 'string') {
        return { success: false, error: 'Invalid target path' };
      }
      const success = logger.exportLogsToFile(targetPath);
      return { success };
    } catch (error) {
      logger.error('Failed to export logs to file', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('logger:get-path', async () => ({
    logPath: logger.getLogPath(),
    logDir: logger.getLogDir(),
    size: logger.getLogSize(),
    sizeFormatted: logger.getLogSizeFormatted(),
  }));

  ipcMain.handle('logger:clear', async () => {
    try {
      const success = logger.clearLogs();
      return { success };
    } catch (error) {
      logger.error('Failed to clear logs', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
      return { success: false, error: String(error) };
    }
  });
}