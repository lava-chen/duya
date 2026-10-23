/**
 * ipc/settings-handlers.ts - Settings-related IPC handlers
 *
 * Handlers for:
 * - Auto-start settings
 * - Agent re-initialization
 */

import { ipcMain, app } from 'electron';
import { getLogger, LogComponent } from '../logging/logger';
import { getAgentProcessPool } from '../agents/process-pool/agent-process-pool';
import { getProviderStore } from '../services/providers/provider-store-electron';
import { resolveLlmClientDiscriminator } from '@duya/ai';
import { setAutoStart, getAutoStartFromSettings, setAutoStartToSettings } from '../services/auto-start';
import {
  getDesktopHostLocalSessionApi,
  getDesktopHostLocalSettingsApi,
} from '../cli/desktop-host-api';
import { getConfigStore } from '../config/store-instance';
import { GatewayProxyConfig } from '../gateway/types';
import { emitGatewayConfigChanged } from '../gateway/config-events';

function parseJsonSetting<T>(value: string | null, defaultValue: T): T {
  if (value === null) return defaultValue;
  try { return JSON.parse(value) as T; } catch { return defaultValue; }
}

const HOST_LOCAL_TOOL_PERMISSION_KEY = 'host.localToolPermission';
const HOST_LOCAL_TOOL_PERMISSIONS = new Set(['ask', 'always', 'never']);

function isHostLocalToolPermission(value: unknown): value is 'ask' | 'always' | 'never' {
  return typeof value === 'string' && HOST_LOCAL_TOOL_PERMISSIONS.has(value);
}

async function getHostLocalToolPermission(): Promise<'ask' | 'always' | 'never'> {
  const raw = await getDesktopHostLocalSettingsApi().getSetting(HOST_LOCAL_TOOL_PERMISSION_KEY);
  const value = parseJsonSetting<unknown>(raw, 'ask');
  return isHostLocalToolPermission(value) ? value : 'ask';
}

async function setHostLocalToolPermission(value: 'ask' | 'always' | 'never'): Promise<void> {
  if (!isHostLocalToolPermission(value)) {
    throw new Error(`Invalid host tool permission: ${String(value)}`);
  }
  await getDesktopHostLocalSettingsApi().setSetting(
    HOST_LOCAL_TOOL_PERMISSION_KEY,
    JSON.stringify(value),
  );
}

