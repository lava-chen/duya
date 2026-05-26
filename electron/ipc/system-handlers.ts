/**
 * ipc/system-handlers.ts - System-level IPC handlers
 *
 * Handlers that don't belong to any specific subsystem:
 * - Dialog
 * - Shell
 * - Notification
 * - App info
 * - Parser
 * - Workspace
 * - Recent folders
 */

import { ipcMain, BrowserWindow, dialog, shell, Notification, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { homedir } from 'os';
import { getLogger, LogComponent } from '../logging/logger';
import { getDocumentParser } from '../services/document-parser/index';
import { isDev } from '../core/bootstrap';
import { getMainWindow } from '../core/window-manager';
import { getAgentServerPort } from '../agents/agent-server-lifecycle';
import { getAgentProcessPool } from '../agents/process-pool/agent-process-pool';
import { getConfigManager } from '../config/manager';

export function registerSystemHandlers(): void {
  // Dialog handlers
  ipcMain.handle('dialog:open-folder', async (_event, options?: { defaultPath?: string; title?: string }) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return { canceled: true, filePaths: [] };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options?.title || 'Select a project folder',
      defaultPath: options?.defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return { canceled: result.canceled, filePaths: result.filePaths };
  });

  // Shell handlers
  ipcMain.handle('shell:open-path', async (_event, folderPath: string) => {
    if (typeof folderPath !== 'string' || folderPath.length === 0 || folderPath.length > 4096) {
      return 'Invalid path';
    }
    if (folderPath.includes('\0')) {
      return 'Invalid path';
    }
    return shell.openPath(folderPath);
  });

  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    if (typeof url !== 'string' || url.length === 0 || url.length > 4096) {
      return 'Invalid URL';
    }
    try {
      await shell.openExternal(url);
      return '';
    } catch (err) {
      return String(err);
    }
  });

  // Browser extension path
  ipcMain.handle('browser-extension:get-path', () => {
    if (isDev) {
      return path.join(app.getAppPath(), 'extension');
    }
    return path.join(process.resourcesPath, 'extension');
  });

  // Notification handler
  ipcMain.handle('notification:show', async (_event, options: { title: string; body: string; sessionId?: string }) => {
    if (!options || typeof options.title !== 'string' || options.title.length === 0 || options.title.length > 500) {
      return false;
    }
    try {
      const notification = new Notification({
        title: options.title,
        body: typeof options.body === 'string' ? options.body.slice(0, 2000) : '',
      });

      // Handle click to navigate to session
      if (options.sessionId) {
        notification.onclick = () => {
          const mainWindow = getMainWindow();
          if (mainWindow && !mainWindow.isDestroyed()) {
            // Show and focus the window
            if (!mainWindow.isVisible()) {
              mainWindow.show();
            }
            if (mainWindow.isMinimized()) {
              mainWindow.restore();
            }
            mainWindow.focus();
            // Send session ID to renderer for navigation
            mainWindow.webContents.send('notification:clicked', { sessionId: options.sessionId });
          }
        };
      }

      notification.show();
      return true;
    } catch (err) {
      const logger = getLogger();
      logger.error('Failed to show notification', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Notification);
      return false;
    }
  });

  // App info handlers
  ipcMain.handle('app:get-version', () => app.getVersion());

  ipcMain.handle('app:quit', () => {
    const { setIsQuitting } = require('../core/window-manager');
    setIsQuitting(true);
    app.quit();
  });

  ipcMain.handle('app:get-default-workspace', () => {
    const defaultWorkspace = path.join(homedir(), '.duya');
    if (!fs.existsSync(defaultWorkspace)) {
      fs.mkdirSync(defaultWorkspace, { recursive: true });
    }
    return defaultWorkspace;
  });

  // Parser handlers
  ipcMain.handle('parser:parse', async (_event, filePath: string, options?: { timeout?: number }) => {
    const docParser = getDocumentParser();
    if (!docParser) {
      throw new Error('Document parser not initialized');
    }
    return docParser.parse(filePath, 'default');
  });

  ipcMain.handle('parser:getCapabilities', async () => {
    const docParser = getDocumentParser();
    if (!docParser) return null;
    return docParser.getCapabilities();
  });

  ipcMain.handle('parser:isReady', async () => {
    const docParser = getDocumentParser();
    if (!docParser) return false;
    return docParser.isReady();
  });

  // Recent folders management
  const getRecentFoldersPath = () => path.join(app.getPath('userData'), 'recent-folders.json');

  const getRecentFolders = (): string[] => {
    try {
      const filePath = getRecentFoldersPath();
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      }
    } catch {}
    return [];
  };

  const saveRecentFolders = (folders: string[]): void => {
    try {
      const filePath = getRecentFoldersPath();
      fs.writeFileSync(filePath, JSON.stringify(folders.slice(0, 10)));
    } catch {}
  };

  ipcMain.handle('projects:get-recent-folders', async () => getRecentFolders());

  ipcMain.handle('projects:add-recent-folder', async (_event, folderPath: string) => {
    if (typeof folderPath !== 'string' || folderPath.length === 0 || folderPath.length > 4096) {
      return getRecentFolders();
    }
    if (folderPath.includes('\0')) {
      return getRecentFolders();
    }
    const recent = getRecentFolders();
    const updated = [folderPath, ...recent.filter(f => f !== folderPath)].slice(0, 10);
    saveRecentFolders(updated);
    return updated;
  });

  // Sync threads changed event
  ipcMain.on('sync:threads-changed', (_event) => {
    const senderWindow = BrowserWindow.fromWebContents(_event.sender);
    const allWindows = BrowserWindow.getAllWindows();
    for (const window of allWindows) {
      if (window !== senderWindow && !window.isDestroyed()) {
        window.webContents.send('sync:threads-changed');
      }
    }
  });

  // Agent Server port query
  ipcMain.handle('agent-server:get-port', () => getAgentServerPort());

  // Vision settings handlers
  ipcMain.handle('vision:get', async () => {
    const configManager = getConfigManager();
    const settings = configManager.getVisionSettings();
    return {
      provider: settings.provider,
      model: settings.model,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      enabled: settings.enabled,
    };
  });

  ipcMain.handle('vision:set', async (_event, data: { provider?: string; model?: string; baseUrl?: string; apiKey?: string; enabled?: boolean }) => {
    const configManager = getConfigManager();
    const currentSettings = configManager.getVisionSettings();
    const newSettings = {
      ...currentSettings,
      provider: data.provider ?? currentSettings.provider,
      model: data.model ?? currentSettings.model,
      baseUrl: data.baseUrl ?? currentSettings.baseUrl,
      apiKey: data.apiKey ?? currentSettings.apiKey,
      enabled: data.enabled ?? currentSettings.enabled,
    };
    configManager.setConfig('visionSettings', newSettings);
  });

  // Session management handlers
  ipcMain.handle('session:getInterruptedSessions', () => {
    const agentPool = getAgentProcessPool();
    return agentPool.getInterruptedSessions();
  });
}