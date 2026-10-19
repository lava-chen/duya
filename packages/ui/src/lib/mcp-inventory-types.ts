export type MCPInventorySource = 'settings' | 'plugin' | 'bundled';

export type MCPInventoryIssuePhase = 'connection' | 'registration' | 'discovery';
export type MCPInventoryIssueSeverity = 'critical' | 'warning' | 'info';

export interface MCPInventoryIssue {
  phase: MCPInventoryIssuePhase;
  humanMessage: string;
  severity: MCPInventoryIssueSeverity;
}

export interface MCPConfiguredServerDTO {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  allowedAgentIds?: string[];
}

export interface MCPPluginDeclaredServerDTO {
  id: string;
  pluginId: string;
  pluginName: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  providerEnabled: boolean;
  effective: boolean;
  shadowed: boolean;
}

export interface MCPEffectiveServerDTO {
  id: string;
  name: string;
  source: MCPInventorySource;
  sourceId?: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Streamable HTTP endpoint when the server uses HTTP transport. */
  url?: string;
  /** Optional request headers for HTTP transport. */
  headers?: Record<string, string>;
  writable: boolean;
  connected: boolean;
  effectiveEnabled: boolean;
  shadowedCandidateCount: number;
  connectionStatus: 'connected' | 'disconnected' | 'connecting' | 'error' | 'unknown';
  lastIssue?: MCPInventoryIssue;
  /**
   * Live tool list reported by the worker's `mcp:status:snapshot` SSE
   * event. Absent when the server never finished `listTools`
   * (transport error, spawn failure). Each entry keeps MCP tool
   * annotations verbatim so the settings UI can badge
   * destructive / open-world tools.
   */
  tools?: MCPEffectiveServerToolDTO[];
}

export interface MCPEffectiveServerToolDTO {
  name: string;
  description: string;
  annotations?: {
    readOnly?: boolean;
    destructive?: boolean;
    openWorld?: boolean;
    [key: string]: unknown;
  };
}

export interface MCPInventorySummaryDTO {
  configuredCount: number;
  configuredEnabledCount: number;
  pluginDeclaredCount: number;
  pluginEnabledCount: number;
  effectiveCount: number;
  bundledEffectiveCount: number;
  shadowedCount: number;
}

export interface MCPInventorySnapshotDTO {
  configuredServers: MCPConfiguredServerDTO[];
  pluginDeclaredServers: MCPPluginDeclaredServerDTO[];
  effectiveServers: MCPEffectiveServerDTO[];
  summary: MCPInventorySummaryDTO;
  generatedAt: number;
}
