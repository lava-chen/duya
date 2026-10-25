/**
 * packages/cli/src/tui/slash/mcp.ts
 *
 * `/mcp` — the MCP servers this Host was configured with.
 *
 * ## Why the CLI asks the Host
 *
 * The Desktop's `/mcp` opens the extensions settings page. The CLI's own
 * `duya mcp list` sub-command talks to the DESKTOP's Electron CLI API, so
 * it only answers while the desktop app is running. This command reads the
 * same data from the Host the TUI already talks to (`GET /v1/mcps`), which
 * is what lets a standalone CLI answer it.
 *
 * The presentation mirrors `duya mcp list` — one row per server, name,
 * state, transport, target — because it is the same configuration. The
 * transport is not: that sub-command needs the desktop, this one does not.
 *
 * ## What this list is, and what it is not
 *
 * The Host reads the user's own `config.toml` MCP section — the same store
 * the Desktop shows. That is a SCOPE, not a defect: plugin-declared MCP
 * servers live in a different registry, the Host's plugin entries carry no
 * `installPath` (the plugin packages live under the Electron app's
 * `userData` directory), and the live connection status and the tool list
 * exist only inside a running worker. The scope line below says so in one
 * line, because a user who sees a plugin's server missing would otherwise
 * conclude that the list is broken.
 *
 * ## "No servers" and "this Host cannot answer" are different answers
 *
 * A Host without the inventory capability answers 404
 * `mcp_inventory_api_unavailable`. That is not "no MCP servers are
 * configured" — it is "this Host cannot answer the question", and the two
 * are rendered differently. A panel that said "no servers" for a Host that
 * simply does not serve the namespace would report a fact it never
 * observed.
 *
 * ## Credentials never travel
 *
 * The inventory deliberately carries no `env` and no `headers`: those hold
 * the servers' credentials. This command never asks the Host for them and
 * never prints them.
 */

import type { TuiSlashCommandDef, TuiSlashContext } from './types.js';
import { describeError, hostErrorCode, showEntries, showPanel, type TuiViewEntry } from './shared.js';

const FOOTER = '↑↓ / PgUp / PgDn scroll · Esc close';

/**
 * The one line that says what this list is not.
 *
 * The Host's inventory covers the user's own configuration only. Plugin
 * servers are a different registry the Host cannot enumerate, and the live
 * connection status and tool list exist only inside a running worker.
 */
const SCOPE_LINE =
  'Scope: your own configuration only — plugin-declared MCP servers are not listed, '
  + 'and there is no live connection status or tool list here (those exist only inside a running worker).';

/** One configured MCP server, as the Host's inventory route reports it. */
interface McpServerEntry {
  readonly name: string;
  readonly transport?: 'stdio' | 'streamable-http';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly enabled: boolean;
}

/** The inventory payload: the servers the Host was configured with. */
interface McpInventoryResponse {
  readonly servers: readonly McpServerEntry[];
}

/**
 * Narrow one unknown record into the fields this command shows.
 *
 * The payload arrives over HTTP as JSON, so the declared type describes the
 * happy path and not a guarantee: one malformed entry must not take the
 * whole listing down.
 */
function narrowEntry(value: unknown): McpServerEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const rawTransport = record['transport'];
  const transport = rawTransport === 'stdio' || rawTransport === 'streamable-http'
    ? rawTransport
    : undefined;
  const rawArgs = record['args'];
  const args = Array.isArray(rawArgs)
    ? (rawArgs as unknown[]).filter((arg): arg is string => typeof arg === 'string')
    : undefined;
  const command = record['command'];
  const url = record['url'];
  return {
    name: typeof record['name'] === 'string' ? record['name'] : '',
    ...(transport === undefined ? {} : { transport }),
    ...(typeof command === 'string' ? { command } : {}),
    ...(args === undefined ? {} : { args }),
    ...(typeof url === 'string' ? { url } : {}),
    // An entry that does not say whether it is enabled counts as enabled,
    // the same way the Desktop's own list counts it: a configuration only
    // writes `enabled = false` when the user turned a server off.
    enabled: record['enabled'] !== false,
  };
}

/**
 * The servers in an inventory payload.
 *
 * `undefined` means the payload is not an inventory at all — a different
 * fact from "the inventory is empty", and one the caller has to report
 * differently.
 */
function readServers(payload: unknown): readonly McpServerEntry[] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const raw = (payload as { readonly servers?: unknown }).servers;
  if (!Array.isArray(raw)) return undefined;
  const servers: McpServerEntry[] = [];
  for (const item of raw) {
    const entry = narrowEntry(item);
    if (entry !== undefined) servers.push(entry);
  }
  return servers;
}

