export { withPluginError, withPluginErrorSync, isSuccess, isFailure, unwrapResult, unwrapOr } from './error-wrapper';
export type { PluginResult } from './error-wrapper';

// NOTE: PathSafetyValidator is NOT re-exported here. It lives in
// './security/path-validator' which imports Node builtins ('path', 'fs').
// Re-exporting it from this barrel would force Vite to load that module in
// the browser, triggering "Module path has been externalized for browser
// compatibility" errors. Node-side consumers import it directly:
//   import { PathSafetyValidator } from '@duya/plugin-core/src/security/path-validator'
export {
  PluginTrustLevel,
  TrustEngine,
  TRUST_LEVEL_CAPABILITIES,
} from './security/trust-engine';
export type { PluginTrustInfo, TrustLevelCapability } from './security/trust-engine';

// Plan 584 Phase 3: PermissionService was removed. It kept an in-memory map
// of granted permissions that nothing ever read, duplicating
// `PluginRegistryEntry.grantedPermissions` — the single persisted record that
// the UI actually reads. A class named "PermissionService" with a
// `checkPermission` method reads as enforcement while gating nothing, so it
// was removed rather than wired. Manifest-declared permissions remain
// metadata today: the `domains` field is not enforced, because navigation
// blocking is driven by the settings-backed DomainBlocker.

export {
  PolicyEngine,
  DEFAULT_POLICY,
} from './security/policy-engine';
export type { EnterprisePolicy } from './security/policy-engine';

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
  PluginErrorSeverity,
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
  // resolveMCPDiscovery is NOT re-exported here — it lives in './mcp/resolve'
  // which imports Node builtins ('fs', 'path'). Node-side consumers import it
  // directly: import { resolveMCPDiscovery } from '@duya/plugin-core/src/mcp/resolve'
  getMCPErrorMessage,
  getMCPErrorSeverity,
  getMCPSuggestedAction,
  // parseUserMcpToml / stringifyUserMcpToml are NOT re-exported here —
  // './mcp/user-config' imports '@iarna/toml', which references the Node
  // `global` builtin and throws "global is not defined" in the browser.
  // Re-exporting them pulls @iarna/toml into the renderer bundle via Vite's
  // dep optimizer. Node-side consumers import them directly:
  //   import { parseUserMcpToml } from '@duya/plugin-core/src/mcp/user-config'
} from './mcp';
// MCP collector input types — type-only re-export. The FUNCTIONS
// (buildMCPCandidates, etc.) live in './mcp/collect' which imports Node
// builtins ('fs', 'path') and are therefore NOT re-exported here (same
// policy as './mcp/resolve'). Node-side consumers import them directly:
//   import { buildMCPCandidates } from '@duya/plugin-core/src/mcp/collect'
export type {
  MCPCollectorSettingsItem,
  MCPCollectorPluginEntry,
  MCPCollectorInput,
} from './mcp/collect';

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
  UserMcpTomlServer,
} from './mcp';

export {
  isMCPError,
  toMCPError,
  withMCPError,
} from './error-wrapper';
export type { MCPResult } from './error-wrapper';

// Workflows — Plan 311.
export {
  PermissionTierSchema,
  PERMISSION_TIER_ORDER,
  tierRank,
  compareTiers,
  mergeTiers,
  bumpPermissionTier,
  tierRequiresConfirmation,
  tierRequiresExplicitConfirmation,
  WorkflowStepSchema,
  WorkflowTemplateSchema,
  toWorkflowSummary,
  instantiateWorkflow,
  extractVariables,
  getTemplatePrompt,
  effectiveTier,
  WorkflowInstantiateError,
} from './workflows';
export type {
  PermissionTier,
  WorkflowStep,
  WorkflowTemplate,
  WorkflowTemplateSummary,
  InstantiateOptions,
  InstantiateResult,
} from './workflows';

// Plan 455: `.app.json` connector declarations (pure module — safe for any
// environment; deep imports also work via
// `@duya/plugin-core/src/connectors/app-schema.js`).
export {
  AppDeclarationFileSchema,
  OAuthClientDeclarationSchema,
  AppToolDeclarationSchema,
  AppDeclarationSchema,
  RestInvokeDeclarationSchema,
  parseAppDeclarationFile,
} from './connectors/app-schema.js';
export type {
  AppDeclaration,
  AppToolDeclaration,
  OAuthClientDeclaration,
  RestInvokeDeclaration,
} from './connectors/app-schema.js';
export {
  asAppConnectorId,
  BUILTIN_CONNECTOR_IDS,
  isBuiltinConnectorId,
  isWellFormedConnectorId,
  pluginConnectorId,
} from './connectors/app-connector-id.js';
export type { AppConnectorId } from './connectors/app-connector-id.js';
