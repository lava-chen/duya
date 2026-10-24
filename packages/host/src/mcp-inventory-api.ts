/**
 * The Host's read-only inventory of the user's configured MCP servers.
 *
 * ## Why this exists
 *
 * A client that can only speak HTTP — the CLI TUI is the one that matters
 * here — has exactly one way to learn which MCP servers the user configured:
 * the Host. The Desktop's own CLI API answers the same question, but only
 * while the desktop app is running, so a standalone TUI cannot use it.
 *
 * The Host already reads the user's `[mcp_servers.*]` section out of
 * `config.toml` (see `connector-services/config.ts`), so the answer is a
 * projection of a file that is already being read — not a second parser and
 * not a second source of truth.
 *
 * ## What this is not
 *
 * This is a READ. It does not start a server, does not probe one, does not
 * need a worker and does not need a session. It reports what the user
 * configured, including servers that are disabled — a client that renders
 * "3 MCP servers" and a client that renders "2 MCP servers, one disabled" are
 * answering different questions, and only the first one is wrong.
 *
 * Credentials never leave: `env` and `headers` are dropped on the way out.
 */

import type { HostMcpInventoryApiV1, HostMcpServerConfig } from '@duya/agent-protocol';
import type { UserMcpTomlServer } from '@duya/plugin-core/mcp/user-config';

/**
 * Where the inventory reads the configured servers from.
 *
 * A port rather than a direct call so the inventory can be tested without a
 * config file on disk, and so a caller can decide WHICH configuration is
 * authoritative (the Host's own data root, for instance).
 */
export interface McpInventoryConfigSource {
  listServers(): Promise<readonly UserMcpTomlServer[]>;
}

/**
 * Order two names by code unit.
 *
 * NOT `localeCompare`: that consults the machine's locale, so the same
 * configuration would come back in a different order on two machines, and
 * "the list is sorted" would stop being a property a client can rely on.
 */
function compareByCodeUnit(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Project one configured server onto the wire shape.
 *
 * `env` and `headers` are dropped here and nowhere else: this is the single
 * place where a credential could escape, so it is the single place that has
 * to be right.
 */
function toHostMcpServerConfig(server: UserMcpTomlServer): HostMcpServerConfig {
  return {
    name: server.name,
    ...(server.transport === undefined ? {} : { transport: server.transport }),
    ...(server.command === undefined ? {} : { command: server.command }),
    ...(server.args === undefined ? {} : { args: [...server.args] }),
    ...(server.url === undefined ? {} : { url: server.url }),
    // A server the user switched off is still a server the user configured.
    enabled: server.enabled !== false,
    ...(server.nameOverride === undefined ? {} : { nameOverride: server.nameOverride }),
    ...(server.startupTimeoutSec === undefined
      ? {}
      : { startupTimeoutSec: server.startupTimeoutSec }),
    ...(server.toolTimeoutSec === undefined ? {} : { toolTimeoutSec: server.toolTimeoutSec }),
  };
}

/**
 * Build the inventory capability over a configuration source.
 *
 * A configuration that does not exist, or one without an MCP section, is an
 * empty inventory — not an error. "The user configured no MCP servers" is a
 * complete answer to the question the route was asked.
 */
export function createHostMcpInventoryApi(source: McpInventoryConfigSource): HostMcpInventoryApiV1 {
  return {
    async listServers() {
      const configured = await source.listServers();
      const servers = configured.map(toHostMcpServerConfig);
      servers.sort((left, right) => compareByCodeUnit(left.name, right.name));
      return { servers };
    },
  };
}
