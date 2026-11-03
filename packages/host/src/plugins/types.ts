// Type-only import from the shared zod schema (single source of truth for
// the manifest shape). Erased at compile time — no runtime dependency on
// src/ is introduced in the main-process bundle.
import type { PluginManifestPermission as PluginPermission } from '@duya/plugin-core/formats/permissions';
import type { PluginAppDefinition } from '@duya/plugin-core/apps/declarations';

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
// the zod-inferred `PluginPermission` in apps/desktop/src/renderer/lib/plugin-types.ts
// ({ name: string; scope?: string; domains?: string[] }). Replaced by a
// type alias so the main-process view cannot drift from the renderer/IPC
// view. Consumed by `PluginManifest.permissions` and
// `PluginRegistryEntry.grantedPermissions` below.
export type PluginPermissionRequest = PluginPermission;

// NOTE: mirrors zod schema in apps/desktop/src/renderer/lib/plugin-types.ts — kept as the
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
  description: string | undefined;
  author: {
    name: string;
    url?: string | undefined;
    email?: string | undefined;
  };
  // Plan: plugin-config-simplification — Codex-style identity fields.
  // Optional on disk; populated by `readPluginManifest` when present in
  // `.duya-plugin/plugin.json`. `publisher` (below) is retained for v1/v2
  // marketplace compatibility but is deprecated in favor of `author`.
  homepage?: string | undefined;
  repository?: string | undefined;
  license?: string | undefined;
  keywords?: string[] | undefined;
  /** Optional market-UI metadata block (replaces deleted plugin.md). */
  interface?: PluginInterface | undefined;
  /** Audited official upstream MCP/skill provenance for a bundled preset. */
  officialAssets?: {
    mcp: {
      provider: string;
      transport: 'stdio' | 'streamable-http';
      authentication: 'oauth' | 'local' | 'none';
      url?: string | undefined;
      package?: string | undefined;
      repository?: string | undefined;
      ref?: string | undefined;
    };
    skills: {
      mode: 'upstream-sync' | 'duya-overlay';
      repository?: string | undefined;
      ref?: string | undefined;
      path?: string | undefined;
    };
  } | undefined;
  capabilities: {
    skills?: string[] | undefined;
    mcpServers?: Array<{
      name: string;
      transport?: 'stdio' | 'streamable-http' | 'sse' | undefined;
      command?: string | undefined;
      args?: string[] | undefined;
      env?: Record<string, string> | undefined;
      url?: string | undefined;
      headers?: Record<string, string> | undefined;
    }> | undefined;
    cli?: Array<{
      name: string;
      command: string;
      args?: string[] | undefined;
    }> | undefined;
    hooks?: Array<{
      event: string;
      handler: string;
    }> | undefined;
    ui?: Array<{
      id: string;
      type: string;
      entry: string;
    }> | undefined;
  };
  // Plan 311 — v2 components field. Required for v2 manifests; absent
  // for v1 manifests (v1 projects `capabilities` into components via
  // `normalizeManifestComponents` in `apps/desktop/src/renderer/lib/plugin-types.ts`).
  components?: {
    mcpServers?: string[] | undefined;
    appConnections?: string[] | undefined;
    skills?: string[] | undefined;
    workflows?: string[] | undefined;
  } | undefined;
  // Plan 311 — v2 permission policy. Mirrors the design doc §6
  // five-tier model.
  permissionPolicy?: {
    defaultMode?: 'read' | 'draft' | 'write' | 'modify' | 'dangerous' | undefined;
    writeActionsRequireApproval?: boolean | undefined;
    destructiveActionsRequireApproval?: boolean | undefined;
  } | undefined;
  // Plan 311 — v2 publisher block. `verified` is a Duya attestation
  // flag; absent for community plugins.
  publisher?: {
    name: string;
    url?: string | undefined;
    verified?: boolean | undefined;
  } | undefined;
  /**
   * Agent Plugins 1.0.0 — client-specific manifest data keyed by
   * reverse-domain namespace. Passed through without runtime semantics.
   * Each namespace value is an object (spec `additionalProperties`).
   */
  extensions?: Record<string, Record<string, unknown>> | undefined;
  /** Package-local App definitions; instances and session runs are runtime state. */
  apps?: PluginAppDefinition[] | undefined;
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
    required?: boolean | undefined;
    /** Plan 312 — only set when type === 'app-connection'. */
    connectionId?: string | undefined;
  }> | undefined;
  engines: {
    duya: string;
    node?: string | undefined;
  };
}

export type PluginCategory = 'productivity' | 'development' | 'research' | 'data' | 'communication' | 'media' | 'automation' | 'other';

/**
 * Plan: plugin-config-simplification — `interface` block.
 *
 * Optional market-UI metadata. Replaces the long-form content that used to
 * live in `plugin.md` (now deleted). Pure-skill plugins with no market
 * presence omit this block entirely. `category` here is the authoritative
 * category for a plugin when present; catalog falls back to deriving it
 * from the plugin source/keywords otherwise.
 */
