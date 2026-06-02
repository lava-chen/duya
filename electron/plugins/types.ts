export type PluginCapabilityKind = 'skills' | 'mcp' | 'cli' | 'ui' | 'hooks';
export type PluginSource = 'bundled' | 'builtin-directory' | 'marketplace' | 'local' | 'development';
export type PluginTrustLevel = 'official' | 'verified' | 'local' | 'untrusted';
export type PluginSetupState = 'complete' | 'needs_setup' | 'invalid';
export type PluginHealthStatus = 'ready' | 'disabled' | 'needs_setup' | 'failed';

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

export interface PluginPermissionRequest {
  name: string;
  scope?: string;
  domains?: string[];
}

export interface PluginManifest {
  schemaVersion: 'duya.plugin.v1';
  id: string;
  name: string;
  version: string;
  description: string;
  author: {
    name: string;
    url?: string;
  };
  capabilities: {
    skills?: string[];
    mcpServers?: Array<{
      name: string;
      command: string;
      args?: string[];
    }>;
    cli?: Array<{
      name: string;
      command: string;
      args?: string[];
    }>;
    hooks?: Array<{
      event: string;
      handler: string;
    }>;
    ui?: Array<{
      id: string;
      type: string;
      entry: string;
    }>;
  };
  permissions: PluginPermissionRequest[];
  setup?: Array<{
    id: string;
    label: string;
    type: 'text' | 'secret' | 'path' | 'url';
    required?: boolean;
  }>;
  engines: {
    duya: string;
    node?: string;
  };
}

export type PluginCategory = 'productivity' | 'development' | 'research' | 'data' | 'communication' | 'media' | 'automation' | 'other';

export interface PluginCatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  source: PluginSource;
  category?: PluginCategory;
  trustLevel: PluginTrustLevel;
  manifest: PluginManifest;
  capabilityCounts?: {
    skills: number;
    mcpServers: number;
    cli: number;
    ui: number;
    hooks: number;
  };
}

export interface PluginRuntimeHealth {
  status: PluginHealthStatus;
  reasons: string[];
  checkedAt: string;
}

export interface PluginRegistryEntry {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  installPath: string;
  dataPath: string;
  source: PluginSource;
  trustLevel: PluginTrustLevel;
  scope: PluginScope;
  marketplace: string;
  autoUpdate: boolean;
  installedAt: string;
  updatedAt: string;
  grantedPermissions: PluginPermissionRequest[];
  setupState: PluginSetupState;
  health: PluginRuntimeHealth;
  lastError?: {
    message: string;
    at: string;
  };
}

export interface PluginRegistryFile {
  version: 1;
  plugins: PluginRegistryEntry[];
}

export interface PluginLockfile {
  lockfileVersion: 1;
  plugins: Record<string, {
    version: string;
    resolved: string;
    integrity?: string;
  }>;
}

export interface PluginViewItem extends PluginRegistryEntry {
  capabilityKinds: PluginCapabilityKind[];
}

// ============================================================================
// Plugin Lifecycle Types
// ============================================================================

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

