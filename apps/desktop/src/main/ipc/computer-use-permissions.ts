/**
 * computer-use-permissions.ts — macOS TCC permission surface (plan 572
 * Phase 1). Channels:
 *
 *   computer-use:permissions:get       → TCC snapshot via the AX helper
 *                                        (`permissions` op) + helper
 *                                        presence; null data on Windows
 *                                        (the UI hides itself there).
 *   computer-use:permissions:open      → open the matching System
 *                                        Settings pane (deep link).
 *
 * The dialog the OS shows grants nothing by itself — the user must
 * toggle the app in the pane, and Screen Recording needs a full app
 * restart. That guidance lives in the UI card (MacPermissionsCard);
 * this handler only reads state and opens panes.
 */

import { ipcMain } from 'electron';
import { execFile } from 'node:child_process';

import { getSharedAxHelperClient } from '../services/recorder/ax-helper.js';
import { getLogger, LogComponent } from '../logging/logger.js';

const logger = getLogger();

export interface ComputerUsePermissionsSnapshot {
  platform: NodeJS.Platform;
  /** True when the helper binary exists and answered. */
  helperAvailable: boolean;
  accessibility: 'granted' | 'denied' | 'not-determined' | 'unknown';
  screen: 'granted' | 'denied' | 'not-determined' | 'unknown';
  listen: 'granted' | 'denied' | 'not-determined' | 'unknown';
  /** PID holding Secure Input, or null when off / unknown. */
  secureInputPid: number | null;
}

const UNKNOWN_SNAPSHOT: ComputerUsePermissionsSnapshot = {
  platform: process.platform,
  helperAvailable: false,
  accessibility: 'unknown',
  screen: 'unknown',
  listen: 'unknown',
  secureInputPid: null,
};

/** System Settings deep links (Privacy & Security panes). */
const SETTINGS_PANES: Record<string, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  listen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
};

export function registerComputerUsePermissionsHandlers(): void {
  ipcMain.handle('computer-use:permissions:get', async (): Promise<ComputerUsePermissionsSnapshot> => {
    if (process.platform !== 'darwin') {
      return UNKNOWN_SNAPSHOT;
    }
    try {
      const helper = getSharedAxHelperClient();
      await helper.ensureStarted();
      const permissions = await helper.permissions();
      if (permissions === null) {
        return { ...UNKNOWN_SNAPSHOT, helperAvailable: false };
      }
      return {
        platform: process.platform,
        helperAvailable: true,
        accessibility: permissions.accessibility,
        screen: permissions.screen,
        listen: permissions.listen,
        secureInputPid: permissions.secureInputPid ?? null,
      };
    } catch (err) {
      logger.warn(
        'computer-use:permissions:get failed',
        { error: err instanceof Error ? err.message : String(err) },
        LogComponent.ComputerUse,
      );
      return UNKNOWN_SNAPSHOT;
    }
  });

  ipcMain.handle('computer-use:permissions:open', async (_event, pane: string): Promise<boolean> => {
    const url = SETTINGS_PANES[pane];
    if (!url || process.platform !== 'darwin') {
      return false;
    }
    return new Promise((resolve) => {
      execFile('open', [url], { timeout: 5_000 }, (err) => {
        if (err) {
          logger.warn('computer-use:permissions:open failed', { pane }, LogComponent.ComputerUse);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  });
}
