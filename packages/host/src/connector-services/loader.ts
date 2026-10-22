/** Host composition around the environment-agnostic MCP discovery engine. */

import type {
  MCPIssue,
  MCPServerInventoryEntry,
  ResolvedMCPServerConfig,
} from '@duya/plugin-core';
import { resolveMCPDiscovery } from '@duya/plugin-core/mcp/resolve';
import type { MCPServerConfig } from '@duya/capabilities/MCP/ports';
import { logger } from '../worker-logger.js';
import {
  collectWorkerMCPCandidates,
  fetchPluginSetupValuesForMcp,
  type MCPCollectorDatabasePort,
  type MCPCollectorLogger,
  type MCPCollectorPorts,
} from './collector.js';

export interface MCPLoadResult {
  inventory: MCPServerInventoryEntry[];
  resolvedConfigs: ResolvedMCPServerConfig[];
  legacyConfigs: MCPServerConfig[];
  issues: MCPIssue[];
}

export interface MCPLoaderOptions {
  agentProfileId?: string;
  collector?: MCPCollectorPorts;
  database?: MCPCollectorDatabasePort;
  environment?: NodeJS.ProcessEnv;
  logger?: MCPCollectorLogger;
  fetchPluginSetupValues?: () => Promise<Record<string, Record<string, string>>>;
}

export function resolvedToLegacyConfig(r: ResolvedMCPServerConfig): MCPServerConfig {
  const raw = r.rawConfig;
  const connectionId = (raw as typeof raw & { connectionId?: string }).connectionId;
  return {
    name: r.scopedServerName,
    ...(raw.transport === undefined ? {} : { transport: raw.transport }),
    ...(raw.command === undefined ? {} : { command: raw.command }),
    ...(raw.args === undefined ? {} : { args: raw.args }),
    ...(raw.env === undefined ? {} : { env: raw.env }),
    ...(raw.url === undefined ? {} : { url: raw.url }),
    ...(raw.headers === undefined ? {} : { headers: raw.headers }),
    ...(r.allowedAgentIds === undefined ? {} : { allowedAgentIds: r.allowedAgentIds }),
    ...(raw.nameOverride === undefined ? {} : { nameOverride: raw.nameOverride }),
    ...(raw.startupTimeoutSec === undefined ? {} : { startupTimeoutSec: raw.startupTimeoutSec }),
    ...(raw.toolTimeoutSec === undefined ? {} : { toolTimeoutSec: raw.toolTimeoutSec }),
    ...(raw.toolTimeouts === undefined ? {} : { toolTimeouts: raw.toolTimeouts }),
    ...(raw.envPassthrough === undefined ? {} : { envPassthrough: raw.envPassthrough }),
    ...(raw.useShell === undefined ? {} : { useShell: raw.useShell }),
    ...(r.pluginId === undefined ? {} : { pluginId: r.pluginId }),
    ...(connectionId === undefined ? {} : { connectionId }),
    source: r.source === 'bundled' || r.source === 'plugin' || r.source === 'settings'
      ? r.source
      : 'unknown',
  };
}

export function filterDefinedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export function filterResolvedMCPServersForAgent(
  configs: ReadonlyArray<ResolvedMCPServerConfig>,
  agentProfileId: string | undefined,
): ResolvedMCPServerConfig[] {
  if (!agentProfileId) return configs.slice();
  return configs.filter((config) =>
    !config.allowedAgentIds?.length || config.allowedAgentIds.includes(agentProfileId),
  );
}

/** Collect and resolve the effective MCP set without mutating runtime state. */
export async function loadAndResolveMCPServers(
  options: MCPLoaderOptions = {},
): Promise<MCPLoadResult> {
  const collection = await collectWorkerMCPCandidates(options.collector);
  const setupValues = options.fetchPluginSetupValues
    ? await options.fetchPluginSetupValues()
    : await fetchPluginSetupValuesForMcp(options.database, options.logger ?? logger);
  const resolution = await resolveMCPDiscovery(collection.candidates, {
    environment: filterDefinedEnv(options.environment ?? process.env),
    userConfigByPlugin: setupValues,
  });
  const resolvedConfigs = filterResolvedMCPServersForAgent(
    resolution.resolvedConfigs,
    options.agentProfileId,
  );
  const log = options.logger ?? logger;

  log.info(
    `[MCP] Resolved ${resolvedConfigs.length}/${resolution.resolvedConfigs.length} servers for agentProfileId=${options.agentProfileId ?? '(none)'}`,
    undefined,
    'MCP',
  );
  for (const config of resolution.resolvedConfigs) {
    if (!resolvedConfigs.includes(config)) {
      log.warn(
        `[MCP] Server "${config.scopedServerName}" filtered out by allowedAgentIds`,
        {
          allowed: config.allowedAgentIds?.length ? config.allowedAgentIds : [],
          agentProfileId: options.agentProfileId ?? null,
        },
        'MCP',
      );
    }
  }

  return {
    inventory: resolution.inventory,
    resolvedConfigs,
    legacyConfigs: resolvedConfigs.map(resolvedToLegacyConfig),
    issues: [...collection.issues, ...resolution.issues],
  };
}
