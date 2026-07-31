import { z } from 'zod';
import type {
  PluginError,
  PluginTrustLevel,
  WorkflowTemplateSummary,
  PermissionTier,
} from '@duya/plugin-core';

// ============================================================================
// MCP re-exports from @duya/plugin-core (plan 97, Phase 0)
// Pure types only — no I/O, no runtime calls. Renderer surfaces these to
// the MCP settings page and to MCP-aware UI components.
// ============================================================================

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
  ResolutionContext,
  MCPServerInventoryEntry,
  ResolvedMCPServerConfig,
  ResolutionResult,
  MCPCollectionResult,
  MCPToolDescriptor,
  MCPHealthReport,
} from '@duya/plugin-core';

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
  sanitizeProviderToolName,
  allocateUniqueProviderToolName,
  expandEnvVarsInString,
  substitutePluginVariables,
  substituteUserConfigVariables,
  expandMcpServerConfig,
  getMCPErrorMessage,
  getMCPErrorSeverity,
  getMCPSuggestedAction,
} from '@duya/plugin-core';

export type { ProviderToolNamePolicy } from '@duya/plugin-core';

// ============================================================================
// Lenient Validation Types (for LLM-friendly plugin descriptions)
// ============================================================================

export interface LenientValidationWarning {
  field: string;
  message: string;
}

export interface ValidatedCapability {
  name: string;
  file: string;
  description?: string;
}

export interface ValidatedHook {
  event: string;
  handler: string;
}

export interface ValidatedCapabilities {
  commands: ValidatedCapability[];
  skills: ValidatedCapability[];
  agents: ValidatedCapability[];
  hooks: ValidatedHook[];
}

export interface CapabilityIndexItem {
  pluginId: string;
  name: string;
  version: string;
  status: 'enabled' | 'disabled';
  description: string;
  agentContext: string;
  capabilities: {
    skills: number;
    mcpServers: number;
    cli: number;
    ui: number;
    hooks: number;
    commands: number;
    agents: number;
    // Plan 311 — workflow template count (manifest v2 / on-disk derived).
    workflows: number;
  };
  permissionSummary: {
    granted: string[];
    denied: string[];
  };
  // Plan 311 — workflow template summaries. Empty for v1 plugins.
  // Full templates are fetched on demand via `plugin:workflow:get`
  // (Plan 241 progressive disclosure — prompt body stays out of the
  // always-on capability index payload).
  workflows?: WorkflowTemplateSummary[];
}

// ============================================================================
// Plugin Manifest Schema (aligned with plugin-system.md)
// ============================================================================

export const PluginAuthorSchema = z.object({
  name: z.string().min(1),
  url: z.string().url().optional(),
});

export const PluginSkillCapabilitySchema = z.object({
  path: z.string(),
  description: z.string().optional(),
});

export const PluginMcpServerSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(['stdio', 'streamable-http']).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
}).superRefine((server, ctx) => {
  const transport = server.transport ?? 'stdio';
  if (transport === 'stdio' && !server.command) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'stdio MCP servers require command', path: ['command'] });
  }
  if (transport === 'streamable-http') {
    if (!server.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'streamable-http MCP servers require url', path: ['url'] });
    } else if (!server.url.startsWith('https://')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'streamable-http MCP URLs must use https', path: ['url'] });
    }
  }
});

export const PluginCliSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
});

export const PluginUiSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['sidebar', 'panel', 'settings']),
  entry: z.string().min(1),
});

export const PluginHookSchema = z.object({
  event: z.string().min(1),
  handler: z.string().min(1),
});

export const PluginCapabilitiesSchema = z.object({
  skills: z.array(PluginSkillCapabilitySchema).default([]),
  mcpServers: z.array(PluginMcpServerSchema).default([]),
  cli: z.array(PluginCliSchema).default([]),
  ui: z.array(PluginUiSchema).default([]),
  hooks: z.array(PluginHookSchema).default([]),
});

export const PluginEntrySchema = z.object({
  type: z.enum(['node', 'python', 'binary']),
  main: z.string().min(1),
});

export const PluginPermissionSchema = z.object({
  name: z.string().min(1),
  scope: z.string().optional(),
  domains: z.array(z.string()).optional(),
});

export const PluginDependencySchema = z.object({
  id: z.string(),
  version: z.string(),
});

export const PluginEnginesSchema = z.object({
  duya: z.string().min(1),
  node: z.string().optional(),
});

// ----------------------------------------------------------------------------
// Plan 311 — v2 manifest components & permission policy
// ----------------------------------------------------------------------------

/**
 * v2 `components` field. Each entry is a stable string ID; the on-disk
 * implementation lives under the corresponding subdirectory (e.g.
 * `skills/<id>.md`, `workflows/<id>.yaml`). All arrays default to
 * empty so a v2 manifest can omit any subset.
 */
