// Type-only import from the shared zod schema (single source of truth for
// the manifest shape). Erased at compile time — no runtime dependency on
// src/ is introduced in the main-process bundle.
import type { PluginPermission } from '../../src/lib/plugin-types';

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

// Converged (R1): the handwritten interface was structurally identical to
// the zod-inferred `PluginPermission` in src/lib/plugin-types.ts
// ({ name: string; scope?: string; domains?: string[] }). Replaced by a
// type alias so the main-process view cannot drift from the renderer/IPC
// view. Consumed by `PluginManifest.permissions` and
// `PluginRegistryEntry.grantedPermissions` below.
export type PluginPermissionRequest = PluginPermission;

// NOTE: mirrors zod schema in src/lib/plugin-types.ts — kept as the
// main-process view because the shapes are NOT compatible:
//  - `capabilities.skills` is `string[]` here vs
//    `Array<{ path: string; description?: string }>` in the zod schema.
//    The bundled catalog and the on-disk v1 loader both emit plain
//    skill-name strings; the zod object form would break them.
//  - `capabilities.mcpServers.args` is optional here (absent → undefined)
//    but required-with-default in the zod schema, and the zod entry also
//    carries an `env` field this view does not model.
//  - `capabilities.cli` has an optional `args` field here that the zod
//    schema does not declare.
//  - `capabilities.ui.type` is a plain `string` here vs the zod enum
//    `'sidebar' | 'panel' | 'settings'`.
//  - `setup` exists only here (the zod schema has no setup block); it is
//    read by `readPluginManifest` and consumed by the catalog/UI.
//  - `entry` and `dependencies` exist only in the zod schema; the
//    main-process loader does not model them.
//  - `capabilities` is always required here; the zod schema makes it
//    optional for v2 (and `components` required for v2 vs optional here).
// Migrating the loader and the inline catalog manifests to the zod shape
// is owned by Plan 311 (v1/v2 compat) and is out of scope for the type
// convergence pass.
export interface PluginManifest {
  schemaVersion: 'duya.plugin.v1' | 'duya.plugin.v2';
  id: string;
  name: string;
  version: string;
  description: string;
  author: {
    name: string;
    url?: string;
  };
  /** Audited official upstream MCP/skill provenance for a bundled preset. */
  officialAssets?: {
    mcp: {
      provider: string;
      transport: 'stdio' | 'streamable-http';
      authentication: 'oauth' | 'local' | 'none';
      url?: string;
      package?: string;
      repository?: string;
      ref?: string;
    };
    skills: {
      mode: 'upstream-sync' | 'duya-overlay';
      repository?: string;
      ref?: string;
      path?: string;
    };
  };
  capabilities: {
    skills?: string[];
    mcpServers?: Array<{
      name: string;
      transport?: 'stdio' | 'streamable-http';
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
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
  // Plan 311 — v2 components field. Required for v2 manifests; absent
  // for v1 manifests (v1 projects `capabilities` into components via
  // `normalizeManifestComponents` in `src/lib/plugin-types.ts`).
  components?: {
    mcpServers?: string[];
    appConnections?: string[];
    skills?: string[];
    workflows?: string[];
  };
  // Plan 311 — v2 permission policy. Mirrors the design doc §6
  // five-tier model.
  permissionPolicy?: {
    defaultMode?: 'read' | 'draft' | 'write' | 'modify' | 'dangerous';
    writeActionsRequireApproval?: boolean;
    destructiveActionsRequireApproval?: boolean;
  };
  // Plan 311 — v2 publisher block. `verified` is a Duya attestation
  // flag; absent for community plugins.
  publisher?: {
    name: string;
    url?: string;
    verified?: boolean;
  };
  permissions: PluginPermissionRequest[];
  setup?: Array<{
    id: string;
    label: string;
    /**
     * `app-connection` (Plan 312): pairs with `connectionId` to render
     * a Connect/Disconnect control. The plugin declares the connection
     * in `apps/connections.json`; this field just flags the UI affordance.
     */
    type: 'text' | 'secret' | 'path' | 'url' | 'app-connection';
    required?: boolean;
    /** Plan 312 — only set when type === 'app-connection'. */
    connectionId?: string;
  }>;
  engines: {
    duya: string;
    node?: string;
  };
}

export type PluginCategory = 'productivity' | 'development' | 'research' | 'data' | 'communication' | 'media' | 'automation' | 'other';

// NOTE: mirrors zod schema in src/lib/plugin-types.ts — kept as the
// main-process view because the shapes are NOT compatible:
//  - Optionality is inverted on four fields: `category`, `trustLevel`,
//    `manifest`, and `capabilityCounts` are each required on exactly one
//    side and optional on the other (e.g. `trustLevel`/`manifest` are
//    required here but optional in the zod view; `category`/
//    `capabilityCounts` are optional here but required in the zod view).
//  - The zod view carries many renderer-only display fields this view
//    does not model: `author`, `shortDescription`, `longDescription`,
//    `developer`, `icon`, `status`, `installed`, `enabled`, `featured`,
//    `capabilities`, `permissions`, `usageExamples`, `website`,
//    `documentationUrl`, `updatedAt`. The main-process catalog only
//    transports the minimal listing payload; the renderer enriches it.
//  - `capabilityCounts.workflows` is optional here but required in the
//    zod view.
// `PluginCatalogEntry['manifest']` also references the handwritten
// `PluginManifest` above (not the zod manifest), so the two entries
// cannot be swapped independently.
export interface PluginCatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  source: PluginSource;
  category?: PluginCategory;
  trustLevel: PluginTrustLevel;
  manifest: PluginManifest;
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
   * source directory (e.g. `packages/agent/skills/office/pdf`). Used by
   * `PluginManager.installFromCatalog` to copy skill files into the
   * installed plugin's `skills/<name>/` directory. Undefined for
   * regular plugin entries.
   */
  skillSourceDir?: string;
  capabilityCounts?: {
    skills: number;
    mcpServers: number;
    cli: number;
    ui: number;
    hooks: number;
    // Plan 311 — workflow template count (manifest v2 / on-disk derived).
    workflows?: number;
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

