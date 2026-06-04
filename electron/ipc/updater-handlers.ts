/**
 * ipc/updater-handlers.ts - Updater-related IPC handlers
 */

import { ipcMain } from 'electron';
import { checkForUpdates, downloadUpdate, installUpdate, getUpdaterState } from '../services/updater';
import { initLogger, getLogger, LogComponent } from '../logging/logger';

const logger = initLogger({ level: 'WARN' });

export function registerUpdaterHandlers(): void {
  ipcMain.handle('updater:check', async () => {
    logger.debug('updater:check IPC invoked');
    return checkForUpdates();
  });

  ipcMain.handle('updater:download', async () => {
    logger.debug('updater:download IPC invoked');
    return downloadUpdate();
  });

  ipcMain.handle('updater:install', async () => {
    logger.info('updater:install IPC invoked', undefined, LogComponent.Main);
    await installUpdate();
    return { success: true };
  });

  ipcMain.handle('updater:get-state', async () => {
    return getUpdaterState();
  });

  ipcMain.on('update:install', () => {
    logger.info('update:install (send) invoked', undefined, LogComponent.Main);
    void installUpdate();
  });
}