/** The transport a server speaks, derived when the entry does not name one. */
function transportOf(entry: McpServerEntry): 'stdio' | 'streamable-http' {
  if (entry.transport !== undefined) return entry.transport;
  return entry.url !== undefined && entry.url !== '' ? 'streamable-http' : 'stdio';
}

/**
 * What the server connects to: the command line it is spawned with, or the
 * URL it is reached at.
 */
function targetOf(entry: McpServerEntry): string {
  if (transportOf(entry) === 'streamable-http') {
    return entry.url !== undefined && entry.url !== '' ? entry.url : '(no url)';
  }
  const command = entry.command !== undefined && entry.command !== '' ? entry.command : '(no command)';
  const args = entry.args ?? [];
  return args.length === 0 ? command : `${command} ${args.join(' ')}`;
}

/** The listing, one row per server. */
function serverLines(servers: readonly McpServerEntry[]): string[] {
  if (servers.length === 0) {
    return [
      'No MCP servers are configured.',
      '',
      `  ${SCOPE_LINE}`,
    ];
  }

  const rows = servers.map((entry) => ({
    name: entry.name !== '' ? entry.name : '(unnamed)',
    state: entry.enabled ? 'on' : 'off',
    transport: transportOf(entry),
    target: targetOf(entry),
  }));
  const nameWidth = Math.max(4, ...rows.map((row) => row.name.length));
  const stateWidth = Math.max(5, ...rows.map((row) => row.state.length));
  const transportWidth = Math.max(9, ...rows.map((row) => row.transport.length));

  const lines = [`${rows.length} MCP server${rows.length === 1 ? '' : 's'} configured`];
  for (const row of rows) {
    lines.push(
      `  ${row.name.padEnd(nameWidth)}  ${row.state.padEnd(stateWidth)}  ${row.transport.padEnd(transportWidth)}  ${row.target}`,
    );
  }
  lines.push('', `  ${SCOPE_LINE}`);
  return lines;
}

/** The detail page of one server: how it is reached and whether it is on. */
function serverDetailLines(entry: McpServerEntry): string[] {
  return [
    entry.name !== '' ? entry.name : '(unnamed)',
    '',
    `  state      ${entry.enabled ? 'on' : 'off'}`,
    `  transport  ${transportOf(entry)}`,
    `  target     ${targetOf(entry)}`,
    '',
    `  ${SCOPE_LINE}`,
  ];
}

/** The interactive list, one selectable entry per server. */
function serverEntries(servers: readonly McpServerEntry[]): TuiViewEntry[] {
  return servers.map((entry) => ({
    label: entry.name !== '' ? entry.name : '(unnamed)',
    value: entry.name !== '' ? entry.name : '(unnamed)',
    description: transportOf(entry),
    valueLabel: entry.enabled ? 'on' : 'off',
    summary: targetOf(entry),
    detailLines: serverDetailLines(entry),
  }));
}

const MCP_COMMAND: TuiSlashCommandDef = {
  name: 'mcp',
  description: 'List the configured MCP servers',
  group: 'Session info',
  async run(ctx: TuiSlashContext) {
    let payload: unknown;
    try {
      payload = await ctx.client.listMcpServers();
    } catch (error) {
      // A Host without the inventory capability cannot answer. That is not
      // the same as an empty inventory, and it is rendered differently.
      if (hostErrorCode(error) === 'mcp_inventory_api_unavailable') {
        showPanel(ctx, 'MCP servers', [
          'This Host does not serve the MCP inventory, so it cannot answer.',
          '',
          '  That is different from "no MCP servers are configured" — here the',
          '  question was never asked of an authority that could answer it.',
          '',
          '  Source: Host MCP inventory (GET /v1/mcps), 404 mcp_inventory_api_unavailable.',
        ], { footer: FOOTER, scrollable: true });
        return { kind: 'handled' };
      }
      ctx.tui.printError(`Could not read the MCP inventory: ${describeError(error)}`);
      return { kind: 'handled' };
    }

    const servers = readServers(payload);
    if (servers === undefined) {
      ctx.tui.printError(
        'Could not read the MCP inventory: the Host answered with something that is not an inventory.',
      );
      return { kind: 'handled' };
    }

    showEntries(ctx, 'MCP servers', serverEntries(servers), serverLines(servers));
    return { kind: 'handled' };
  },
};

export const MCP_COMMANDS: readonly TuiSlashCommandDef[] = [MCP_COMMAND];
