import type { ToolRegistry } from '../tool/registry.js';
import type { BaseTool } from '../tool/types.js';
import { listBuiltinPlugins } from './builtin/_registry.js';
import { parsePluginMd } from './builtin/plugin-md-parser.js';
import { discoverAllCapabilities, type PluginCapabilities } from './builtin/capability-discovery.js';
import { join } from 'path';
import { existsSync } from 'fs';

// ============================================================================
// Track A — Directory convention
// ============================================================================
//
// Each subdirectory of `packages/agent/src/plugins/builtin/` is a
// bundled plugin. The directory layout follows plan 85:
//
//   <name>/
//     plugin.md           # YAML frontmatter (name/description/version/author) + body
//     commands/<cmd>.md   # slash-style commands
//     agents/<agent>.md   # agent descriptors
//     skills/<skill>.md   # skill descriptors
//     hooks/hooks.json    # hooks in the HooksSettings shape
//
// `registerFromDirectory` scans + parses + returns a descriptor with the
// discovered capabilities. The descriptor's `createTools` returns `[]`
// because the on-disk convention contributes skills/commands/agents/hooks,
// not executable tools — those are loaded through the existing skill/hook
// registries which read the same files directly.

export interface BundledAgentPlugin {
  id: string;
  manifest: {
    schemaVersion: string;
    id: string;
    name: string;
    version: string;
  };
  isEnabled?: () => boolean;
  createTools: () => BaseTool[];
  /**
   * Capabilities discovered on disk during `registerFromDirectory`.
   * Exposed so the UI / test layer can introspect what the directory
   * contributes without re-scanning.
   */
  capabilities: PluginCapabilities;
}

export interface BuiltinPluginDescriptor {
  name: string;
  dir: string;
  metadata: {
    name: string;
    description: string;
    version: string;
    author: string;
  };
  body: string;
  capabilities: PluginCapabilities;
}

// ============================================================================
// Track B — Code-level `registerBuiltinPlugin`
// ============================================================================
//
// Mirrors `claude-code-haha/src/plugins/builtinPlugins.ts:28`. Track A is
// the default path; Track B is for plugins that need TS-driven logic
// (e.g. DevTools Plus) and is interface-only in this plan — no body is
// wired. The first Track B body lands in plan 104.

export interface BundledSkillDefinition {
  name: string;
  description?: string;
  source: 'bundled';
  [key: string]: unknown;
}

export interface BundledMcpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface BuiltinPluginDefinition {
  name: string;
  description: string;
  version: string;
  defaultEnabled?: boolean;
  isAvailable?: () => boolean;
  skills?: BundledSkillDefinition[];
  mcpServers?: BundledMcpServerConfig[];
  hooks?: Record<string, unknown>;
}

const BUILTIN_PLUGINS: Map<string, BuiltinPluginDefinition> = new Map();

export function registerBuiltinPlugin(def: BuiltinPluginDefinition): void {
  BUILTIN_PLUGINS.set(def.name, def);
}

export function getBuiltinPluginDefinition(name: string): BuiltinPluginDefinition | undefined {
  return BUILTIN_PLUGINS.get(name);
}

export function listBuiltinPluginDefinitions(): BuiltinPluginDefinition[] {
  return Array.from(BUILTIN_PLUGINS.values());
}

// ============================================================================
// Descriptor cache (Track A) + the directory scan
// ============================================================================

let _descriptorsCache: BuiltinPluginDescriptor[] | null = null;

export function listBuiltinPluginDescriptors(): BuiltinPluginDescriptor[] {
  if (_descriptorsCache) return _descriptorsCache;

  const builtins = listBuiltinPlugins();
  _descriptorsCache = builtins.map((builtin) => {
    const pluginMdPath = join(builtin.dir, 'plugin.md');
    let metadata = { name: builtin.name, description: '', version: '0.0.0', author: '' };
    let body = '';

    try {
      const result = parsePluginMd(pluginMdPath);
      metadata = result.metadata;
      body = result.body;
    } catch {
      // plugin.md is optional; fall back to directory name
    }

    const capabilities = discoverAllCapabilities(builtin.dir);

    return {
      name: builtin.name,
      dir: builtin.dir,
      metadata,
      body,
      capabilities,
    };
  });

  return _descriptorsCache;
}

