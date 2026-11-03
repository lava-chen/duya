/**
 * packages/cli/src/tui/slash/plugin.ts
 *
 * `/plugin` — browse the marketplaces, install, toggle and remove plugins.
 *
 * ## Three tabs, one set of files
 *
 * This panel is the TUI projection of the Host's plugin management surface:
 * `Installed` (what this machine records intent for), `Discover` (what the
 * configured marketplaces offer and this machine does not have) and
 * `Marketplaces` (the sources themselves, addable and removable). All three come
 * from Host reads — the CLI never scans a data directory — and every gesture
 * writes through the Host, so the Desktop sees exactly what the TUI did.
 *
 * ## Why the detail rides the row
 *
 * The dock holds one panel at a time, so a detail "page" would replace the list
 * and lose the cursor when it came back. `WindowItem.detail` is the merged
 * primitive for exactly this: the selected row's long text renders under the
 * list, and the list viewport already reserves the rows it costs. Enter is
 * therefore free to be the verb rather than the description — toggle on
 * Installed, install on Discover, refresh on Marketplaces.
 *
 * ## Two Tab gestures
 *
 * In the list, Tab toggles the highlighted plugin: the gesture codex puts on a
 * plugin row, and the reason `RichPanelController` lets a tab claim the chord.
 * Only the Installed tab claims it — a Tab that installed a plugin from
 * Discover would be a write the user did not mean. In the tab strip, and for
 * every other panel, Tab stays the tab switch it has always been, and Shift+Tab
 * switches tabs from either focus, so claiming Tab never traps anyone in a list.
 * The plain letters (`i`, `u`, `t`, `r`, `x`) fire from the strip, because in
 * the list every plain letter belongs to the filter.
 *
 * ## "Cannot answer" is not "nothing"
 *
 * A Host without the management surface answers 404
 * `plugin_management_api_unavailable`, and a `TUIApp` without a dock cannot open
 * a tabbed panel at all. Both degrade to the read-only inventory listing, which
 * states that it is a degradation, rather than showing an empty marketplace.
 */

import type { TuiSlashCommandDef, TuiSlashContext } from './types.js';
import type { RichPanelHandle } from '../TUIApp.js';
import type { RichPanelTab, WindowItem } from '../window.js';
import { describeError, hostErrorCode, showEntries, showPanel, type TuiViewEntry } from './shared.js';

const READ_ONLY_FOOTER = '↑↓ / PgUp / PgDn scroll · Esc close';
const INSTALLED_FOOTER = 'Tab / t toggle · i reinstall · u uninstall · ⇄ switch tab · Esc close';
const DISCOVER_FOOTER = 'Enter / i install · ⇄ switch tab · Esc close';
const MARKETPLACE_FOOTER = 'Enter / r refresh · a add · x remove · ⇄ switch tab · Esc close';

/** One catalog row, as far as this view needs to trust it. */
interface CatalogRow {
  readonly pluginId: string;
  readonly marketplace: string;
  readonly name: string;
  readonly displayName?: string;
  readonly shortDescription?: string;
  readonly longDescription?: string;
  readonly description?: string;
  readonly version: string;
  readonly installPolicy: string;
  readonly installed: boolean;
  readonly enabled: boolean;
}

/** One marketplace row, including the error the probe could not clear. */
interface MarketplaceRow {
  readonly name: string;
  readonly displayName: string;
  readonly kind: string;
  readonly url?: string;
  readonly path?: string;
  readonly ref?: string;
  readonly hidden: boolean;
  readonly pluginCount: number;
  readonly isDefault: boolean;
  readonly error?: string;
}

/** One inventory row: the installed plugin plus the component names it declares. */
interface PluginEntry {
  readonly id: string;
  readonly name: string;
  readonly displayName?: string;
  readonly shortDescription?: string;
  readonly longDescription?: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly marketplace: string;
  readonly installed: boolean;
  readonly appConnections?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly skillNames?: readonly string[];
}