export const PluginComponentsSchema = z.object({
  mcpServers: z.array(z.string()).default([]),
  appConnections: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  workflows: z.array(z.string()).default([]),
});

export type PluginComponents = z.infer<typeof PluginComponentsSchema>;

/**
 * v2 `permissionPolicy` field. Maps to the design doc §6 five-tier
 * model. All fields optional; when omitted, the runtime applies the
 * design doc defaults (`defaultMode: 'read'`, write/destructive
 * require approval).
 */
export const PermissionPolicySchema = z.object({
  defaultMode: z.enum(['read', 'draft', 'write', 'modify', 'dangerous']).optional(),
  writeActionsRequireApproval: z.boolean().optional(),
  destructiveActionsRequireApproval: z.boolean().optional(),
});

export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

/**
 * v2 `publisher` field. `verified` is a boolean (Duya attestation);
 * absent for community plugins. Mirrors the design doc §7 trust
 * states.
 */
export const PluginPublisherSchema = z.object({
  name: z.string().min(1),
  url: z.string().url().optional(),
  verified: z.boolean().optional(),
});

export type PluginPublisher = z.infer<typeof PluginPublisherSchema>;

const PluginManifestV1Schema = z.object({
  schemaVersion: z.literal('duya.plugin.v1'),
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  author: PluginAuthorSchema,
  entry: PluginEntrySchema,
  capabilities: PluginCapabilitiesSchema,
  permissions: z.array(PluginPermissionSchema).default([]),
  dependencies: z.record(z.string(), z.string()).optional(),
  engines: PluginEnginesSchema,
});

const PluginManifestV2Schema = z.object({
  schemaVersion: z.literal('duya.plugin.v2'),
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  author: PluginAuthorSchema,
  entry: PluginEntrySchema.optional(),
  capabilities: PluginCapabilitiesSchema.optional(),
  components: PluginComponentsSchema,
  permissionPolicy: PermissionPolicySchema.optional(),
  publisher: PluginPublisherSchema.optional(),
  permissions: z.array(PluginPermissionSchema).default([]),
  dependencies: z.record(z.string(), z.string()).optional(),
  engines: PluginEnginesSchema,
});

export const PluginManifestSchema = z.discriminatedUnion('schemaVersion', [
  PluginManifestV1Schema,
  PluginManifestV2Schema,
]);

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginManifestV1 = z.infer<typeof PluginManifestV1Schema>;
export type PluginManifestV2 = z.infer<typeof PluginManifestV2Schema>;
export type PluginCapabilities = z.infer<typeof PluginCapabilitiesSchema>;
export type PluginPermission = z.infer<typeof PluginPermissionSchema>;

/**
 * Normalized components view, used by capability counting and the
 * capability index. v1 manifests project their `capabilities` field
 * into the components shape (with `workflows: []`); v2 manifests
 * pass `components` through. This lets the rest of the codebase
 * treat every manifest as v2-shaped regardless of schema version.
 */
export interface NormalizedPluginComponents {
  mcpServers: string[];
  appConnections: string[];
  skills: string[];
  workflows: string[];
}

export function normalizeManifestComponents(
  manifest: PluginManifest,
): NormalizedPluginComponents {
  if (manifest.schemaVersion === 'duya.plugin.v2') {
    return {
      mcpServers: manifest.components.mcpServers,
      appConnections: manifest.components.appConnections,
      skills: manifest.components.skills,
      workflows: manifest.components.workflows,
    };
  }
  // v1: project `capabilities` into components, no workflows.
  return {
    mcpServers: manifest.capabilities.mcpServers.map((s) => s.name),
    appConnections: [],
    skills: manifest.capabilities.skills.map((s) =>
      typeof s === 'string' ? s : (s as { path: string }).path,
    ),
    workflows: [],
  };
}

/**
 * Type guard for v2 manifests.
 */
export function isManifestV2(
  manifest: PluginManifest,
): manifest is PluginManifestV2 {
  return manifest.schemaVersion === 'duya.plugin.v2';
}

/**
 * Re-export the workflow summary / permission tier types from
 * `@duya/plugin-core` so renderer code can `import { WorkflowTemplateSummary } from '@/lib/plugin-types'`
 * without reaching across the package boundary directly.
 */
export type { WorkflowTemplateSummary, PermissionTier };

// ============================================================================
// Plugin Catalog Types (for marketplace listing)
// ============================================================================

export type PluginSource = 'bundled' | 'builtin-directory' | 'marketplace' | 'local';

export type PluginCategory = 'productivity' | 'development' | 'research' | 'data' | 'communication' | 'media' | 'automation' | 'other';

export type PluginRuntimeStatus = 'enabled' | 'disabled' | 'needs_setup' | 'failed_to_load' | 'update_available';

// ============================================================================
// Plugin Scope & Lifecycle Types
// ============================================================================

export enum PluginScope {
  Managed = 'managed',
  User = 'user',
  Project = 'project',
  Local = 'local',
  Builtin = 'builtin',
}

