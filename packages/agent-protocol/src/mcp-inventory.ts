/**
 * Read-only inventory of the MCP servers a user configured.
 *
 * The Host already reads the user's `[mcp_servers.*]` section out of
 * `config.toml`, so it can answer "which MCP servers are configured" without
 * a worker, a live session or the Desktop app running. This contract is what
 * that answer looks like on the wire.
 *
 * It is deliberately a PROJECTION and not the configuration itself: the
 * configuration carries credentials (`env`, `headers`), and a list a client
 * can read must not carry them.
 */

/**
 * One MCP server as the Host knows it from the user's configuration.
 *
 * `env` and `headers` are deliberately absent: they carry credentials and
 * must never cross a boundary that a client can read.
 */
export interface HostMcpServerConfig {
  readonly name: string;
  readonly transport?: 'stdio' | 'streamable-http';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly enabled: boolean;
  readonly nameOverride?: string;
  readonly startupTimeoutSec?: number;
  readonly toolTimeoutSec?: number;
}

export interface HostMcpInventoryApiV1 {
  listServers(): Promise<{ readonly servers: readonly HostMcpServerConfig[] }>;
}
