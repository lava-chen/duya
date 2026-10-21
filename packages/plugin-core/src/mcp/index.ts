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
  MCPCollectionResult,
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
  computeProviderName,
  MCP_PROVIDER_PREFIX,
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

// parseUserMcpToml / stringifyUserMcpToml are NOT re-exported here —
// './user-config' imports '@iarna/toml', which references the Node `global`
// builtin and throws "global is not defined" in the browser. Re-exporting
// them from this barrel would pull @iarna/toml into the renderer bundle via
// Vite's dep optimizer. Import them directly in Node-side code:
//   import { parseUserMcpToml } from '../user-config'
export type { UserMcpTomlServer } from './user-config';

// resolveMCPDiscovery is NOT re-exported here — './resolve' imports Node
// builtins ('fs', 'path'). Import it directly in Node-side code:
//   import { resolveMCPDiscovery } from '../resolve'
