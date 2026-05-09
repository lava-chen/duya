/**
 * MCP Client - Model Context Protocol Client
 * Manages MCP server connections and tool calls
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool, ToolResult, MCPServerConfig, MCPConnectionStatus } from '../types.js';
import { logger } from '../utils/logger.js';
import { getCircuitBreakerManager, type CircuitBreaker } from './circuit-breaker.js';
export { getCircuitBreakerManager, CircuitBreaker };

/**
 * MCP Client - Manages connection to a single MCP server
 */
export class MCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private config: MCPServerConfig;
  private connectionStatus: MCPConnectionStatus = 'disconnected';
  private tools: Tool[] = [];
  private circuitBreaker: CircuitBreaker;

  constructor(config: MCPServerConfig) {
    this.config = config;
    this.circuitBreaker = getCircuitBreakerManager().getBreaker(config.name);
  }

  /**
   * Get server name
   */
  getName(): string {
    return this.config.name;
  }

  /**
   * Get current connection status
   */
  getStatus(): MCPConnectionStatus {
    return this.connectionStatus;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connectionStatus === 'connected';
  }

  /**
   * Get available tools
   */
  getTools(): Tool[] {
    return this.tools;
  }

  /**
   * Connect to the MCP server
   */
  async connect(): Promise<void> {
    if (this.connectionStatus === 'connected') {
      return;
    }

    // Check circuit breaker
    if (!this.circuitBreaker.canExecute()) {
      throw new Error(`Circuit breaker is open for MCP server: ${this.config.name}`);
    }

    try {
      this.connectionStatus = 'connecting';
      
      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        env: this.config.env,
      });

      this.client = new Client(
        {
          name: 'duya-mcp-client',
          version: '0.1.0',
        },
        {
          capabilities: {},
        }
      );

      await this.client.connect(this.transport);
      
      // List available tools
      const toolsResponse = await this.client.listTools();
      this.tools = toolsResponse.tools.map((tool: { name: string; description?: string; inputSchema?: unknown }) => ({
        name: tool.name,
        description: tool.description || '',
        input_schema: tool.inputSchema as Record<string, unknown>,
      }));

      this.connectionStatus = 'connected';
      this.circuitBreaker.recordSuccess();
      
      logger.info(`[MCP] Connected to server: ${this.config.name} (${this.tools.length} tools)`);
    } catch (error) {
      this.connectionStatus = 'error';
      this.circuitBreaker.recordFailure();
      
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[MCP] Failed to connect to server: ${this.config.name} - ${errorMsg}`);
      throw new Error(`Failed to connect to MCP server ${this.config.name}: ${errorMsg}`);
    }
  }

  /**
   * Disconnect from the MCP server
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
    this.connectionStatus = 'disconnected';
    this.tools = [];
    logger.info(`[MCP] Disconnected from server: ${this.config.name}`);
  }

  /**
   * Call a tool on the MCP server
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.client || this.connectionStatus !== 'connected') {
      throw new Error(`MCP server not connected: ${this.config.name}`);
    }

    // Check circuit breaker
    if (!this.circuitBreaker.canExecute()) {
      throw new Error(`Circuit breaker is open for MCP server: ${this.config.name}`);
    }

    try {
      const result = await this.client.callTool(
        {
          name,
          arguments: args,
        },
        CallToolResultSchema
      );

      this.circuitBreaker.recordSuccess();

      // Convert MCP result to ToolResult
      const content = result.content as Array<{ type: string; text?: string }>;
      const textContent = content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map(c => c.text)
        .join('\n');

      const toolResult: ToolResult = {
        id: `${this.config.name}-${name}`,
        name: name,
        result: textContent,
      };
      if (result.isError) {
        toolResult.error = true;
      }
      return toolResult;
    } catch (error) {
      this.circuitBreaker.recordFailure();
      
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[MCP] Tool call failed: ${this.config.name}.${name} - ${errorMsg}`);
      return {
        id: `${this.config.name}-${name}`,
        name: name,
        result: `Error: ${errorMsg}`,
        error: true,
      };
    }
  }
}

/**
 * MCP Manager - Manages multiple MCP server connections
 */
export class MCPManager {
  private clients: Map<string, MCPClient> = new Map();

  /**
   * Add and connect to an MCP server
   */
  async addServer(config: MCPServerConfig): Promise<MCPClient> {
    const client = new MCPClient(config);
    await client.connect();
    this.clients.set(config.name, client);
    return client;
  }

  /**
   * Remove and disconnect from an MCP server
   */
  async removeServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      await client.disconnect();
      this.clients.delete(name);
    }
  }

  /**
   * Get a client by name
   */
  getClient(name: string): MCPClient | undefined {
    return this.clients.get(name);
  }

  /**
   * Get all connected clients
   */
  getAllClients(): MCPClient[] {
    return Array.from(this.clients.values());
  }

  /**
   * Get all available tools from all connected servers
   */
  getAllTools(): Array<Tool & { serverName: string }> {
    const tools: Array<Tool & { serverName: string }> = [];
    for (const client of this.clients.values()) {
      if (client.isConnected()) {
        for (const tool of client.getTools()) {
          tools.push({
            ...tool,
            serverName: client.getName(),
          });
        }
      }
    }
    return tools;
  }

  /**
   * Call a tool on a specific server
   */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server not found: ${serverName}`);
    }
    return client.callTool(toolName, args);
  }

  /**
   * Disconnect from all servers
   */
  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.disconnect();
    }
    this.clients.clear();
  }

  /**
   * Get connection status for all servers
   */
  getAllStatus(): Array<{ name: string; status: MCPConnectionStatus; toolCount: number }> {
    return Array.from(this.clients.entries()).map(([name, client]) => ({
      name,
      status: client.getStatus(),
      toolCount: client.getTools().length,
    }));
  }
}

/**
 * Global MCP manager instance
 */
let globalMCPManager: MCPManager | null = null;

export function getMCPManager(): MCPManager {
  if (!globalMCPManager) {
    globalMCPManager = new MCPManager();
  }
  return globalMCPManager;
}

export function resetMCPManager(): void {
  globalMCPManager = null;
}
