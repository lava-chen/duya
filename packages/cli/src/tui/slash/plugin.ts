/**
 * packages/cli/src/tui/slash/plugin.ts
 *
 * `/plugin` — the plugins installed on this machine.
 *
 * ## Why the CLI asks the Host
 *
 * The TUI is a pure HTTP client of the Host (see packages/cli/src/chat.ts),
 * so the plugin inventory is a Host read: `GET /v1/local/plugins`. The
 * Host knows which plugin packages exist on disk; the CLI has no business
 * scanning another process's data directory for them.
 *
 * ## The shape this command reads
 *
 * The inventory answers
 *
 *     { plugins: [{ id, name, enabled, marketplace, installed,
 *                   description?, appConnections?, mcpServers?, skillNames? }] }
 *
 * `installed` says whether the plugin's package directory could be found.
 * A plugin that is registered but whose package is gone is a DIFFERENT fact
 * from a plugin that was never installed, and the list says which one it
 * is — a registered plugin with no package is a broken install, not a
 * missing one. The component fields are NAMES ONLY (the projection rule the
 * inventory route keeps); an older Host answers without them and the detail
 * page shows fewer lines, which is honest degradation.
 *
 * ## The list is a browser, not a table
 *
 * A listing you cannot move through is a wall of text: the rows render as a
 * selectable list (`showEntries`), Enter opens the selected plugin's detail
 * page, and Esc comes back. The detail page also states the mention form
 * (`@<id>`), because pointing a turn at a plugin is the one action this view
 * leads to — matching the desktop's `@` popover.
 *
 * ## "No plugins" and "this Host cannot answer" are different answers
 *
 * A Host without the inventory answers 404
 * `plugin_inventory_api_unavailable`. That is not "no plugins are
 * installed" — it is "this Host cannot answer the question", and the two
 * are rendered differently. An empty list is a fact that was observed; a
 * refusal is not, and a panel that said "no plugins" for a Host that never
 * answered would report a fact it never observed.
 */

import type { TuiSlashCommandDef, TuiSlashContext } from './types.js';
import { describeError, hostErrorCode, showEntries, showPanel, type TuiViewEntry } from './shared.js';

const FOOTER = '↑↓ / PgUp / PgDn scroll · Esc close';

/** One installed plugin, as the Host's inventory reports it. */
interface PluginEntry {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly marketplace: string;
  readonly installed: boolean;
  readonly description?: string;
  readonly appConnections?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly skillNames?: readonly string[];
}

/**
 * The slice of the Host client this command depends on.
 *
 * `listPlugins()` ships on `HostSessionHttpClient` together with the Host's
 * inventory route. It is declared here as a structural interface so this
 * file states the contract it reads instead of trusting a payload shape; a
 * client that does not carry the method cannot answer, and that is a fact
 * the command can report rather than a crash it cannot.
 */
interface PluginInventoryCapableClient {
  listPlugins(): Promise<unknown>;
}

/**
 * The string list one component field carries, read leniently.
 *
 * The summaries are NAMES the Host projects; an older Host answers without
 * them and the detail page just shows fewer lines.
 */
function readNames(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && item !== '');
}

/**
 * Narrow one unknown record into the fields this command shows.
 *
 * The payload arrives over HTTP as JSON, so the declared type describes the
 * happy path and not a guarantee: one malformed entry must not take the
 * whole listing down.
 */
function narrowPlugin(value: unknown): PluginEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    id: typeof record['id'] === 'string' ? record['id'] : '',
    name: typeof record['name'] === 'string' ? record['name'] : '',
    // A plugin that does not say whether it is enabled counts as enabled: a
    // registry only writes `enabled = false` when the user turned it off.
    enabled: record['enabled'] !== false,
    marketplace: typeof record['marketplace'] === 'string' ? record['marketplace'] : '',
    installed: record['installed'] !== false,
    description: typeof record['description'] === 'string' && record['description'] !== ''
      ? record['description']
      : undefined,
    appConnections: readNames(record['appConnections']),
    mcpServers: readNames(record['mcpServers']),
    skillNames: readNames(record['skillNames']),
  };
}

/**
 * The plugins in an inventory payload.
 *
 * `undefined` means the payload is not an inventory at all — a different
 * fact from "the inventory is empty", and one the caller has to report
 * differently.
 */
function readPlugins(payload: unknown): readonly PluginEntry[] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const raw = (payload as { readonly plugins?: unknown }).plugins;
  if (!Array.isArray(raw)) return undefined;
  const plugins: PluginEntry[] = [];
  for (const item of raw) {
    const entry = narrowPlugin(item);
    if (entry !== undefined) plugins.push(entry);
  }
  return plugins;
}

