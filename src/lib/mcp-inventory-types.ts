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
  writable: boolean;
  connected: boolean;
  effectiveEnabled: boolean;
  shadowedCandidateCount: number;
  connectionStatus: 'connected' | 'disconnected' | 'connecting' | 'error' | 'unknown';
  lastIssue?: MCPInventoryIssue;
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
