import { z } from 'zod';
import type { PluginError } from './plugin-error-types';
import type { PluginTrustLevel } from './plugin-security-types';

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
  };
  permissionSummary: {
    granted: string[];
    denied: string[];
  };
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
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
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

export const PluginManifestSchema = z.object({
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

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginCapabilities = z.infer<typeof PluginCapabilitiesSchema>;
export type PluginPermission = z.infer<typeof PluginPermissionSchema>;

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

export interface AutoUpdatePolicy {
  enabled: boolean;
  interval: 'daily' | 'weekly' | 'manual';
  scope: PluginScope[];
  prerelease: boolean;
}

export interface PluginUpdateInfo {
  name: string;
  current: string;
  latest: string;
  marketplace: string;
}

export interface InstalledPluginInfoV2 {
  marketplace: string;
  version: string;
  scope: PluginScope;
  installPath: string;
  capabilities: string[];
  autoUpdate: boolean;
  installedAt?: number;
  source?: string;
}

export interface InstalledPluginsFileV2 {
  version: 2;
  plugins: Record<string, InstalledPluginInfoV2>;
}

export interface PluginCatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author: { name: string; url?: string };
  icon?: string;
  source: PluginSource;
  category: PluginCategory;
  trustLevel?: PluginTrustLevel;
  capabilityCounts: {
    skills: number;
    mcpServers: number;
    cli: number;
    ui: number;
    hooks: number;
  };
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
  type: 'text' | 'password' | 'path' | 'url' | 'select' | 'boolean';
  required: boolean;
  description?: string;
  defaultValue?: string | boolean;
  options?: Array<{ label: string; value: string }>;
  placeholder?: string;
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