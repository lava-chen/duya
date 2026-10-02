import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { initLogger, getLogger, LogComponent } from '../logging/logger';

const logger = initLogger({ level: 'WARN' });

// =============================================================================
// Settings helpers (auto-start, etc.)
// =============================================================================

export interface SettingsData {
  auto_start?: boolean;
  [key: string]: unknown;
}

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
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
export function setAutoStart(enabled: boolean): boolean {
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