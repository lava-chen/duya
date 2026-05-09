import { app, BrowserWindow, ipcMain, shell, dialog, Notification, MessageChannelMain, Tray, Menu, nativeImage } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import * as http from 'http'
import { randomUUID } from 'crypto'
import { homedir, platform as getPlatform } from 'os'

import { initDatabaseFromBoot, registerDbHandlers, registerConductorHandlers, isSafeMode, getSafeModeReason, getDatabasePath, initDatabase, getDatabase } from './db-handlers'
import { registerAgentHandlers } from './ipc/agent-communicator'
import { registerNetHandlers } from './net-handlers'
import { startGatewayProcess, stopGatewayProcess, registerGatewayIpcHandlers, forwardToGateway, isGatewaySession, sendRequest, waitForGatewayReady } from './ipc/gateway-communicator'
import { initConfigManager, getConfigManager, toLLMProvider } from './config-manager'
import { initChannelManager, getChannelManager } from './message-port-manager'
import { initPerformanceMonitor } from './performance-monitor'
import { initSessionManager, getSessionManager } from './session-manager'
import { initAgentProcessPool, getAgentProcessPool, AgentProcessPool } from './agent-process-pool'
import { resolveDatabasePath, updateDatabasePath } from './boot-config'
import { startBrowserDaemon, stopBrowserDaemon, getBrowserExtensionStatus } from './browser-daemon'
import { getAutomationScheduler, initAutomationScheduler } from './automation/Scheduler'
import { initLogger, getLogger, LogComponent } from './logger'
import { initUpdater, checkForUpdates, downloadUpdate, installUpdate, getUpdaterState, cleanupUpdater } from './updater'
import { scanSkillFile, shouldAllowInstall, type SkillFinding, type SkillScanResult } from '../packages/agent/src/security/skillScanner.js'

const isDev = !app.isPackaged
const DEBUG_IPC = process.env.DUYA_DEBUG_IPC === 'true'

// =============================================================================
// Development Mode: Use isolated userData directory
// This prevents conflicts between dev and production instances
// =============================================================================
if (isDev) {
  const originalUserData = app.getPath('userData')
  const devUserData = path.join(originalUserData, 'duya-dev')
  app.setPath('userData', devUserData)
}

// Initialize logger first
const logger = initLogger()

function debugLog(...args: unknown[]): void {
  if (DEBUG_IPC) {
    logger.debug(args.join(' '), { source: 'Main' })
  }
}

// =============================================================================
// Step 0: Single Instance Lock (prevent multi-instance file contention)
// =============================================================================

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  })
}

// =============================================================================
// Settings helpers (auto-start, etc.)
// =============================================================================

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

interface SettingsData {
  auto_start?: boolean;
  [key: string]: unknown;
}

function getSettings(): SettingsData {
  try {
    const settingsPath = getSettingsPath();
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
  } catch (error) {
    logger.error('Failed to read settings', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Settings);
  }
  return {};
}

function saveSettings(settings: SettingsData): void {
  try {
    const settingsPath = getSettingsPath();
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (error) {
    logger.error('Failed to save settings', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Settings);
  }
}

function getAutoStartFromSettings(): boolean {
  return getSettings().auto_start === true;
}

function setAutoStartToSettings(enabled: boolean): void {
  const settings = getSettings();
  settings.auto_start = enabled;
  saveSettings(settings);
}

/**
 * Check if the app was launched as a hidden login item (system login auto-start).
 * On Windows: checks for --hidden in process.argv
 * On macOS: uses app.getLoginItemSettings().wasOpenedAsHidden
 */
function wasLaunchedAsHidden(): boolean {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') {
    return process.argv.includes('--hidden');
  }
  if (process.platform === 'darwin') {
    return app.getLoginItemSettings().wasOpenedAsHidden;
  }
  return false;
}

/**
 * Set the app to start on system login.
 * - Windows: uses args: ['--hidden'] to support hidden startup
 * - macOS: uses openAsHidden (supported on macOS < 13, for macOS 13+ uses SMLoginItemSetEnabled via Electron)
 * - Linux: not supported by Electron, returns false
 */
function setAutoStart(enabled: boolean): boolean {
  if (!app.isPackaged) return false;

  try {
    if (process.platform === 'win32') {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: false,
        args: enabled ? ['--hidden'] : [],
      });
      return true;
    }

    if (process.platform === 'darwin') {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: enabled,
      });
      return true;
    }

    // Linux is not supported by Electron's setLoginItemSettings
    return false;
  } catch (error) {
    logger.error('Failed to set auto-start', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Settings);
    return false;
  }
}

// =============================================================================
// Window management
// =============================================================================

let mainWindow: BrowserWindow | null = null
let safeModeWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

function getIconPath(): string {
  const getAssetPath = (...paths: string[]) => path.join(__dirname, '..', 'assets', ...paths);
  if (process.platform === 'win32') {
    return isDev ? getAssetPath('windows', 'icon.ico') : path.join(process.resourcesPath, 'assets', 'windows', 'icon.ico');
  }
  if (process.platform === 'darwin') {
    return isDev ? getAssetPath('macos', 'icon.icns') : path.join(process.resourcesPath, 'assets', 'macos', 'icon.icns');
  }
  return isDev ? getAssetPath('linux', 'icons', '512x512.png') : path.join(process.resourcesPath, 'assets', 'linux', 'icons', '512x512.png');
}

function getTrayIconPath(): string {
  const getAssetPath = (...paths: string[]) => path.join(__dirname, '..', 'assets', ...paths);
  if (process.platform === 'win32') {
    return isDev ? getAssetPath('windows', '16x16.png') : path.join(process.resourcesPath, 'assets', 'windows', '16x16.png');
  }
  if (process.platform === 'darwin') {
    return isDev ? getAssetPath('macos', '16x16.png') : path.join(process.resourcesPath, 'assets', 'macos', '16x16.png');
  }
  return isDev ? getAssetPath('linux', 'icons', '16x16.png') : path.join(process.resourcesPath, 'assets', 'linux', 'icons', '16x16.png');
}

function createTray(): void {
  const iconPath = getTrayIconPath();
  let trayIcon: Electron.NativeImage;

  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (process.platform === 'darwin') {
      trayIcon = trayIcon.resize({ width: 16, height: 16 });
    }
  } else {
    const appIconPath = getIconPath();
    if (fs.existsSync(appIconPath)) {
      trayIcon = nativeImage.createFromPath(appIconPath);
      if (process.platform === 'darwin') {
        trayIcon = trayIcon.resize({ width: 16, height: 16 });
      } else if (process.platform === 'win32') {
        trayIcon = trayIcon.resize({ width: 16, height: 16 });
      }
    } else {
      trayIcon = nativeImage.createEmpty();
    }
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('DUYA');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show DUYA',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit DUYA',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  tray.on('click', () => {
    if (process.platform !== 'darwin') {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.focus();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    }
  });
}

function getNodeExecutable(): string {
  const possiblePaths = [
    path.join(process.env.APPDATA || '', '..', 'Local', 'nvm', 'v22.17.1', 'node.exe'),
    path.join(process.env.APPDATA || '', 'nvm4w', 'v22.17.1', 'node.exe'),
    path.join('C:\\Program Files\\nodejs\\node.exe'),
    path.join('C:\\Program Files (x86)\\nodejs\\node.exe'),
  ];

  const pathEnv = process.env.PATH || '';
  const pathDirs = pathEnv.split(path.delimiter);
  for (const dir of pathDirs) {
    const nodePath = path.join(dir, 'node.exe');
    if (fs.existsSync(nodePath)) {
      return nodePath;
    }
  }

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return 'node';
}

async function detectDevServerPort(): Promise<number | null> {
  const portsToCheck = [3000, 3001, 3002, 3003, 3004, 3005];

  const checkPort = (port: number): Promise<boolean> => {
    return new Promise((resolve) => {
      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/',
        method: 'HEAD',
        timeout: 3000,
      }, (res) => {
        resolve(res.statusCode !== undefined);
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.end();
    });
  };

  for (const port of portsToCheck) {
    const isReady = await checkPort(port);
    if (isReady) {
      logger.info(`Detected Vite dev server on port ${port}`, undefined, LogComponent.Main);
      return port;
    }
  }

  return null;
}

