/**
 * packages/cli/src/commands/mcp.ts
 *
 * `duya mcp …` — manage MCP server configuration.
 *
 * Surface (Plan 99 §3.3 Phase 7 + Plan 102, list re-added for
 * `duya mcp list`):
 *   list    — `GET    /v1/mcps`              (read configured entries)
 *   add     — `POST   /v1/mcps`              (Plan 102, replaces `duya_config mcp_server_add`)
 *   remove  — `DELETE /v1/mcps/:name`        (Plan 102, replaces `duya_config mcp_server_remove`)
 *   assign  — `PATCH  /v1/mcps/:name`        (Plan 102, replaces `duya_config mcp_server_assign`)
 *
 * The `mcp info` single-server read and the `mcp test` smoke-spawn
 * subcommands remain removed. Live connection status
 * (connected / disconnected / tool count) is still owned by the
 * worker's `mcp:status:snapshot` SSE event plus the
 * capability-management snapshot — those are the runtime truth.
 * `mcp list` returns the *configured* entries (the same store that
 * add/remove/assign read and write), so the read and write surfaces
 * never drift.
 */

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';
import type { CliSubcommandContext, ExitCode } from '../program/registry.js';
import type { UserMcpTomlServer } from '@duya/plugin-core/src/mcp/user-config.js';

// ---------------------------------------------------------------------------
// Helpers shared by mcp subcommands (Plan 99 §3.3 Phase 7 + Plan 102).
// ---------------------------------------------------------------------------

function writeErrorAndExit(err: unknown): never {
  if (err instanceof CliApiError) {
    process.stderr.write(err.hint + '\n');
    process.exit(err.isAppUnavailable() ? 2 : 1);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Read op (`duya mcp list`)
// ---------------------------------------------------------------------------

function renderListText(servers: UserMcpTomlServer[]): string {
  if (servers.length === 0) {
    return '(no MCP servers configured; use `duya mcp add` to add one)';
  }
  const lines: string[] = [];
  lines.push(`${servers.length} MCP server${servers.length !== 1 ? 's' : ''} configured`);
  // Stable columns: NAME  STATE  TRANSPORT  COMMAND  SCOPE
  const rows = servers.map((s) => {
    const state = s.enabled === false ? 'off' : 'on';
    const transport = s.transport ?? (s.url ? 'streamable-http' : 'stdio');
    const command = s.command ?? s.url ?? '';
    const scope =
      s.allowedAgentIds && s.allowedAgentIds.length > 0
        ? s.allowedAgentIds.join(',')
        : 'all';
    return {
      name: s.name,
      state,
      transport,
      command,
      scope,
    };
  });
  const widths = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    state: Math.max(5, ...rows.map((r) => r.state.length)),
    transport: Math.max(9, ...rows.map((r) => r.transport.length)),
  };
  for (const r of rows) {
    lines.push(
      `  ${r.name.padEnd(widths.name)}  ${r.state.padEnd(widths.state)}  ${r.transport.padEnd(widths.transport)}  ${r.command}  [${r.scope}]`,
    );
  }
  return lines.join('\n');
}

/**
 * `duya mcp list` — show every configured MCP server.
 *
 * Read-only. Reads from `GET /v1/mcps`, which is backed by the
 * same ConfigStore that `add`/`remove`/`assign` write to, so the
 * list never drifts from the write surface. Live connection status
 * (connected / tool count) is owned by the worker's
 * `mcp:status:snapshot` SSE event and is not surfaced here.
 */
export async function runMCPListCommand(format: OutputFormat): Promise<number> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<{ servers: UserMcpTomlServer[] }>('/v1/mcps');
    const servers = Array.isArray(body?.servers) ? body.servers : [];
    if (format === 'json') {
      process.stdout.write(renderJson({ servers }) + '\n');
    } else {
      process.stdout.write(renderListText(servers) + '\n');
    }
    return 0;
  } catch (err) {
    if (err instanceof CliApiError) {
      process.stderr.write(err.hint + '\n');
      return err.isAppUnavailable() ? 2 : 1;
    }
    throw err;
  }
}

/**
 * Convert repeatable `--env KEY=VAL` argv into a string→string map.
 * Throws on missing `=` or empty key.
 */
function envArrayToObject(env: string[] | undefined): Record<string, string> | undefined {
  if (!env || env.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const e of env) {
    const idx = e.indexOf('=');
    if (idx < 0) throw new Error(`--env expects KEY=VAL, got '${e}'`);
    const k = e.slice(0, idx);
    const v = e.slice(idx + 1);
    if (k.length === 0) throw new Error(`--env has empty key in '${e}'`);
    out[k] = v;
  }
  return out;
}

export async function runMCPAddCommand(ctx: CliSubcommandContext): Promise<ExitCode> {
  const o = ctx.options;
  const server = o.configId; // --server <name> maps to --id in the agent argv
  const command = o.configType; // --command <cmd> maps to --type (single-token value)
  if (typeof server !== 'string' || server.length === 0) {
    process.stderr.write('mcp add — --server <name> is required\n');
    return 64;
  }
  if (typeof command !== 'string' || command.length === 0) {
    process.stderr.write('mcp add — --command <cmd> is required\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = {
      name: server,
      command,
      args: o.configArgs ?? [],
      env: envArrayToObject(o.configEnv),
      allowedAgentIds: o.configAgents ?? [],
    };
    const result = await client.post<{ ok: boolean; server: Record<string, unknown> }>(
      '/v1/mcps',
      body,
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(result) + '\n');
    } else {
      process.stdout.write(`mcp server '${server}' added\n`);
    }
    return 0;
  } catch (err) {
    return writeErrorAndExit(err), 0;
  }
}

export async function runMCPRemoveCommand(ctx: CliSubcommandContext): Promise<ExitCode> {
  const name = ctx.args[0];
  if (typeof name !== 'string' || name.length === 0) {
    process.stderr.write('mcp remove <name> — name is required\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const result = await client.delete<{ ok: boolean; removed: string }>(
      `/v1/mcps/${encodeURIComponent(name)}`,
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(result) + '\n');
    } else {
      process.stdout.write(`mcp server '${name}' removed\n`);
    }
    return 0;
  } catch (err) {
    return writeErrorAndExit(err), 0;
  }
}

export async function runMCPAssignCommand(ctx: CliSubcommandContext): Promise<ExitCode> {
  const name = ctx.args[0];
  if (typeof name !== 'string' || name.length === 0) {
    process.stderr.write('mcp assign <name> — name is required\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = {
      // Empty array means "all agents" (matches the legacy
      // `duya_config mcp_server_assign` semantics).
      allowedAgentIds: ctx.options.configAgents ?? [],
    };
    const result = await client.patch<{ ok: boolean; server: string; allowedAgentIds: string[] | 'all' }>(
      `/v1/mcps/${encodeURIComponent(name)}`,
      body,
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(result) + '\n');
    } else {
      const scope =
        Array.isArray(result.allowedAgentIds) && result.allowedAgentIds.length > 0
          ? result.allowedAgentIds.join(',')
          : 'all';
      process.stdout.write(`mcp server '${name}' assigned to: ${scope}\n`);
    }
    return 0;
  } catch (err) {
    return writeErrorAndExit(err), 0;
  }
}
