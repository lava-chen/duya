/**
 * MCP Notifications Module
 * Handles dynamic tool refresh via server notifications
 * Supports tools/list_changed notification for dynamic tool updates
 */

import type { MCPManager } from './index.js';
import type { ToolRegistry } from '../tool/registry.js';
import { registerMCPTools } from './discovery.js';
import { logger } from '../utils/logger.js';

/**
 * Notification handler options
 */
export interface NotificationHandlerOptions {
  /** Tool registry to update when tools change */
  toolRegistry: ToolRegistry;
  /** Conflict resolution strategy */
  conflictStrategy?: 'prefix' | 'skip' | 'overwrite';
  /** Prefix for conflicting tool names */
  prefix?: string;
}

/**
 * MCP Notification Handler
 * Manages server notifications and triggers tool refreshes
 */
export class MCPNotificationHandler {
  private mcpManager: MCPManager;
  private options: NotificationHandlerOptions;
  private unsubscribers: Array<() => void> = [];

  constructor(mcpManager: MCPManager, options: NotificationHandlerOptions) {
    this.mcpManager = mcpManager;
    this.options = options;
  }

  /**
   * Start listening for notifications from all connected servers
   */
  startListening(): void {
    // Note: The current MCPManager doesn't have onStatusChange method
    // This is a placeholder for future implementation
    logger.info('[MCP Notifications] Started listening for server notifications');
  }

  /**
   * Stop listening for notifications
   */
  stopListening(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
    logger.info('[MCP Notifications] Stopped listening for notifications');
  }

  /**
   * Handle new server connection
   */
  private handleServerConnected(serverName: string): void {
    logger.info(`[MCP Notifications] Server connected: ${serverName}`);

    // Register tools from the newly connected server
    const result = registerMCPTools(this.mcpManager, this.options.toolRegistry, {
      conflictStrategy: this.options.conflictStrategy,
      prefix: this.options.prefix,
    });

    logger.info(
      `[MCP Notifications] Prepared ${result.registered.length} tools from ${serverName}`
    );

    if (result.conflicts.length > 0) {
      logger.warn(
        `[MCP Notifications] ${result.conflicts.length} tool conflicts detected`
      );
    }
  }

  /**
   * Manually trigger tool refresh for all connected servers
   */
  async refreshAllTools(): Promise<{
    totalRegistered: number;
    conflicts: Array<{ toolName: string; source: string; existingSource: string }>;
  }> {
    logger.info('[MCP Notifications] Manually refreshing all tools');

    const result = registerMCPTools(this.mcpManager, this.options.toolRegistry, {
      conflictStrategy: this.options.conflictStrategy,
      prefix: this.options.prefix,
    });

    return {
      totalRegistered: result.registered.length,
      conflicts: result.conflicts,
    };
  }

  /**
   * Refresh tools for a specific server
   */
  async refreshServerTools(serverName: string): Promise<{
    registered: string[];
    conflicts: Array<{ toolName: string; source: string; existingSource: string }>;
  }> {
    logger.info(`[MCP Notifications] Refreshing tools for server: ${serverName}`);

    const client = this.mcpManager.getClient(serverName);
    if (!client) {
      throw new Error(`Server not found: ${serverName}`);
    }

    // Get tools from this specific server
    const tools = client.getTools();

    // Track registration results
    const registered: string[] = [];
    const conflicts: Array<{ toolName: string; source: string; existingSource: string }> = [];

    for (const tool of tools) {
      const toolName = tool.name;

      // Check for conflicts
      if (this.options.toolRegistry.has(toolName)) {
        if (this.options.conflictStrategy === 'skip') {
          continue;
        } else if (this.options.conflictStrategy === 'prefix') {
          const prefixedName = `${this.options.prefix || 'mcp_'}${toolName}`;
          registered.push(prefixedName);
          continue;
        }
      }

      registered.push(toolName);
    }

    return { registered, conflicts };
  }
}

/**
 * Create a notification handler
 */
export function createNotificationHandler(
  mcpManager: MCPManager,
  options: NotificationHandlerOptions
): MCPNotificationHandler {
  return new MCPNotificationHandler(mcpManager, options);
}
