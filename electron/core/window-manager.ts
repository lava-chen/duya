import { app, BrowserWindow, shell, dialog, MessageChannelMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { isDev, isPreviewMode } from './bootstrap';
import { getLogger, LogComponent } from '../logging/logger';
import { getChannelManager } from '../messaging/port-manager';
import { getConfigManager } from '../config/manager';
import { initUpdater } from '../services/updater';
import { wasLaunchedAsHidden } from '../services/auto-start';
import { getNodeExecutable } from '../services/dev-detector';
import { isHttpUrl } from '../ipc/system-handlers';

const logger = getLogger();

// Module-level window state
let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

// Export getters/setters
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function getIsQuitting(): boolean {
  return isQuitting;
}

export function setIsQuitting(value: boolean): void {
  isQuitting = value;
}

// =============================================================================
// Icon Path Helpers
// =============================================================================

export function getIconPath(): string {
  const getAssetPath = (...paths: string[]) => path.join(__dirname, '..', 'assets', ...paths);
  if (process.platform === 'win32') {
    return isDev ? getAssetPath('windows', 'icon.ico') : path.join(process.resourcesPath, 'assets', 'windows', 'icon.ico');
  }
  if (process.platform === 'darwin') {
    return isDev ? getAssetPath('macos', 'icon.icns') : path.join(process.resourcesPath, 'assets', 'macos', 'icon.icns');
  }
  return isDev ? getAssetPath('linux', 'icons', '512x512.png') : path.join(process.resourcesPath, 'assets', 'linux', 'icons', '512x512.png');
}

// =============================================================================
// Renderer URL Detection
// =============================================================================

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

export async function getRendererUrl(): Promise<string> {
  if (isPreviewMode) {
    const distPath = path.join(process.cwd(), 'dist');
    const indexPath = path.join(distPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      logger.info('Preview mode: loading from dist/', undefined, LogComponent.Main);
      return `file://${indexPath}`;
    }
    logger.warn('Preview mode: dist/index.html not found, trying Vite preview on port 4173', undefined, LogComponent.Main);
    const previewPort = await detectDevServerPort();
    if (previewPort && previewPort !== 3000) {
      return `http://localhost:${previewPort}`;
    }
    logger.warn('Preview mode: falling back to port 4173', undefined, LogComponent.Main);
    return 'http://localhost:4173';
  }

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
// Main Window
// =============================================================================

export async function createWindow(
  handleConductorMessage: (data: unknown) => void,
): Promise<void> {
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
    if (isHttpUrl(targetUrl)) {
      shell.openExternal(targetUrl);
    }
    // Always deny opening inside the BrowserWindow, regardless of protocol.
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    let appOrigin: string;
    try {
      appOrigin = new URL(mainWindow!.webContents.getURL()).origin;
    } catch {
      event.preventDefault();
      return;
    }
    let targetOrigin: string;
    try {
      targetOrigin = new URL(targetUrl).origin;
    } catch {
      event.preventDefault();
      return;
    }
    if (targetOrigin !== appOrigin) {
      event.preventDefault();
      // Only forward http(s) URLs to the OS; everything else is blocked.
      if (isHttpUrl(targetUrl)) {
        shell.openExternal(targetUrl);
      }
    }
  });

  let updaterSetup = false;

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

      const conductorChannel = new MessageChannelMain();
      channelManager.registerChannel('conductor', conductorChannel.port1);
      mainWindow?.webContents.postMessage('conductor-port', null, [conductorChannel.port2]);

      channelManager.onChannelMessage('conductor', handleConductorMessage);

      logger.info('Conductor port sent to renderer', undefined, LogComponent.Main);
    }

    if (!updaterSetup) {
      updaterSetup = true;
      initUpdater(mainWindow!);
      logger.info('Auto updater initialized', undefined, 'Main');
    }
  });

  try {
    const rendererUrl = await getRendererUrl();
    logger.info(`Loading URL: ${rendererUrl}`, undefined, 'Main');
    mainWindow.loadURL(rendererUrl);

    if (isDev && !isPreviewMode) {
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