/** Everything the panel shows, as of one read. */
interface PanelData {
  readonly rows: readonly CatalogRow[];
  readonly marketplaces: readonly MarketplaceRow[];
  readonly inventory: readonly PluginEntry[];
  readonly revision: string;
  /** Why the marketplace list is empty, when it is empty because it could not be read. */
  readonly marketplaceError?: string;
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function readNames(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && item !== '');
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function narrowCatalogRow(value: unknown): CatalogRow | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const pluginId = readText(record['pluginId']);
  if (pluginId === undefined) return undefined;
  return {
    pluginId,
    marketplace: readText(record['marketplace']) ?? '',
    name: readText(record['name']) ?? pluginId,
    displayName: readText(record['displayName']),
    shortDescription: readText(record['shortDescription']),
    longDescription: readText(record['longDescription']),
    description: readText(record['description']),
    version: readText(record['version']) ?? '0.0.0',
    installPolicy: readText(record['installPolicy']) ?? 'available',
    installed: record['installed'] === true,
    // A row that does not say counts as enabled: the file writes the boolean
    // only when a person turned the plugin off.
    enabled: record['enabled'] !== false,
  };
}

function narrowMarketplaceRow(value: unknown): MarketplaceRow | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const name = readText(record['name']);
  if (name === undefined) return undefined;
  const count = record['pluginCount'];
  return {
    name,
    displayName: readText(record['displayName']) ?? name,
    kind: readText(record['kind']) ?? 'git',
    url: readText(record['url']),
    path: readText(record['path']),
    ref: readText(record['ref']),
    hidden: record['hidden'] === true,
    pluginCount: typeof count === 'number' ? count : 0,
    isDefault: record['isDefault'] === true,
    error: readText(record['error']),
  };
}

function narrowInventoryEntry(value: unknown): PluginEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = readText(record['id']);
  if (id === undefined) return undefined;
  return {
    id,
    name: readText(record['name']) ?? id,
    displayName: readText(record['displayName']),
    shortDescription: readText(record['shortDescription']),
    longDescription: readText(record['longDescription']),
    description: readText(record['description']),
    enabled: record['enabled'] !== false,
    marketplace: readText(record['marketplace']) ?? '',
    installed: record['installed'] !== false,
    appConnections: readNames(record['appConnections']),
    mcpServers: readNames(record['mcpServers']),
    skillNames: readNames(record['skillNames']),
  };
}

/** The label a user recognizes: the interface name, else the manifest name or id. */
function rowLabel(row: CatalogRow): string {
  return row.displayName ?? (row.name !== '' ? row.name : row.pluginId);
}

/** The composite key the configuration file uses — and the row's identity here. */
function rowKey(row: CatalogRow): string {
  return `${row.pluginId}@${row.marketplace}`;
}

