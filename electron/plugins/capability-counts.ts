// electron/plugins/capability-counts.ts
// Plan 101 — Phase 4: derive `capabilityCounts` for a plugin from the
// on-disk directory via `discoverAllCapabilities` when one is resolvable,
// falling back to counting the fields in the manifest otherwise.
//
// The bundled catalog entries (`BUNDLED_PLUGIN_CATALOG` in `catalog.ts`)
// used to ship hard-coded counts that drifted every time a skill was
// added to `packages/agent/src/plugins/builtin/<name>/skills/`. This
// helper reads the disk so the count and the directory are guaranteed
// to agree at all times.

import { discoverAllCapabilities } from '../../packages/agent/src/plugins/builtin/capability-discovery.js';
import type { PluginCatalogEntry } from './types';

export interface CapabilityCounts {
  skills: number;
  mcpServers: number;
  cli: number;
  ui: number;
  hooks: number;
}

/**
 * Derive `capabilityCounts` for a single plugin.
 *
 * If `pluginDir` resolves to an existing directory under
 * `packages/agent/src/plugins/builtin/`, the counts come from the
 * directory's `skills/`, `agents/`, `commands/`, and `hooks/hooks.json`
 * (skills, agents, commands, hooks). `mcpServers` and `cli` come from
 * the manifest's `capabilities` field because the directory convention
 * does not encode them.
 *
 * If `pluginDir` is not provided (e.g. a marketplace-fetched plugin
 * whose install path is not yet on disk), the counts come entirely
 * from the manifest.
 */
export function deriveCapabilityCounts(
  manifest: PluginCatalogEntry['manifest'],
  pluginDir?: string,
): CapabilityCounts {
  if (pluginDir) {
    const caps = discoverAllCapabilities(pluginDir);
    return {
      skills: caps.skills.length,
      mcpServers: manifest?.capabilities?.mcpServers?.length ?? 0,
      cli: manifest?.capabilities?.cli?.length ?? 0,
      ui: manifest?.capabilities?.ui?.length ?? 0,
      hooks: caps.hooks.length,
    };
  }
  return {
    skills: manifest?.capabilities?.skills?.length ?? 0,
    mcpServers: manifest?.capabilities?.mcpServers?.length ?? 0,
    cli: manifest?.capabilities?.cli?.length ?? 0,
    ui: manifest?.capabilities?.ui?.length ?? 0,
    hooks: manifest?.capabilities?.hooks?.length ?? 0,
  };
}
