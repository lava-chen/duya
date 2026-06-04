/**
 * packages/cli/src/commands/mcp.ts
 *
 * `duya mcp …` — read and write MCP server configuration.
 *
 * Reads: list / info (existing).
 * Writes: add / remove / assign (Plan 99 §3.3 Phase 7 + Plan 102).
 * The `mcp add` write op is the agent-facing replacement for
 * `duya_config mcp_server_add`; it routes through the same audit
 * path as cron writes (`kind: 'mcp.add'`).
 */

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';
import type { CliSubcommandContext, ExitCode } from '../program/registry.js';

interface MCPListItemDTO {
  id: string;
  name: string;
  source: 'bundled' | 'plugin' | 'settings';
  sourceId?: string;
  enabled: boolean;
  connected: boolean;
}

interface MCPInfoItemDTO extends MCPListItemDTO {
  command: string;
  args: string[];
}

function renderListText(mcps: MCPListItemDTO[]): string {
  if (mcps.length === 0) return '(no MCP servers available)';
  const lines: string[] = [];
  lines.push(`${mcps.length} MCP server${mcps.length !== 1 ? 's' : ''} available`);
  for (const m of mcps) {
    const state = m.connected ? 'on' : 'off';
    const enabled = m.enabled ? 'enabled' : 'disabled';
    const src = m.sourceId ? `${m.source}:${m.sourceId}` : m.source;
    lines.push(`  ${m.id.padEnd(48)} ${state}  ${src.padEnd(14)} ${enabled}`);
  }
  return lines.join('\n');
}

function renderInfoText(m: MCPInfoItemDTO): string {
  const lines: string[] = [];
  lines.push(`${m.id}`);
  lines.push(`  name:      ${m.name}`);
  lines.push(`  source:    ${m.source}${m.sourceId ? ` (${m.sourceId})` : ''}`);
  lines.push(`  enabled:   ${m.enabled ? 'yes' : 'no'}`);
  lines.push(`  connected: ${m.connected ? 'yes' : 'no'}`);
  lines.push(`  command:   ${m.command}`);
  if (m.args.length > 0) {
    lines.push(`  args:      ${m.args.join(' ')}`);
  }
  return lines.join('\n');
}

async function fetchMCPs(): Promise<MCPListItemDTO[]> {
  const client = await CliApiClient.connect();
  const body = await client.get<{ mcps: MCPListItemDTO[] }>('/v1/mcps');
  return body.mcps;
}

async function fetchMCPInfo(id: string): Promise<MCPInfoItemDTO> {
  const client = await CliApiClient.connect();
  const body = await client.get<{ mcp: MCPInfoItemDTO }>(`/v1/mcps/${encodeURIComponent(id)}`);
  return body.mcp;
}

export async function runMCPListCommand(format: OutputFormat): Promise<number> {
  try {
    const mcps = await fetchMCPs();
    if (format === 'json') {
      process.stdout.write(renderJson({ mcps }) + '\n');
    } else {
      process.stdout.write(renderListText(mcps) + '\n');
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

export async function runMCPInfoCommand(id: string, format: OutputFormat): Promise<number> {
  try {
    const info = await fetchMCPInfo(id);
    if (format === 'json') {
      process.stdout.write(renderJson({ mcp: info }) + '\n');
    } else {
      process.stdout.write(renderInfoText(info) + '\n');
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