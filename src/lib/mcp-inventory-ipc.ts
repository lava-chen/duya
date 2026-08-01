/**
 * mcp-inventory-ipc.ts
 *
 * Compatibility wrapper that adapts the capability-management snapshot
 * to the legacy `MCPInventorySnapshotDTO` shape consumed by the
 * settings / extensions / chat components.
 *
 * The previous implementation talked to the main-process
 * `MCPInventoryService` via the `mcp:inventory:snapshot` IPC channel.
 * That service ran a second, simplified resolver that diverged from
 * the worker's `applyMCPConfiguration` result (no env expansion,
 * no `env_missing` checks), producing inconsistent "effectiveCount"
 * numbers versus what the agent actually loaded.
 *
 * After the deletion of the old framework, this wrapper pulls the
 * MCP picture from the capability-management snapshot, which is
 * aggregated from the same `collectMainMCPCandidates` source and
 * enriched with the worker's `lastMCPLoadResult` (connection status,
 * last issue, tool count). The renderer keeps the legacy DTO shape so
 * existing components do not need to change.
 *
 * Field shrinkage (intentional):
 *   - `configuredServers` is always empty. Callers (MCPSection,
 *     ExtensionsPage) fall back to `settings.mcpServers` when the
 *     array is empty, which is the correct editable source anyway.
 *   - `pluginDeclaredServers[].command/args/env` are blank because
 *     the capability snapshot does not carry raw spawn config.
 *   - `effectiveServers[].command/args/env/url/headers` are blank
 *     for the same reason. Components that need the spawn config
 *     (MessageInput's command label, MCPSection's mono text) now
 *     show an empty string; the server name and effective/blocked
 *     state are still accurate.
 *
 * If the capability-management API is unavailable (e.g. running
 * against the Vite dev server without Electron), both helpers
 * degrade: `hasMCPInventoryAPI()` returns false and
 * `fetchMCPInventorySnapshot()` returns null.
 */

import type { CapabilityManagementSnapshot, CapabilityDTO } from './capability-management-types';
import {
  fetchCapabilityManagementSnapshot,
  hasCapabilityManagementAPI,
} from './capability-management-ipc';
import type {
  MCPConfiguredServerDTO,
  MCPEffectiveServerDTO,
  MCPInventorySnapshotDTO,
  MCPInventorySource,
  MCPPluginDeclaredServerDTO,
} from './mcp-inventory-types';

/**
 * Map the capability-management origin enum onto the v0 MCP source
 * enum. The v0 enum is the public-facing type still consumed by the
 * CLI DTO and the renderer components.
 */
function toMCPSource(origin: CapabilityDTO['origin']): MCPInventorySource {
  switch (origin) {
    case 'bundled':
      return 'bundled';
    case 'plugin':
    case 'marketplace':
    case 'local':
      return 'plugin';
    default:
      // 'settings' | 'user' | 'project' | 'custom' | 'unknown'
      return 'settings';
  }
}

/**
 * Build the legacy snapshot DTO from the capability-management
 * snapshot. Returns null when the input is null.
 */
function adaptSnapshot(cap: CapabilityManagementSnapshot | null): MCPInventorySnapshotDTO | null {
  if (!cap) return null;

  const pluginNameById = new Map(cap.plugins.map((p) => [p.id, p.name]));
  const mcpCaps = cap.capabilities.filter((c) => c.kind === 'mcp');

  const pluginDeclaredServers: MCPPluginDeclaredServerDTO[] = [];
  const effectiveServers: MCPEffectiveServerDTO[] = [];

  for (const capItem of mcpCaps) {
    const source = toMCPSource(capItem.origin);
    const providerPluginId = capItem.providerPluginId;
    const effectiveEnabled = capItem.effectiveEnabled !== false;
    const connectionStatus = capItem.mcp?.connectionStatus ?? 'unknown';
    const lastIssue = capItem.mcp?.lastIssue;
    const id = capItem.displayKey;

    // Every MCP capability contributes to the effective list. The
    // capability aggregator already filters out shadowed / blocked
    // entries (effectiveEnabled === null means "fully shadowed" and
    // is treated as not effective below).
    effectiveServers.push({
      id,
      name: capItem.name,
      source,
      ...(providerPluginId ? { sourceId: providerPluginId } : {}),
      command: '',
      args: [],
      env: {},
      writable: source === 'settings',
      connected: connectionStatus === 'connected',
      effectiveEnabled,
      shadowedCandidateCount: 0,
      connectionStatus,
      ...(lastIssue ? { lastIssue } : {}),
    });

    if (source === 'plugin' && providerPluginId) {
      pluginDeclaredServers.push({
        id,
        pluginId: providerPluginId,
        pluginName: pluginNameById.get(providerPluginId) ?? providerPluginId,
        name: capItem.name,
        command: '',
        args: [],
        env: {},
        providerEnabled: capItem.providerEnabled,
        effective: effectiveEnabled && capItem.providerEnabled,
        shadowed: !effectiveEnabled,
      });
    }
  }

  // `configuredServers` carries the raw spawn config (command/args/env).
  // The capability snapshot does not expose that, so we return an empty
  // array and let callers fall back to `settings.mcpServers`.
  const configuredServers: MCPConfiguredServerDTO[] = [];

  const effectiveCount = effectiveServers.filter((s) => s.effectiveEnabled).length;
  const summary = {
    configuredCount: configuredServers.length,
    configuredEnabledCount: 0,
    pluginDeclaredCount: pluginDeclaredServers.length,
    pluginEnabledCount: pluginDeclaredServers.filter((s) => s.providerEnabled).length,
    effectiveCount,
    bundledEffectiveCount: effectiveServers.filter(
      (s) => s.effectiveEnabled && s.source === 'bundled',
    ).length,
    shadowedCount: 0,
  };

  return {
    configuredServers,
    pluginDeclaredServers,
    effectiveServers,
    summary,
    generatedAt: cap.generatedAt,
  };
}

/**
 * Fetch the MCP inventory snapshot.
 *
 * Preserved signature — the wrapper now sources the data from the
 * capability-management aggregator instead of the deleted
 * `mcp:inventory:snapshot` IPC. Returns null when the
 * capability-management API is unavailable or the snapshot could
 * not be fetched; callers fall back to `settings.mcpServers` in
 * that case.
 */
export async function fetchMCPInventorySnapshot(): Promise<MCPInventorySnapshotDTO | null> {
  if (!hasCapabilityManagementAPI()) return null;
  try {
    const cap = await fetchCapabilityManagementSnapshot();
    return adaptSnapshot(cap);
  } catch {
    return null;
  }
}

/**
 * Preserved signature — reports whether the MCP inventory data source
 * is available. Now equivalent to the capability-management API
 * being wired up in preload.
 */
export function hasMCPInventoryAPI(): boolean {
  return hasCapabilityManagementAPI();
}