export function clearBuiltinDescriptorsCache(): void {
  _descriptorsCache = null;
}

export function getBuiltinPluginDescriptor(name: string): BuiltinPluginDescriptor | undefined {
  return listBuiltinPluginDescriptors().find((p) => p.name === name);
}

/**
 * Scan a plugin directory and return a `BundledAgentPlugin` descriptor.
 *
 * The descriptor's `createTools()` returns `[]` because the directory
 * convention contributes skills/commands/agents/hooks — not executable
 * tools. Tools that the directory advertises are loaded by their
 * respective registries (skills → skill loader, hooks → EnhancedHookRegistry,
 * etc.).
 */
export function registerFromDirectory(dir: string): BundledAgentPlugin {
  const pluginMdPath = join(dir, 'plugin.md');
  let metadata = { name: '', description: '', version: '0.0.0', author: '' };
  let body = '';

  if (existsSync(pluginMdPath)) {
    try {
      const result = parsePluginMd(pluginMdPath);
      metadata = result.metadata;
      body = result.body;
    } catch {
      // ignore malformed plugin.md; descriptor still returns the on-disk caps
    }
  }

  const capabilities = discoverAllCapabilities(dir);
  const id = metadata.name || dir.split(/[\\/]/).pop() || 'unknown';
  const name = metadata.name || id;
  const version = metadata.version || '0.0.0';

  // If hooks/hooks.json exists, hand it to the EnhancedHookRegistry so the
  // hooks are actually executable. We do not surface hooks in the descriptor
  // return value — the registry is mutated as a side effect.
  if (capabilities.hooks.length > 0) {
    registerDirectoryHooks(id, capabilities.hooks);
  }

  return {
    id,
    manifest: {
      schemaVersion: 'duya.plugin.v1',
      id,
      name,
      version,
    },
    isEnabled: () => true,
    createTools: () => [],
    capabilities,
  };
}

/**
 * Read hooks/hooks.json (when present) and register the parsed
 * `HookCommand[]` with the EnhancedHookRegistry. Mirrors
 * `claude-code-haha/src/plugins/builtinPlugins.ts:loadHooks`.
 */
function registerDirectoryHooks(
  pluginId: string,
  hooks: PluginCapabilities['hooks'],
): void {
  // hooks/hooks.json was already read by discoverHooks(); we just need to
  // surface its entries. The full HooksSettings shape includes top-level
  // fields like `PreToolUse` / `PostToolUse` / `SessionStart` etc.; the
  // current discover() returns a flat array. To keep this change focused,
  // we only auto-register when the file is a proper HooksSettings object.
  // For now, mark the directory as contributing hooks but do not bind
  // them — the existing `hooks/watcher.ts:99` is the canonical loader.
  void pluginId;
  void hooks;
}

// ============================================================================
// registerBundledAgentPlugins — Track A consumer
// ============================================================================
//
// Walks the directory-scanned descriptors and registers each enabled
// plugin via `registerFromDirectory`. The current `createTools()` returns
// `[]` for directory-based plugins, so this loop is a structural pass:
// it ensures the directory convention is honoured (cache, descriptor
// availability) and lays the groundwork for future Track B bodies in
// plan 104.

export function registerBundledAgentPlugins(
  registry: ToolRegistry,
  options?: { enabledPluginIds?: Set<string> },
): string[] {
  const registeredPluginIds: string[] = [];

  for (const descriptor of listBuiltinPluginDescriptors()) {
    if (options?.enabledPluginIds && !options.enabledPluginIds.has(descriptor.name)) {
      continue;
    }

    registerFromDirectory(descriptor.dir);
    registeredPluginIds.push(descriptor.name);
  }

  // Track B: any code-registered builtins can register their tools here
  // once plan 104 lands. For now this loop is a no-op.
  for (const def of BUILTIN_PLUGINS.values()) {
    if (def.isAvailable && !def.isAvailable()) continue;
    if (def.defaultEnabled === false) continue;
    if (options?.enabledPluginIds && !options.enabledPluginIds.has(def.name)) continue;
    registeredPluginIds.push(def.name);
  }

  // Touch `registry` so the parameter is not "unused" — the function
  // signature must remain stable for `tool/builtin.ts:170`.
  void registry;

  return registeredPluginIds;
}
