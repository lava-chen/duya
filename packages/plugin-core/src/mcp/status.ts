// packages/plugin-core/src/mcp/status.ts
// MCP status enums. Pure types only — no runtime imports.

/**
 * Static, discovery-time status for an MCP server entry.
 * Computed by the pure resolution engine in plugin-core; not dependent on
 * any running process.
 */
export type MCPDiscoveryStatus =
  | 'configured'              // static checks all pass; ready to attempt connection
  | 'script_missing'          // args[0] (or relative-path command) does not exist on disk
  | 'command_missing'         // command is empty/whitespace or fails the static syntax check
  | 'manifest_invalid'        // manifest.json / plugin.json could not be parsed or is missing required fields
  | 'env_missing'             // required ${VAR} expansion produced missingVars
  | 'user_config_missing'     // ${user_config.X} referenced but key not saved
  | 'allowed_paths_violation' // resolved path escapes plugin install dir
  | 'disabled';               // plugin or entry deliberately skipped (NOT an error)

/**
 * Dynamic, runtime connection status. Defaults to 'not_started' when no
 * worker has attempted to connect this session.
 */
export type MCPConnectionStatus =
  | 'not_started'
  | 'connecting'
  | 'connected'
  | 'connection_failed'  // spawn returned non-zero, transport error, or timeout
  | 'disconnected';      // was connected, now closed
