import type { ToolResult } from '@duya/ai';

export type MCPConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'degraded';

/**
 * Provenance bucket of an MCP server, as the runtime permission gate
 * sees it.
 *
 * `'app'` is the app layer's own bucket (plan 616): the host-owned
 * `duya_app` server. It is NOT `bundled`. `bundled` short-circuits the
 * permission chain to `allow`; `app` must not, because the app layer owns
 * tools that reach outside the app (sending messages to users, scheduling
 * routines) and those still need the catastrophic check, the host standing
 * switch and the risk tiers. See plan 616 §C9.
 */
export type MCPToolSource = 'bundled' | 'plugin' | 'local' | 'settings' | 'unknown' | 'app';

export interface MCPSamplingRateLimitConfig {
  maxRpm?: number;
  maxTokensCap?: number;
  maxToolRounds?: number;
}

/**
 * A host-owned MCP server that lives in the SAME process as the MCP client
 * (plan 616 T610a).
 *
 * `duya_app` is the first such server: the product capabilities (
 * bot / browser) are implemented in-process, so the server is handed to the
 * client as an object rather than spawned as a subprocess. Two consequences
 * the design depends on:
 *
 *  1. The client and the server share one process, so the live
 *     `ToolUseContext` (host IPC functions, session id, per-turn state)
 *     reaches the tool implementation without crossing a serialization
 *     boundary — see the AsyncLocalStorage pipeline (plan 616 T610b).
 *  2. `connect` / `close` mirror the MCP SDK `Server` surface, so the
 *     client treats it exactly like a remote server.
 */
export interface InProcessMcpServer {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}

/** Transport configuration consumed by the capability-owned MCP client. */
export interface MCPServerConfig {
  name: string;
  connectionId?: string;
  pluginId?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * `'in-process'` connects to a host-owned server object handed over in
   * `inProcessServer` instead of spawning a subprocess. It exists so
   * first-party product capabilities can speak the same MCP contract as
   * external servers (plan 616).
   */
  transport?: 'stdio' | 'streamable-http' | 'in-process';
  /** The host-owned server, required when `transport === 'in-process'`. */
  inProcessServer?: InProcessMcpServer;
  url?: string;
  headers?: Record<string, string>;
  allowedAgentIds?: string[];
  source?: MCPToolSource;
  envPassthrough?: 'allowlist' | 'inherit';
  nameOverride?: string;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
  toolTimeouts?: Record<string, number>;
  useShell?: boolean;
  sampling?: MCPSamplingRateLimitConfig;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  annotations?: {
    readOnly?: boolean;
    destructive?: boolean;
    openWorld?: boolean;
    [key: string]: unknown;
  };
  internalKey?: string;
  providerName?: string;
  mcpInfo?: {
    serverName: string;
    toolName: string;
    source: MCPToolSource;
    connectionId?: string;
    pluginId?: string;
  };
  serverName?: string;
}

/** Minimal logging surface; process and application loggers are injected. */
export interface MCPLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface MCPManagerOptions {
  logger?: MCPLogger;
}

export type MCPToolCallResult = ToolResult;

export const silentMCPLogger: MCPLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
