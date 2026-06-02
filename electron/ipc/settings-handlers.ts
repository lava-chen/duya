/**
 * ipc/settings-handlers.ts - Settings-related IPC handlers
 *
 * Handlers for:
 * - Auto-start settings
 * - Browser extension status
 * - Agent re-initialization
 */

import { ipcMain, app } from 'electron';
import { getLogger, LogComponent } from '../logging/logger';
import { getConfigManager, toLLMProvider } from '../config/manager';
import { getAgentProcessPool } from '../agents/process-pool/agent-process-pool';
import {
  getBrowserExtensionStatus,
  setAllowedExtensionIds,
  getAllowedExtensionIds,
  approvePendingExtensionApproval,
  denyPendingExtensionApproval,
  setOnAutoApprovedExtensionId,
} from '../services/browser/daemon';
import { getDatabase } from './db-handlers';
import { setAutoStart, getAutoStartFromSettings, setAutoStartToSettings } from '../services/auto-start';
import {
  getGatewayProxyConfig,
  setGatewayProxyConfig,
  GatewayProxyConfig,
  getJsonSetting,
  setJsonSetting,
} from '../db/queries/settings';

const BROWSER_EXTENSION_ALLOWED_IDS_KEY = 'browserExtensionAllowedIds';
let allowedExtensionIdsLoaded = false;

function normalizeExtensionIds(ids: string[]): string[] {
  return Array.from(new Set(
    ids
      .filter((id) => typeof id === 'string')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  ));
}

function ensureAllowedExtensionIdsLoaded(): void {
  if (allowedExtensionIdsLoaded) return;
  const persisted = getJsonSetting<string[]>(BROWSER_EXTENSION_ALLOWED_IDS_KEY, []);
  const normalized = normalizeExtensionIds(Array.isArray(persisted) ? persisted : []);
  setAllowedExtensionIds(normalized);
  allowedExtensionIdsLoaded = true;
}

function persistAllowedExtensionIds(ids: string[]): void {
  const normalized = normalizeExtensionIds(ids);
  setAllowedExtensionIds(normalized);
  setJsonSetting(BROWSER_EXTENSION_ALLOWED_IDS_KEY, normalized);
}

function syncAllowedExtensionIdsToSettings(): void {
  const runtimeIds = normalizeExtensionIds(getAllowedExtensionIds());
  const persistedIds = normalizeExtensionIds(
    getJsonSetting<string[]>(BROWSER_EXTENSION_ALLOWED_IDS_KEY, []),
  );
  if (runtimeIds.length !== persistedIds.length || runtimeIds.some((id, index) => id !== persistedIds[index])) {
    persistAllowedExtensionIds(runtimeIds);
  }
}

