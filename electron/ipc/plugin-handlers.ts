/**
 * ipc/plugin-handlers.ts — Plugin-related IPC handlers
 *
 * Handlers for:
 * - Plugin catalog listing
 * - Plugin registry (installed) listing
 * - Plugin detail retrieval
 * - Plugin health listing
 * - Plugin install/enable/disable/remove (mutations with structured errors)
 * - Security: permissions, trust levels, policy
 */

import { ipcMain } from 'electron';
import { existsSync } from 'fs';
import { getLogger, LogComponent } from '../logging/logger';
import { getPluginManager } from '../plugins/PluginManager';
import {
  getPluginErrorMessage,
  getPluginErrorSeverity,
  isRetryable,
  getSuggestedAction,
} from '../../src/lib/plugin-error-messages';
import type {
  PluginHealthReport,
  PluginIpcListResponse,
  PluginIpcDetailResponse,
} from '../../src/lib/plugin-types';
import type { PluginError } from '../../packages/plugin-core/src/types';
import { getKnownMarketplacesManager } from '../plugins/marketplace/known-marketplaces-manager';
import { isBlockedMarketplaceName } from '../plugins/marketplace/impersonation-detector';
import type { MarketplaceEntry } from '../plugins/marketplace/types';

const COMPONENT = 'PluginHandlers' as LogComponent;

function buildHealthIssue(err: PluginError) {
  return {
    error: err,
    severity: getPluginErrorSeverity(err),
    humanMessage: getPluginErrorMessage(err),
    technicalDetails: err.type === 'generic-error' ? err.stack : undefined,
    actionable: isRetryable(err) || !!getSuggestedAction(err),
    suggestedAction: getSuggestedAction(err),
    timestamp: Date.now(),
  };
}

function handleResult<T>(result: { success: true; data: T } | { success: false; error: PluginError }) {
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    data: null as unknown as T,
    error: getPluginErrorMessage(result.error),
    pluginError: result.error,
    healthIssue: buildHealthIssue(result.error),
  };
}

