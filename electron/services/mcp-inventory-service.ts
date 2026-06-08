import { getConfigManager } from '../config/manager';
import { getPluginManager } from '../plugins/PluginManager';
import { readPluginManifest } from '../plugins/manifest';
import { collectMainMCPCandidates } from '../agents/mcp/collect-main';
import { computeMCPId, resolveAvailableMCPs } from '../../packages/agent/src/mcp/mcpService';
import type { MCPCandidate, MCPIssue } from '@duya/plugin-core';
import type {
  MCPConfiguredServerDTO,
  MCPEffectiveServerDTO,
  MCPInventorySnapshotDTO,
  MCPPluginDeclaredServerDTO,
} from '../../src/lib/mcp-inventory-types';

interface ConfiguredServerEntry {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  allowedAgentIds?: string[];
}

function normalizeConfiguredServer(entry: ConfiguredServerEntry): MCPConfiguredServerDTO {
  return {
    name: entry.name,
    command: entry.command,
    args: Array.isArray(entry.args) ? entry.args : [],
    env: entry.env ?? {},
    enabled: entry.enabled !== false,
    allowedAgentIds: Array.isArray(entry.allowedAgentIds) && entry.allowedAgentIds.length > 0
      ? entry.allowedAgentIds
      : undefined,
  };
}

function issueForServer(issues: MCPIssue[], serverName: string): MCPIssue | undefined {
  return issues.find((issue) => issue.serverName === serverName);
}

function toEffectiveServerDTO(
  candidate: MCPCandidate,
  shadowedCandidateCount: number,
  issues: MCPIssue[],
): MCPEffectiveServerDTO {
  const issue = issueForServer(issues, candidate.rawConfig.name);
  const source = candidate.source === 'settings'
    ? 'settings'
    : candidate.source === 'plugin'
      ? 'plugin'
      : 'bundled';

  return {
    id: computeMCPId(candidate),
    name: candidate.rawConfig.name,
    source,
    sourceId: candidate.pluginId,
    command: candidate.rawConfig.command,
    args: Array.isArray(candidate.rawConfig.args) ? candidate.rawConfig.args : [],
    env: candidate.rawConfig.env ?? {},
    writable: source === 'settings',
    connected: false,
    effectiveEnabled: true,
    shadowedCandidateCount,
    connectionStatus: issue
      ? (issue.phase === 'connection' ? 'error' : 'disconnected')
      : 'unknown',
    lastIssue: issue
      ? {
          phase: issue.phase,
          humanMessage: issue.humanMessage,
          severity: issue.severity,
        }
      : undefined,
  };
}

export class MCPInventoryService {
  async buildSnapshot(): Promise<MCPInventorySnapshotDTO> {
    const configManager = getConfigManager();
    const pluginManager = getPluginManager();

    const agentSettings = configManager.getAgentSettings() as unknown as {
      mcpServers?: ConfiguredServerEntry[];
    };
    const configuredServers = Array.isArray(agentSettings.mcpServers)
      ? agentSettings.mcpServers
          .filter((entry) => entry && typeof entry.name === 'string' && typeof entry.command === 'string')
          .map(normalizeConfiguredServer)
      : [];

    const collected = await collectMainMCPCandidates();
    const winners = resolveAvailableMCPs(collected.candidates);
    const winnerIds = new Set(winners.map((candidate) => computeMCPId(candidate)));

    const byName = new Map<string, MCPCandidate[]>();
    for (const candidate of collected.candidates) {
      const existing = byName.get(candidate.rawConfig.name) ?? [];
      existing.push(candidate);
      byName.set(candidate.rawConfig.name, existing);
    }

    const effectiveServers = winners.map((candidate) =>
      toEffectiveServerDTO(
        candidate,
        Math.max(0, (byName.get(candidate.rawConfig.name)?.length ?? 1) - 1),
        collected.issues,
      ),
    );

    const pluginDeclaredServers: MCPPluginDeclaredServerDTO[] = [];
    for (const plugin of pluginManager.listInstalled()) {
      try {
        const manifest = readPluginManifest(plugin.installPath);
        for (const server of manifest.capabilities?.mcpServers ?? []) {
          const candidateId = computeMCPId({
            source: 'plugin',
            pluginId: plugin.id,
            pluginName: plugin.name,
            pluginRoot: plugin.installPath,
            pluginDataPath: plugin.dataPath,
            rawConfig: {
              name: server.name,
              command: server.command,
              args: server.args,
              env: server.env,
            },
          });
          pluginDeclaredServers.push({
            id: candidateId,
            pluginId: plugin.id,
            pluginName: plugin.name,
            name: server.name,
            command: server.command,
            args: Array.isArray(server.args) ? server.args : [],
            env: server.env ?? {},
            providerEnabled: plugin.enabled,
            effective: winnerIds.has(candidateId),
            shadowed: !winnerIds.has(candidateId),
          });
        }
      } catch {
        // Ignore malformed plugin manifests here; plugin health surfaces separately.
      }
    }

    const summary = {
      configuredCount: configuredServers.length,
      configuredEnabledCount: configuredServers.filter((server) => server.enabled).length,
      pluginDeclaredCount: pluginDeclaredServers.length,
      pluginEnabledCount: pluginDeclaredServers.filter((server) => server.providerEnabled).length,
      effectiveCount: effectiveServers.length,
      bundledEffectiveCount: effectiveServers.filter((server) => server.source === 'bundled').length,
      shadowedCount: collected.candidates.length - winners.length,
    };

    return {
      configuredServers,
      pluginDeclaredServers,
      effectiveServers,
      summary,
      generatedAt: Date.now(),
    };
  }
}

let singleton: MCPInventoryService | null = null;

export function getMCPInventoryService(): MCPInventoryService {
  if (!singleton) {
    singleton = new MCPInventoryService();
  }
  return singleton;
}
