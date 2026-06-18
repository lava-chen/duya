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
import { isHttpUrl } from './url-safety';
export { isHttpUrl } from './url-safety';

export function registerSystemHandlers(): void {
  // Public predicate — kept exported for unit tests.
  // Duya's open-external policy is intentionally strict: only standard
  // http(s) URLs are forwarded to the OS. file://, javascript:, smb://, and
  // custom schemes are blocked to prevent external content from coercing the
  // OS into launching unintended handlers or exposing local files.
  // (See audit BLOCKER A: external URL safety, 2026-06-03.)
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
    const allowed = isHttpUrl(url);
    if (!allowed) {
      getLogger().warn(
        'Rejected shell:open-external request for non-http(s) URL',
        { urlPreview: url.slice(0, 80) },
        LogComponent.Main,
      );
      return 'Blocked: only http(s) URLs are allowed';
    }
    try {
      await shell.openExternal(url);
      return '';
    } catch (err) {
      return String(err);
    }
  });

  // Public export for tests
  ;(registerSystemHandlers as unknown as { __isHttpUrl?: typeof isHttpUrl }).__isHttpUrl = isHttpUrl;

  // Browser extension path
  ipcMain.handle('browser-extension:get-path', () => {
    if (isDev) {
      return path.join(app.getAppPath(), 'extension');
    }
    return path.join(process.resourcesPath, 'extension');
  });

  // Notification handler
  //
  // payload: { title, body, sessionId?, type?, actions?, replyPlaceholder?,
  //            permissionId?, toolName? }
  // - type 'message' (default): generic notification (e.g. message completed).
  // - type 'permission': permission request — renderer forwards the user's
  //   allow/deny decision via notification:action.
  // - actions: at most 2 entries (Electron / OS limits). Each triggers a
  //   'action' event that is forwarded to the renderer as
  //   'notification:action'. On macOS, the special reply action id
  //   '__reply' surfaces the user's text via payload.reply when the
  //   'reply' event fires.
  ipcMain.handle(
    'notification:show',
    async (
      _event,
      options: {
        title: string;
        body: string;
        sessionId?: string;
        type?: 'message' | 'permission';
        actions?: { id: string; label: string }[];
        replyPlaceholder?: string;
        permissionId?: string;
        toolName?: string;
      },
    ) => {
      if (!options || typeof options.title !== 'string' || options.title.length === 0 || options.title.length > 500) {
        return false;
      }
      try {
        const actionList = Array.isArray(options.actions)
          ? options.actions
              .filter(
                (a): a is { id: string; label: string } =>
                  !!a &&
                  typeof a.id === 'string' &&
                  a.id.length > 0 &&
                  a.id.length <= 64 &&
                  typeof a.label === 'string' &&
                  a.label.length > 0 &&
                  a.label.length <= 64,
              )
              .slice(0, 2)
          : undefined;

        // Build the Electron Notification. hasReply enables the inline
        // reply text field on macOS — the text is delivered via the
        // 'reply' event rather than 'action'.
        const notification = new Notification({
          title: options.title,
          body: typeof options.body === 'string' ? options.body.slice(0, 2000) : '',
          ...(actionList && actionList.length > 0 ? { actions: actionList } : {}),
          ...(options.replyPlaceholder
            ? { hasReply: true, replyPlaceholder: options.replyPlaceholder.slice(0, 200) }
            : {}),
        });

        const broadcastAction = (action: {
          actionId: string;
          reply?: string;
        }) => {
          const mainWindow = getMainWindow();
          if (!mainWindow || mainWindow.isDestroyed()) return;
          mainWindow.webContents.send('notification:action', {
            sessionId: options.sessionId,
            type: options.type ?? 'message',
            permissionId: options.permissionId,
            toolName: options.toolName,
            ...action,
          });
        };

        notification.on('action', (_event, index) => {
          const action = actionList?.[index];
          if (action) {
            broadcastAction({ actionId: action.id });
            notification.close();
          }
        });

        notification.on('reply', (_event, reply) => {
          // macOS only. Treat the typed reply as the synthetic '__reply' action.
          broadcastAction({ actionId: '__reply', reply: String(reply ?? '').slice(0, 4000) });
          notification.close();
        });

        // Handle click to navigate to session (existing behavior).
        notification.on('click', () => {
          const mainWindow = getMainWindow();
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (!mainWindow.isVisible()) {
              mainWindow.show();
            }
            if (mainWindow.isMinimized()) {
              mainWindow.restore();
            }
            mainWindow.focus();
            mainWindow.webContents.send('notification:clicked', { sessionId: options.sessionId });
          }
        });

        notification.show();
        return true;
      } catch (err) {
        const logger = getLogger();
        logger.error('Failed to show notification', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Notification);
        return false;
      }
    },
  );

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

  ipcMain.handle('app:create-project-folder', async (_event, projectName: string) => {
    if (typeof projectName !== 'string' || projectName.length === 0 || projectName.length > 255) {
      return { success: false, error: 'Invalid project name', path: '' };
    }
    // Sanitize project name for filesystem
    const sanitized = projectName.replace(/[<>:"|?*\x00-\x1f]/g, '_').trim();
    if (sanitized.length === 0) {
      return { success: false, error: 'Invalid project name', path: '' };
    }
    try {
      const workspaceDir = path.join(homedir(), '.duya', 'workspace');
      if (!fs.existsSync(workspaceDir)) {
        fs.mkdirSync(workspaceDir, { recursive: true });
      }
      const projectDir = path.join(workspaceDir, sanitized);
      if (fs.existsSync(projectDir)) {
        return { success: false, error: 'Project folder already exists', path: projectDir };
      }
      fs.mkdirSync(projectDir, { recursive: true });
      return { success: true, error: '', path: projectDir };
    } catch (err) {
      const logger = getLogger();
      logger.error('Failed to create project folder', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.System);
      return { success: false, error: String(err), path: '' };
    }
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

  // System location — authoritative locale/timezone from the host machine.
  // Used by the agent subprocess to build a locale-aware system prompt.
  ipcMain.handle('system:get-location', () => {
    return {
      locale: app.getLocale(),
      localeCountryCode: app.getLocaleCountryCode(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  });
}