/** Host adapter that gathers MCP discovery inputs from worker DB and config. */

import { pluginDb } from '../worker-db-client.js';
import { logger } from '../worker-logger.js';
import {
  buildMCPCandidates,
  type MCPCollectorInput,
  type MCPCollectorPluginEntry,
  type MCPCollectorSettingsItem,
} from '@duya/plugin-core/mcp/collect';
import {
  getMCPErrorMessage,
  getMCPErrorSeverity,
  getMCPSuggestedAction,
  type MCPCollectionResult,
  type MCPIssue,
  type MCPSourceContext,
} from '@duya/plugin-core';
import { readUserMcpToml } from './config.js';

export interface MCPCollectorDatabasePort {
  registryList(): Promise<unknown>;
  setupListAll(): Promise<unknown>;
}

export interface MCPCollectorLogger {
  info(message: string, context?: Record<string, unknown>, component?: string): void;
  warn(message: string, context?: Record<string, unknown>, component?: string): void;
}

export interface MCPCollectorPorts {
  database: MCPCollectorDatabasePort;
  readUserMcpToml(): Promise<MCPCollectorSettingsItem[]>;
  logger?: MCPCollectorLogger;
}

const defaultLogger: MCPCollectorLogger = logger;

const defaultPorts: MCPCollectorPorts = {
  database: pluginDb,
  readUserMcpToml,
  logger: defaultLogger,
};

function errorToIssue(err: unknown, reasonPrefix: string): MCPIssue {
  const error = {
    type: 'mcp-settings-invalid' as const,
    source: { source: 'settings', sourceSubOrigin: 'tomlFile' } as MCPSourceContext,
    reason: `${reasonPrefix}: ${err instanceof Error ? err.message : String(err)}`,
  };
  const suggestedAction = getMCPSuggestedAction(error);
  return {
    phase: 'discovery',
    source: error.source,
    serverName: '<settings>',
    error,
    humanMessage: getMCPErrorMessage(error),
    severity: getMCPErrorSeverity(error),
    ...(suggestedAction === undefined ? {} : { suggestedAction }),
  };
}

/**
 * Fetch plugin declarations and user config, then delegate source conversion
 * and provenance tagging to plugin-core's canonical collector.
 */
export async function collectWorkerMCPCandidates(
  ports: MCPCollectorPorts = defaultPorts,
): Promise<MCPCollectionResult> {
  const issues: MCPIssue[] = [];
  const input: MCPCollectorInput = { installedPlugins: [], userTomlItems: [] };
  const log = ports.logger ?? defaultLogger;

  try {
    const raw = await ports.database.registryList();
    if (Array.isArray(raw)) {
      input.installedPlugins = raw as unknown as MCPCollectorPluginEntry[];
    }
  } catch (error) {
    log.warn('[MCP] plugin registry lookup failed during discovery', {
      error: error instanceof Error ? error.message : String(error),
    }, 'MCP');
  }

  try {
    input.userTomlItems = await ports.readUserMcpToml();
  } catch (error) {
    issues.push(errorToIssue(error, 'mcp.toml is invalid'));
  }

  const built = buildMCPCandidates(input);
  return { candidates: built.candidates, issues: [...issues, ...built.issues] };
}

/** Return setup values for `${setup.X}` expansion in plugin manifests. */
export async function fetchPluginSetupValuesForMcp(
  database: MCPCollectorDatabasePort = pluginDb,
  log: MCPCollectorLogger = defaultLogger,
): Promise<Record<string, Record<string, string>>> {
  try {
    const raw = await database.setupListAll();
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, Record<string, string>>;
    }
  } catch (error) {
    log.warn('[MCP] plugin setup lookup failed during discovery', {
      error: error instanceof Error ? error.message : String(error),
    }, 'MCP');
  }
  return {};
}