/** The listing, one row per plugin. */
function pluginLines(plugins: readonly PluginEntry[]): string[] {
  if (plugins.length === 0) {
    return [
      'No plugins are installed.',
      '',
      '  The plugin inventory answered with an empty list — this Host does',
      '  serve it, and there is nothing installed.',
    ];
  }

  const rows = plugins.map((entry) => ({
    name: entry.name !== '' ? entry.name : entry.id || '(unnamed)',
    marketplace: entry.marketplace !== '' ? entry.marketplace : '(local)',
    enabled: entry.enabled ? 'yes' : 'no',
    installed: entry.installed ? 'yes' : 'no',
  }));
  const nameWidth = Math.max(4, ...rows.map((row) => row.name.length));
  const marketplaceWidth = Math.max(11, ...rows.map((row) => row.marketplace.length));

  const lines = [`${rows.length} plugin${rows.length === 1 ? '' : 's'}`];
  for (const row of rows) {
    lines.push(
      `  ${row.name.padEnd(nameWidth)}  ${row.marketplace.padEnd(marketplaceWidth)}  `
      + `${row.enabled.padEnd(7)}  ${row.installed}`,
    );
  }
  const missing = plugins.filter((entry) => !entry.installed).length;
  if (missing > 0) {
    lines.push(
      '',
      `  ${missing} plugin${missing === 1 ? ' is' : 's are'} registered but the package`
      + `${missing === 1 ? ' was' : 's were'} not found on disk.`,
    );
  }
  return lines;
}

/** The capability sentence a plugin's component summaries make: `2 apps · 1 MCP server · 3 skills`. */
function capabilitySummary(entry: PluginEntry): string | undefined {
  const parts: string[] = [];
  const apps = entry.appConnections?.length ?? 0;
  const servers = entry.mcpServers?.length ?? 0;
  const skills = entry.skillNames?.length ?? 0;
  if (apps > 0) parts.push(`${apps} app${apps === 1 ? '' : 's'}`);
  if (servers > 0) parts.push(`${servers} MCP server${servers === 1 ? '' : 's'}`);
  if (skills > 0) parts.push(`${skills} skill${skills === 1 ? '' : 's'}`);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/** The detail page of one plugin: identity, state, capabilities, how to mention it. */
function pluginDetailLines(entry: PluginEntry): string[] {
  const name = entry.name !== '' ? entry.name : entry.id || '(unnamed)';
  const lines = [name];
  if (entry.description !== undefined) lines.push(entry.description);
  lines.push('');
  lines.push(`  id          ${entry.id}`);
  lines.push(`  marketplace ${entry.marketplace !== '' ? entry.marketplace : '(local)'}`);
  lines.push(`  enabled     ${entry.enabled ? 'yes' : 'no'}`);
  lines.push(`  installed   ${entry.installed ? 'yes' : 'no'}`);
  const summary = capabilitySummary(entry);
  if (summary !== undefined) {
    lines.push('', `  capabilities: ${summary}`);
    for (const appId of entry.appConnections ?? []) lines.push(`    app: ${appId}`);
    for (const server of entry.mcpServers ?? []) lines.push(`    MCP server: ${server}`);
    for (const skill of entry.skillNames ?? []) lines.push(`    skill: ${skill}`);
  }
  lines.push('', '  Mention it in a message as @' + (entry.id || name) + ' to point this turn at it.');
  return lines;
}

/** The interactive list, one selectable entry per plugin. */
function pluginEntries(plugins: readonly PluginEntry[]): TuiViewEntry[] {
  return plugins.map((entry) => {
    const name = entry.name !== '' ? entry.name : entry.id || '(unnamed)';
    const summary = capabilitySummary(entry);
    const state = entry.installed ? (entry.enabled ? 'on' : 'off') : 'missing';
    return {
      label: name,
      value: entry.id !== '' ? entry.id : name,
      description: entry.description !== undefined && summary !== undefined
        ? `${summary} — ${entry.description}`
        : entry.description ?? summary,
      valueLabel: state,
      summary: summary ?? entry.description,
      detailLines: pluginDetailLines(entry),
    };
  });
}

const PLUGIN_COMMAND: TuiSlashCommandDef = {
  name: 'plugin',
  description: 'List the installed plugins',
  group: 'Session info',
  async run(ctx: TuiSlashContext) {
    // The Host's inventory route lands `listPlugins` on the client. A client
    // without it cannot answer, and the command says so rather than calling
    // into nothing.
    const client: Partial<PluginInventoryCapableClient> = ctx.client;
    if (typeof client.listPlugins !== 'function') {
      ctx.tui.printError(
        'This CLI cannot read the plugin inventory: its Host client does not offer the inventory route.',
      );
      return { kind: 'handled' };
    }

    let payload: unknown;
    try {
      payload = await client.listPlugins();
    } catch (error) {
      // A Host without the inventory cannot answer. That is not the same as
      // an empty inventory, and it is rendered differently.
      if (hostErrorCode(error) === 'plugin_inventory_api_unavailable') {
        showPanel(ctx, 'Plugins', [
          'This Host does not serve the plugin inventory, so it cannot answer.',
          '',
          '  That is different from "no plugins are installed" — here the',
          '  question was never asked of an authority that could answer it.',
          '',
          '  Source: Host plugin inventory (GET /v1/local/plugins),',
          '  404 plugin_inventory_api_unavailable.',
        ], { footer: FOOTER, scrollable: true });
        return { kind: 'handled' };
      }
      ctx.tui.printError(`Could not read the plugin inventory: ${describeError(error)}`);
      return { kind: 'handled' };
    }

    const plugins = readPlugins(payload);
    if (plugins === undefined) {
      ctx.tui.printError(
        'Could not read the plugin inventory: the Host answered with something that is not an inventory.',
      );
      return { kind: 'handled' };
    }

    showEntries(ctx, 'Plugins', pluginEntries(plugins), pluginLines(plugins));
    return { kind: 'handled' };
  },
};

export const PLUGIN_COMMANDS: readonly TuiSlashCommandDef[] = [PLUGIN_COMMAND];
