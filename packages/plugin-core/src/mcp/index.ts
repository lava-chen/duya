// packages/plugin-core/src/mcp/index.ts
// Barrel for the mcp/ subfolder. Re-exports every public type and helper
// added in Phase 0. Pure types and pure functions only — no I/O.

export type {
  MCPDiscoveryStatus,
  MCPConnectionStatus,
} from './status';

export type {
  MCPDiscoveryError,
  MCPConnectionError,
  MCPRegistrationError,
  MCPError,
  MCPIssue,
  MCPPhase,
} from './errors';

export type {
  MCPSource,
  MCPSettingsSubOrigin,
  MCPSourceContext,
  MCPCandidate,
  ResolutionContext,
  MCPServerInventoryEntry,
  ResolvedMCPServerConfig,
  ResolutionResult,
  MCPToolDescriptor,
  MCPHealthReport,
  BuiltinFallbackReplacement,
} from './discovery';

export { BUILTIN_FALLBACK_REPLACEMENTS, findBuiltinFallbackReplacement } from './discovery';

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
} from './scope';

export {
  AnthropicToolNamePolicy,
  OpenAIToolNamePolicy,
  shortStableHash,
  sanitizeProviderToolName,
  allocateUniqueProviderToolName,
} from './provider-tool-name';
export type { ProviderToolNamePolicy } from './provider-tool-name';

export {
  expandEnvVarsInString,
  substitutePluginVariables,
  substituteUserConfigVariables,
  expandMcpServerConfig,
} from './env-expansion';

export {
  getMCPErrorMessage,
  getMCPErrorSeverity,
  getMCPSuggestedAction,
} from './error-messages';

export { applySourceShadowing } from './shadow';
export type { ShadowApplicationResult } from './shadow';

export { resolveMCPDiscovery } from './resolve';
