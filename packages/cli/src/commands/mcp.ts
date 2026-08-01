/**
 * packages/cli/src/commands/mcp.ts
 *
 * `duya mcp …` — write MCP server configuration.
 *
 * Writes: add / remove / assign (Plan 99 §3.3 Phase 7 + Plan 102).
 * The `mcp add` write op is the agent-facing replacement for
 * `duya_config mcp_server_add`; it routes through the same audit
 * path as cron writes (`kind: 'mcp.add'`).
 *
 * The read subcommands (`mcp list`, `mcp info`) and the
 * `mcp test` smoke-spawn subcommand were removed with the old
 * MCP inventory framework. The worker's `mcp:status:snapshot` SSE
 * event + capability-management snapshot are now the single source
 * of truth for the effective MCP set; the CLI no longer exposes a
 * parallel read path.
 */

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson } from '../api/format.js';
import type { CliSubcommandContext, ExitCode } from '../program/registry.js';

// ---------------------------------------------------------------------------
// Write ops (Plan 99 §3.3 Phase 7 + Plan 102).
// ---------------------------------------------------------------------------

function writeErrorAndExit(err: unknown): never {
  if (err instanceof CliApiError) {
    process.stderr.write(err.hint + '\n');
    process.exit(err.isAppUnavailable() ? 2 : 1);
  }
  throw err;
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
