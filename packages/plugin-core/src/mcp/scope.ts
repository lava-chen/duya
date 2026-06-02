// packages/plugin-core/src/mcp/scope.ts
// Pure helpers for scoping MCP server names and tool registry keys.
// No runtime imports, no I/O.

/**
 * Prefix for scoped server names contributed by a plugin. The intent is to
 * make `scopedPluginServerName(pluginId, 'literature')` distinguishable
 * from a user-authored `literature` server in settings.
 */
export const PLUGIN_SCOPE_PREFIX = 'plugin:';

/**
 * Prefix for the in-process tool registry key. Model-visible tool names
 * are derived from the internal key by the provider policy helpers in
 * provider-tool-name.ts.
 */
export const MCP_INTERNAL_PREFIX = 'mcp__';

/**
 * Separator between the scoped server name and the original tool name in
 * the internal registry key.
 */
export const MCP_INTERNAL_SEP = '__';

/**
 * Build the scoped server name for a plugin-provided MCP server.
 *
 *   scopedPluginServerName('com.duya.lit', 'literature')
 *     === 'plugin:com.duya.lit:literature'
 *
 * For non-plugin sources (bundled, settings) the caller should pass the
 * raw name unchanged; this helper is only meaningful for `source: 'plugin'`.
 */
export function scopedPluginServerName(pluginId: string, serverName: string): string {
  return `${PLUGIN_SCOPE_PREFIX}${pluginId}:${serverName}`;
}

/**
 * Build the in-process tool registry key for an MCP tool.
 *
 *   toolInternalKey('plugin:com.duya.lit:literature', 'add_source')
 *     === 'mcp__plugin:com.duya.lit:literature__add_source'
 *
 * Always unique by construction (scoped server names differ across plugins
 * and across sources, so two servers exposing the same tool name produce
 * different internal keys).
 */
export function toolInternalKey(scopedServerName: string, toolName: string): string {
  return `${MCP_INTERNAL_PREFIX}${scopedServerName}${MCP_INTERNAL_SEP}${toolName}`;
}

/**
 * Strip the `plugin:` prefix from a scoped server name and return the
 * original (unscoped) display name. If the input is not a plugin-scoped
 * name, returns it unchanged.
 *
 *   unscopedServerName('plugin:com.duya.lit:literature') === 'literature'
 *   unscopedServerName('literature')                     === 'literature'
 */
export function unscopedServerName(scopedName: string): string {
  if (!isPluginScopedName(scopedName)) return scopedName;
  const rest = scopedName.slice(PLUGIN_SCOPE_PREFIX.length);
  const colon = rest.indexOf(':');
  return colon === -1 ? rest : rest.slice(colon + 1);
}

/**
 * Return the pluginId component of a scoped server name, or undefined if
 * the input is not plugin-scoped. Useful for routing lookups where the
 * caller wants the pluginId without reparsing the full name.
 *
 *   pluginIdFromScopedName('plugin:com.duya.lit:literature') === 'com.duya.lit'
 *   pluginIdFromScopedName('literature')                     === undefined
 */
export function pluginIdFromScopedName(scopedName: string): string | undefined {
  if (!isPluginScopedName(scopedName)) return undefined;
  const rest = scopedName.slice(PLUGIN_SCOPE_PREFIX.length);
  const colon = rest.indexOf(':');
  return colon === -1 ? rest : rest.slice(0, colon);
}

/**
 * True if the name was produced by `scopedPluginServerName`.
 *
 *   isPluginScopedName('plugin:foo:bar')   === true
 *   isPluginScopedName('plugin:')         === false   (no server name)
 *   isPluginScopedName('plugin')          === false   (no separator)
 *   isPluginScopedName('')                === false
 *   isPluginScopedName('literature')      === false
 */
export function isPluginScopedName(name: string): boolean {
  if (!name.startsWith(PLUGIN_SCOPE_PREFIX)) return false;
  const rest = name.slice(PLUGIN_SCOPE_PREFIX.length);
  if (rest.length === 0) return false;
  return rest.includes(':');
}

/**
 * Build a stable inventoryId for a candidate. The shape is encoded in the
 * id so it is reversible via simple string parsing; helpers in Phase 1 will
 * use this to thread inventoryIds through the resolution result.
 *
 *   buildInventoryId({ source: 'bundled',  rawConfig: { name: 'literature', ... } })
 *     === 'bundled:literature'
 *   buildInventoryId({ source: 'plugin',   pluginId: 'com.duya.lit', rawConfig: { name: 'literature', ... } })
 *     === 'plugin:com.duya.lit:literature'
 *   buildInventoryId({ source: 'settings', sourceSubOrigin: 'agentSettings', rawConfig: { name: 'literature', ... } })
 *     === 'settings:agentSettings:literature'
 */
export function buildInventoryId(args: {
  source: 'bundled' | 'plugin' | 'settings';
  sourceSubOrigin?: 'legacyFile' | 'settingsKv' | 'agentSettings';
  pluginId?: string;
  serverName: string;
}): string {
  if (args.source === 'plugin') {
    const pid = args.pluginId ?? '<unknown-plugin>';
    return `${args.source}:${pid}:${args.serverName}`;
  }
  if (args.source === 'settings') {
    const sub = args.sourceSubOrigin ?? 'agentSettings';
    return `${args.source}:${sub}:${args.serverName}`;
  }
  return `${args.source}:${args.serverName}`;
}