export const PLUGIN_SCOPE_PRIORITY: Record<PluginScope, number> = {
  [PluginScope.Managed]: 100,
  [PluginScope.User]: 80,
  [PluginScope.Project]: 60,
  [PluginScope.Builtin]: 40,
  [PluginScope.Local]: 20,
};

export interface PluginDependency {
  name: string;
  version?: string;
  marketplace?: string;
}

export interface DependencyVerificationResult {
  satisfied: boolean;
  missing: PluginDependency[];
  downgraded: string[];
}

export interface PluginPermissionDisplay {
  id: string;
  title: string;
  description: string;
  required: boolean;
  enabled: boolean;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface PluginCapabilityDisplay {
  id: string;
  name: string;
  type: 'skill' | 'mcp' | 'tool' | 'cli' | 'connector';
  description: string;
  required: boolean;
  enabled: boolean;
}

export interface UsageExample {
  title?: string;
  prompt: string;
}

export interface PluginCatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  shortDescription?: string;
  longDescription?: string;
  author: { name: string; url?: string };
  developer?: string;
  icon?: string;
  source: PluginSource;
  category: PluginCategory;
  trustLevel?: PluginTrustLevel;
  /**
   * Distinguishes a standalone skill marketplace entry (`'skill'`) from a
   * regular plugin entry (`'plugin'`, the default). Skill entries are
   * sourced from `packages/agent/skills/` and install only a single
   * skill directory; plugin entries follow the normal plugin install
   * path. Absent values are treated as `'plugin'` for backward compat.
   */
  kind?: 'plugin' | 'skill';
  /**
   * For `kind === 'skill'` entries: absolute path to the bundled skill
   * source directory. Used by the installer to copy skill files. Not
   * serialized for the renderer — the renderer only needs `kind`.
   */
  skillSourceDir?: string;
  status?: 'enabled' | 'disabled' | 'needs_attention';
  installed?: boolean;
  enabled?: boolean;
  featured?: boolean;
  capabilityCounts: {
    skills: number;
    mcpServers: number;
    cli: number;
    ui: number;
    hooks: number;
    // Plan 311 — workflow template count (manifest v2 / on-disk derived).
    workflows: number;
  };
  capabilities?: PluginCapabilityDisplay[];
  permissions?: PluginPermissionDisplay[];
  usageExamples?: UsageExample[];
  website?: string;
  documentationUrl?: string;
  updatedAt?: string;
  manifest?: PluginManifest;
}

// ============================================================================
// Plugin Registry Types (for installed plugins)
// ============================================================================

export interface PluginRegistryEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author: { name: string; url?: string };
  icon?: string;
  enabled: boolean;
  installPath: string;
  installedAt: string;
  updatedAt?: string;
  source: PluginSource;
  trustLevel: PluginTrustLevel;
  runtimeStatus: PluginRuntimeStatus;
  permissionsGranted: string[];
  permissionDenied: string[];
  setupRequired: boolean;
  setupFields: PluginSetupField[];
  manifest: PluginManifest;
}

export interface PluginSetupField {
  key: string;
  label: string;
  /**
   * `app-connection` (Plan 312): renders a Connect/Disconnect control
   * bound to the named `connectionId` instead of a text input. The
   * field's `required` flag drives the `needs_setup` health state.
   */
  type: 'text' | 'password' | 'path' | 'url' | 'select' | 'boolean' | 'app-connection';
  required: boolean;
  description?: string;
  defaultValue?: string | boolean;
  options?: Array<{ label: string; value: string }>;
  placeholder?: string;
  /**
   * Plan 312 — only set when `type === 'app-connection'`. References
   * the plugin-local connection id declared in `apps/connections.json`.
   */
  connectionId?: string;
}

// ============================================================================
// Plugin Health Types (upgraded with structured error context)
// ============================================================================

export interface PluginHealthIssue {
  error: PluginError;
  severity: 'critical' | 'warning' | 'info';
  humanMessage: string;
  technicalDetails?: string;
  actionable: boolean;
  suggestedAction?: string;
  timestamp: number;
}

export interface PluginHealthReport {
  pluginId: string;
  healthy: boolean;
  issues: PluginHealthIssue[];
  lastCheckedAt: string;
  lastError?: {
    type: string;
    message: string;
    at: string;
  };
}

// ============================================================================
// Permission Display Types
// ============================================================================

export interface PermissionDisplayInfo {
  name: string;
  label: string;
  description: string;
  icon: string;
  scope?: string;
  domains?: string[];
  granted: boolean;
}

// ============================================================================
// IPC Response Wrappers
// ============================================================================

export interface PluginIpcListResponse<T> {
  success: boolean;
  data: T[];
  error?: string;
}

export interface PluginIpcDetailResponse<T> {
  success: boolean;
  data: T | null;
  error?: string;
}
