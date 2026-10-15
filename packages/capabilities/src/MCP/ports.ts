import type { ToolResult } from '@duya/ai';

export type MCPConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'degraded';

export type MCPToolSource = 'bundled' | 'plugin' | 'local' | 'settings' | 'unknown';

export interface MCPSamplingRateLimitConfig {
  maxRpm?: number;
  maxTokensCap?: number;
  maxToolRounds?: number;
}

/** Transport configuration consumed by the capability-owned MCP client. */
export interface MCPServerConfig {
  name: string;
  connectionId?: string;
  pluginId?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: 'stdio' | 'streamable-http';
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