export interface PluginInterface {
  displayName?: string | undefined;
  displayName_zh?: string | undefined;
  shortDescription?: string | undefined;
  shortDescription_zh?: string | undefined;
  longDescription?: string | undefined;
  longDescription_zh?: string | undefined;
  category?: PluginCategory | undefined;
  brandColor?: string | undefined;
  screenshots?: string[] | undefined;
  /**
   * Plugin brand icon, relative to the plugin root (e.g. `./assets/icon.svg`).
   * The catalog resolves this to a `duya-file://` URL the renderer can load.
   */
  icon?: string | undefined;
  /**
   * codex parity (doc 17.2): up to 3 example prompts shown as "try asking"
   * suggestions. Parsed by `parseInterfaceBlock` (each <= 128 chars).
   */
  defaultPrompt?: string[] | undefined;
}

// NOTE: mirrors zod schema in apps/desktop/src/renderer/lib/plugin-types.ts — kept as the
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
  displayName_zh?: string | undefined;
  shortDescription_zh?: string | undefined;
  longDescription_zh?: string | undefined;
  id: string;
  name: string;
  version: string;
  description: string;
  source: PluginSource;
  category?: PluginCategory | undefined;
  trustLevel: PluginTrustLevel;
  manifest: PluginManifest;
  /**
   * Resolved `duya-file://` icon URL from the manifest `interface.icon`
   * (renderer `PluginCatalogEntry` carries the same field). Undefined when
   * the plugin declares no icon or the file is missing on disk.
   */
  icon?: string | undefined;
  /** Manifest author (renderer `PluginCatalogEntry` carries the same field). */
  author?: { name: string; url?: string | undefined } | undefined;
  /**
   * Distinguishes a standalone skill marketplace entry (`'skill'`) from a
   * regular plugin entry (`'plugin'`, the default). Skill entries are
   * sourced from `packages/agent/skills/` and install only a single
   * skill directory; plugin entries follow the normal plugin install
   * path. Absent values are treated as `'plugin'` for backward compat.
   */
  kind?: 'plugin' | 'skill' | undefined;
  /**
   * For `kind === 'skill'` entries: absolute path to the bundled skill
   * source directory (e.g. `packages/agent/skills/development/docker-deploy`).
   * Used by `PluginManager.installFromCatalog` to copy skill files into
   * the installed plugin's `skills/<name>/` directory. Undefined for
   * regular plugin entries.
   */
  skillSourceDir?: string | undefined;
  /**
   * Plan 455 — marketplace attribution for `source: 'marketplace'` entries.
   * Matches the ConfigStore `[marketplaces.<name>]` key and the registry
   * composite key suffix (`<pluginId>@<marketplace>`).
   */
  marketplace?: string | undefined;
  /**
   * Plan 455 — absolute, containment-fenced directory of the plugin inside
   * its marketplace clone. `PluginManager.installFromCatalog` copies from
   * here during materialization. Undefined for non-marketplace entries.
   */
  marketplacePluginDir?: string | undefined;
  /**
   * Plan 531 — for marketplace entries with `source: 'git'`: the git URL
   * of the plugin repo, materialized on-demand at install time.
   * When present, `installFromCatalog` clones the repo instead of copying
   * from `marketplacePluginDir`.
   */
  gitSourceUrl?: string | undefined;
  /** Plan 531 — optional git ref (branch/tag/sha) for git-source plugins. */
  gitSourceRef?: string | undefined;
  /** Plan 455 — catalog-declared installation policy (codex 17.3.1 parity). */
  installPolicy?: 'not_available' | 'available' | 'installed_by_default' | undefined;
  /** Plan 455 — catalog-declared authentication policy (codex 17.3.1 parity). */
  authPolicy?: 'on_install' | 'on_use' | undefined;
  /**
   * Short/long marketing copy from the manifest `interface` block. The
   * renderer displays `shortDescription` on marketplace cards and falls
   * back to `description`.
   */
  shortDescription?: string | undefined;
  longDescription?: string | undefined;
  /** "Try asking" prompts (manifest `interface.defaultPrompt`, max 3). */
  usageExamples?: Array<{ prompt: string }> | undefined;
  capabilityCounts?: {
    skills: number;
    mcpServers: number;
    cli: number;
    ui: number;
    hooks: number;
    // Plan 311 — workflow template count (manifest v2 / on-disk derived).
    workflows?: number | undefined;
  } | undefined;
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
  /**
   * Resolved `duya-file://` icon URL, derived at read time from the catalog
   * entry by `hydrateViewItem` (never persisted — config stores only
   * `enabled`).
   */
  icon?: string | undefined;
  lastError?: {
    message: string;
    at: string;
  } | undefined;
}

export interface PluginRegistryFile {
  version: 1;
  plugins: PluginRegistryEntry[];
}

export interface PluginViewItem extends PluginRegistryEntry {
  capabilityKinds: PluginCapabilityKind[];
  /** Safe manifest metadata projected for installed-list consumers. */
  apps?: PluginAppDefinition[] | undefined;
}

// ============================================================================
// Plugin Lifecycle Types
// ============================================================================

export interface PluginDependency {
  name: string;
  version?: string | undefined;
  marketplace?: string | undefined;
}

export interface DependencyVerificationResult {
  satisfied: boolean;
  missing: PluginDependency[];
  downgraded: string[];
}
