export { withPluginError, withPluginErrorSync, isSuccess, isFailure, unwrapResult, unwrapOr } from './error-wrapper';
export type { PluginResult } from './error-wrapper';

export {
  PathSafetyValidator,
} from './security/path-validator';
export type { PathValidationResult } from './security/path-validator';

export {
  PluginTrustLevel,
  TrustEngine,
  TRUST_LEVEL_CAPABILITIES,
} from './security/trust-engine';
export type { PluginTrustInfo, TrustLevelCapability } from './security/trust-engine';

export {
  PermissionService,
} from './security/permission-service';
export type {
  PermissionRequest,
  GrantedPermission,
  PermissionCheckResult,
} from './security/permission-service';

export {
  PolicyEngine,
  DEFAULT_POLICY,
} from './security/policy-engine';
export type { EnterprisePolicy } from './security/policy-engine';

export {
  PluginSecretStore,
} from './security/secret-store';
export type { SecretEntry } from './security/secret-store';

export {
  isPluginError,
  toPluginError,
} from './types';
export type {
  PluginError,
  PluginInstallError,
  PluginManifestError,
  PluginRuntimeError,
  PluginMarketplaceError,
  PluginCompatError,
} from './types';

// MCP — types and pure functions added in Phase 0 of plan 97.
// Flat re-exports so consumers can `import { scopedPluginServerName } from '@duya/plugin-core'`.
// The MCP namespace re-export is kept for consumers that prefer the grouped form.
export {
  PLUGIN_SCOPE_PREFIX,
  MCP_INTERNAL_PREFIX,
  MCP_INTERNAL_SEP,
  scopedPluginServerName,
  toolInternalKey,
  unscopedServerName,
  pluginIdFromScopedName,
  isPluginScopedName,
  buildInventoryId,
  AnthropicToolNamePolicy,
  OpenAIToolNamePolicy,
  shortStableHash,
  sanitizeProviderToolName,
  allocateUniqueProviderToolName,
  computeProviderName,
  MCP_PROVIDER_PREFIX,
  expandEnvVarsInString,
  substitutePluginVariables,
  substituteUserConfigVariables,
  expandMcpServerConfig,
  applySourceShadowing,
  resolveMCPDiscovery,
  getMCPErrorMessage,
  getMCPErrorSeverity,
  getMCPSuggestedAction,
} from './mcp';
export type {
  MCPDiscoveryStatus,
  MCPConnectionStatus,
  MCPDiscoveryError,
  MCPConnectionError,
  MCPRegistrationError,
  MCPError,
  MCPIssue,
  MCPPhase,
  MCPSource,
  MCPSettingsSubOrigin,
  MCPSourceContext,
  MCPCandidate,
  MCPCollectionResult,
  ResolutionContext,
  MCPServerInventoryEntry,
  ResolvedMCPServerConfig,
  ResolutionResult,
  MCPToolDescriptor,
  MCPHealthReport,
  BuiltinFallbackReplacement,
  ShadowApplicationResult,
  ProviderToolNamePolicy,
} from './mcp';

export {
  isMCPError,
  toMCPError,
  withMCPError,
} from './error-wrapper';
export type { MCPResult } from './error-wrapper';