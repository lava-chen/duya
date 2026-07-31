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
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getLogger, LogComponent } from '../logging/logger';
import { getPluginManager } from '../plugins/PluginManager';
import { notifyMcpConfigChanged } from '../services/mcp-write-reload';
import { getAgentServerUrl } from '../services/agent-server-url';
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
// Plan 311 — workflow template discovery & summary projection.
import { listBuiltinPlugins } from '../../packages/agent/src/plugins/builtin/_registry.js';
import { discoverWorkflows, discoverSkills } from '../../packages/agent/src/plugins/builtin/capability-discovery.js';
import {
  toWorkflowSummary,
  type WorkflowTemplate,
  type WorkflowTemplateSummary,
} from '../../packages/plugin-core/src/workflows/schema.js';
import { readPluginManifest } from '../plugins/manifest.js';

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

/**
 * Plan 311 — Resolve the on-disk directory to scan for workflow templates.
 *
 * Installed plugins copy their files to a cache dir (`installPath`), but
 * bundled plugins are staged from `packages/agent/src/plugins/builtin/`
 * and the cache copy may not include the `workflows/` subdirectory. This
 * helper tries `installPath` first (works for local / marketplace plugins
 * and bundled plugins whose cache includes workflows), then falls back to
 * scanning the builtin plugin directories by matching the plugin id
 * against each directory's `plugin.json` / `plugin.md` frontmatter.
 *
 * Returns `undefined` when no directory with a `workflows/` subfolder can
 * be resolved — callers treat that as "no workflows".
 */
