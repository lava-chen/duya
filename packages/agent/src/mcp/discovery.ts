/**
 * MCP Tool Discovery Module
 * Handles tool discovery, registration, and conflict resolution
 */

import type { Tool } from '../types.js';
import type { ToolRegistry } from '../tool/registry.js';
import type { MCPManager, MCPClient } from './index.js';
import { logger } from '../utils/logger.js';

/**
 * Tool discovery result
 */
export interface ToolDiscoveryResult {
  tools: Tool[];
  conflicts: Array<{
    toolName: string;
    source: string;
    existingSource: string;
  }>;
  skipped: Array<{
    toolName: string;
    reason: string;
  }>;
}

/**
 * Tool registration result
 */
export interface ToolRegistrationResult {
  registered: string[];
  conflicts: Array<{
    toolName: string;
    source: string;
    existingSource: string;
  }>;
  skipped: Array<{
    toolName: string;
    reason: string;
  }>;
}

/**
 * Prefix strategy for conflict resolution
 */
export type ConflictStrategy = 'prefix' | 'skip' | 'overwrite';

/**
 * Discover tools from MCP manager
 */
export async function discoverMCPTools(mcpManager: MCPManager): Promise<ToolDiscoveryResult> {
  const result: ToolDiscoveryResult = {
    tools: [],
    conflicts: [],
    skipped: [],
  };

  try {
    const allTools = mcpManager.getAllTools();
    const clients = mcpManager.getAllClients();

    logger.info(`[MCP Discovery] Discovering tools from ${clients.length} servers`);

    for (const tool of allTools) {
      result.tools.push(tool);
    }

    logger.info(`[MCP Discovery] Discovered ${result.tools.length} tools`);
  } catch (error) {
    logger.error(`[MCP Discovery] Error discovering tools: ${error instanceof Error ? error.message : String(error)}`);
  }

  return result;
}

/**
 * Register MCP tools to tool registry with conflict resolution
 * Note: This is a placeholder implementation. Actual tool registration
 * requires executor functions which are not available at discovery time.
 */
export function registerMCPTools(
  mcpManager: MCPManager,
  registry: ToolRegistry,
  options: {
    conflictStrategy?: ConflictStrategy;
    prefix?: string;
  } = {}
): ToolRegistrationResult {
  const result: ToolRegistrationResult = {
    registered: [],
    conflicts: [],
    skipped: [],
  };

  const { conflictStrategy = 'prefix', prefix = 'mcp_' } = options;

  try {
    const allTools = mcpManager.getAllTools();

    for (const tool of allTools) {
      const toolName = tool.name;

      // Check for conflicts with existing tools
      if (registry.has(toolName)) {
        if (conflictStrategy === 'skip') {
          result.skipped.push({
            toolName,
            reason: 'Tool already exists in registry (skip strategy)',
          });
          continue;
        } else if (conflictStrategy === 'prefix') {
          // Apply prefix to avoid conflict
          const prefixedName = `${prefix}${toolName}`;
          result.registered.push(prefixedName);
          logger.debug(`[MCP Discovery] Would register tool with prefix: ${prefixedName}`);
          continue;
        }
        // overwrite strategy falls through
      }

      result.registered.push(toolName);
      logger.debug(`[MCP Discovery] Would register tool: ${toolName}`);
    }

    logger.info(`[MCP Discovery] Prepared ${result.registered.length} MCP tools for registration`);
  } catch (error) {
    logger.error(`[MCP Discovery] Error preparing tools: ${error instanceof Error ? error.message : String(error)}`);
  }

  return result;
}

/**
 * Get tool source information
 */
export function getToolSource(mcpManager: MCPManager, toolName: string): string | undefined {
  const clients = mcpManager.getAllClients();
  for (const client of clients) {
    const tools = client.getTools();
    if (tools.some(t => t.name === toolName)) {
      return client.getName();
    }
  }
  return undefined;
}

/**
 * Check if tool is from MCP
 */
export function isMCPTool(mcpManager: MCPManager, toolName: string): boolean {
  return getToolSource(mcpManager, toolName) !== undefined;
}

/**
 * Get all MCP tool names grouped by server
 */
export function getToolsByServer(mcpManager: MCPManager): Map<string, string[]> {
  const result = new Map<string, string[]>();

  const clients = mcpManager.getAllClients();
  for (const client of clients) {
    const tools = client.getTools();
    result.set(client.getName(), tools.map(t => t.name));
  }

  return result;
}