/** `2 apps · 1 MCP server · 3 skills`, from the inventory projection of the same plugin. */
function capabilitySummary(entry: PluginEntry | undefined): string | undefined {
  if (entry === undefined) return undefined;
  const parts: string[] = [];
  const apps = entry.appConnections?.length ?? 0;
  const servers = entry.mcpServers?.length ?? 0;
  const skills = entry.skillNames?.length ?? 0;
  if (apps > 0) parts.push(`${apps} app${apps === 1 ? '' : 's'}`);
  if (servers > 0) parts.push(`${servers} MCP server${servers === 1 ? '' : 's'}`);
  if (skills > 0) parts.push(`${skills} skill${skills === 1 ? '' : 's'}`);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/** The explanation the selected plugin row earns. */
function rowDetail(row: CatalogRow, inventory: readonly PluginEntry[]): string {
  const prose = row.longDescription ?? row.shortDescription ?? row.description;
  const facts = [
    `id ${row.pluginId}`,
    `marketplace ${row.marketplace}`,
    `version ${row.version}`,
    row.enabled ? 'on' : 'off',
  ].join(' · ');
  const lines = prose === undefined ? [facts] : [prose, facts];
  const capabilities = capabilitySummary(inventory.find((entry) => entry.id === row.pluginId));
  if (capabilities !== undefined) lines.push(`capabilities: ${capabilities}`);
  lines.push(`mention it as @${row.pluginId} to point a turn at it`);
  return lines.join('\n  ');
}

function catalogItems(rows: readonly CatalogRow[], inventory: readonly PluginEntry[]): WindowItem[] {
  return rows.map((row) => {
    const summary = row.shortDescription ?? row.description;
    return {
      label: rowLabel(row),
      value: rowKey(row),
      ...(summary === undefined ? {} : { description: summary }),
      valueLabel: row.installed ? (row.enabled ? 'on' : 'off') : 'not installed',
      detail: rowDetail(row, inventory),
    };
  });
}

function marketplaceItems(rows: readonly MarketplaceRow[]): WindowItem[] {
  return rows.map((row) => ({
    label: row.displayName,
    value: row.name,
    description: row.url ?? row.path ?? '',
    valueLabel: `${row.pluginCount} plugin${row.pluginCount === 1 ? '' : 's'}`,
    detail: [
      row.error ?? 'synced',
      `source ${row.kind}`,
      ...(row.ref === undefined ? [] : [`ref ${row.ref}`]),
      ...(row.hidden ? ['hidden from the catalog'] : []),
      ...(row.isDefault ? ['a pre-seeded official source'] : []),
    ].join(' · '),
  }));
}

/**
 * Read the lists the panel shows.
 *
 * The catalog and the marketplace list are the panel's substance; the inventory
 * only adds the capability line, so a Host that cannot serve it is ignored rather
 * than fatal. A catalog read failure throws — there is then no panel to draw.
 */
async function readPanelData(ctx: TuiSlashContext): Promise<PanelData> {
  const client = ctx.client;
  const [catalog, marketplaces, inventory] = await Promise.all([
    client.listPluginCatalog(),
    client.listMarketplaces().catch((error: unknown) => {
      // An empty tab with a named reason is honest; a thrown error would take
      // the whole panel down over one namespace this Host could not read.
      ctx.tui.printError(`Could not read the marketplaces: ${describeError(error)}`);
      return null;
    }),
    client.listPlugins().catch(() => null),
  ]);
  const rows = readArray(catalog.entries)
    .map(narrowCatalogRow)
    .filter((row): row is CatalogRow => row !== undefined);
  return {
    rows,
    marketplaces: marketplaces === null
      ? []
      : readArray(marketplaces.marketplaces)
        .map(narrowMarketplaceRow)
        .filter((row): row is MarketplaceRow => row !== undefined),
    inventory: inventory === null
      ? []
      : readArray(inventory.plugins)
        .map(narrowInventoryEntry)
        .filter((entry): entry is PluginEntry => entry !== undefined),
    revision: catalog.revision,
    ...(marketplaces === null ? { marketplaceError: 'the marketplace list could not be read' } : {}),
  };
}

/** The read-only browser the panel degrades to, one row per installed plugin. */
function readOnlyEntries(plugins: readonly PluginEntry[]): TuiViewEntry[] {
  return plugins.map((entry) => {
    const name = entry.displayName ?? (entry.name !== '' ? entry.name : entry.id);
    const summary = capabilitySummary(entry);
    const description = entry.shortDescription ?? entry.description;
    const prose = entry.longDescription ?? entry.shortDescription ?? entry.description;
    return {
      label: name,
      value: entry.id,
      ...(description === undefined && summary === undefined
        ? {}
        : { description: description ?? summary }),
      valueLabel: entry.installed ? (entry.enabled ? 'on' : 'off') : 'missing',
      ...(summary === undefined && description === undefined
        ? {}
        : { summary: summary ?? description }),
      detailLines: [
        name,
        ...(prose === undefined ? [] : [prose]),
        '',
        `  id          ${entry.id}`,
        `  marketplace ${entry.marketplace !== '' ? entry.marketplace : '(local)'}`,
        `  enabled     ${entry.enabled ? 'yes' : 'no'}`,
        `  installed   ${entry.installed ? 'yes' : 'no'}`,
        ...(summary === undefined ? [] : ['', `  capabilities: ${summary}`]),
        ...(entry.appConnections ?? []).map((appId) => `    app: ${appId}`),
        ...(entry.mcpServers ?? []).map((server) => `    MCP server: ${server}`),
        ...(entry.skillNames ?? []).map((skill) => `    skill: ${skill}`),
        '',
        `  Mention it in a message as @${entry.id || name} to point this turn at it.`,
      ],
    };
  });
}

/**
 * The read-only listing, with the reason the panel is not on screen.
 *
 * The reason is part of the output, not a warning: a person who asked for the
 * marketplace browser needs to know they got the inventory instead.
 */
function showReadOnly(ctx: TuiSlashContext, reason: string): void {
  ctx.client
    .listPlugins()
    .then((payload) => {
      const plugins = readArray((payload as { plugins?: unknown }).plugins)
        .map(narrowInventoryEntry)
        .filter((entry): entry is PluginEntry => entry !== undefined);
      const entries = readOnlyEntries(plugins);
      // The fallback a terminal without a list browser gets has to carry the
      // names, not just a count: `showEntries` renders these lines instead of
      // the rows, so a count alone would answer "what is installed" with "one".
      showEntries(ctx, 'Plugins', entries, [
        plugins.length === 0
          ? 'No plugins are installed.'
          : `${plugins.length} plugin${plugins.length === 1 ? '' : 's'} from the inventory.`,
        '',
        ...entries.map((entry) => `  ${entry.label}  ${entry.valueLabel ?? ''}`.trimEnd()),
        '',
        `  ${reason}`,
      ]);
    })
    .catch((error: unknown) => {
      if (hostErrorCode(error) === 'plugin_inventory_api_unavailable') {
        showPanel(ctx, 'Plugins', [
          'This Host cannot manage plugins, and cannot say what is installed either.',
          '',
          '  404 plugin_management_api_unavailable and 404 plugin_inventory_api_unavailable',
          '  are refusals to answer, not an empty plugin list.',
        ], { footer: READ_ONLY_FOOTER, scrollable: true });
        return;
      }
      ctx.tui.printError(`Could not read the plugin inventory: ${describeError(error)}`);
    });
}

const PLUGIN_COMMAND: TuiSlashCommandDef = {
  name: 'plugin',
  description: 'Browse marketplaces, install and toggle plugins',
  group: 'Session info',
  async run(ctx: TuiSlashContext) {
    const client = ctx.client;
    if (ctx.tui.showRichPanel === undefined) {
      showReadOnly(ctx, 'This terminal has no tabbed panel, so this is the read-only inventory.');
      return { kind: 'handled' };
    }

    let data: PanelData;
    try {
      data = await readPanelData(ctx);
    } catch (error) {
      if (hostErrorCode(error) === 'plugin_management_api_unavailable') {
        showReadOnly(ctx, 'This Host does not serve the plugin management surface.');
        return { kind: 'handled' };
      }
      ctx.tui.printError(`Could not read the plugin catalog: ${describeError(error)}`);
      return { kind: 'handled' };
    }

    /**
     * The live panel and whether the user has left it.
     *
     * Every mutation re-reads and repaints, and a refresh that lands after the
     * panel closed must not reach for a handle the dock no longer holds.
     */
    let panel: RichPanelHandle | null = null;
    let closed = false;

    const findRow = (key: string): CatalogRow | undefined =>
      data.rows.find((row) => rowKey(row) === key);

    /**
     * Re-read and repaint all three tabs.
     *
     * A failed mutation re-reads too: the Host may have written before it
     * refused, and a panel still showing the pre-mutation rows would report a
     * state that is no longer on disk.
     */
    async function refresh(): Promise<void> {
      try {
        data = await readPanelData(ctx);
      } catch (error) {
        if (!closed) {
          ctx.tui.printError(`Could not re-read the plugin catalog: ${describeError(error)}`);
        }
        return;
      }
      if (closed || panel === null) return;
      panel.syncTab('installed', installedSection());
      panel.syncTab('discover', discoverSection());
      panel.syncTab('marketplaces', marketplaceSection());
    }

    /** Run one mutation, refusing while a turn streams. */
    async function mutate(label: string, action: () => Promise<unknown>): Promise<void> {
      if (ctx.busy) {
        ctx.tui.printError(`Cannot ${label} while a turn is streaming — wait for it to settle.`);
        return;
      }
      try {
        await action();
      } catch (error) {
        ctx.tui.printError(`Could not ${label}: ${describeError(error)}`);
        await refresh();
        return;
      }
      await refresh();
    }

    function toggle(key: string): void {
      const row = findRow(key);
      if (row === undefined) return;
      void mutate(`toggle ${rowLabel(row)}`, () =>
        client.setPluginEnabled({
          pluginId: row.pluginId,
          marketplace: row.marketplace,
          enabled: !row.enabled,
          expectedRevision: data.revision,
        }),
      );
    }

    function install(key: string): void {
      const row = findRow(key);
      if (row === undefined) return;
      if (row.installPolicy === 'not_available') {
        ctx.tui.printError(`${rowLabel(row)} is not offered for installation by ${row.marketplace}.`);
        return;
      }
      void mutate(`install ${rowLabel(row)}`, () =>
        client.installPlugin({
          pluginId: row.pluginId,
          marketplace: row.marketplace,
          expectedRevision: data.revision,
        }),
      );
    }

    function uninstall(key: string): void {
      const row = findRow(key);
      if (row === undefined) return;
      void mutate(`uninstall ${rowLabel(row)}`, () =>
        client.removePlugin({
          pluginId: row.pluginId,
          marketplace: row.marketplace,
          expectedRevision: data.revision,
        }),
      );
    }

    function refreshMarketplace(name: string): void {
      void mutate('refresh the marketplace', () =>
        client.refreshMarketplace({ marketplace: name, expectedRevision: data.revision }),
      );
    }

    function addMarketplace(): void {
      if (ctx.tui.promptText === undefined) {
        ctx.tui.printError('This terminal cannot prompt for a marketplace source.');
        return;
      }
      void (async () => {
        const source = await ctx.tui.promptText?.(
          'Add marketplace — git URL, owner/repo, or a local directory',
          { placeholder: 'owner/repo' },
        );
        if (source === null || source === undefined || source.trim() === '') return;
        await mutate('add the marketplace', () =>
          client.addMarketplace({ source: source.trim(), expectedRevision: data.revision }),
        );
      })();
    }

    function removeMarketplace(name: string): void {
      void mutate(`remove ${name}`, () =>
        client.removeMarketplace({ marketplace: name, expectedRevision: data.revision }),
      );
    }

    function installedSection(): RichPanelTab {
      return {
        id: 'installed',
        label: 'Installed',
        footer: INSTALLED_FOOTER,
        items: catalogItems(data.rows.filter((row) => row.installed), data.inventory),
        filterable: true,
        onSubmit: toggle,
        // Tab is the toggle in the list; the letters are the same verbs from
        // the strip, where no filter is eating them.
        rowActions: { tab: toggle, t: toggle, i: install, u: uninstall },
      };
    }

    function discoverSection(): RichPanelTab {
      return {
        id: 'discover',
        label: 'Discover',
        footer: DISCOVER_FOOTER,
        items: catalogItems(
          data.rows.filter((row) => !row.installed && row.installPolicy !== 'not_available'),
          data.inventory,
        ),
        filterable: true,
        onSubmit: install,
        // No `u` here: this tab only lists rows the machine does not have, and
        // uninstalling one of them is a question with no answer.
        rowActions: { i: install },
      };
    }

    function marketplaceSection(): RichPanelTab {
      return {
        id: 'marketplaces',
        label: 'Marketplaces',
        footer: MARKETPLACE_FOOTER,
        items: marketplaceItems(data.marketplaces),
        filterable: true,
        onSubmit: refreshMarketplace,
        rowActions: { r: refreshMarketplace, x: removeMarketplace, a: () => addMarketplace() },
      };
    }

    return ctx.tui
      .showRichPanel({
        title: 'Plugins',
        tabs: [installedSection(), discoverSection(), marketplaceSection()],
        onOpen: (handle) => {
          panel = handle;
        },
        onClose: () => {
          closed = true;
        },
      })
      .then(() => ({ kind: 'handled' as const }));
  },
};

export const PLUGIN_COMMANDS: readonly TuiSlashCommandDef[] = [PLUGIN_COMMAND];
