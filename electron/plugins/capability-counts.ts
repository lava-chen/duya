// electron/plugins/capability-counts.ts
// Plan 101 — Phase 4: derive `capabilityCounts` for a plugin from the
// on-disk directory via `discoverAllCapabilities` when one is resolvable,
// falling back to counting the fields in the manifest otherwise.
// Plan 311 — extended with `workflows` count (on-disk discovery for
// bundled / builtin plugins; manifest `components.workflows` for v2
// marketplace plugins; 0 for v1 manifests without a plugin dir).
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
  /**
   * Plan 311 — workflow template count. Derived from
   * `<pluginDir>/workflows/*.yaml` when a plugin dir is available;
   * otherwise from `manifest.components.workflows` (v2) or 0 (v1).
   */
  workflows: number;
}

/**
 * Derive `capabilityCounts` for a single plugin.
 *
 * If `pluginDir` resolves to an existing directory under
 * `packages/agent/src/plugins/builtin/`, the counts come from the
 * directory's `skills/`, `agents/`, `commands/`, `hooks/hooks.json`
 * (skills, agents, commands, hooks), and `workflows/*.yaml`
 * (workflows, Plan 311). `mcpServers` and `cli` come from
 * the manifest's `capabilities` field because the directory convention
 * does not encode them.
 *
 * If `pluginDir` is not provided (e.g. a marketplace-fetched plugin
 * whose install path is not yet on disk), the counts come entirely
 * from the manifest. For v2 manifests this includes
 * `components.workflows`; for v1 manifests `workflows` is 0.
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
      workflows: caps.workflows.length,
    };
  }
  // No plugin dir — derive from manifest alone.
  const components = manifest?.components;
  return {
    skills: manifest?.capabilities?.skills?.length ?? 0,
    mcpServers: manifest?.capabilities?.mcpServers?.length ?? 0,
    cli: manifest?.capabilities?.cli?.length ?? 0,
    ui: manifest?.capabilities?.ui?.length ?? 0,
    hooks: manifest?.capabilities?.hooks?.length ?? 0,
    workflows: components?.workflows?.length ?? 0,
  };
}