export function registerSettingsHandlers(): void {
  // Plan 453 Task H: Wake Agent settings (config.toml [wake] section).
  ipcMain.handle('settings:get-wake-config', async () => {
    const configStore = getConfigStore();
    return {
      enabled: (configStore.getByPath('wake.enabled') ?? true) as boolean,
      shortcut:
        (configStore.getByPath('wake.shortcut') as string | undefined) ??
        'Shift+=',
      injectOsContext: (configStore.getByPath('wake.inject_os_context') ??
        true) as boolean,
      autoCollapseMs: (configStore.getByPath('wake.auto_collapse_ms') ??
        60_000) as number,
      orb: (configStore.getByPath('wake.orb') as
        | { x: number; y: number; displayId: number }
        | undefined) ?? { x: 100, y: 100, displayId: 0 },
    };
  });

  ipcMain.handle(
    'settings:set-wake-config',
    async (
      _event,
      payload: {
        enabled?: boolean;
        shortcut?: string;
        injectOsContext?: boolean;
        autoCollapseMs?: number;
        orb?: { x: number; y: number; displayId: number };
      },
    ) => {
      const configStore = getConfigStore();
      if (payload.enabled !== undefined) {
        configStore.set('wake.enabled', payload.enabled);
      }
      if (payload.shortcut !== undefined) {
        configStore.set('wake.shortcut', payload.shortcut);
      }
      if (payload.injectOsContext !== undefined) {
        configStore.set('wake.inject_os_context', payload.injectOsContext);
      }
      if (payload.autoCollapseMs !== undefined) {
        configStore.set('wake.auto_collapse_ms', payload.autoCollapseMs);
      }
      if (payload.orb !== undefined) {
        configStore.set('wake.orb', payload.orb);
      }
      return { ok: true };
    },
  );

  // Plan 453 Task H: persist orb position (called when the user drags
  // the ball; the renderer can debounce these calls).
  ipcMain.handle(
    'settings:set-orb-position',
    async (
      _event,
      payload: { x: number; y: number; displayId: number },
    ) => {
      getConfigStore().set('wake.orb', payload);
      return { ok: true };
    },
  );

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

  // Memory system toggle (settings → Memory section).
  // Writes config.toml `memory.memory_enabled` (the value every consumer
  // reads: boot worker gate, agent-server lifecycle env, process-pool env)
  // AND hot-pauses/resumes/hot-starts the running worker, so the toggle
  // takes effect immediately without an app restart. The renderer still
  // mirrors the value into the SQLite settings table via useSettings.save
  // for its own read-back; boot alignment (syncMemoryToggleFromSettingsDb)
  // treats SQLite as the intent source when the stores ever disagree.
  ipcMain.handle('settings:get-memory-enabled', async () => {
    try {
      return {
        success: true,
        enabled: getConfigStore().getByPath('memory.memory_enabled') === true,
      };
    } catch (error) {
      return { success: false, enabled: false, error: String(error) };
    }
  });

  ipcMain.handle('settings:set-memory-enabled', async (_event, enabled: boolean) => {
    try {
      const configStore = getConfigStore();
      configStore.set('memory.memory_enabled', enabled === true);

      const { getMemoryWorkerHandle } = await import('../memory/memory-worker');
      const handle = getMemoryWorkerHandle();
      if (enabled) {
        if (handle) {
          if (handle.isPaused()) handle.resume();
          return { ok: true, worker: 'resumed' };
        }
        const { startMemoryWorkerFromConfig } = await import('../memory/worker-bootstrap');
        const outcome = await startMemoryWorkerFromConfig();
        return { ok: true, worker: outcome };
      }
      if (handle) {
        handle.pause();
        return { ok: true, worker: 'paused' };
      }
      return { ok: true, worker: 'not-running' };
    } catch (error) {
      const logger = getLogger();
      logger.error('Failed to set memory enabled', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Settings);
      return { ok: false, error: String(error) };
    }
  });

  // Agent re-initialization with new provider
  ipcMain.handle('agent:reinit-provider', async () => {
    try {
      const store = getProviderStore();
      const activeLlm = store.getActiveLlmProvider();

      if (!activeLlm) {
        const logger = getLogger();
        logger.info('agent:reinit-provider: No active provider found', undefined, LogComponent.Main);
        return { success: false, reason: 'no_active_provider' };
      }

      const modelId =
        (activeLlm.options?.defaultModel as string) ||
        (activeLlm.options?.model as string) ||
        '';
      const cfg = await store.getActiveProviderRuntimeConfig(modelId);
      if ('error' in cfg) {
        const logger = getLogger();
        logger.info('agent:reinit-provider: active provider runtime config unavailable', { code: cfg.code }, LogComponent.Main);
        return { success: false, reason: cfg.code };
      }

      const logger = getLogger();
      logger.info('Re-initializing agent with provider', { providerId: cfg.providerId, apiFormat: cfg.apiFormat, baseUrl: cfg.baseUrl }, LogComponent.Main);

      const agentPool = getAgentProcessPool();
      const status = agentPool.getStatus();
      // Get sandbox enabled setting
      let sandboxEnabled = true;
      try {
        const value = await getDesktopHostLocalSettingsApi().getSetting('sandboxEnabled');
        if (value !== null) {
          sandboxEnabled = value === 'true';
        }
      } catch {}

      const localSessions = getDesktopHostLocalSessionApi();
      for (const proc of status.processes) {
        // Plan 328 Phase 5: replaced the legacy
        // `SELECT working_directory, system_prompt FROM chat_sessions`
        // with the Host's authenticated local session projection.
        // `system_prompt` lives in the `extensions` JSON column.
        const session = await localSessions.readLocalSession(proc.sessionId);
        const workingDirectory = session?.workingDirectory ?? '';
        const systemPromptValue = session?.extensions.system_prompt;
        const systemPrompt = typeof systemPromptValue === 'string' ? systemPromptValue : '';

        agentPool.send(proc.sessionId, {
          type: 'init',
          sessionId: proc.sessionId,
          providerConfig: {
            provider: resolveLlmClientDiscriminator(cfg.apiFormat),
            apiKey: cfg.apiKey ?? '',
            baseURL: cfg.baseUrl,
            model: cfg.model,
            authStyle: cfg.accessToken ? 'auth_token' : 'api_key',
            runtimeConfig: cfg,
          },
          workingDirectory,
          systemPrompt,
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

  // Plan 487: host-level standing permission switch (3-state: ask/always/never).
  ipcMain.handle('settings:get-host-tool-permission', async () => {
    try {
      return { success: true, value: await getHostLocalToolPermission() };
    } catch (error) {
      const logger = getLogger();
      logger.error('Failed to read host tool permission', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Settings);
      return { success: false, value: 'ask', error: String(error) };
    }
  });

  // Plan 487: persist the new value and trigger agent re-init so the
  // change applies to running sessions without an app restart.
  ipcMain.handle('settings:set-host-tool-permission', async (_event, value: 'ask' | 'always' | 'never') => {
    try {
      await setHostLocalToolPermission(value);
      const logger = getLogger();
      logger.info(`Host tool permission set to: ${value}`, undefined, LogComponent.Settings);

      try {
        await ipcMain.emit('agent:reinit-provider');
      } catch {
        logger.warn(
          'agent:reinit-provider after host permission change failed (will take effect on next session)',
          undefined,
          LogComponent.Settings,
        );
      }
      return { success: true, value };
    } catch (error) {
      const logger = getLogger();
      logger.error('Failed to set host tool permission', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Settings);
      return { success: false, error: String(error) };
    }
  });

  // Gateway per-channel proxy configuration
  ipcMain.handle('settings:get-gateway-proxy-config', async () => {
    try {
      const raw = getConfigStore().getByPath('gateway_proxy') as { global_enabled?: boolean; channels?: Record<string, boolean> } | undefined;
      const config: GatewayProxyConfig = {
        globalEnabled: raw?.global_enabled ?? true,
        channels: raw?.channels ?? {},
      };
      return { success: true, config };
    } catch (error) {
      const logger = getLogger();
      logger.error('Failed to get gateway proxy config', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Settings);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('settings:set-gateway-proxy-config', async (_event, config: GatewayProxyConfig) => {
    try {
      getConfigStore().set('gateway_proxy', {
        global_enabled: config.globalEnabled === true,
        channels: config.channels ?? {},
      });
      emitGatewayConfigChanged('settings:set-gateway-proxy-config');
      return { success: true };
    } catch (error) {
      const logger = getLogger();
      logger.error('Failed to set gateway proxy config', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Settings);
      return { success: false, error: String(error) };
    }
  });
}
