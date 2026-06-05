/**
 * capability-management/index.ts
 *
 * Public surface for the capability-management aggregate layer.
 * Plan 83b Phase 1A.
 */

export {
  CapabilityManagementService,
  getCapabilityManagementService,
} from './capability-management-service';

export type {
  CapabilityDTO,
  CapabilityBlockedReason,
  CapabilityHookFields,
  CapabilityCliFields,
  CapabilityMcpFields,
  CapabilityMcpIssue,
  CapabilityMcpIssuePhase,
  CapabilityMcpIssueSeverity,
  CapabilityMcpConnectionStatus,
  CapabilityKind,
  CapabilityOrigin,
  CapabilitySkillFields,
  CapabilitySkillSecurityVerdict,
  CapabilityUiFields,
  CapabilityManagementSnapshot,
  CapabilityManagementSources,
  CapabilityUnsupportedEntry,
  PluginPackageDTO,
  PluginCapabilityCounts,
  PluginHealth,
  PluginOrigin,
  PluginTrustLevel,
} from './types';

export { CAPABILITY_MANAGEMENT_SNAPSHOT_SCHEMA_VERSION } from './types';

export {
  toPluginPackageDTO,
  toPluginDeclaredCapabilities,
} from './dto-mappers';
