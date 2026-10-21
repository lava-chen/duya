import { app, Tray, Menu, nativeImage, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { isDev } from './bootstrap';
import { getMainWindow, getIconPath, setIsQuitting } from './window-manager';

let tray: Tray | null = null;

export function getTray(): Tray | null {
  return tray;
}

export function getTrayIconPath(): string {
  const getAssetPath = (...paths: string[]) => path.join(__dirname, '..', 'assets', ...paths);
  if (process.platform === 'win32') {
    return isDev ? getAssetPath('windows', '16x16.png') : path.join(process.resourcesPath, 'assets', 'windows', '16x16.png');
  }
  if (process.platform === 'darwin') {
    return isDev ? getAssetPath('macos', '16x16.png') : path.join(process.resourcesPath, 'assets', 'macos', '16x16.png');
  }
  return isDev ? getAssetPath('linux', 'icons', '16x16.png') : path.join(process.resourcesPath, 'assets', 'linux', 'icons', '16x16.png');
}

export function createTray(): void {
  const iconPath = getTrayIconPath();
  let trayIcon: Electron.NativeImage;

  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (process.platform === 'darwin') {
      // macOS menu bar icons must be template images (black + alpha) so the
      // system can recolor them for light/dark mode. Marking a colored PNG
      // as template makes the system treat it as a silhouette; for correct
      // rendering the asset should be a black-on-transparent PNG.
      trayIcon = trayIcon.resize({ width: 16, height: 16 });
      trayIcon.setTemplateImage(true);
    }
  } else {
    const appIconPath = getIconPath();
    if (fs.existsSync(appIconPath)) {
      trayIcon = nativeImage.createFromPath(appIconPath);
      if (process.platform === 'darwin') {
        trayIcon = trayIcon.resize({ width: 16, height: 16 });
        trayIcon.setTemplateImage(true);
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
        const mainWindow = getMainWindow();
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
        setIsQuitting(true);
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  tray.on('click', () => {
    if (process.platform !== 'darwin') {
      const mainWindow = getMainWindow();
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
