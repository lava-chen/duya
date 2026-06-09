/**
 * agent-communicator.ts - Thin IPC handler layer for Agent communication
 *
 * Registers IPC handlers that delegate to db-bridge.ts for business logic.
 * This file is the entry point for agent-related IPC in electron/main.ts.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { getAgentProcessPool } from './process-pool/agent-process-pool';
import { getConfigManager, toLLMProvider, type ApiProvider } from '../config/manager';
import { getDatabase } from '../ipc/db-handlers';
import { getLogger, LogComponent } from '../logging/logger';
import { dispatchDbAction, handleDbRequest as processDbRequest, type DbRequest, type DbResponse } from './db-bridge';
import { getProviderStore } from '../services/providers/provider-store-electron';
import {
  toRuntimeConfig as buildRuntimeConfig,
  normalizeBaseUrl,
  inferApiFormatFromLegacyProviderType,
  redactSecrets,
} from '../../src/lib/providers';

// Re-export for backward compatibility
export { dispatchDbAction, handleDbRequest as handleDbRequest, type DbRequest, type DbResponse } from './db-bridge';

/**
 * Get default model name based on provider type
 */
function getDefaultModelForProvider(providerType: ApiProvider['providerType'], options?: Record<string, unknown>): string {
  if (options) {
    const optModel = (options as Record<string, unknown>).defaultModel || (options as Record<string, unknown>).model;
    if (typeof optModel === 'string' && optModel.length > 0) {
      return optModel;
    }
  }

  switch (providerType) {
    case 'ollama':
      return 'llama3.2';
    case 'openai':
    case 'openai-compatible':
    case 'openrouter':
    case 'google':
    case 'gemini-image':
      return 'gpt-4o';
    case 'anthropic':
    case 'bedrock':
    case 'vertex':
      return 'claude-sonnet-4-20250514';
    default:
      return '';
  }
}

// Broadcast event to all renderer windows
function broadcastToRenderers(channel: string, ...args: unknown[]): void {
  const windows = BrowserWindow.getAllWindows();
  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, ...args);
    }
  }
}

