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
import { buildSafeEnv, sanitizeSecrets, scanMcpDescription } from './security.js';
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
   * Get the source bucket for the runtime permission gate. Set
   * by `applyMCPConfiguration` from the resolved config; defaults
   * to `'unknown'` when the caller did not stamp the field.
   */
  getSource(): 'bundled' | 'plugin' | 'local' | 'settings' | 'unknown' {
    return this.config.source ?? 'unknown';
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

      // Security layer 1 (env allowlist): strip secrets from the subprocess
      // environment before spawning the MCP server process. MCP servers are
      // untrusted external code; without this, any API key / token in the
      // agent process env leaks to them. `envPassthrough: 'inherit'` opts
      // out for trusted bundled servers that depend on inherited env.
      const safeEnv = buildSafeEnv(this.config.env, {
        forceInherit: this.config.envPassthrough === 'inherit',
      });

      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        env: safeEnv,
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
      this.tools = toolsResponse.tools.map((tool: { name: string; description?: string; inputSchema?: unknown }) => {
        // Security layer 3 (prompt injection scan): warn on suspicious tool
        // descriptions. Does not block — false positives would break legit
        // servers. The permission gate (permission-gate.ts) handles blocking
        // based on source. Here we only observe + log.
        scanMcpDescription(this.config.name, tool.name, tool.description || '');
        return {
          name: tool.name,
          description: tool.description || '',
          input_schema: tool.inputSchema as Record<string, unknown>,
        };
      });

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

      const rawMsg = error instanceof Error ? error.message : String(error);
      // Security layer 2 (secret sanitization): redact credential-like
      // patterns (ghp_*, sk-*, Bearer, token=, etc.) before the error
      // message is returned to the LLM via ToolResult.result. Without
      // this, a misconfigured MCP server that echoes its auth token in
      // an error string would leak it into the conversation history.
      const errorMsg = sanitizeSecrets(rawMsg);
      logger.error(`[MCP] Tool call failed: ${this.config.name}.${name} - ${rawMsg}`);
      return {
        id: `${this.config.name}-${name}`,
        name: name,
        result: `Error: ${errorMsg}`,
        error: true,
      };
    }
  }

  /**
   * List resources exposed by this MCP server.
   *
   * Returns `[]` when:
   *  - the client is not connected
   *  - the server does not implement the resources capability (the SDK
   *    throws "Method not found")
   *  - the call times out / errors for any other reason
   *
   * Resources are MCP's read-only data plane (files, DB rows, API
   * snapshots). Some servers expose a handful; most expose none. The
   * list_mcp_resources tool surfaces this so the model can discover
   * what's available.
   */
  async listResources(): Promise<Array<{ uri: string; name?: string; description?: string; mimeType?: string }>> {
    if (!this.client || this.connectionStatus !== 'connected') {
      return [];
    }
    try {
      const result = await this.client.listResources();
      // The SDK returns `{ resources, nextCursor? }`. We only return the
      // page at hand — pagination can be added when an MCP server actually
      // returns more resources than fit in one page in practice.
      return result.resources.map((r) => ({
        uri: r.uri,
        ...(r.name !== undefined && { name: r.name }),
        ...(r.description !== undefined && { description: r.description }),
        ...(r.mimeType !== undefined && { mimeType: r.mimeType }),
      }));
    } catch (error) {
      // Method not found = the server simply doesn't expose resources.
      // That's not an error condition for our caller; surface as empty.
      const msg = error instanceof Error ? error.message : String(error);
      if (/Method not found/i.test(msg) || /unknown method/i.test(msg)) {
        return [];
      }
      logger.warn(`[MCP] listResources failed for ${this.config.name}: ${msg}`);
      return [];
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
   * Phase 2A worker closure: same as getAllTools but with
   * Tool.internalKey / providerName / mcpInfo pre-computed for
   * direct registration. The providerName allocator is supplied
   * by the caller (applyMCPConfiguration) so lifecycle and
   * uniqueness policy stay in one place. Tools from disconnected
   * clients are skipped, matching the previous getAllTools
   * behavior.
   *
   * Tools are sorted by (scopedServerName asc, toolName asc)
   * before allocation; the allocator maintains its own usedNames
   * set, so identical input + identical ordering yields identical
   * providerNames across reloads.
   */
  getAllToolsWithIdentity(
    allocateProviderName: (internalKey: string) => string,
  ): Array<Tool & { serverName: string }> {
    type Pending = {
      scopedServerName: string;
      toolName: string;
      description: string;
      input_schema: Record<string, unknown>;
      source: 'bundled' | 'plugin' | 'local' | 'settings' | 'unknown';
    };
    const pending: Pending[] = [];
    for (const client of this.clients.values()) {
      if (!client.isConnected()) continue;
      const scopedServerName = client.getName();
      const source = client.getSource();
      for (const tool of client.getTools()) {
        pending.push({
          scopedServerName,
          toolName: tool.name,
          description: tool.description,
          input_schema: tool.input_schema,
          source,
        });
      }
    }
    pending.sort((a, b) => {
      if (a.scopedServerName < b.scopedServerName) return -1;
      if (a.scopedServerName > b.scopedServerName) return 1;
      if (a.toolName < b.toolName) return -1;
      if (a.toolName > b.toolName) return 1;
      return 0;
    });
    const tools: Array<Tool & { serverName: string }> = [];
    for (const p of pending) {
      const internalKey = `mcp__${p.scopedServerName}__${p.toolName}`;
      const providerName = allocateProviderName(internalKey);
      tools.push({
        name: providerName,
        description: p.description,
        input_schema: p.input_schema,
        internalKey,
        providerName,
        mcpInfo: {
          serverName: p.scopedServerName,
          toolName: p.toolName,
          source: p.source,
        },
        serverName: p.scopedServerName,
      });
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
