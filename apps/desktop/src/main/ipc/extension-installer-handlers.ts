/**
 * ipc/extension-installer-handlers.ts
 *
 * IPC bridge for the one-click extension install feature (plan 532).
 * Exposes three calls to the renderer:
 *
 *   - `extensionInstaller:detect`    → DetectLocalExtensionResult
 *   - `extensionInstaller:install`   → InstallLocalExtensionResult
 *   - `extensionInstaller:uninstall` → UninstallLocalExtensionResult
 *
 * After a successful `install` we also push the production extension ID
 * into the daemon's allowed-id whitelist so the bridge hello protocol is
 * accepted without a manual approval step on first connection.
 *
 * @see docs/exec-plans/active/532-one-click-extension-install.md
 */

import { ipcMain } from 'electron';

import { getLogger, LogComponent } from '../logging/logger';
import {
  detectLocalExtension,
  installLocalExtension,
  uninstallLocalExtension,
  DUYA_BRIDGE_EXTENSION_ID,
} from '../services/browser/extension-installer';
import {
  getAllowedExtensionIds,
  setAllowedExtensionIds,
} from '../services/browser/daemon';
import { getJsonSetting, setJsonSetting } from '../db/queries/settings';

const logger = getLogger();

const BROWSER_EXTENSION_ALLOWED_IDS_KEY = 'browserExtensionAllowedIds';

function persistAllowedExtensionIds(ids: string[]): void {
  setJsonSetting(BROWSER_EXTENSION_ALLOWED_IDS_KEY, ids);
}

/**
 * Whitelist the production extension ID in the daemon's in-memory allow
 * list and persist it to settings so future DUYA boots accept it without
 * user re-approval. Called right after a successful install so the
 * bridge hello protocol lands in `verified`, not `pendingApproval`.
 */
function autoApproveInstalledExtensionId(): void {
  const current = getAllowedExtensionIds();
  if (current.includes(DUYA_BRIDGE_EXTENSION_ID)) return;
  const next = [...current, DUYA_BRIDGE_EXTENSION_ID];
  setAllowedExtensionIds(next);
  persistAllowedExtensionIds(next);
  logger.info(
    `[extensionInstaller] Whitelisted ${DUYA_BRIDGE_EXTENSION_ID} after local install`,
    undefined,
    LogComponent.BrowserDaemon,
  );
}

export function registerExtensionInstallerHandlers(): void {
  ipcMain.handle('extensionInstaller:detect', async () => {
    try {
      return await detectLocalExtension();
    } catch (error) {
      logger.error(
        '[extensionInstaller] detect failed',
        error instanceof Error ? error : new Error(String(error)),
        undefined,
        LogComponent.BrowserDaemon,
      );
      return {
        state: 'unsupported',
        expectedVersion: '',
        installedVersion: null,
        expectedPath: null,
        installedIn: [],
      };
    }
  });

  ipcMain.handle('extensionInstaller:install', async () => {
    const result = await installLocalExtension();
    if (result.ok) {
      autoApproveInstalledExtensionId();
    }
    return result;
  });

  ipcMain.handle('extensionInstaller:uninstall', async () => {
    return uninstallLocalExtension();
  });

  logger.debug(
    '[extensionInstaller] IPC handlers registered',
    undefined,
    LogComponent.BrowserDaemon,
  );
}

/**
 * Re-export so test code can verify the auto-approve side effect without
 * needing to drive the IPC channel itself.
 */
export const __extensionInstallerTestHooks = {
  autoApproveInstalledExtensionId,
  // Make sure the persisted allow-list key is the same the daemon reads
  // — defensive assertion in tests, since both modules could drift.
  BROWSER_EXTENSION_ALLOWED_IDS_KEY,
};
