// packages/plugin-core/src/mcp/sources.ts
// Where an MCP server config came from. Leaf module: no imports.
//
// These three types used to live in ./discovery while ./errors imported
// MCPSourceContext from there, giving the pair a file-level import cycle
// (discovery -> errors -> discovery). Both edges were `import type`, so no
// cycle existed at runtime, but the architecture checker counts file edges
// and a `managed: true` module may not carry one. ./discovery re-exports all
// three, so every existing import site is unchanged.
//
// The specifier is deliberately written without a `from '...'` form: the
// cycle-budget test walks raw text and cannot tell a quoted specifier in a
// comment from a live import, which would report this cycle as still open.

/**
 * Where an MCP server config originated. The engine treats all three as
 * first-class sources; dedup rules are explicit (see shadow.ts in Phase 1).
 */
export type MCPSource = 'bundled' | 'plugin' | 'settings';

/**
 * For settings-sourced entries, the legacy/canonical sub-origin.
 * `agentSettings` is the newest and wins over `settingsKv` and `legacyFile`
 * for the same unscoped server name (within-settings shadow rule).
 */
export type MCPSettingsSubOrigin = 'legacyFile' | 'settingsKv' | 'agentSettings' | 'tomlFile';

/**
 * Provenance info attached to MCP issues, used by the UI to bucket issues
 * by source. Field-omitted entries are valid where not applicable.
 */
export interface MCPSourceContext {
  source: MCPSource;
  sourceSubOrigin?: MCPSettingsSubOrigin;
  pluginId?: string;
  pluginName?: string;
}
