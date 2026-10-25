/**
 * The plugin inventory a Host serves to a client.
 *
 * ## Why this is a separate shape
 *
 * The Host's own plugin registry entry carries the install path, the data
 * path and the plugin manifest. The manifest's `capabilities.mcpServers` can
 * declare an `env`, `headers`, `command`, `args` or `url` for every MCP
 * server the plugin brings — that is credential material, not inventory.
 *
 * A client that only wants to SHOW the plugin list must never receive it.
 * This contract is therefore a projection: the identity of the plugin, the
 * user's intent, and whether the Host can actually see the plugin's files.
 * No path and no credential appears here.
 *
 * ## The two absences mean different things
 *
 * `installed: false` is an OBSERVED FACT — the Host looked and the package
 * directory is not there. A Host that cannot answer the question at all
 * refuses the route with 404 `plugin_inventory_api_unavailable` rather than
 * reporting an empty list, so "no plugins are installed" and "this Host
 * cannot say" never read the same.
 */

/** One plugin, as a client is allowed to see it. */
export interface HostPluginInventoryEntry {
  /** The plugin id, without the marketplace suffix. */
  readonly id: string;
  /** The display name; the registry carries the id as the name. */
  readonly name: string;
  /** Whether the user enabled the plugin. */
  readonly enabled: boolean;
  /** The marketplace the plugin came from. */
  readonly marketplace: string;
  /** Whether the Host can see the plugin's package directory on disk. */
  readonly installed: boolean;
  /** Whether the plugin's own data directory exists. */
  readonly hasDataPath: boolean;
}

/**
 * The Host capability that serves the plugin inventory.
 *
 * Optional on the HTTP server: a Host composed without the plugin registry
 * cannot say which plugins are installed, and it answers 404 with a named
 * code rather than pretending the machine has no plugins.
 *
 * The shape mirrors the sibling inventory capabilities (`mcp-inventory.ts`,
 * `skill-inventory.ts`): the method answers with a WRAPPER object, and the
 * route serves it verbatim, so every inventory reads the same way.
 */
export interface HostPluginInventoryApiV1 {
  listPluginInventory(): Promise<{ readonly plugins: readonly HostPluginInventoryEntry[] }>;
}