function resolvePluginDiscoveryDir(pluginId: string, installPath?: string): string | undefined {
  // 1. Install path (cache copy). Works when the install staging copied
  //    the full plugin directory (local source) or when a bundled plugin
  //    was installed with its workflows dir intact. When `installPath`
  //    is omitted (bundled-but-not-installed), skip straight to the
  //    builtin-dir fallback.
  if (installPath && existsSync(join(installPath, 'workflows'))) {
    return installPath;
  }

  // 2. Bundled plugins live under packages/agent/src/plugins/builtin/.
  //    Scan each directory and match by manifest id. The literature
  //    plugin only ships `plugin.md` (no `plugin.json`), so we check
  //    both files. The `plugin.md` frontmatter uses `name` (not `id`);
  //    the catalog synthesises the id as `com.duya.<name>`.
  for (const candidate of listBuiltinPlugins()) {
    const jsonPath = join(candidate.dir, 'plugin.json');
    if (existsSync(jsonPath)) {
      try {
        const raw = JSON.parse(readFileSync(jsonPath, 'utf8')) as { id?: string };
        if (raw.id === pluginId) return candidate.dir;
      } catch {
        // skip unreadable manifest
      }
      continue;
    }

    // plugin.md frontmatter: id is `com.duya.<name>`.
    const mdPath = join(candidate.dir, 'plugin.md');
    if (existsSync(mdPath)) {
      try {
        const content = readFileSync(mdPath, 'utf8');
        const nameMatch = content.match(/^name:\s*(.+)$/m);
        if (nameMatch) {
          const derivedId = `com.duya.${nameMatch[1].trim()}`;
          if (derivedId === pluginId) return candidate.dir;
        }
      } catch {
        // skip unreadable plugin.md
      }
    }
  }

  return undefined;
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
      if (result.success) {
        notifyMcpConfigChanged();
      }
      return handleResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('plugin:install failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, error: message };
    }
  });

  // --- plugin:install-local ---
  ipcMain.handle('plugin:install-local', async (_event, payload: { pluginPath: string; scope?: string; autoUpdate?: boolean }) => {
    try {
      const result = await manager.installFromPath(payload.pluginPath, payload.scope as 'user' | undefined, payload.autoUpdate ?? false);
      if (result.success) {
        notifyMcpConfigChanged();
      }
      return handleResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('plugin:install-local failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, error: message };
    }
  });

  // --- plugin:enable ---
  ipcMain.handle('plugin:enable', async (_event, pluginId: string) => {
    try {
      const result = await manager.setEnabled(pluginId, true);
      if (result.success) {
        notifyMcpConfigChanged();
      }
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
      if (result.success) {
        notifyMcpConfigChanged();
      }
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
      if (result.success) {
        notifyMcpConfigChanged();
      }
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
  // Plan 311 — workflows count is now discovery-driven (scans the
  // plugin's on-disk `workflows/` directory) and each item carries
  // template summaries (id/name/description/permissionTier). The
  // prompt body is NOT included — full templates are fetched on
  // demand via `plugin:workflow:get` (Plan 241 progressive
  // disclosure). The existing grantedPermissions-prefix counts for
  // skills/mcp/cli/ui/hooks are retained unchanged.
  ipcMain.handle('plugin:capability-index', async () => {
    try {
      const enabled = manager.listInstalled().filter(
        (p) => p.enabled && p.health?.status !== 'disabled',
      );
      const index = enabled.map((p) => {
        // Plan 311 — discover workflow templates from the plugin's
        // on-disk directory. Falls back to an empty list when no
        // directory with `workflows/` can be resolved (e.g. the
        // plugin was installed from a marketplace that did not ship
        // workflow files).
        const discoveryDir = resolvePluginDiscoveryDir(p.id, p.installPath);
        const templates: WorkflowTemplate[] = discoveryDir
          ? discoverWorkflows(discoveryDir)
          : [];
        const workflowSummaries: WorkflowTemplateSummary[] = templates.map(toWorkflowSummary);
        const discoveredSkills = discoveryDir ? discoverSkills(discoveryDir) : [];
        const mcpServerCount = (() => {
          if (!discoveryDir) return 0;
          try {
            const m = readPluginManifest(discoveryDir);
            return m.capabilities?.mcpServers?.length ?? 0;
          } catch { return 0; }
        })();

        return {
          pluginId: p.id,
          name: p.name,
          version: p.version,
          status: 'enabled' as const,
          trustLevel: p.trustLevel,
          capabilities: {
            skills: discoveredSkills.length,
            mcpServers: mcpServerCount,
            cli: p.grantedPermissions?.filter((x) => x.name.startsWith('cli.')).length ?? 0,
            ui: p.grantedPermissions?.filter((x) => x.name.startsWith('ui.')).length ?? 0,
            hooks: p.grantedPermissions?.filter((x) => x.name.startsWith('hooks.')).length ?? 0,
            // Plan 311 — workflow count from on-disk discovery.
            workflows: workflowSummaries.length,
          },
          permissionSummary: {
            granted: p.grantedPermissions?.map((x) => x.name) ?? [],
            denied: [],
          },
          // Plan 311 — workflow template summaries (no prompt body).
          workflows: workflowSummaries,
        };
      });

      logger.debug('plugin:capability-index generated', { count: index.length }, COMPONENT);
      return { success: true, data: index };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('plugin:capability-index failed', err instanceof Error ? err : new Error(message), COMPONENT);
      return { success: false, data: [], error: message };
    }
  });

  // --- plugin:workflow:get (Plan 311) ---
  // Fetch the full workflow template (including prompt body) for a
  // given plugin + workflow id. The capability index only ships
  // summaries; the renderer calls this when the user actually opens
  // the launch dialog. Returns `null` when the workflow is not found
  // so the renderer can show a "template missing" message.
  ipcMain.handle(
    'plugin:workflow:get',
    async (_event, payload: { pluginId: string; workflowId: string }) => {
      try {
        const { pluginId, workflowId } = payload;
        if (!pluginId || !workflowId) {
          return {
            success: false,
            data: null,
            error: 'pluginId and workflowId are required',
          };
        }

        // Resolve the discovery directory. For installed plugins we
        // use the registry entry's installPath; for bundled plugins
        // that are not yet installed we fall back to the builtin dir
        // scan inside `resolvePluginDiscoveryDir`.
        const installed = manager.listInstalled().find((p) => p.id === pluginId);
        const installPath = installed?.installPath;
        const discoveryDir = resolvePluginDiscoveryDir(pluginId, installPath);

        if (!discoveryDir) {
          logger.warn('plugin:workflow:get — no discovery dir resolved', { pluginId }, COMPONENT);
          return {
            success: false,
            data: null,
            error: `Plugin directory not found: ${pluginId}`,
          };
        }

        const templates = discoverWorkflows(discoveryDir);
        const template = templates.find((t) => t.id === workflowId);
        if (!template) {
          logger.warn(
            'plugin:workflow:get — workflow not found',
            { pluginId, workflowId, available: templates.map((t) => t.id) },
            COMPONENT,
          );
          return {
            success: false,
            data: null,
            error: `Workflow not found: ${workflowId}`,
          };
        }

        logger.debug('plugin:workflow:get', { pluginId, workflowId }, COMPONENT);
        return { success: true, data: template };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(
          'plugin:workflow:get failed',
          err instanceof Error ? err : new Error(message),
          COMPONENT,
        );
        return { success: false, data: null, error: message };
      }
    },
  );

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
  // Plan 101 Phase 5: schema simplified to read-only. The historical
  // `action: 'update'` variant was advertised in the parameter type but
  // never implemented — the handler always returned `getPolicy()`.
  // Dropped for honesty; policy updates are out of scope for v0.1.3 and
  // will be reintroduced in a follow-up plan if needed.
  ipcMain.handle('plugin:security:policy', async () => {
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