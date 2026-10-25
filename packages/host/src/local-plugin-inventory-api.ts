/**
 * The plugin inventory a Host serves over HTTP.
 *
 * ## Why the projection exists
 *
 * `createHostLocalPluginRegistryApi` returns the FULL registry entry, and
 * that entry carries the plugin's manifest. The manifest's
 * `capabilities.mcpServers` can declare an `env`, `headers`, `command`,
 * `args` or `url` for every MCP server the plugin brings — credential
 * material that a client listing plugins must never receive.
 *
 * So the HTTP surface answers with a PROJECTION, not with the registry:
 * identity, user intent, and whether the Host can see the plugin's files.
 * The manifest, the install path and the data path never leave the Host.
 *
 * The projection is computed here rather than in the route handler so the
 * rule "no credential reaches a client" has exactly one home, and so a
 * second route serving the inventory cannot get it wrong.
 */

import type { HostPluginInventoryApiV1, HostPluginInventoryEntry } from '@duya/agent-protocol/plugin-inventory';
import {
  createHostLocalPluginRegistryApi,
  type HostPluginRegistryEntry,
} from './local-plugin-registry-api.js';

/**
 * One registry entry, reduced to what a client may see.
 *
 * `installed` and `hasDataPath` are booleans on purpose: the client learns
 * that the package directory is missing without learning where the ones
 * that exist live. The component summaries ride along under the same rule —
 * NAMES only (description, app connector ids, MCP server and skill names);
 * the manifest's declarations (env, headers, command, args, url) never do.
 */
function toInventoryEntry(entry: HostPluginRegistryEntry): HostPluginInventoryEntry {
  return {
    id: entry.id,
    name: entry.name,
    enabled: entry.enabled,
    marketplace: entry.marketplace,
    installed: entry.installPath !== undefined,
    hasDataPath: entry.dataPath !== undefined,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.appConnections === undefined ? {} : { appConnections: entry.appConnections }),
    ...(entry.manifest?.capabilities?.mcpServers === undefined
      ? {}
      : { mcpServers: entry.manifest.capabilities.mcpServers.map((server) => server.name) }),
    ...(entry.skillNames === undefined ? {} : { skillNames: entry.skillNames }),
  };
}

/**
 * The Host's plugin inventory, read from the shared config root.
 *
 * `configRootOverride` names the config root to read; without it the shared
 * root is probed the same way the registry API probes it.
 */
export function createHostLocalPluginInventoryApi(
  configRootOverride?: string,
): HostPluginInventoryApiV1 {
  const registry = createHostLocalPluginRegistryApi(configRootOverride);
  return {
    async listPluginInventory(): Promise<{ readonly plugins: readonly HostPluginInventoryEntry[] }> {
      return { plugins: registry.listPlugins().map(toInventoryEntry) };
    },
  };
}
