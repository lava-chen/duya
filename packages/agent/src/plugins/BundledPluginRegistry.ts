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