async function getRendererUrl(): Promise<string> {
  if (isDev) {
    const detectedPort = await detectDevServerPort();
    if (detectedPort) {
      return `http://localhost:${detectedPort}`;
    }
    logger.warn('Could not detect Vite dev server port, falling back to 3000', undefined, LogComponent.Main);
    return 'http://localhost:3000';
  }

  const distPath = path.join(process.resourcesPath, 'app.asar', 'dist');
  const indexPath = path.join(distPath, 'index.html');
  return `file://${indexPath}`;
}

// =============================================================================
// Safe Mode Window (Defense 2: prevent crash when DB path is invalid)
// =============================================================================

async function createSafeModeWindow(reason: string, dbPath: string) {
  safeModeWindow = new BrowserWindow({
    width: 600,
    height: 450,
    resizable: false,
    title: 'DUYA - Safe Recovery Mode',
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const safeModeHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>DUYA - Safe Recovery Mode</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e; color: #e0e0e0;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      height: 100vh; padding: 40px;
    }
    h1 { color: #ff6b6b; font-size: 24px; margin-bottom: 16px; }
    .reason { background: #2a2a4a; padding: 16px; border-radius: 8px; margin-bottom: 24px; width: 100%; font-size: 14px; word-break: break-all; }
    .path { color: #ffd93d; font-family: monospace; }
    .buttons { display: flex; gap: 12px; }
    button {
      padding: 10px 24px; border: none; border-radius: 6px; cursor: pointer;
      font-size: 14px; font-weight: 500;
    }
    .btn-primary { background: #4ecdc4; color: #1a1a2e; }
    .btn-secondary { background: #555; color: #e0e0e0; }
    button:hover { opacity: 0.9; }
    .status { margin-top: 16px; font-size: 13px; color: #aaa; }
  </style>
</head>
<body>
  <h1>⚠ Database Connection Failed</h1>
  <div class="reason">
    <p>Reason: ${reason}</p>
    <p class="path">Path: ${dbPath}</p>
  </div>
  <div class="buttons">
    <button class="btn-primary" onclick="relocate()">Relocate Database</button>
    <button class="btn-secondary" onclick="resetDefault()">Reset to Default</button>
  </div>
  <div class="status" id="status"></div>
  <script>
    const { ipcRenderer } = require('electron');

    async function relocate() {
      document.getElementById('status').textContent = 'Opening folder picker...';
      const result = await ipcRenderer.invoke('dialog:open-folder', {
        title: 'Select new database location'
      });
      if (result.canceled) {
        document.getElementById('status').textContent = 'Cancelled.';
        return;
      }
      const newDir = result.filePaths[0];
      if (!newDir) return;

      document.getElementById('status').textContent = 'Relocating database...';
      const relocateResult = await ipcRenderer.invoke('db:relocateDatabase', newDir);
      if (relocateResult.success) {
        document.getElementById('status').textContent = 'Relocated! Restarting...';
        const { app } = require('@electron/remote') || {};
        setTimeout(() => {
          require('electron').ipcRenderer.invoke('db:migration:updateBootAndRestart', relocateResult.newPath);
        }, 1000);
      } else {
        document.getElementById('status').textContent = 'Failed: ' + relocateResult.error;
      }
    }

    async function resetDefault() {
      document.getElementById('status').textContent = 'Resetting to default path...';
      const result = await ipcRenderer.invoke('db:resetToDefaultPath');
      if (result.success) {
        document.getElementById('status').textContent = 'Reset! Restarting...';
        setTimeout(() => {
          require('electron').ipcRenderer.invoke('db:migration:updateBootAndRestart', result.newPath);
        }, 1000);
      } else {
        document.getElementById('status').textContent = 'Failed: ' + result.error;
      }
    }
  </script>
</body>
</html>`;

  safeModeWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(safeModeHtml)}`);

  safeModeWindow.on('closed', () => {
    safeModeWindow = null;
  });
}

// =============================================================================
// Main Window
// =============================================================================

async function createWindow() {
  const isHiddenLaunch = wasLaunchedAsHidden();
  if (isHiddenLaunch) {
    logger.info('App launched as hidden login item, starting minimized to tray', undefined, LogComponent.Main);
  }

  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 600,
    title: 'DUYA Beta',
    icon: getIconPath(),
    show: !isHiddenLaunch,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };

  if (process.platform === 'darwin') {
    windowOptions.titleBarStyle = 'hiddenInset';
  } else if (process.platform === 'win32') {
    windowOptions.titleBarStyle = 'hidden';
    windowOptions.titleBarOverlay = {
      color: '#00000000',
      symbolColor: '#888888',
      height: 44,
    };
  }

  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
      shell.openExternal(targetUrl);
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const appOrigin = new URL(mainWindow!.webContents.getURL()).origin;
    if (new URL(targetUrl).origin !== appOrigin) {
      event.preventDefault();
      shell.openExternal(targetUrl);
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    logger.info('Window did-finish-load, setting up ports...', undefined, LogComponent.Main);

    const channelManager = getChannelManager();
    if (channelManager) {
      const configChannel = new MessageChannelMain();
      channelManager.registerChannel('config', configChannel.port1);

      const configManager = getConfigManager();
      if (configManager) {
        configManager.addSubscriber(configChannel.port1, 'renderer');
      }

      mainWindow?.webContents.postMessage('config-port', null, [configChannel.port2]);
      logger.info('Config port sent to renderer', undefined, LogComponent.Main);

      const agentControlChannel = new MessageChannelMain();
      channelManager.registerChannel('agentControl', agentControlChannel.port1);

      const agentPool = getAgentProcessPool();

      /**
       * Start an agent turn for a session with the given prompt.
       * Handles process acquisition, init, message forwarding, and queue draining.
       */
      const startAgentTurn = async (sessionId: string, prompt: string, options?: Record<string, unknown>): Promise<void> => {
        const sessionMgr = getSessionManager();
        sessionMgr.registerSession(sessionId);
        sessionMgr.updateSessionState(sessionId, 'streaming');
        agentPool.markSessionBusy(sessionId);
        logger.info('startAgentTurn begin', { sessionId, promptLength: prompt.length, hasOptions: !!options }, 'Main');

        try {
          const { isNew } = await agentPool.acquire(sessionId);
          logger.info('agentPool.acquire result', { sessionId, isNew }, 'Main');

          if (isNew) {
            const configManager = getConfigManager();

            // Get session info including provider_id and model
            const { getDatabase } = require('./db-handlers');
            const db = getDatabase();
            const sessionRow = db?.prepare('SELECT working_directory, system_prompt, provider_id, model FROM chat_sessions WHERE id = ?').get(sessionId) as { working_directory: string; system_prompt: string; provider_id: string; model: string } | undefined;
            const workingDirectory = sessionRow?.working_directory ?? '';
            const systemPrompt = sessionRow?.system_prompt || '';

            // Determine which provider to use:
            // 1. If session has provider_id, try to find that provider
            // 2. Otherwise fall back to active provider
            let provider = null;
            console.log('[Main] Session provider_id:', sessionRow?.provider_id);
            if (sessionRow?.provider_id) {
              const allProviders = configManager?.getAllProviders();
              console.log('[Main] All providers:', Object.keys(allProviders || {}));
              // provider_id could be the actual provider ID or the provider name (from old format)
              provider = allProviders?.[sessionRow.provider_id];
              console.log('[Main] Provider from ID:', provider?.id, provider?.name);
              // If not found by ID, try to find by name
              if (!provider && allProviders) {
                provider = Object.values(allProviders).find(p => p.name === sessionRow.provider_id);
                console.log('[Main] Provider from name:', provider?.id, provider?.name);
              }
            }

            // Fall back to active provider if session provider not found
            if (!provider) {
              provider = configManager?.getActiveProvider();
              console.log('[Main] Fallback to active provider:', provider?.id, provider?.name);
            }

            if (!provider) {
              logger.error('No active provider for new agent process', undefined, { sessionId }, 'Main');
              throw new Error('No active provider configured. Please configure and activate a provider first.');
            }

            // Get model from:
            // 1. options (user selection in this turn)
            // 2. session model (if already set and compatible with provider)
            // 3. provider config default
            // 4. fallback default
            let providerModel = (options?.model as string);

            // If no model in options, check session model compatibility
            if (!providerModel && sessionRow?.model) {
              const sessionModel = sessionRow.model as string;
              // Check if session model is compatible with current provider
              const isOllamaProvider = provider.providerType === 'ollama' ||
                (provider.providerType === 'openai-compatible' &&
                 (provider.baseUrl?.includes('localhost:11434') || provider.baseUrl?.includes('127.0.0.1:11434')));
              const isOllamaModel = !sessionModel.includes('/') && !sessionModel.includes('-') &&
                ['llama', 'qwen', 'mistral', 'deepseek', 'qwq', 'phi', 'gemma'].some(m =>
                  sessionModel.toLowerCase().includes(m));

              if (isOllamaProvider && isOllamaModel) {
                // Ollama provider with Ollama model - compatible
                providerModel = sessionModel;
              } else if (!isOllamaProvider && !isOllamaModel) {
                // API provider with API model - compatible
                providerModel = sessionModel;
              } else {
                // Incompatible - log warning and use provider default
                logger.warn('Session model incompatible with provider, using provider default', {
                  sessionId,
                  sessionModel,
                  providerType: provider.providerType,
                  providerId: provider.id,
                }, 'Main');
              }
            }

            // Fall back to provider default (options.defaultModel is now persisted by ProviderManager)
            providerModel = providerModel ||
              (provider.options?.defaultModel as string) ||
              (provider.options?.model as string) ||
              '';

            const llmProvider = toLLMProvider(provider.providerType, provider.baseUrl);
            logger.info('Provider config debug', {
              sessionId,
              originalProviderType: provider.providerType,
              convertedProvider: llmProvider,
              baseUrl: provider.baseUrl,
              providerModel,
              sessionModel: sessionRow?.model,
              providerId: provider.id,
            }, 'Main');

            // Get vision settings if configured
            const visionSettings = configManager?.getVisionSettings();
            const visionConfig = visionSettings?.enabled ? {
              provider: visionSettings.provider,
              model: visionSettings.model,
              baseURL: visionSettings.baseUrl,
              apiKey: visionSettings.apiKey,
              enabled: visionSettings.enabled,
            } : undefined;

            // Get blocked domains from settings
            let blockedDomains: string[] = [];
            try {
              const blockedRow = db?.prepare("SELECT value FROM settings WHERE key = 'blockedDomains'").get() as { value: string } | undefined;
              if (blockedRow?.value) {
                blockedDomains = JSON.parse(blockedRow.value);
              }
            } catch {
              // ignore parse errors
            }

            // Get agent language preference from settings
            let agentLanguage: string | undefined;
            try {
              const langRow = db?.prepare("SELECT value FROM settings WHERE key = 'agentLanguage'").get() as { value: string } | undefined;
              if (langRow?.value) {
                agentLanguage = langRow.value;
              }
            } catch {
              // ignore parse errors
            }

            // Get sandbox enabled setting
            let sandboxEnabled = true;
            try {
              const sandboxRow = db?.prepare("SELECT value FROM settings WHERE key = 'sandboxEnabled'").get() as { value: string } | undefined;
              if (sandboxRow?.value !== undefined) {
                sandboxEnabled = sandboxRow.value === 'true';
              }
            } catch {
              // ignore parse errors
            }

            const initSent = agentPool.send(sessionId, {
              type: 'init',
              sessionId,
              providerConfig: {
                apiKey: provider.apiKey,
                baseURL: provider.baseUrl,
                model: providerModel,
                provider: llmProvider,
                authStyle: 'api_key',
                visionConfig,
              },
              workingDirectory,
              systemPrompt,
              blockedDomains,
              language: agentLanguage,
              sandboxEnabled,
            });
            logger.info('init sent to agent', { sessionId, initSent, workingDirectory, provider: llmProvider }, 'Main');
            if (!initSent) {
              throw new Error(`Failed to send init to agent process for ${sessionId}`);
            }

            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => {
                logger.error('Agent ready timeout', undefined, { sessionId }, 'Main');
                reject(new Error(`Agent ready timeout for ${sessionId}`));
              }, 30000);

              const readyHandler = (agentMsg: { type: string }) => {
                if (agentMsg.type === 'ready') {
                  clearTimeout(timeout);
                  agentPool.removeMessageHandler(sessionId);
                  logger.info('Agent ready received', { sessionId }, 'Main');
                  resolve();
                }
              };
              agentPool.onMessage(sessionId, readyHandler);
            });
          }

          // Replace handler for this session (remove old one first if exists)
          agentPool.removeMessageHandler(sessionId);
          agentPool.onMessage(sessionId, (agentMsg) => {
            debugLog('agent->renderer', { sessionId, type: agentMsg.type });
            const sent = channelManager.sendToChannel('agentControl', agentMsg);
            if (!sent) {
              logger.error('Failed to forward agent message to renderer', undefined, {
                sessionId,
                msgType: agentMsg.type,
              }, LogComponent.Main);
            }

            if (isGatewaySession(sessionId)) {
              forwardToGateway(sessionId, agentMsg as Record<string, unknown>);
            }

            const agentMsgType = agentMsg.type as string;
            if (agentMsgType === 'chat:done' || agentMsgType === 'chat:error') {
              sessionMgr.updateSessionState(sessionId, 'idle');
              agentPool.markSessionIdle(sessionId);

              // Drain and process next queued message
              const next = agentPool.drainNextMessage(sessionId);
              if (next) {
                logger.info('Processing queued message for session', { sessionId }, LogComponent.Main);
                startAgentTurn(sessionId, next.prompt, next.options);
              }
            } else if (agentMsgType === 'chat:text' || agentMsgType === 'chat:thinking' || agentMsgType === 'chat:tool_use') {
              sessionMgr.updateSessionActivity(sessionId);
            } else if (agentMsgType === 'process:disconnected') {
              logger.error('Agent process disconnected', undefined, { sessionId }, LogComponent.Main);
              sessionMgr.updateSessionState(sessionId, 'error');
              agentPool.markSessionIdle(sessionId);
              const disconnectSent = channelManager.sendToChannel('agentControl', {
                type: 'chat:error',
                sessionId,
                message: 'Agent process disconnected unexpectedly. The conversation may have been interrupted.',
                code: (agentMsg as { code?: number }).code,
                signal: (agentMsg as { signal?: string }).signal,
              });
              if (!disconnectSent) {
                logger.error('Failed to forward disconnect error to renderer', undefined, { sessionId }, LogComponent.Main);
              }

              // Try to process queued messages even after crash
              const next = agentPool.drainNextMessage(sessionId);
              if (next) {
                startAgentTurn(sessionId, next.prompt, next.options);
              }
            }
          });

          logger.info('Agent ready, sending chat:start to agent process', { sessionId, promptLength: prompt.length }, LogComponent.Main);
          const chatStartSent = agentPool.send(sessionId, {
            type: 'chat:start',
            id: randomUUID(),
            sessionId,
            prompt,
            options: {
              messages: options?.messages,
              systemPrompt: options?.systemPrompt,
              permissionMode: options?.permissionMode,
              files: options?.files,
              agentProfileId: options?.agentProfileId,
            },
          });
          logger.info('chat:start sent to agent', { sessionId, chatStartSent }, 'Main');
          if (!chatStartSent) {
            throw new Error(`Failed to send chat:start to agent process for ${sessionId}`);
          }
        } catch (err) {
          logger.error('Failed to start agent turn', err instanceof Error ? err : new Error(String(err)), { sessionId }, LogComponent.Main);
          sessionMgr.updateSessionState(sessionId, 'error');
          agentPool.markSessionIdle(sessionId);
          channelManager.sendToChannel('agentControl', { type: 'chat:error', sessionId, message: String(err) });

          // On error, try to process queued messages
          const next = agentPool.drainNextMessage(sessionId);
          if (next) {
            startAgentTurn(sessionId, next.prompt, next.options);
          }
        }
      };

      channelManager.onChannelMessage('agentControl', async (data) => {
        const msg = data as { type: string; sessionId?: string; prompt?: string; options?: Record<string, unknown>; id?: string; decision?: string };
        logger.info('Agent control message', { type: msg.type, sessionId: msg.sessionId }, LogComponent.Main);

        if (msg.type === 'chat:start' && msg.sessionId && msg.prompt) {
          if (agentPool.isSessionBusy(msg.sessionId)) {
            logger.info('Session busy, queueing message', { sessionId: msg.sessionId }, LogComponent.Main);
            agentPool.queueMessage(msg.sessionId, msg.prompt, msg.options);
            return;
          }
          startAgentTurn(msg.sessionId, msg.prompt, msg.options);
        } else if (msg.type === 'chat:interrupt') {
          if (msg.sessionId) {
            logger.info('Interrupting agent', { sessionId: msg.sessionId }, LogComponent.Main);
            // First, try graceful interrupt via IPC
            const interruptSent = agentPool.send(msg.sessionId, { type: 'chat:interrupt' });
            if (!interruptSent) {
              // Process not reachable, force kill
              logger.warn('Cannot send interrupt to agent, force releasing', { sessionId: msg.sessionId }, LogComponent.Main);
              agentPool.release(msg.sessionId);
            }
            // The agent's interrupt() will cause streamChat to exit,
            // which triggers chat:done → markSessionIdle in the handler above.
            // Fallback: force kill after 4 seconds if still running.
            setTimeout(() => {
              if (agentPool.isRunning(msg.sessionId!)) {
                logger.warn('Agent did not stop gracefully, force killing', { sessionId: msg.sessionId }, LogComponent.Main);
                agentPool.release(msg.sessionId!);
              }
            }, 4000);
          }
        } else if (msg.type === 'permission:resolve' && msg.id && msg.decision) {
          if (msg.sessionId) {
            const permSent = agentPool.send(msg.sessionId, {
              type: 'permission:resolve',
              id: msg.id,
              decision: msg.decision,
            });
            if (!permSent) {
              logger.error('Failed to send permission resolution to agent', undefined, {
                sessionId: msg.sessionId,
                permissionId: msg.id,
              }, LogComponent.Main);
            }
          }
        } else if (msg.type === 'compact' && msg.sessionId) {
          const compactSent = agentPool.send(msg.sessionId, { type: 'compact' });
          if (!compactSent) {
            logger.error('Failed to send compact to agent', undefined, {
              sessionId: msg.sessionId,
            }, LogComponent.Main);
          }
        }
      });

      mainWindow?.webContents.postMessage('agent-control-port', null, [agentControlChannel.port2]);
      logger.info('Agent control port sent to renderer', undefined, 'Main');

      const conductorChannel = new MessageChannelMain();
      channelManager.registerChannel('conductor', conductorChannel.port1);
      mainWindow?.webContents.postMessage('conductor-port', null, [conductorChannel.port2]);

      // Handle conductor channel messages (renderer → main)
      channelManager.onChannelMessage('conductor', async (data) => {
        const msg = data as { type: string; sessionId?: string; prompt?: string; snapshot?: unknown; model?: string };
        logger.info('Conductor channel message', { type: msg.type, sessionId: msg.sessionId }, LogComponent.Main);

        if (msg.type === 'conductor:agent:start' && msg.sessionId && msg.prompt) {
          const conductorSessionId = msg.sessionId;
          logger.info('Starting conductor agent', { sessionId: conductorSessionId }, LogComponent.Main);

          try {
            const { isNew } = await agentPool.acquire(conductorSessionId);
            logger.info('Conductor agentPool.acquire result', { sessionId: conductorSessionId, isNew }, LogComponent.Main);

            if (isNew) {
              const configManager = getConfigManager();

              // Parse model: "[providerName] modelId" → { providerName, modelId }
              let selectedModel: string | undefined;
              let targetProvider = null;

              if (msg.model) {
                const match = msg.model.match(/^\[(.+?)\]\s+(.+)$/);
                if (match) {
                  const providerName = match[1];
                  const cleanModelId = match[2];
                  selectedModel = cleanModelId;

                  const allProviders = configManager?.getAllProviders();
                  if (allProviders) {
                    targetProvider = Object.values(allProviders).find(
                      (p) => p.name === providerName
                    );
                  }
                }
              }

              // Fall back to active provider if no model specified or provider not found
              if (!targetProvider) {
                targetProvider = configManager?.getActiveProvider();
              }

              if (!targetProvider) {
                channelManager.sendToChannel('conductor', {
                  type: 'conductor:error',
                  sessionId: conductorSessionId,
                  message: 'No active provider configured',
                });
                return;
              }

              // Use selected model from user, or provider default
              const providerModel = selectedModel ||
                targetProvider.options?.defaultModel ||
                targetProvider.options?.model ||
                '';

              const llmProvider = toLLMProvider(targetProvider.providerType);

              const conductorInitMsg = {
                type: 'conductor:init',
                sessionId: conductorSessionId,
                providerConfig: {
                  apiKey: targetProvider.apiKey,
                  baseURL: targetProvider.baseUrl || undefined,
                  model: providerModel,
                  provider: llmProvider,
                  authStyle: targetProvider.authStyle || 'api_key',
                },
                snapshot: msg.snapshot,
                workingDirectory: '',
                systemPrompt: '',
              };

              const conductorInitSent = agentPool.send(conductorSessionId, conductorInitMsg);
              if (!conductorInitSent) {
                logger.error('Failed to send conductor:init to agent process', undefined, { sessionId: conductorSessionId }, LogComponent.Main);
                channelManager.sendToChannel('conductor', {
                  type: 'conductor:error',
                  sessionId: conductorSessionId,
                  message: 'Failed to initialize conductor agent process',
                });
                return;
              }

              // Set up message forwarding: agent process → renderer via conductor channel
              agentPool.onMessage(conductorSessionId, (agentMsg) => {
                const am = agentMsg as Record<string, unknown>;
                if (am.type === 'conductor:text' || am.type === 'conductor:thinking' ||
                    am.type === 'conductor:tool_use' || am.type === 'conductor:tool_result' ||
                    am.type === 'conductor:status' || am.type === 'conductor:error' ||
                    am.type === 'conductor:done' || am.type === 'conductor:permission' ||
                    am.type === 'conductor:ready') {
                  channelManager.sendToChannel('conductor', am);
                } else if (am.type === 'pong') {
                  // Heartbeat, ignore
                } else if (am.type === 'process:disconnected') {
                  channelManager.sendToChannel('conductor', {
                    type: 'conductor:disconnected',
                    sessionId: conductorSessionId,
                  });
                }
              });

              // Wait for conductor:ready before sending start
              agentPool.waitForReady(conductorSessionId, 30000).then(() => {
                agentPool.send(conductorSessionId, {
                  type: 'conductor:agent:start',
                  sessionId: conductorSessionId,
                  prompt: msg.prompt,
                });
              }).catch((err: Error) => {
                channelManager.sendToChannel('conductor', {
                  type: 'conductor:error',
                  sessionId: conductorSessionId,
                  message: `Conductor agent ready timeout: ${err.message}`,
                });
              });
            }
          } catch (err) {
            logger.error('Failed to start conductor agent', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
            channelManager.sendToChannel('conductor', {
              type: 'conductor:error',
              sessionId: msg.sessionId,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        } else if (msg.type === 'conductor:interrupt' && msg.sessionId) {
          logger.info('Interrupting conductor agent', { sessionId: msg.sessionId }, LogComponent.Main);
          const interruptSent = agentPool.send(msg.sessionId, { type: 'conductor:interrupt' });
          if (!interruptSent) {
            logger.error('Failed to send conductor:interrupt to agent process', undefined, { sessionId: msg.sessionId }, LogComponent.Main);
            agentPool.release(msg.sessionId);
          }
          agentPool.release(msg.sessionId);
        }
      });

      logger.info('Conductor port sent to renderer', undefined, LogComponent.Main);

      // Initialize auto updater after window is ready
      initUpdater(mainWindow!);
      logger.info('Auto updater initialized', undefined, 'Main');
    }
  });

  try {
    const rendererUrl = await getRendererUrl();
    logger.info(`Loading URL: ${rendererUrl}`, undefined, 'Main');
    mainWindow.loadURL(rendererUrl);

    if (isDev) {
      mainWindow.webContents.openDevTools();
    }
  } catch (err) {
    logger.error('Failed to start renderer', err instanceof Error ? err : new Error(String(err)), undefined, 'Main');
    dialog.showErrorBox('Startup Error', `Failed to start application: ${err}`);
  }

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// =============================================================================
// App Lifecycle: lock -> boot -> db -> config -> daemon/UI
// =============================================================================

app.whenReady().then(async () => {
  // Set app name for notifications (Windows shows this as the notification source)
  app.name = 'DUYA';
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.duya.app');
  }

  logger.info('DUYA starting...', undefined, 'Main');
  logger.info(`Dev mode: ${isDev}`, undefined, 'Main');

  // ============================================================
  // Step 1: Read boot.json (The Compass) - resolve database path
  // ============================================================
  logger.info('Step 1: Reading boot configuration...', undefined, 'Main');
  const { dbPath } = resolveDatabasePath();
  logger.info('Database path resolved', { dbPath }, 'Main');

  // ============================================================
  // Step 2: Initialize Database (The Ledger) - with Safe Mode
  // ============================================================
  logger.info('Step 2: Initializing database gateway...', undefined, 'Main');
  const dbResult = initDatabaseFromBoot();

  if (!dbResult.success) {
    logger.error('Database initialization failed', dbResult.error instanceof Error ? dbResult.error : new Error(String(dbResult.error)), undefined, 'Main');
    logger.info('Entering Safe Mode...', undefined, 'Main');
    registerDbHandlers();
    registerConductorHandlers();
    registerBasicIpcHandlers();
    createSafeModeWindow(dbResult.error || 'Unknown error', dbResult.dbPath || dbPath);
    return;
  }

  logger.info('Database gateway initialized', { dbPath: dbResult.dbPath }, 'Main');
  registerDbHandlers();
  registerConductorHandlers();

  // ============================================================
  // Step 3: Initialize ConfigManager (The Vault)
  // ============================================================
  logger.info('Step 3: Initializing ConfigManager...', undefined, 'Main');
  const configManager = initConfigManager();
  logger.info('ConfigManager initialized', undefined, 'Main');

  // Migrate provider data from database to ConfigManager (one-time migration)
  try {
    const { getDatabase } = require('./db-handlers');
    const db = getDatabase();
    if (db) {
      const tableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='api_providers'").get();
      if (tableInfo) {
        const providers = db.prepare('SELECT * FROM api_providers').all() as Array<{
          id: string;
          name: string;
          provider_type: string;
          base_url: string;
          api_key: string;
          is_active: number;
          sort_order: number;
          extra_env: string;
          headers_json: string;
          options_json: string;
          notes: string;
        }>;
        if (providers.length > 0) {
          logger.info('Migrating providers from database to ConfigManager', { count: providers.length }, 'Main');
          for (const p of providers) {
            configManager.upsertProvider({
              id: p.id,
              name: p.name,
              providerType: (p.provider_type || 'anthropic') as 'anthropic' | 'openai' | 'ollama',
              baseUrl: p.base_url || '',
              apiKey: p.api_key || '',
              isActive: p.is_active === 1,
              sortOrder: p.sort_order || 0,
              extraEnv: p.extra_env ? JSON.parse(p.extra_env) : undefined,
              headers: p.headers_json ? JSON.parse(p.headers_json) : undefined,
              options: p.options_json ? JSON.parse(p.options_json) : undefined,
              notes: p.notes || '',
            });
          }
          logger.info('Provider migration completed', undefined, 'Main');
        }
      }
    }
  } catch (error) {
    logger.error('Provider migration failed (continuing anyway)', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
  }

  // ============================================================
  // Step 4: Initialize ChannelManager, Performance, Session, etc.
  // ============================================================
  logger.info('Step 4: Initializing subsystems...', undefined, 'Main');

  const channelManager = initChannelManager([
    { name: 'config', maxReconnectAttempts: 3 },
    { name: 'toolExec', maxReconnectAttempts: 5 },
    { name: 'toolStream', maxReconnectAttempts: 5 },
    { name: 'agentControl', maxReconnectAttempts: 3, messageQueueLimit: 500 },
  ]);
  logger.info('ChannelManager initialized', undefined, 'Main');

  initPerformanceMonitor();
  logger.info('PerformanceMonitor initialized', undefined, 'Main');

  initSessionManager();
  logger.info('SessionManager initialized', undefined, 'Main');

  registerAgentHandlers();
  registerNetHandlers();
  registerGatewayIpcHandlers();

  try {
    initAgentProcessPool();
    logger.info('Agent process pool initialized', undefined, 'Main');
  } catch (error) {
    logger.error('Failed to initialize agent process pool', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
  }

  try {
    const database = getDatabase();
    if (database) {
      initAutomationScheduler(database);
      logger.info('Automation scheduler initialized', undefined, 'Main');
    }
  } catch (error) {
    logger.error('Failed to initialize automation scheduler', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
  }

  // Apply app auto-start setting (Windows login)
  const autoStartValue = getAutoStartFromSettings()
  if (autoStartValue) {
    setAutoStart(true)
  }

  // Auto-start Gateway if bridge_auto_start is enabled
  try {
    const { getDatabase } = require('./db-handlers')
    const db = getDatabase()
    if (db) {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'bridge_auto_start'").get() as { value: string } | undefined
      if (row?.value === 'true') {
        logger.info('Auto-starting Gateway (bridge_auto_start=true)...', undefined, 'Main')
        startGatewayProcess()
      }
    }
  } catch (error) {
    logger.error('Failed to auto-start Gateway', error instanceof Error ? error : new Error(String(error)), undefined, 'Main')
  }

  // ============================================================
  // Step 5: Start Browser Daemon
  // ============================================================
  logger.info('Step 5: Starting Browser Daemon...', undefined, 'Main');
  try {
    await startBrowserDaemon();
    logger.info('Browser Daemon started', undefined, 'Main');
  } catch (error) {
    logger.error('Failed to start Browser Daemon', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
    // Non-critical error, continue without browser extension support
  }

  // ============================================================
  // Step 6: Launch UI
  // ============================================================
  logger.info('Step 6: Launching UI...', undefined, 'Main');
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

// =============================================================================
// Basic IPC handlers (available even in Safe Mode)
// =============================================================================

function registerBasicIpcHandlers() {
  ipcMain.handle('dialog:open-folder', async (_event, options?: { defaultPath?: string; title?: string }) => {
    const targetWindow = mainWindow || safeModeWindow;
    if (!targetWindow) return { canceled: true, filePaths: [] };
    const result = await dialog.showOpenDialog(targetWindow, {
      title: options?.title || 'Select a project folder',
      defaultPath: options?.defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return { canceled: result.canceled, filePaths: result.filePaths };
  });
}

// =============================================================================
// Graceful Shutdown
// =============================================================================

let isShuttingDown = false;

async function performGracefulShutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('Starting graceful shutdown...', undefined, 'Main');

  // 1. Stop all Agent processes
  try {
    const agentPool = getAgentProcessPool();
    await agentPool.shutdown();
  } catch (err) {
    logger.error('Error shutting down agent pool', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
  }

  // 2. Shutdown channel manager
  try {
    const channelMgr = getChannelManager();
    channelMgr.shutdown();
  } catch (err) {
    logger.error('Error shutting down channel manager', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
  }

  // 3. Stop performance monitor
  try {
    const { getPerformanceMonitor } = require('./performance-monitor');
    getPerformanceMonitor().shutdown();
  } catch (err) {
    logger.error('Error shutting down performance monitor', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
  }

  // 4. Stop gateway process (wait for clean exit)
  try {
    await stopGatewayProcess();
  } catch (err) {
    logger.error('Error stopping gateway process', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
  }

  // 5. Shutdown session manager (no DB writes)
  try {
    getSessionManager().shutdown();
  } catch (err) {
    logger.error('Error shutting down session manager', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
  }

  // 6. Stop Browser Daemon
  try {
    await stopBrowserDaemon();
    logger.info('Browser Daemon stopped', undefined, 'Main');
  } catch {}

  // 6.5 Stop automation scheduler
  try {
    getAutomationScheduler()?.shutdown();
  } catch {}

  // 6.6 Cleanup updater
  try {
    cleanupUpdater();
  } catch {}

  // 7. Shutdown config manager (flushes pending saves with atomic write)
  try {
    const configMgr = getConfigManager();
    configMgr.shutdown();
  } catch {}

  // 8. Close database connection (last step, ensures all writes complete)
  try {
    const { getDatabase } = require('./db-handlers');
    const database = getDatabase();
    if (database) {
      database.close();
      logger.info('Database connection closed', undefined, 'Main');
    }
  } catch (error) {
    logger.error('Failed to close database', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
  }

  logger.info('Graceful shutdown complete', undefined, 'Main');
}

app.on('window-all-closed', async () => {
  if (isQuitting) {
    const SHUTDOWN_TIMEOUT_MS = 10000;
    const shutdownPromise = performGracefulShutdown();

    const forceQuitTimeout = setTimeout(() => {
      logger.warn('window-all-closed shutdown timeout exceeded, forcing quit', undefined, 'Main');
      app.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      await shutdownPromise;
      clearTimeout(forceQuitTimeout);
    } catch (err) {
      logger.error('Graceful shutdown failed in window-all-closed', err instanceof Error ? err : new Error(String(err)), undefined, 'Main');
      clearTimeout(forceQuitTimeout);
      app.exit(1);
    }

    if (process.platform !== 'darwin') {
      app.quit();
    }
  }
});

app.on('before-quit', (event) => {
  if (!isShuttingDown) {
    event.preventDefault();
    // Start shutdown but enforce a hard timeout to prevent hanging.
    // Each shutdown step has its own internal timeout; this is a global safety net.
    const SHUTDOWN_TIMEOUT_MS = 10000;
    const shutdownPromise = performGracefulShutdown();

    const forceQuitTimeout = setTimeout(() => {
      logger.warn('Global shutdown timeout exceeded, forcing quit', undefined, 'Main');
      // app.exit bypasses before-quit/will-quit and terminates immediately
      app.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);

    shutdownPromise.then(() => {
      clearTimeout(forceQuitTimeout);
      app.quit();
    }).catch((err) => {
      logger.error('Graceful shutdown failed', err instanceof Error ? err : new Error(String(err)), undefined, 'Main');
      clearTimeout(forceQuitTimeout);
      app.exit(1);
    });
  }
});

// =============================================================================
// IPC Handlers
// =============================================================================

ipcMain.handle('dialog:open-folder', async (_event, options?: { defaultPath?: string; title?: string }) => {
  if (!mainWindow) return { canceled: true, filePaths: [] };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options?.title || 'Select a project folder',
    defaultPath: options?.defaultPath || undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  return { canceled: result.canceled, filePaths: result.filePaths };
});

ipcMain.handle('shell:open-path', async (_event, folderPath: string) => {
  if (typeof folderPath !== 'string' || folderPath.length === 0 || folderPath.length > 4096) {
    return 'Invalid path';
  }
  if (folderPath.includes('\0')) {
    return 'Invalid path';
  }
  return shell.openPath(folderPath);
});

ipcMain.handle('browser-extension:get-path', () => {
  if (isDev) {
    return path.join(app.getAppPath(), 'extension');
  }
  return path.join(process.resourcesPath, 'extension');
});

ipcMain.handle('notification:show', async (_event, options: { title: string; body: string }) => {
  if (!options || typeof options.title !== 'string' || options.title.length === 0 || options.title.length > 500) {
    return false;
  }
  try {
    const notification = new Notification({
      title: options.title,
      body: typeof options.body === 'string' ? options.body.slice(0, 2000) : '',
    });
    notification.show();
    return true;
  } catch (err) {
    logger.error('Failed to show notification', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Notification);
    return false;
  }
});

ipcMain.handle('app:get-version', () => {
  return app.getVersion();
});

ipcMain.handle('app:quit', () => {
  isQuitting = true;
  app.quit();
});

ipcMain.handle('app:get-default-workspace', () => {
  const defaultWorkspace = path.join(homedir(), '.duya');
  if (!fs.existsSync(defaultWorkspace)) {
    fs.mkdirSync(defaultWorkspace, { recursive: true });
  }
  return defaultWorkspace;
});

const getRecentFoldersPath = () => {
  return path.join(app.getPath('userData'), 'recent-folders.json');
};

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

ipcMain.handle('projects:get-recent-folders', async () => {
  return getRecentFolders();
});

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

ipcMain.on('sync:threads-changed', (_event) => {
  const senderWindow = BrowserWindow.fromWebContents(_event.sender);
  const allWindows = BrowserWindow.getAllWindows();

  for (const window of allWindows) {
    if (window !== senderWindow && !window.isDestroyed()) {
      window.webContents.send('sync:threads-changed');
    }
  }
});

ipcMain.handle('settings:set-auto-start', async (_event, enabled: boolean) => {
  try {
    const success = setAutoStart(enabled);
    if (success) {
      setAutoStartToSettings(enabled);
    }
    return { success, supported: process.platform !== 'linux' };
  } catch (error) {
    logger.error('Failed to set auto-start', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Settings);
    return { success: false, supported: process.platform !== 'linux', error: String(error) };
  }
});

ipcMain.handle('settings:get-auto-start-status', async () => {
  try {
    const loginItemSettings = app.getLoginItemSettings();
    const dbValue = getAutoStartFromSettings();
    const isSupported = process.platform !== 'linux';

    // On Windows, we need to check with the same args used when setting
    const isEnabled = process.platform === 'win32'
      ? loginItemSettings.openAtLogin
      : loginItemSettings.openAtLogin;

    return {
      enabled: isEnabled,
      dbValue: dbValue,
      canChange: app.isPackaged && isSupported,
      supported: isSupported,
      platform: process.platform,
    };
  } catch (error) {
    logger.error('Failed to get auto-start status', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Settings);
    return { enabled: false, canChange: false, supported: false, platform: process.platform, error: String(error) };
  }
});

ipcMain.handle('browser-extension:get-status', async () => {
  try {
    const status = getBrowserExtensionStatus();
    return { success: true, status };
  } catch (error) {
    logger.error('Failed to get browser extension status', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('agent:reinit-provider', async () => {
  try {
    const configManager = getConfigManager();
    const activeProvider = configManager.getActiveProvider();

    if (!activeProvider) {
      logger.info('agent:reinit-provider: No active provider found', undefined, LogComponent.Main);
      return { success: false, reason: 'no_active_provider' };
    }

    logger.info('Re-initializing agent with provider', { providerType: activeProvider.providerType, baseUrl: activeProvider.baseUrl }, LogComponent.Main);

    // Get all running sessions and send init to each
    const agentPool = getAgentProcessPool();
    const status = agentPool.getStatus();
    const { getDatabase } = require('./db-handlers');
    const db = getDatabase();

    // Get blocked domains from settings
    let blockedDomains: string[] = [];
    try {
      const blockedRow = db?.prepare("SELECT value FROM settings WHERE key = 'blockedDomains'").get() as { value: string } | undefined;
      if (blockedRow?.value) {
        blockedDomains = JSON.parse(blockedRow.value);
      }
    } catch {
      // ignore parse errors
    }

    // Get sandbox enabled setting
    let sandboxEnabled = true;
    try {
      const sandboxRow = db?.prepare("SELECT value FROM settings WHERE key = 'sandboxEnabled'").get() as { value: string } | undefined;
      if (sandboxRow?.value !== undefined) {
        sandboxEnabled = sandboxRow.value === 'true';
      }
    } catch {
      // ignore parse errors
    }

    for (const proc of status.processes) {
      // Get session info for each running process
      const sessionRow = db?.prepare('SELECT working_directory, system_prompt FROM chat_sessions WHERE id = ?').get(proc.sessionId) as { working_directory: string; system_prompt: string } | undefined;
      const workingDirectory = sessionRow?.working_directory ?? '';
      const systemPrompt = sessionRow?.system_prompt || '';

      // Get model from provider options or use default
      const providerModel = (activeProvider.options?.defaultModel as string) ||
        (activeProvider.options?.model as string) ||
        '';

      agentPool.send(proc.sessionId, {
        type: 'init',
        sessionId: proc.sessionId,
        providerConfig: {
          provider: toLLMProvider(activeProvider.providerType),
          apiKey: activeProvider.apiKey,
          baseURL: activeProvider.baseUrl,
          model: providerModel,
          authStyle: 'api_key',
        },
        workingDirectory,
        systemPrompt,
        blockedDomains,
        sandboxEnabled,
      });
    }

    return { success: true };
  } catch (error) {
    logger.error('agent:reinit-provider failed', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Main);
    return { success: false, reason: String(error) };
  }
});

/**
 * Check if the current platform matches the skill's supported platforms
 * @param platforms - Array of supported platforms from skill frontmatter
 * @returns true if skill should be shown on current platform
 */
function isPlatformSupported(platforms?: string[]): boolean {
  if (!platforms || platforms.length === 0) {
    return true;
  }

  const currentPlatform = getPlatform();
  const platformMap: Record<string, string> = {
    'darwin': 'macos',
    'win32': 'windows',
    'linux': 'linux',
  };

  const normalizedCurrent = platformMap[currentPlatform] || currentPlatform;

  return platforms.some(p => {
    const normalized = p.toLowerCase().trim();
    return normalized === normalizedCurrent ||
           (normalized === 'macos' && currentPlatform === 'darwin') ||
           (normalized === 'windows' && currentPlatform === 'win32');
  });
}

// Skills API - load and return skills from filesystem
ipcMain.handle('skills:list', async () => {
  try {
    const skills: Array<{
      name: string;
      description: string;
      category?: string;
      source?: string;
      userInvocable?: boolean;
      whenToUse?: string;
      allowedTools?: string[];
      platforms?: string[];
      content: string;
      frontmatter: Record<string, unknown>;
      security?: {
        verdict: 'safe' | 'caution' | 'dangerous';
        findings: SkillFinding[];
        scanned: boolean;
      };
    }> = [];

    const loadedNames = new Set<string>();

    // Helper to load skills from a directory
    const loadSkillsFromDir = (baseDir: string, source: string) => {
      if (!fs.existsSync(baseDir)) return;

      const entries = fs.readdirSync(baseDir);

      for (const entry of entries) {
        // Skip hidden files and manifest
        if (entry.startsWith('.')) continue;

        const entryPath = path.join(baseDir, entry);
        const stat = fs.statSync(entryPath);

        if (!stat.isDirectory()) continue;

        // Check if this is a category directory (has DESCRIPTION.md)
        const descriptionPath = path.join(entryPath, 'DESCRIPTION.md');
        const isCategoryDir = fs.existsSync(descriptionPath);

        if (isCategoryDir) {
          // Read skills in this category
          const skillEntries = fs.readdirSync(entryPath);
          for (const skillEntry of skillEntries) {
            // Skip hidden files
            if (skillEntry.startsWith('.')) continue;

            const skillPath = path.join(entryPath, skillEntry);
            const skillStat = fs.statSync(skillPath);
            if (!skillStat.isDirectory()) continue;

            const skillMdPath = path.join(skillPath, 'SKILL.md');
            if (!fs.existsSync(skillMdPath)) continue;

            // Skip if already loaded (project takes priority over user)
            if (loadedNames.has(skillEntry)) continue;

            try {
              const content = fs.readFileSync(skillMdPath, 'utf-8');
              const { frontmatter, content: markdownContent } = parseSkillFrontmatter(content);

              // Parse platforms from frontmatter
              const platforms = parseAllowedTools(frontmatter.platforms);

              // Check platform compatibility - skip if not supported on current platform
              if (!isPlatformSupported(platforms)) {
                logger.info(`Skipping skill '${skillEntry}' - not supported on current platform`, undefined, LogComponent.Skills);
                continue;
              }

              // Security scan for all skills from filesystem
              const findings = scanSkillFile(markdownContent, 'SKILL.md');
              const verdict = findings.some((f) => f.severity === 'critical')
                ? 'dangerous'
                : findings.some((f) => f.severity === 'high')
                ? 'caution'
                : 'safe';
              const securityScan = { verdict, findings, scanned: true };

              skills.push({
                name: skillEntry,
                description: (frontmatter.description as string) || skillEntry,
                category: entry,
                source,
                userInvocable: frontmatter['user-invocable'] !== false,
                whenToUse: frontmatter['when-to-use'] as string | undefined,
                allowedTools: parseAllowedTools(frontmatter['allowed-tools']),
                platforms,
                content: markdownContent,
                frontmatter,
                security: securityScan,
              });
              loadedNames.add(skillEntry);
            } catch (error) {
              logger.error(`Failed to load skill ${skillEntry}`, error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Skills);
            }
          }
        } else {
          // Direct skill directory (no category)
          const skillMdPath = path.join(entryPath, 'SKILL.md');
          if (!fs.existsSync(skillMdPath)) continue;

          // Skip if already loaded
          if (loadedNames.has(entry)) continue;

          try {
            const content = fs.readFileSync(skillMdPath, 'utf-8');
            const { frontmatter, content: markdownContent } = parseSkillFrontmatter(content);

            // Parse platforms from frontmatter
            const platforms = parseAllowedTools(frontmatter.platforms);

            // Check platform compatibility - skip if not supported on current platform
            if (!isPlatformSupported(platforms)) {
              logger.info(`Skipping skill '${entry}' - not supported on current platform`, undefined, LogComponent.Skills);
              continue;
            }

            // Security scan for all skills from filesystem
            const findings = scanSkillFile(markdownContent, 'SKILL.md');
            const verdict = findings.some((f) => f.severity === 'critical')
              ? 'dangerous'
              : findings.some((f) => f.severity === 'high')
              ? 'caution'
              : 'safe';
            const securityScan = { verdict, findings, scanned: true };

            skills.push({
              name: entry,
              description: (frontmatter.description as string) || entry,
              category: (frontmatter.category as string) || 'other',
              source,
              userInvocable: frontmatter['user-invocable'] !== false,
              whenToUse: frontmatter['when-to-use'] as string | undefined,
              allowedTools: parseAllowedTools(frontmatter['allowed-tools']),
              platforms,
              content: markdownContent,
              frontmatter,
              security: securityScan,
            });
            loadedNames.add(entry);
          } catch (error) {
            logger.error(`Failed to load skill ${entry}`, error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Skills);
          }
        }
      }
    };

    // Sync bundled skills to user directory first
    // This ensures built-in skills are copied to ~/.duya/skills/ where users can see and edit them
    const userSkillsDir = path.join(homedir(), '.duya', 'skills');
    let syncStatus: {
      synced: boolean;
      added: string[];
      updated: string[];
      skipped: string[];
      removed: string[];
      error?: string;
    } = { synced: false, added: [], updated: [], skipped: [], removed: [] };

    try {
      const { syncBundledSkills } = await import('../packages/agent/src/skills/skillsSync.js');
      const syncResult = await syncBundledSkills();
      syncStatus = {
        synced: true,
        added: syncResult.added,
        updated: syncResult.updated,
        skipped: syncResult.skipped,
        removed: syncResult.removed,
      };
      if (syncResult.added.length > 0 || syncResult.updated.length > 0) {
        logger.info('Bundled skills synced to user directory', {
          added: syncResult.added,
          updated: syncResult.updated,
        }, LogComponent.Skills);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logger.warn('Failed to sync bundled skills', e instanceof Error ? e : new Error(errMsg), undefined, LogComponent.Skills);
      syncStatus = {
        synced: false,
        added: [],
        updated: [],
        skipped: [],
        removed: [],
        error: errMsg,
      };
    }

    // 1. Load user skills from ~/.duya/skills (includes synced bundled skills)
    if (fs.existsSync(userSkillsDir)) {
      logger.info('Loading user skills', { dir: userSkillsDir }, LogComponent.Skills);
      loadSkillsFromDir(userSkillsDir, 'user');
    }

    // 2. Load project skills from <cwd>/.duya/skills (takes priority over user skills)
    const projectSkillsDir = path.join(process.cwd(), '.duya', 'skills');
    if (fs.existsSync(projectSkillsDir) && projectSkillsDir !== userSkillsDir) {
      logger.info('Loading project skills', { dir: projectSkillsDir }, LogComponent.Skills);
      loadSkillsFromDir(projectSkillsDir, 'project');
    }

    // 3. Load custom skills from configured skill_path
    const configManager = getConfigManager();
    const customSkillPath = configManager.getConfig().skill_path;
    if (customSkillPath && fs.existsSync(customSkillPath)) {
      const normalizedCustomPath = path.normalize(customSkillPath);
      const normalizedUserDir = path.normalize(userSkillsDir);
      const normalizedProjectDir = path.normalize(projectSkillsDir);
      // Avoid loading duplicates if skill_path overlaps with user/project dirs
      if (normalizedCustomPath !== normalizedUserDir && normalizedCustomPath !== normalizedProjectDir) {
        logger.info('Loading custom skills from skill_path', { dir: customSkillPath }, LogComponent.Skills);
        loadSkillsFromDir(customSkillPath, 'custom');
      }
    }

    logger.info(`Loaded ${skills.length} skills total`, undefined, LogComponent.Skills);
    return { success: true, skills, syncStatus };
  } catch (error) {
    logger.error('Failed to list skills', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Skills);
    return { success: false, error: String(error), skills: [], syncStatus: null };
  }
});

// Get security bypass list
ipcMain.handle('skills:getSecurityBypass', async () => {
  try {
    const configManager = getConfigManager();
    const bypassSkills = configManager.getConfig().securityBypassSkills || [];
    return { success: true, skills: bypassSkills };
  } catch (error) {
    logger.error('Failed to get security bypass list', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Skills);
    return { success: false, error: String(error), skills: [] };
  }
});

// Update security bypass list (add or remove skill)
ipcMain.handle('skills:setSecurityBypass', async (_event, skillName: string, bypass: boolean) => {
  try {
    const configManager = getConfigManager();
    const config = configManager.getConfig();
    const currentList = config.securityBypassSkills || [];
    
    let newList: string[];
    if (bypass) {
      // Add to bypass list if not already present
      if (currentList.includes(skillName)) {
        return { success: true, skills: currentList };
      }
      newList = [...currentList, skillName];
    } else {
      // Remove from bypass list
      newList = currentList.filter(s => s !== skillName);
    }
    
    configManager.setConfig('securityBypassSkills', newList);
    logger.info(`Updated security bypass list: ${bypass ? 'added' : 'removed'} '${skillName}'`, undefined, LogComponent.Skills);
    return { success: true, skills: newList };
  } catch (error) {
    logger.error('Failed to update security bypass list', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Skills);
    return { success: false, error: String(error) };
  }
});

// Helper function to parse skill frontmatter
function parseSkillFrontmatter(content: string): { frontmatter: Record<string, unknown>; content: string } {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)---\s*\n?/);

  if (!frontmatterMatch) {
    return { frontmatter: {}, content };
  }

  const frontmatterText = frontmatterMatch[1] || '';
  const markdownContent = content.slice(frontmatterMatch[0].length);

  const frontmatter: Record<string, unknown> = {};

  for (const line of frontmatterText.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value: string = line.slice(colonIndex + 1).trim();

    // Handle quoted strings
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Handle booleans
    if (value === 'true') {
      frontmatter[key] = true;
      continue;
    }
    if (value === 'false') {
      frontmatter[key] = false;
      continue;
    }

    // Handle arrays
    if (value.includes(',') && !value.startsWith('[')) {
      frontmatter[key] = value.split(',').map(s => s.trim()).filter(Boolean);
      continue;
    }

    frontmatter[key] = value;
  }

  return { frontmatter, content: markdownContent };
}

// Helper function to parse allowed tools
function parseAllowedTools(tools: unknown): string[] | undefined {
  if (!tools) return undefined;
  if (Array.isArray(tools)) {
    return tools.map(String).filter(Boolean);
  }
  if (typeof tools === 'string') {
    return tools.split(',').map(s => s.trim()).filter(Boolean);
  }
  return undefined;
}

// =============================================================================
// File Tree API - Browse directory structure
// =============================================================================

interface FileTreeNode {
  name: string;
  path: string;
  type: 'directory' | 'file';
  extension?: string;
  children?: FileTreeNode[];
}

const IGNORED_ENTRIES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.DS_Store',
  'Thumbs.db',
  '.idea',
  '.vscode',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.pytest_cache',
  '*.log',
]);

function shouldIgnore(name: string): boolean {
  if (IGNORED_ENTRIES.has(name)) return true;
  if (name.startsWith('.')) return true;
  if (name.endsWith('.log')) return true;
  return false;
}

function getExtension(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined;
}

function buildFileTree(dirPath: string, baseDir: string, depth: number, maxDepth: number): FileTreeNode[] {
  if (depth > maxDepth) return [];

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const nodes: FileTreeNode[] = [];

    for (const entry of entries) {
      if (shouldIgnore(entry.name)) continue;

      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(baseDir, fullPath);

      if (entry.isDirectory()) {
        const children = buildFileTree(fullPath, baseDir, depth + 1, maxDepth);
        nodes.push({
          name: entry.name,
          path: relativePath,
          type: 'directory',
          children,
        });
      } else if (entry.isFile()) {
        nodes.push({
          name: entry.name,
          path: relativePath,
          type: 'file',
          extension: getExtension(entry.name),
        });
      }
    }

    // Sort: directories first, then files, both alphabetically
    nodes.sort((a, b) => {
      if (a.type === b.type) {
        return a.name.localeCompare(b.name);
      }
      return a.type === 'directory' ? -1 : 1;
    });

    return nodes;
  } catch (error) {
    logger.error('Failed to read directory', error instanceof Error ? error : new Error(String(error)), { dirPath }, LogComponent.Files);
    return [];
  }
}

ipcMain.handle('files:browse', async (_event, dirPath: string, maxDepth = 4) => {
  try {
    if (!dirPath || typeof dirPath !== 'string') {
      return { success: false, error: 'Invalid directory path', tree: [] };
    }

    const resolvedPath = path.resolve(dirPath);
    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: 'Directory does not exist', tree: [] };
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isDirectory()) {
      return { success: false, error: 'Path is not a directory', tree: [] };
    }

    const tree = buildFileTree(resolvedPath, resolvedPath, 0, maxDepth);
    return { success: true, tree };
  } catch (error) {
    logger.error('files:browse error', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
    return { success: false, error: String(error), tree: [] };
  }
});

ipcMain.handle('files:delete', async (_event, targetPath: string) => {
  try {
    if (!targetPath || typeof targetPath !== 'string') {
      return { success: false, error: 'Invalid path' };
    }

    const resolvedPath = path.resolve(targetPath);
    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: 'Path does not exist' };
    }

    const stat = fs.statSync(resolvedPath);
    if (stat.isDirectory()) {
      fs.rmdirSync(resolvedPath, { recursive: true });
    } else {
      fs.unlinkSync(resolvedPath);
    }

    return { success: true };
  } catch (error) {
    logger.error('files:delete error', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('files:rename', async (_event, targetPath: string, newName: string) => {
  try {
    if (!targetPath || typeof targetPath !== 'string' || !newName || typeof newName !== 'string') {
      return { success: false, error: 'Invalid path or name' };
    }

    const resolvedPath = path.resolve(targetPath);
    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: 'Path does not exist' };
    }

    const parentDir = path.dirname(resolvedPath);
    const newPath = path.join(parentDir, newName);

    if (fs.existsSync(newPath)) {
      return { success: false, error: 'A file or folder with that name already exists' };
    }

    fs.renameSync(resolvedPath, newPath);
    return { success: true, newPath };
  } catch (error) {
    logger.error('files:rename error', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
    return { success: false, error: String(error) };
  }
});

// =============================================================================
// Logger & Updater IPC Handlers
// =============================================================================

// Logger IPC handlers
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

ipcMain.handle('logger:get-path', async () => {
  return {
    logPath: logger.getLogPath(),
    logDir: logger.getLogDir(),
    size: logger.getLogSize(),
    sizeFormatted: logger.getLogSizeFormatted(),
  };
});

ipcMain.handle('logger:clear', async () => {
  try {
    const success = logger.clearLogs();
    return { success };
  } catch (error) {
    logger.error('Failed to clear logs', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
    return { success: false, error: String(error) };
  }
});

// Updater IPC handlers
ipcMain.handle('updater:check', async () => {
  return checkForUpdates();
});

ipcMain.handle('updater:download', async () => {
  return downloadUpdate();
});

ipcMain.handle('updater:install', async () => {
  installUpdate();
  return { success: true };
});

ipcMain.handle('updater:get-state', async () => {
  return getUpdaterState();
});