export function registerSettingsHandlers(): void {
  // Persist auto-approved extension IDs immediately
  setOnAutoApprovedExtensionId((extensionId: string) => {
    ensureAllowedExtensionIdsLoaded();
    const current = getAllowedExtensionIds();
    if (!current.includes(extensionId)) {
      current.push(extensionId);
    }
    persistAllowedExtensionIds(current);
  });

  // Auto-start settings
  ipcMain.handle('settings:set-auto-start', async (_event, enabled: boolean) => {
    try {
      const success = setAutoStart(enabled);
      if (success) {
        setAutoStartToSettings(enabled);
      }
      return { success, supported: process.platform !== 'linux' };
    } catch (error) {
      const logger = getLogger();
      logger.error('Failed to set auto-start', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Settings);
      return { success: false, supported: process.platform !== 'linux', error: String(error) };
    }
  });

  ipcMain.handle('settings:get-auto-start-status', async () => {
    try {
      const loginItemSettings = app.getLoginItemSettings();
      const dbValue = getAutoStartFromSettings();
      const isSupported = process.platform !== 'linux';

      const isEnabled = process.platform === 'win32'
        ? loginItemSettings.openAtLogin
        : loginItemSettings.openAtLogin;

      return {
        enabled: isEnabled,
        dbValue,
        canChange: app.isPackaged && isSupported,
        supported: isSupported,
        platform: process.platform,
      };
    } catch (error) {
      const logger = getLogger();
      logger.error('Failed to get auto-start status', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Settings);
      return { enabled: false, canChange: false, supported: false, platform: process.platform, error: String(error) };
    }
  });

  // Browser extension status
  ipcMain.handle('browser-extension:get-status', async () => {
    try {
      ensureAllowedExtensionIdsLoaded();
      syncAllowedExtensionIdsToSettings();
      const status = getBrowserExtensionStatus();
      return { success: true, status };
    } catch (error) {
      const logger = getLogger();
      logger.error('Failed to get browser extension status', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('browser-extension:approve-pending', async () => {
    try {
      ensureAllowedExtensionIdsLoaded();
      const approvalResult = approvePendingExtensionApproval();
      if (!approvalResult.success) {
        return { success: false, error: approvalResult.error, status: getBrowserExtensionStatus() };
      }

      persistAllowedExtensionIds(getAllowedExtensionIds());
      return { success: true, status: getBrowserExtensionStatus() };
    } catch (error) {
      const logger = getLogger();
      logger.error('Failed to approve pending browser extension', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Settings);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('browser-extension:deny-pending', async () => {
    try {
      ensureAllowedExtensionIdsLoaded();
      denyPendingExtensionApproval();
      return { success: true, status: getBrowserExtensionStatus() };
    } catch (error) {
      const logger = getLogger();
      logger.error('Failed to deny pending browser extension', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Settings);
      return { success: false, error: String(error) };
    }
  });

  // Agent re-initialization with new provider
  ipcMain.handle('agent:reinit-provider', async () => {
    try {
      const configManager = getConfigManager();
      const activeProvider = configManager.getActiveProvider();

      if (!activeProvider) {
        const logger = getLogger();
        logger.info('agent:reinit-provider: No active provider found', undefined, LogComponent.Main);
        return { success: false, reason: 'no_active_provider' };
      }

      const logger = getLogger();
      logger.info('Re-initializing agent with provider', { providerType: activeProvider.providerType, baseUrl: activeProvider.baseUrl }, LogComponent.Main);

      const agentPool = getAgentProcessPool();
      const status = agentPool.getStatus();
      const db = getDatabase();

      // Get blocked domains from settings
      let blockedDomains: string[] = [];
      try {
        const blockedRow = db?.prepare("SELECT value FROM settings WHERE key = 'blockedDomains'").get() as { value: string } | undefined;
        if (blockedRow?.value) {
          blockedDomains = JSON.parse(blockedRow.value);
        }
      } catch {}

      // Get sandbox enabled setting
      let sandboxEnabled = true;
      try {
        const sandboxRow = db?.prepare("SELECT value FROM settings WHERE key = 'sandboxEnabled'").get() as { value: string } | undefined;
        if (sandboxRow?.value !== undefined) {
          sandboxEnabled = sandboxRow.value === 'true';
        }
      } catch {}

      for (const proc of status.processes) {
        const sessionRow = db?.prepare('SELECT working_directory, system_prompt FROM chat_sessions WHERE id = ?').get(proc.sessionId) as { working_directory: string; system_prompt: string } | undefined;
        const workingDirectory = sessionRow?.working_directory ?? '';
        const systemPrompt = sessionRow?.system_prompt || '';

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
      const logger = getLogger();
      logger.error('agent:reinit-provider failed', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Main);
      return { success: false, reason: String(error) };
    }
  });

  // Gateway per-channel proxy configuration
  ipcMain.handle('settings:get-gateway-proxy-config', async () => {
    try {
      const config = getGatewayProxyConfig();
      return { success: true, config };
    } catch (error) {
      const logger = getLogger();
      logger.error('Failed to get gateway proxy config', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Settings);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('settings:set-gateway-proxy-config', async (_event, config: GatewayProxyConfig) => {
    try {
      setGatewayProxyConfig(config);
      return { success: true };
    } catch (error) {
      const logger = getLogger();
      logger.error('Failed to set gateway proxy config', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Settings);
      return { success: false, error: String(error) };
    }
  });
}
