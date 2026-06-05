/**
 * Capability Management DTO (electron side)
 *
 * Mirror type definitions for the capability-management aggregate snapshot.
 *
 * Plan 83b Phase 1A — read-only aggregation of installed plugins and their
 * declared capabilities. This file MUST stay in sync with
 * `src/lib/capability-management-types.ts`. The parity test in
 * `electron/services/capability-management/dto-parity.test.ts` verifies
 * the two sides agree on field names and enumeration values.
 *
 * Rev 3 终版 4 处最终修订：
 *   1. CapabilityDTO.ownEnabled / effectiveEnabled 是 boolean | null
 *      （providerEnabled=true 但 own 状态未读取时为 null）
 *   2. enumerate 全部 installed，含 enabled=false
 *   3. 主/renderer 共享 DTO 优先；备选 mirror + parity test（本文件即备选）
 *   4. mcp.connectionStatus / mcp.lastIssue 反映运行时；
 *      blockedReason 仅由 providerEnabled + ownEnabled 派生，**不**来自 connection error
 */

export type PluginTrustLevel = 'official' | 'verified' | 'local' | 'untrusted';
export type PluginHealth = 'ready' | 'disabled' | 'needs_setup' | 'failed' | 'unknown';
export type PluginOrigin = 'bundled' | 'marketplace' | 'local' | 'builtin-directory' | 'development' | 'unknown';

export interface PluginCapabilityCounts {
  skills: number;
  mcpServers: number;
  cli: number;
  ui: number;
  hooks: number;
}

export interface PluginPackageDTO {
  id: string;
  name: string;
  version?: string;
  description?: string;
  origin: PluginOrigin;
  enabled: boolean;
  trustLevel: PluginTrustLevel;
  health: PluginHealth;
  capabilityCounts: PluginCapabilityCounts;
}

export type CapabilityKind = 'skill' | 'mcp' | 'cli' | 'ui' | 'hook';
export type CapabilityOrigin =
  | 'bundled'
  | 'user'
  | 'plugin'
  | 'project'
  | 'custom'
  | 'settings'
  | 'local'
  | 'marketplace'
  | 'unknown';

export type CapabilityMcpConnectionStatus = 'connected' | 'disconnected' | 'connecting' | 'error' | 'unknown';
export type CapabilityMcpIssuePhase = 'connection' | 'registration' | 'discovery';
export type CapabilityMcpIssueSeverity = 'critical' | 'warning' | 'info';

export interface CapabilityMcpIssue {
  phase: CapabilityMcpIssuePhase;
  humanMessage: string;
  severity: CapabilityMcpIssueSeverity;
}

export interface CapabilityMcpFields {
  connectionStatus: CapabilityMcpConnectionStatus;
  toolCount?: number;
  lastIssue?: CapabilityMcpIssue;
}

export type CapabilitySkillSecurityVerdict = 'safe' | 'caution' | 'dangerous' | 'unknown';

export interface CapabilitySkillFields {
  securityVerdict: CapabilitySkillSecurityVerdict;
  findingCount: number;
}

export interface CapabilityCliFields {
  command: string;
  args?: string[];
}

export interface CapabilityUiFields {
  id: string;
  type: string;
}

export interface CapabilityHookFields {
  event: string;
  handler: string;
}

export type CapabilityBlockedReason = 'plugin-disabled' | 'user-disabled' | 'overridden-off' | 'unresolved';

export interface CapabilityDTO {
  displayKey: string;
  kind: CapabilityKind;
  name: string;
  description?: string;
  origin: CapabilityOrigin;
  providerPluginId?: string;
  ownEnabled: boolean | null;
  providerEnabled: boolean;
  effectiveEnabled: boolean | null;
  blockedReason?: CapabilityBlockedReason;
  mcp?: CapabilityMcpFields;
  skill?: CapabilitySkillFields;
  cli?: CapabilityCliFields;
  ui?: CapabilityUiFields;
  hook?: CapabilityHookFields;
}

export interface CapabilityUnsupportedEntry {
  kind: CapabilityKind;
  reason: string;
}

export interface CapabilityManagementSources {
  plugins: 'electron/plugins/PluginManager' | 'none';
  skills: 'packages/agent/src/skills' | 'none';
  mcp: 'electron/agents/mcp/collect-main' | 'none';
  ui: 'plugin-manifest' | 'none';
  hooks: 'plugin-manifest' | 'none';
  cli: 'plugin-manifest' | 'none';
}

export interface CapabilityManagementSnapshot {
  plugins: PluginPackageDTO[];
  capabilities: CapabilityDTO[];
  generatedAt: number;
  sources: CapabilityManagementSources;
  unsupported: CapabilityUnsupportedEntry[];
}

export interface CapabilityManagementSnapshotPhase1B
  extends CapabilityManagementSnapshot {
  /**
   * Cross-source sources consulted in Phase 1B. Phase 1A leaves this
   * field undefined. Phase 3 will surface the resolved MCP list when
   * SSE is wired in.
   */
  crossSource?: {
    skillCandidateCount: number;
    mcpCandidateCount: number;
    settingsOverrideApplied: boolean;
  };
}

export const CAPABILITY_MANAGEMENT_SNAPSHOT_SCHEMA_VERSION = 1;
