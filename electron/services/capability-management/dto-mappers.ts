/**
 * dto-mappers.ts
 *
 * Plan 83b Phase 1A — Pure converters from plugin runtime types to the
 * capability-management DTO. No I/O, no side effects, no plugin state
 * mutation. Every function takes a snapshot of inputs and returns a DTO
 * literal.
 *
 * Rev 3 终版 4 处最终修订：
 *   1. ownEnabled 永远填 null（Phase 1A 不读取 own 状态）
 *      effectiveEnabled: providerEnabled=false → false, blockedReason='plugin-disabled'
 *                        providerEnabled=true  → null
 *   2. enumerate 全部 installed — does not filter by entry.enabled
 *   4. mcp.connectionStatus='unknown', mcp.lastIssue=undefined
 *      blockedReason 不派生自 connection error
 */

import { existsSync } from 'fs';

import { deriveCapabilityCounts } from '../../plugins/capability-counts';
import { readPluginManifest } from '../../plugins/manifest';
import type {
  PluginRegistryEntry,
  PluginViewItem,
} from '../../plugins/types';

import type {
  CapabilityDTO,
  CapabilityHookFields,
  CapabilityCliFields,
  CapabilityMcpFields,
  CapabilityUiFields,
  PluginCapabilityCounts,
  PluginHealth,
  PluginOrigin,
  PluginPackageDTO,
} from './types';

function mapOrigin(source: PluginRegistryEntry['source']): PluginOrigin {
  switch (source) {
    case 'bundled':
    case 'marketplace':
    case 'local':
    case 'builtin-directory':
    case 'development':
      return source;
    default:
      return 'unknown';
  }
}

function mapHealth(entry: PluginRegistryEntry): PluginHealth {
  switch (entry.health.status) {
    case 'ready':
    case 'disabled':
    case 'needs_setup':
    case 'failed':
      return entry.health.status;
    default:
      return 'unknown';
  }
}

function readCounts(entry: PluginRegistryEntry, installPath: string): PluginCapabilityCounts {
  if (!existsSync(installPath)) {
    return { skills: 0, mcpServers: 0, cli: 0, ui: 0, hooks: 0 };
  }
  try {
    const manifest = readPluginManifest(installPath);
    return deriveCapabilityCounts(manifest, installPath);
  } catch {
    return { skills: 0, mcpServers: 0, cli: 0, ui: 0, hooks: 0 };
  }
}

export function toPluginPackageDTO(view: PluginViewItem): PluginPackageDTO {
  const counts = readCounts(view, view.installPath);
  return {
    id: view.id,
    name: view.name,
    version: view.version,
    description: undefined,
    origin: mapOrigin(view.source),
    enabled: view.enabled,
    trustLevel: view.trustLevel,
    health: mapHealth(view),
    capabilityCounts: counts,
  };
}

/**
 * Build a `displayKey` for a plugin-declared capability.
 *
 * The format is `plugin:<pluginId>:<kind>:<name>`. It is intentionally
 * distinct from MCP canonical ids (`mcpService.idFor`) — Phase 1A only
 * emits plugin-declared capabilities, so the format is unambiguous.
 *
 * The key is consumed by the renderer as a React `key` and for debugging.
 * It is NOT a stable cross-service identifier.
 */
function buildDisplayKey(pluginId: string, kind: CapabilityDTO['kind'], name: string): string {
  return `plugin:${pluginId}:${kind}:${name}`;
}

/**
 * Compute the effectiveEnabled / blockedReason pair for a plugin-declared
 * capability.
 *
 * Phase 1A rule (Rev 3 修订 1):
 *   - ownEnabled is always null
 *   - providerEnabled=false → effectiveEnabled=false, blockedReason='plugin-disabled'
 *   - providerEnabled=true  → effectiveEnabled=null (no blockedReason)
 *
 * Phase 1A does NOT derive blockedReason from MCP connection errors
 * (Rev 3 修订 4); connection error is reserved for mcp.connectionStatus /
 * mcp.lastIssue only.
 */
