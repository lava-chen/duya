/**
 * electron/cli/handlers/plugins.ts
 *
 * Read-only plugin handler for the CLI control plane.
 *
 * IMPORTANT: directly reuses `electron/plugins/PluginManager` — does NOT
 * create a new CLI-side wrapper service. Per audit, `listInstalled()` and
 * `getDetail(id)` already expose everything we need.
 *
 * Stable JSON contract (Phase 0):
 *   list  → 5 fields: name / version / enabled / capabilities / source
 *   info  → 7 fields: name / version / enabled / capabilities / source / description / permissions
 *
 * NEVER exposes: installPath (absolute path), raw manifest, env, lastError internals.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getPluginManager } from '../../plugins/PluginManager';
import type { PluginCapabilityKind, PluginRegistryEntry, PluginCatalogEntry } from '../../plugins/types';
import { listCapabilityKinds } from '../../plugins/manifest';

interface PluginListItem {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  capabilities: PluginCapabilityKind[];
  source: string;
}

interface PluginInfoItem extends PluginListItem {
  description: string;
  permissions: string[];
}

function toListItem(entry: PluginRegistryEntry, catalogEntry: PluginCatalogEntry | null): PluginListItem {
  const capabilities: PluginCapabilityKind[] = catalogEntry
    ? listCapabilityKinds(catalogEntry.manifest)
    : (entry as unknown as { capabilityKinds?: PluginCapabilityKind[] }).capabilityKinds ?? [];

  return {
    id: entry.id,
    name: entry.name,
    version: entry.version,
    enabled: entry.enabled,
    capabilities,
    source: entry.source,
  };
}

function toInfoItem(entry: PluginRegistryEntry, catalogEntry: PluginCatalogEntry | null): PluginInfoItem {
  const list = toListItem(entry, catalogEntry);
  return {
    ...list,
    description: catalogEntry?.manifest?.description ?? '',
    permissions: (entry.grantedPermissions ?? []).map((p) => p.name),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

/**
 * Probe plugin registry accessibility for the /v1/status endpoint.
 * Returns true if `listInstalled()` succeeds; false otherwise.
 * Catches errors silently — the caller reports pluginReady=false.
 */
export function probePluginRegistry(): boolean {
  try {
    getPluginManager().listInstalled();
    return true;
  } catch {
    return false;
  }
}

export function handleListPlugins(_req: IncomingMessage, res: ServerResponse): void {
  let entries: PluginRegistryEntry[];
  let catalogIndex: Map<string, PluginCatalogEntry>;
  try {
    const manager = getPluginManager();
    entries = manager.listInstalled();
    catalogIndex = new Map();
    for (const catalog of manager.listCatalog()) {
      catalogIndex.set(catalog.id, catalog);
    }
  } catch (err) {
    sendJson(res, 500, {
      error: {
        code: 'plugin_registry_error',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    return;
  }

  const plugins: PluginListItem[] = entries.map((e) =>
    toListItem(e, catalogIndex.get(e.id) ?? null)
  );
  sendJson(res, 200, { plugins });
}

/**
 * Path: /v1/plugins/:id — `id` is the stable unique plugin id
 * (e.g. "com.duya.literature"). Display name lookup is intentionally NOT
 * supported; the CLI surface takes the id directly.
 */
export function handleGetPlugin(_req: IncomingMessage, res: ServerResponse, id: string): void {
  let entry: PluginRegistryEntry | null = null;
  let catalog: PluginCatalogEntry | null = null;
  try {
    const manager = getPluginManager();
    const detail = manager.getDetail(id);
    if (detail.entry) {
      entry = detail.entry;
      catalog = detail.catalog;
    }
  } catch (err) {
    sendJson(res, 500, {
      error: {
        code: 'plugin_registry_error',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    return;
  }

  if (!entry) {
    sendJson(res, 404, {
      error: {
        code: 'plugin_not_found',
        message: `Plugin not found: ${id}`,
      },
    });
    return;
  }

  sendJson(res, 200, toInfoItem(entry, catalog));
}
