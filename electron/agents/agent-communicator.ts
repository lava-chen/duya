/**
 * agent-communicator.ts - Thin IPC handler layer for Agent communication
 *
 * Registers IPC handlers that delegate to db-bridge.ts for business logic.
 * This file is the entry point for agent-related IPC in electron/main.ts.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { getAgentProcessPool } from './process-pool/agent-process-pool';
import { toLLMProvider, type ApiProvider } from '../config/provider-types';
import { getCoreStores } from '../db/core-connection';
import { getLogger, LogComponent } from '../logging/logger';
import { dispatchDbAction, handleDbRequest as processDbRequest, type DbRequest, type DbResponse } from './db-bridge';
import { getProviderStore } from '../services/providers/provider-store-electron';
import { getConfigStore } from '../config/store-instance';
import { toLegacyApiProvider, migrateLegacyApiProvider } from '../../src/lib/providers/legacy';
import {
  toRuntimeConfig as buildRuntimeConfig,
  normalizeBaseUrl,
  inferApiFormatFromLegacyProviderType,
  redactSecrets,
} from '../../src/lib/providers';

// Defaults preserved from the legacy ConfigManager so the new
// ConfigStore-backed path returns the same shapes on a fresh store.
const DEFAULT_VISION_SETTINGS: Record<string, string | boolean> = {
  provider: '',
  model: '',
  baseUrl: '',
  apiKey: '',
  enabled: false,
};

const DEFAULT_OUTPUT_STYLES: Record<string, unknown> = {
  normal: {
    id: 'normal',
    name: 'Normal',
    description: 'Default response style',
    prompt: 'Respond in a balanced, natural tone. Provide clear and helpful information without being overly verbose or too terse.',
    keepCodingInstructions: true,
    isBuiltin: true,
  },
  learning: {
    id: 'learning',
    name: 'Learning',
    description: 'Educational and explanatory',
    prompt: 'Adopt an educational tone. Explain concepts thoroughly, break down complex ideas into understandable pieces, and provide examples where helpful. Encourage deep understanding.',
    keepCodingInstructions: true,
    isBuiltin: true,
  },
  concise: {
    id: 'concise',
    name: 'Concise',
    description: 'Brief and to the point',
    prompt: 'Be extremely concise. Give direct answers with minimal exposition. Skip pleasantries and get straight to the point. Only elaborate when explicitly asked.',
    keepCodingInstructions: true,
    isBuiltin: true,
  },
  explanatory: {
    id: 'explanatory',
    name: 'Explanatory',
    description: 'Detailed explanations',
    prompt: 'Provide thorough, detailed explanations for everything. Walk through your reasoning step by step. Include context, alternatives, and trade-offs. Leave no question unanswered.',
    keepCodingInstructions: true,
    isBuiltin: true,
  },
  formal: {
    id: 'formal',
    name: 'Formal',
    description: 'Professional tone',
    prompt: 'Maintain a formal, professional tone. Use precise language, avoid colloquialisms, and structure responses with proper organization. Address the user with respect and professionalism.',
    keepCodingInstructions: true,
    isBuiltin: true,
  },
};

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
    const store = getProviderStore();
    store.migrateAllLegacyProviders();

    // Read provider_id / model from the core sessions store (plan 328).
    const session = getCoreStores().sessions.get(sessionId);

    let provider: ApiProvider | null = null;
    if (session?.providerId) {
      const llm = store.getLlmProvider(session.providerId);
      provider = llm ? toLegacyApiProvider(llm) : null;
    }

    if (!provider) {
      const activeLlm = store.getDefaultLlmProvider();
      provider = activeLlm ? toLegacyApiProvider(activeLlm) : null;
    }

    if (!provider) return null;

    const defaultModel = getDefaultModelForProvider(provider.providerType, provider.options);

    // Build runtime config via the store for new agent code paths.
    const llm = store.getLlmProvider(provider.id);
    let runtimeConfig: Record<string, unknown> | undefined;
    if (llm) {
      const resolvedModelId = session?.model || defaultModel;
      const capability = store.getModelCapability(provider.id, resolvedModelId);
      const cfg = buildRuntimeConfig(llm, {
        modelId: resolvedModelId,
        capabilities: capability,
      });
      runtimeConfig = {
        providerId: cfg.providerId,
        apiFormat: cfg.apiFormat,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        accessToken: cfg.accessToken,
        headers: cfg.headers,
        model: cfg.model,
        modelCapabilities: cfg.modelCapabilities,
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
    const store = getProviderStore();
    store.migrateAllLegacyProviders();

    // Read provider_id / model from the core sessions store (plan 328).
    const session = getCoreStores().sessions.get(sessionId);

    let provider: ApiProvider | null = null;
    if (session?.providerId) {
      const llm = store.getLlmProvider(session.providerId);
      provider = llm ? toLegacyApiProvider(llm) : null;
    }

    if (!provider) {
      const activeLlm = store.getDefaultLlmProvider();
      provider = activeLlm ? toLegacyApiProvider(activeLlm) : null;
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
    const store = getProviderStore();
    store.migrateAllLegacyProviders();
    const masked = store.listLlmProviders().map((llm) => maskProvider(toLegacyApiProvider(llm)));
    getLogger().info('config:provider:getAll', { count: masked.length }, LogComponent.AgentCommunicator);
    return masked;
  });

  // Get provider by ID (masked)
  ipcMain.handle('config:provider:get', (_event, id: string) => {
    const store = getProviderStore();
    store.migrateAllLegacyProviders();
    const llm = store.getLlmProvider(id);
    return llm ? maskProvider(toLegacyApiProvider(llm)) : null;
  });

  // Get active provider (masked)
  ipcMain.handle('config:provider:getActive', () => {
    const store = getProviderStore();
    store.migrateAllLegacyProviders();
    const activeLlm = store.getDefaultLlmProvider();
    const provider = activeLlm ? toLegacyApiProvider(activeLlm) : undefined;
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
    const store = getProviderStore();
    store.migrateAllLegacyProviders();

    const activeLlm = store.getDefaultLlmProvider();
    const provider = activeLlm ? toLegacyApiProvider(activeLlm) : undefined;
    if (!provider) return null;

    // Plan 209 P4-prime: the original implementation only read
    // `options.defaultModel / model / enabled_models[0]` and
    // returned '' if none were set. That meant a freshly-added
    // provider (no options yet) could not be used to start a
    // chat because `stream-session-manager` saw an empty
    // `model` and aborted with "No model configured". We now
    // fall through to `getDefaultModelForProvider` so any
    // anthropic/openai/etc. provider gets a sensible default
    // out of the box. The `options.*` keys still win when set.
    const explicit =
      (provider.options?.defaultModel as string) ||
      (provider.options?.model as string) ||
      (Array.isArray(provider.options?.enabled_models) &&
        (provider.options?.enabled_models as string[])[0]) ||
      '';
    const model = explicit || getDefaultModelForProvider(provider.providerType, provider.options);

    // Derive the runtime config from the migrated LlmProvider so the
    // new path is exercised on every Chat call.
    const llm = store.getActiveLlmProvider();
    let runtimeConfig: Record<string, unknown> | null = null;
    if (llm) {
      const capability = store.getModelCapability(llm.id, model);
      const cfg = buildRuntimeConfig(llm, {
        modelId: model,
        capabilities: capability,
      });
      runtimeConfig = {
        providerId: cfg.providerId,
        providerName: cfg.providerName,
        apiFormat: cfg.apiFormat,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        accessToken: cfg.accessToken,
        headers: cfg.headers,
        model: cfg.model,
        modelCapabilities: cfg.modelCapabilities,
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
    const store = getProviderStore();
    store.migrateAllLegacyProviders();
    const providerLlm = store.getLlmProvider(providerId);
    const provider = providerLlm ? toLegacyApiProvider(providerLlm) : undefined;
    if (!provider) return null;

    // Plan 209 P4-prime: prefer the requested `model`, then fall
    // through to the provider's options, then to the protocol-
    // aware default. Without this fallback, a title model that
    // asks for `minimax-cn:undefined` (e.g. from a stale
    // `title_model` value) silently yields an empty string.
    const resolvedModel =
      model ||
      (provider.options?.defaultModel as string) ||
      (provider.options?.model as string) ||
      (Array.isArray(provider.options?.enabled_models) &&
        (provider.options?.enabled_models as string[])[0]) ||
      getDefaultModelForProvider(provider.providerType, provider.options);

    // Build the same runtime config shape on this path too.
    const llm = store.getLlmProvider(providerId);
    let runtimeConfig: Record<string, unknown> | null = null;
    if (llm) {
      const capability = store.getModelCapability(providerId, resolvedModel);
      const cfg = buildRuntimeConfig(llm, {
        modelId: resolvedModel,
        capabilities: capability,
      });
      runtimeConfig = {
        providerId: cfg.providerId,
        providerName: cfg.providerName,
        apiFormat: cfg.apiFormat,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        accessToken: cfg.accessToken,
        headers: cfg.headers,
        model: cfg.model,
        modelCapabilities: cfg.modelCapabilities,
        requestOptions: cfg.requestOptions,
      };
    }

    return {
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl || undefined,
      model: resolvedModel,
      provider: toLLMProvider(provider.providerType),
      authStyle: 'api_key' as const,
      runtimeConfig,
    };
  });

  // Upsert provider
  ipcMain.handle('config:provider:upsert', (_event, data: ApiProvider) => {
    const store = getProviderStore();
    store.migrateAllLegacyProviders();
    store.upsertLlmProvider(migrateLegacyApiProvider(data));
    return maskProvider(data);
  });

  // Update provider (partial update)
  ipcMain.handle('config:provider:update', (_event, id: string, data: Partial<ApiProvider>) => {
    const store = getProviderStore();
    store.migrateAllLegacyProviders();
    const existingLlm = store.getLlmProvider(id);
    const existing = existingLlm ? toLegacyApiProvider(existingLlm) : undefined;
    if (!existing) return null;
    const updated = { ...existing, ...data, id };
    store.upsertLlmProvider(migrateLegacyApiProvider(updated));
    return maskProvider(updated);
  });

  // Delete provider
  ipcMain.handle('config:provider:delete', (_event, id: string) => {
    const store = getProviderStore();
    store.migrateAllLegacyProviders();
    return store.deleteLlmProvider(id);
  });

  // Activate provider
  ipcMain.handle('config:provider:activate', (_event, id: string) => {
    const store = getProviderStore();
    store.migrateAllLegacyProviders();
    store.setDefaultLlmProvider(id);
    const providerLlm = store.getLlmProvider(id);
    return providerLlm ? maskProvider(toLegacyApiProvider(providerLlm)) : null;
  });

  // ==================== Output Style handlers ====================
  ipcMain.handle('config:style:getAll', () => {
    const styles = (getConfigStore().getByPath('auxiliary.output_styles') as Record<string, unknown> | undefined) ?? DEFAULT_OUTPUT_STYLES;
    return Object.values(styles);
  });

  ipcMain.handle('config:style:get', (_event, id: string) => {
    const styles = (getConfigStore().getByPath('auxiliary.output_styles') as Record<string, unknown> | undefined) ?? DEFAULT_OUTPUT_STYLES;
    return styles[id] || null;
  });

  ipcMain.handle('config:style:upsert', (_event, data: { id: string; name: string; description?: string; prompt: string; keepCodingInstructions?: boolean }) => {
    const store = getConfigStore();
    const styles = (store.getByPath('auxiliary.output_styles') as Record<string, unknown> | undefined) ?? {};
    const style = {
      id: data.id,
      name: data.name,
      description: data.description,
      prompt: data.prompt,
      keepCodingInstructions: data.keepCodingInstructions,
    };
    const next = { ...styles, [data.id]: style };
    store.set('auxiliary.output_styles', next);
    return next[data.id] || null;
  });

  ipcMain.handle('config:style:delete', (_event, id: string) => {
    const store = getConfigStore();
    const styles = (store.getByPath('auxiliary.output_styles') as Record<string, unknown> | undefined) ?? {};
    const style = styles[id] as { isBuiltin?: boolean } | undefined;
    if (!style) return false;
    if (style.isBuiltin) return false;
    const next = { ...styles };
    delete next[id];
    store.set('auxiliary.output_styles', next);
    return true;
  });

  // ==================== Vision handlers ====================
  ipcMain.handle('config:vision:get', () => {
    const store = getConfigStore();
    return (store.getByPath('auxiliary.vision') as Record<string, unknown> | undefined) ?? DEFAULT_VISION_SETTINGS;
  });

  ipcMain.handle('config:vision:set', (_event, data: { provider?: string; model?: string; baseUrl?: string; baseURL?: string; apiKey?: string; enabled?: boolean }) => {
    const store = getConfigStore();
    const current = (store.getByPath('auxiliary.vision') as Record<string, string | boolean> | undefined) ?? DEFAULT_VISION_SETTINGS;
    const merged = {
      ...current,
      ...data,
      // Normalize baseURL/baseUrl -> baseUrl for ConfigStore
      baseUrl: data.baseUrl || data.baseURL || (current.baseUrl as string),
    };
    // Remove baseURL from merged since ConfigStore uses baseUrl
    delete (merged as Record<string, unknown>).baseURL;
    store.set('auxiliary.vision', merged);
    return (store.getByPath('auxiliary.vision') as Record<string, string | boolean> | undefined) ?? merged;
  });

  getLogger().info('Agent handlers registered', undefined, LogComponent.AgentCommunicator);
}