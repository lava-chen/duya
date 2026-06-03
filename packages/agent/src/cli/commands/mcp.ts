/**
 * packages/agent/src/cli/commands/mcp.ts
 *
 * `duya mcp list` / `duya mcp info <id>` read-only commands.
 *
 * Reads the available MCP list from the main process via
 * /v1/mcps. The main process owns the unified collector and DTO.
 */

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';

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