function computeEffective(
  providerEnabled: boolean,
): { effectiveEnabled: boolean | null; blockedReason?: CapabilityDTO['blockedReason'] } {
  if (!providerEnabled) {
    return { effectiveEnabled: false, blockedReason: 'plugin-disabled' };
  }
  return { effectiveEnabled: null };
}

const EMPTY_MCP: CapabilityMcpFields = { connectionStatus: 'unknown' };

export function toPluginDeclaredCapabilities(
  view: PluginViewItem,
): CapabilityDTO[] {
  if (!existsSync(view.installPath)) {
    return [];
  }
  let manifest;
  try {
    manifest = readPluginManifest(view.installPath);
  } catch {
    return [];
  }
  const capabilities = manifest.capabilities ?? {};
  const providerEnabled = view.enabled;
  const out: CapabilityDTO[] = [];
  const origin: CapabilityDTO['origin'] = 'plugin';
  const providerPluginId = view.id;

  for (const skill of capabilities.skills ?? []) {
    const eff = computeEffective(providerEnabled);
    out.push({
      displayKey: buildDisplayKey(providerPluginId, 'skill', skill),
      kind: 'skill',
      name: skill,
      origin,
      providerPluginId,
      ownEnabled: null,
      providerEnabled,
      effectiveEnabled: eff.effectiveEnabled,
      blockedReason: eff.blockedReason,
    });
  }

  for (const mcp of capabilities.mcpServers ?? []) {
    const eff = computeEffective(providerEnabled);
    const mcpFields: CapabilityMcpFields = { ...EMPTY_MCP };
    out.push({
      displayKey: buildDisplayKey(providerPluginId, 'mcp', mcp.name),
      kind: 'mcp',
      name: mcp.name,
      origin,
      providerPluginId,
      ownEnabled: null,
      providerEnabled,
      effectiveEnabled: eff.effectiveEnabled,
      blockedReason: eff.blockedReason,
      mcp: mcpFields,
    });
  }

  for (const cli of capabilities.cli ?? []) {
    const eff = computeEffective(providerEnabled);
    const cliFields: CapabilityCliFields = { command: cli.command, args: cli.args };
    out.push({
      displayKey: buildDisplayKey(providerPluginId, 'cli', cli.name),
      kind: 'cli',
      name: cli.name,
      origin,
      providerPluginId,
      ownEnabled: null,
      providerEnabled,
      effectiveEnabled: eff.effectiveEnabled,
      blockedReason: eff.blockedReason,
      cli: cliFields,
    });
  }

  for (const ui of capabilities.ui ?? []) {
    const eff = computeEffective(providerEnabled);
    const uiFields: CapabilityUiFields = { id: ui.id, type: ui.type };
    out.push({
      displayKey: buildDisplayKey(providerPluginId, 'ui', ui.id),
      kind: 'ui',
      name: ui.id,
      origin,
      providerPluginId,
      ownEnabled: null,
      providerEnabled,
      effectiveEnabled: eff.effectiveEnabled,
      blockedReason: eff.blockedReason,
      ui: uiFields,
    });
  }

  for (const hook of capabilities.hooks ?? []) {
    const eff = computeEffective(providerEnabled);
    const hookFields: CapabilityHookFields = { event: hook.event, handler: hook.handler };
    out.push({
      displayKey: buildDisplayKey(providerPluginId, 'hook', `${hook.event}:${hook.handler}`),
      kind: 'hook',
      name: `${hook.event}:${hook.handler}`,
      origin,
      providerPluginId,
      ownEnabled: null,
      providerEnabled,
      effectiveEnabled: eff.effectiveEnabled,
      blockedReason: eff.blockedReason,
      hook: hookFields,
    });
  }

  return out;
}
