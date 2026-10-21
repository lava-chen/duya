import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { initLogger, getLogger, LogComponent } from '../logging/logger';

const logger = initLogger({ level: 'WARN' });

interface ElectronApp {
  getPath(name: 'userData'): string;
  isPackaged: boolean;
  getLoginItemSettings(): { wasOpenedAsHidden: boolean };
  setLoginItemSettings(settings: {
    openAtLogin: boolean;
    openAsHidden: boolean;
    args?: string[];
  }): void;
}

/**
 * Electron is OPTIONAL here: this module is inside the value-import closure of
 * the headless control plane's server entry
 * (`01-headless-control-plane.md` §2.1). A module-scope
 * `import { app } from 'electron'` is evaluated when the module is and throws
 * THERE, taking the whole graph with it, so `app` is resolved through a
 * guarded require and reported as absent instead.
 */
function electronApp(): ElectronApp | undefined {
  try {
    const { app } = require('electron') as { app?: ElectronApp };
    return app;
  } catch {
    return undefined;
  }
}

/**
 * Electron wins whenever it is present: this is the app's own directory and
 * must not move because the variable below happens to be exported in a dev
 * shell. `DUYA_CLI_USER_DATA_DIR` (`cli/handlers/plugins.ts`) is the existing
 * headless entry point and applies only when there is no desktop, where
 * `~/.duya` is the same root the settings the desktop app writes are already
 * read from, so the two hosts share one settings file instead of each keeping
 * a private one.
 */
function getSettingsPath(): string {
  const app = electronApp();
  if (app && typeof app.getPath === 'function') return path.join(app.getPath('userData'), 'settings.json');
  const envOverride = process.env.DUYA_CLI_USER_DATA_DIR;
  if (envOverride && envOverride.trim().length > 0) return path.join(envOverride, 'settings.json');
  return path.join(os.homedir(), '.duya', 'settings.json');
}

/**
 * Login items are an OS-level registration against an INSTALLED application.
 * A headless control plane has no installed app to register, and the existing
 * `!app.isPackaged` early-out already reports that honestly by returning
 * false — the same answer a dev checkout gives. Requiring `app` to be present
 * before answering keeps "not supported" from becoming a crash.
 */
function isPackagedHost(): ElectronApp | undefined {
  const app = electronApp();
  return app && app.isPackaged ? app : undefined;
}

// =============================================================================
// Settings helpers (auto-start, etc.)
// =============================================================================

export interface SettingsData {
  auto_start?: boolean;
  [key: string]: unknown;
}

export function getSettings(): SettingsData {
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

export function saveSettings(settings: SettingsData): void {
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

export function getAutoStartFromSettings(): boolean {
  return getSettings().auto_start === true;
}

export function setAutoStartToSettings(enabled: boolean): void {
  const settings = getSettings();
  settings.auto_start = enabled;
  saveSettings(settings);
}

/**
 * Check if the app was launched as a hidden login item (system login auto-start).
 * On Windows: checks for --hidden in process.argv
 * On macOS: uses app.getLoginItemSettings().wasOpenedAsHidden
 */
export function wasLaunchedAsHidden(): boolean {
  const app = isPackagedHost();
  if (!app) return false;
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
export function setAutoStart(enabled: boolean): boolean {
  const app = isPackagedHost();
  if (!app) return false;

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