// Register Agent-specific IPC handlers
export function registerAgentHandlers(): void {
  // Handler for agent to send notifications to renderer
  ipcMain.handle('agent:notify', (_event, data: { type: string; payload: unknown }) => {
    getLogger().info('Notification', { type: data.type, payload: data.payload }, LogComponent.AgentCommunicator);
    broadcastToRenderers('agent:event', data);
  });

  // Handler to check if agent is running
  ipcMain.handle('agent:isRunning', () => {
    const pool = getAgentProcessPool();
    return pool.isRunning('');
  });

  // Handler to get agent provider config for initializing agent subprocess
  ipcMain.handle('agent:getProviderConfig', (_event, sessionId: string) => {
    const configManager = getConfigManager();
    const db = getDatabase();
    const store = getProviderStore();
    store.migrateAllLegacyProviders();

    const session = db?.prepare('SELECT provider_id, model FROM chat_sessions WHERE id = ?').get(sessionId) as { provider_id: string | null; model: string | null } | undefined;

    let provider = session?.provider_id
      ? configManager.getAllProviders()[session.provider_id]
      : null;

    if (!provider) {
      provider = configManager.getActiveProvider() || null;
    }

    if (!provider) return null;

    const defaultModel = getDefaultModelForProvider(provider.providerType, provider.options);

    // Build runtime config via the store for new agent code paths.
    const llm = store.getLlmProvider(provider.id);
    let runtimeConfig: Record<string, unknown> | undefined;
    if (llm) {
      const cfg = buildRuntimeConfig(llm, {
        modelId: session?.model || defaultModel,
      });
      runtimeConfig = {
        providerId: cfg.providerId,
        apiFormat: cfg.apiFormat,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        accessToken: cfg.accessToken,
        headers: cfg.headers,
        model: cfg.model,
        requestOptions: cfg.requestOptions,
      };
    }

    return {
      apiKey: provider.apiKey,
      baseURL: provider.baseUrl || undefined,
      model: session?.model || defaultModel,
      provider: toLLMProvider(provider.providerType),
      // Phase 2: include the runtime config so the agent can adopt
      // the new path when ready.
      runtimeConfig,
    };
  });

  // Handler to get masked provider config for renderer (no API key exposure)
  ipcMain.handle('agent:getMaskedProviderConfig', (_event, sessionId: string) => {
    const configManager = getConfigManager();
    const db = getDatabase();

    const session = db?.prepare('SELECT provider_id, model FROM chat_sessions WHERE id = ?').get(sessionId) as { provider_id: string | null; model: string | null } | undefined;

    let provider = session?.provider_id
      ? configManager.getAllProviders()[session.provider_id]
      : null;

    if (!provider) {
      provider = configManager.getActiveProvider() || null;
    }

    if (!provider) return null;

    const key = provider.apiKey;
    const maskedKey = key.length <= 8 ? '***' : key.slice(0, 4) + '***' + key.slice(-4);

    return {
      apiKey: maskedKey,
      baseURL: provider.baseUrl || undefined,
      model: session?.model || '',
      provider: provider.providerType,
    };
  });

  // Helper to mask API key in provider for renderer
  function maskProvider(provider: ApiProvider): Record<string, unknown> {
    const key = provider.apiKey;
    const hasKey = !!key && key.length > 0;
    const maskedKey = hasKey && key.length > 8 ? key.slice(0, 4) + '***' + key.slice(-4) : (hasKey ? '***' : '');
    return {
      id: provider.id,
      name: provider.name,
      providerType: provider.providerType,
      baseUrl: provider.baseUrl ?? '',
      apiKey: maskedKey,
      isActive: provider.isActive,
      hasApiKey: hasKey,
      sortOrder: provider.sortOrder ?? 0,
      extraEnv: JSON.stringify(provider.extraEnv ?? {}),
      protocol: provider.providerType,
      headers: JSON.stringify(provider.headers ?? {}),
      options: JSON.stringify(provider.options ?? {}),
      notes: provider.notes ?? '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  // Get all providers (masked)
  ipcMain.handle('config:provider:getAll', () => {
    const configManager = getConfigManager();
    const providers = configManager.getAllProviders();
    const masked = Object.values(providers).map(maskProvider);
    getLogger().info('config:provider:getAll', { count: masked.length }, LogComponent.AgentCommunicator);
    return masked;
  });

  // Get provider by ID (masked)
  ipcMain.handle('config:provider:get', (_event, id: string) => {
    const configManager = getConfigManager();
    const provider = configManager.getAllProviders()[id];
    return provider ? maskProvider(provider) : null;
  });

  // Get active provider (masked)
  ipcMain.handle('config:provider:getActive', () => {
    const configManager = getConfigManager();
    const provider = configManager.getActiveProvider();
    return provider ? maskProvider(provider) : null;
  });

  // Get active provider with full API key (for agent initialization)
  //
  // Phase 2: this handler now derives a ProviderRuntimeConfig via
  // `ProviderStore` + `ProviderRuntimeAdapter`. The legacy fields
  // (`provider` / `providerType` / `authStyle`) are still populated so
  // the existing agent runtime keeps working. New agent code should
  // prefer the `runtimeConfig` field.
  ipcMain.handle('config:provider:getActiveProviderConfig', () => {
    const configManager = getConfigManager();
    const store = getProviderStore();
    store.migrateAllLegacyProviders();

    const provider = configManager.getActiveProvider();
    if (!provider) return null;

    const model = (provider.options?.defaultModel as string) ||
      (provider.options?.model as string) ||
      (Array.isArray(provider.options?.enabled_models) && (provider.options?.enabled_models as string[])[0]) ||
      '';

    // Derive the runtime config from the migrated LlmProvider so the
    // new path is exercised on every Chat call.
    const llm = store.getActiveLlmProvider();
    let runtimeConfig: Record<string, unknown> | null = null;
    if (llm) {
      const cfg = buildRuntimeConfig(llm, { modelId: model });
      runtimeConfig = {
        providerId: cfg.providerId,
        providerName: cfg.providerName,
        apiFormat: cfg.apiFormat,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        accessToken: cfg.accessToken,
        headers: cfg.headers,
        model: cfg.model,
        requestOptions: cfg.requestOptions,
      };
    }

    return {
      // Legacy fields (kept for backward compat with existing agent runtime).
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl || undefined,
      providerType: provider.providerType,
      model,
      provider: toLLMProvider(provider.providerType),
      authStyle: 'api_key' as const,
      // New (Phase 2) field. Agent runtime can migrate at its own pace.
      runtimeConfig,
    };
  });

  // Get provider config by ID with unmasked API key (for title generation model resolution)
  ipcMain.handle('config:provider:getConfig', (_event, providerId: string, model: string) => {
    const configManager = getConfigManager();
    const provider = configManager.getAllProviders()[providerId];
    if (!provider) return null;

    // Build the same runtime config shape on this path too.
    const store = getProviderStore();
    store.migrateAllLegacyProviders();
    const llm = store.getLlmProvider(providerId);
    let runtimeConfig: Record<string, unknown> | null = null;
    if (llm) {
      const cfg = buildRuntimeConfig(llm, { modelId: model || '' });
      runtimeConfig = {
        providerId: cfg.providerId,
        providerName: cfg.providerName,
        apiFormat: cfg.apiFormat,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        accessToken: cfg.accessToken,
        headers: cfg.headers,
        model: cfg.model,
        requestOptions: cfg.requestOptions,
      };
    }

    return {
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl || undefined,
      model: model || '',
      provider: toLLMProvider(provider.providerType),
      authStyle: 'api_key' as const,
      runtimeConfig,
    };
  });

  // Upsert provider
  ipcMain.handle('config:provider:upsert', (_event, data: ApiProvider) => {
    const configManager = getConfigManager();
    configManager.upsertProvider(data);
    return maskProvider(data);
  });

  // Update provider (partial update)
  ipcMain.handle('config:provider:update', (_event, id: string, data: Partial<ApiProvider>) => {
    const configManager = getConfigManager();
    const existing = configManager.getAllProviders()[id];
    if (!existing) return null;
    const updated = { ...existing, ...data, id };
    configManager.upsertProvider(updated);
    return maskProvider(updated);
  });

  // Delete provider
  ipcMain.handle('config:provider:delete', (_event, id: string) => {
    const configManager = getConfigManager();
    return configManager.deleteProvider(id);
  });

  // Activate provider
  ipcMain.handle('config:provider:activate', (_event, id: string) => {
    const configManager = getConfigManager();
    configManager.activateProvider(id);
    const provider = configManager.getAllProviders()[id];
    return provider ? maskProvider(provider) : null;
  });

  // ==================== Output Style handlers ====================
  ipcMain.handle('config:style:getAll', () => {
    const configManager = getConfigManager();
    const styles = configManager.getOutputStyles();
    return Object.values(styles);
  });

  ipcMain.handle('config:style:get', (_event, id: string) => {
    const configManager = getConfigManager();
    const styles = configManager.getOutputStyles();
    return styles[id] || null;
  });

  ipcMain.handle('config:style:upsert', (_event, data: { id: string; name: string; description?: string; prompt: string; keepCodingInstructions?: boolean }) => {
    const configManager = getConfigManager();
    const result = configManager.upsertOutputStyle({
      id: data.id,
      name: data.name,
      description: data.description,
      prompt: data.prompt,
      keepCodingInstructions: data.keepCodingInstructions,
    });
    return result ? configManager.getOutputStyles()[data.id] : null;
  });

  ipcMain.handle('config:style:delete', (_event, id: string) => {
    const configManager = getConfigManager();
    return configManager.deleteOutputStyle(id);
  });

  // ==================== Vision handlers ====================
  ipcMain.handle('config:vision:get', () => {
    const configManager = getConfigManager();
    return configManager.getVisionSettings();
  });

  ipcMain.handle('config:vision:set', (_event, data: { provider?: string; model?: string; baseUrl?: string; baseURL?: string; apiKey?: string; enabled?: boolean }) => {
    const configManager = getConfigManager();
    const current = configManager.getVisionSettings();
    const merged = {
      ...current,
      ...data,
      // Normalize baseURL/baseUrl -> baseUrl for ConfigManager
      baseUrl: data.baseUrl || data.baseURL || current.baseUrl,
    };
    // Remove baseURL from merged since ConfigManager uses baseUrl
    delete (merged as Record<string, unknown>).baseURL;
    configManager.setConfig('visionSettings', merged, 'renderer');
    return configManager.getVisionSettings();
  });

  getLogger().info('Agent handlers registered', undefined, LogComponent.AgentCommunicator);
}