export function registerPluginHandlers(): void {
  const logger = getLogger();
  const manager = getPluginManager();

  // --- plugin:catalog:list ---
  ipcMain.handle('plugin:catalog:list', async (_event, filters?: {
    search?: string;
    category?: string;
    source?: string;
    installed?: boolean;
  }): Promise<PluginIpcListResponse<unknown>> => {
    try {
      let results = manager.listCatalog();

      if (filters?.search) {
        const q = filters.search.toLowerCase();
        results = results.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q) ||
            p.id.toLowerCase().includes(q),
        );
      }

      if (filters?.category) {
        results = results.filter((p) => p.category === filters.category);
      }

      if (filters?.source) {
        results = results.filter((p) => p.source === filters.source);
      }

      if (filters?.installed !== undefined) {
        const installedIds = new Set(manager.listInstalled().map((p) => p.id));
        if (filters.installed) {
          results = results.filter((p) => installedIds.has(p.id));
        } else {
          results = results.filter((p) => !installedIds.has(p.id));
        }
      }

      logger.debug('plugin:catalog:list returned', { count: results.length }, COMPONENT);
      return { success: true, data: results };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('plugin:catalog:list failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, data: [], error: message };
    }
  });

  // --- plugin:registry:list ---
  ipcMain.handle('plugin:registry:list', async (): Promise<PluginIpcListResponse<unknown>> => {
    try {
      const installed = manager.listInstalled();
      logger.debug('plugin:registry:list returned', { count: installed.length }, COMPONENT);
      return { success: true, data: installed };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('plugin:registry:list failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, data: [], error: message };
    }
  });

  // --- plugin:detail:get ---
  ipcMain.handle('plugin:detail:get', async (_event, pluginId: string): Promise<PluginIpcDetailResponse<unknown>> => {
    try {
      const detail = manager.getDetail(pluginId);
      if (!detail.catalog && !detail.entry) {
        return { success: false, data: null, error: `Plugin not found: ${pluginId}` };
      }
      logger.debug('plugin:detail:get', { pluginId }, COMPONENT);
      return { success: true, data: detail };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('plugin:detail:get failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, data: null, error: message };
    }
  });

  // --- plugin:health:list ---
  ipcMain.handle('plugin:health:list', async (): Promise<PluginIpcListResponse<PluginHealthReport>> => {
    try {
      const installed = manager.listInstalled();
      const now = new Date().toISOString();
      const reports: PluginHealthReport[] = [];

      for (const plugin of installed) {
        const issues: PluginHealthReport['issues'] = [];

        if (!plugin.enabled) {
          issues.push(buildHealthIssue({
            type: 'generic-error',
            plugin: plugin.id,
            message: 'Plugin is disabled',
          }));
        }

        if (plugin.health?.status === 'failed') {
          issues.push(buildHealthIssue({
            type: 'generic-error',
            plugin: plugin.id,
            message: plugin.health.reasons.join('; '),
          }));
        }

        reports.push({
          pluginId: plugin.id,
          healthy: issues.length === 0,
          issues,
          lastCheckedAt: now,
          lastError: plugin.lastError ? {
            type: 'generic-error',
            message: plugin.lastError.message,
            at: plugin.lastError.at,
          } : undefined,
        });
      }

      logger.debug('plugin:health:list returned', { count: reports.length }, COMPONENT);
      return { success: true, data: reports };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('plugin:health:list failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, data: [], error: message };
    }
  });

  // --- plugin:install ---
  ipcMain.handle('plugin:install', async (_event, payload: { pluginId: string }) => {
    try {
      const result = await manager.installFromCatalog(payload.pluginId);
      return handleResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('plugin:install failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, error: message };
    }
  });

  // --- plugin:enable ---
  ipcMain.handle('plugin:enable', async (_event, pluginId: string) => {
    try {
      const result = await manager.setEnabled(pluginId, true);
      return handleResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('plugin:enable failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, error: message };
    }
  });

  // --- plugin:disable ---
  ipcMain.handle('plugin:disable', async (_event, pluginId: string) => {
    try {
      const result = await manager.setEnabled(pluginId, false);
      return handleResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('plugin:disable failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, error: message };
    }
  });

  // --- plugin:remove ---
  ipcMain.handle('plugin:remove', async (_event, payload: { pluginId: string; deleteData?: boolean }) => {
    try {
      const result = await manager.remove(payload.pluginId, payload.deleteData ?? false);
      return handleResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('plugin:remove failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, error: message };
    }
  });

  // --- plugin:doctor ---
  ipcMain.handle('plugin:doctor', async (_event, pluginId?: string) => {
    try {
      const targets = pluginId
        ? manager.listInstalled().filter((p) => p.id === pluginId)
        : manager.listInstalled();
      const now = new Date().toISOString();
      const reports: PluginHealthReport[] = [];

      for (const plugin of targets) {
        const issues: PluginHealthReport['issues'] = [];

        if (!existsSync(plugin.installPath)) {
          issues.push(buildHealthIssue({
            type: 'path-not-found',
            plugin: plugin.id,
            path: plugin.installPath,
          }));
        }

        if (plugin.setupState === 'needs_setup') {
          issues.push(buildHealthIssue({
            type: 'generic-error',
            plugin: plugin.id,
            message: 'Plugin requires setup configuration',
          }));
        }

        if (!plugin.enabled) {
          issues.push(buildHealthIssue({
            type: 'generic-error',
            plugin: plugin.id,
            message: 'Plugin is disabled',
          }));
        }

        reports.push({
          pluginId: plugin.id,
          healthy: issues.length === 0,
          issues,
          lastCheckedAt: now,
        });
      }

      logger.debug('plugin:doctor completed', { count: reports.length }, COMPONENT);
      return { success: true, data: reports };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('plugin:doctor failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, data: [], error: message };
    }
  });

  // --- plugin:capability-index ---
  ipcMain.handle('plugin:capability-index', async () => {
    try {
      const enabled = manager.listInstalled().filter(
        (p) => p.enabled && p.health?.status !== 'disabled',
      );
      const index = enabled.map((p) => ({
        pluginId: p.id,
        name: p.name,
        version: p.version,
        status: 'enabled' as const,
        trustLevel: p.trustLevel,
        capabilities: {
          skills: p.grantedPermissions?.filter((x) => x.name.startsWith('skills.')).length ?? 0,
          mcpServers: p.grantedPermissions?.filter((x) => x.name.startsWith('mcp.')).length ?? 0,
          cli: p.grantedPermissions?.filter((x) => x.name.startsWith('cli.')).length ?? 0,
          ui: p.grantedPermissions?.filter((x) => x.name.startsWith('ui.')).length ?? 0,
          hooks: p.grantedPermissions?.filter((x) => x.name.startsWith('hooks.')).length ?? 0,
        },
        permissionSummary: {
          granted: p.grantedPermissions?.map((x) => x.name) ?? [],
          denied: [],
        },
      }));

      logger.debug('plugin:capability-index generated', { count: index.length }, COMPONENT);
      return { success: true, data: index };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('plugin:capability-index failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, data: [], error: message };
    }
  });

  // --- plugin:security:trust-info ---
  ipcMain.handle('plugin:security:trust-info', async (_event, payload: { pluginId: string; source: string; marketplace?: string }) => {
    try {
      const trustEngine = manager.getTrustEngine();
      const trust = trustEngine.determineTrustLevel(payload.source, payload.marketplace);
      const capabilities = trustEngine.getCapabilities(trust);
      return { success: true, data: { trust, capabilities } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // --- plugin:security:policy ---
  ipcMain.handle('plugin:security:policy', async (_event, _payload?: { action: 'get' | 'update'; policy?: Record<string, unknown> }) => {
    try {
      const policyEngine = manager.getPolicyEngine();
      return { success: true, data: policyEngine.getPolicy() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // --- plugin:security:check-path ---
  ipcMain.handle('plugin:security:check-path', async (_event, payload: { path: string; base: string }) => {
    try {
      const validator = manager['pathValidator'];
      const result = (validator as { validatePathWithinBase: (p: string, b: string) => { safe: boolean; resolvedPath?: string; reason?: string } }).validatePathWithinBase(payload.path, payload.base);
      return { success: true, data: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // --- plugin:check-update ---
  ipcMain.handle('plugin:check-update', async () => {
    try {
      const updates = await manager.checkUpdates();
      return { success: true, data: updates };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('plugin:check-update failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, data: [], error: message };
    }
  });

  // --- plugin:update ---
  ipcMain.handle('plugin:update', async (_event, payload: { pluginId: string; targetVersion: string }) => {
    try {
      const result = await manager.updatePlugin(payload.pluginId, payload.targetVersion);
      return { success: true, data: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('plugin:update failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, error: message };
    }
  });

  // --- plugin:installed:v2 ---
  ipcMain.handle('plugin:installed:v2', async () => {
    try {
      const plugins = manager.getInstalledV2();
      return { success: true, data: plugins };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('plugin:installed:v2 failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, data: [], error: message };
    }
  });

  // --- plugin:checkout-version ---
  ipcMain.handle('plugin:checkout-version', async (_event, payload: { pluginId: string; version: string }) => {
    try {
      const entry = manager.checkoutVersion(payload.pluginId, payload.version);
      return { success: true, data: entry };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('plugin:checkout-version failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, error: message };
    }
  });

  // --- plugin:cache:stats ---
  ipcMain.handle('plugin:cache:stats', async () => {
    try {
      const { getCacheStats } = await import('../plugins/cache/layout');
      const stats = getCacheStats();
      return { success: true, data: stats };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('plugin:cache:stats failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, error: message };
    }
  });

  // --- plugin:cache:cleanup ---
  ipcMain.handle('plugin:cache:cleanup', async (_event, payload: { marketplace: string; pluginId: string; keepLatest?: number }) => {
    try {
      const { cleanupOldVersions } = await import('../plugins/cache/layout');
      const removed = cleanupOldVersions(payload.marketplace, payload.pluginId, payload.keepLatest ?? 3);
      return { success: true, data: { removed } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('plugin:cache:cleanup failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, error: message };
    }
  });

  // --- marketplace:list ---
  ipcMain.handle('marketplace:list', async () => {
    try {
      const mkManager = getKnownMarketplacesManager();
      const marketplaces = mkManager.getAll();
      const entries = Object.entries(marketplaces).map(([key, entry]) => ({
        key,
        ...entry,
      }));
      return { success: true, data: entries };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('marketplace:list failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, data: [], error: message };
    }
  });

  // --- marketplace:add ---
  ipcMain.handle('marketplace:add', async (_event, payload: { key: string; entry: MarketplaceEntry }) => {
    try {
      if (isBlockedMarketplaceName(payload.key)) {
        return { success: false, error: `Marketplace name "${payload.key}" is blocked (impersonation detected)` };
      }
      const mkManager = getKnownMarketplacesManager();
      const added = mkManager.add(payload.key, payload.entry);
      if (!added) {
        return { success: false, error: `Marketplace "${payload.key}" already exists` };
      }
      const entry = mkManager.get(payload.key);
      return { success: true, data: { key: payload.key, ...entry } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('marketplace:add failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, error: message };
    }
  });

  // --- marketplace:update ---
  ipcMain.handle('marketplace:update', async (_event, payload: { key: string; entry: Partial<MarketplaceEntry> }) => {
    try {
      const mkManager = getKnownMarketplacesManager();
      const updated = mkManager.update(payload.key, payload.entry);
      if (!updated) {
        return { success: false, error: `Marketplace "${payload.key}" not found` };
      }
      const entry = mkManager.get(payload.key);
      return { success: true, data: { key: payload.key, ...entry } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('marketplace:update failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, error: message };
    }
  });

  // --- marketplace:remove ---
  ipcMain.handle('marketplace:remove', async (_event, payload: { key: string }) => {
    try {
      const mkManager = getKnownMarketplacesManager();
      const removed = mkManager.remove(payload.key);
      if (!removed) {
        return { success: false, error: `Marketplace "${payload.key}" not found` };
      }
      return { success: true, data: { removed: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('marketplace:remove failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, error: message };
    }
  });

  // --- marketplace:reset ---
  ipcMain.handle('marketplace:reset', async () => {
    try {
      const mkManager = getKnownMarketplacesManager();
      const file = mkManager.reset();
      const entries = Object.entries(file.marketplaces).map(([key, entry]) => ({
        key,
        ...entry,
      }));
      return { success: true, data: entries };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('marketplace:reset failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, data: [], error: message };
    }
  });

  // --- marketplace:check-name ---
  ipcMain.handle('marketplace:check-name', async (_event, name: string) => {
    try {
      const blocked = isBlockedMarketplaceName(name);
      return { success: true, data: { name, blocked } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('marketplace:check-name failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, error: message };
    }
  });
}