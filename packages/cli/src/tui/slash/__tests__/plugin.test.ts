/**
 * packages/cli/src/tui/slash/__tests__/plugin.test.ts
 *
 * `/plugin` — the tabbed marketplace browser.
 *
 * ## What these cases pin
 *
 *  1. Three tabs, split by what the Host actually said: `Installed` is the rows
 *     the configuration records, `Discover` is what the marketplaces offer and
 *     this machine does not have, and a row whose marketplace forbids
 *     installation appears in neither action list.
 *
 *  2. Every gesture writes through the Host, with the revision the panel was
 *     drawn from. A toggle that sent the wrong `enabled`, or an install that
 *     dropped `marketplace`, would change a different plugin than the row the
 *     user is standing on.
 *
 *  3. A mutation repaints from a fresh read, and a FAILED mutation repaints too
 *     — the Host may have written before it refused, and a panel still showing
 *     the pre-mutation rows would report a state that is no longer on disk.
 *
 *  4. A turn in flight blocks the writes. The read is harmless; an install that
 *     adds tools mid-turn is not.
 *
 *  5. Degradation tells the truth. A Host that 404s the management surface, or a
 *     terminal with no dock, falls back to the read-only inventory and SAYS it
 *     fell back; a Host that cannot be asked at all is not rendered as a machine
 *     with no plugins.
 *
 * The handler is called directly rather than through the registry: the registry
 * entry is another writer's file, and a test that depended on it would fail here
 * for a reason that has nothing to do with this command.
 */

import { describe, expect, it, vi } from 'vitest';

import type { HostSessionHttpClient } from '@duya/host/http-client';

import { PLUGIN_COMMANDS } from '../plugin.js';
import type { RichPanelHandle } from '../../TUIApp.js';
import type { RichPanelTab, WindowItem } from '../../window.js';
import type { TuiSlashContext, TuiSlashHost } from '../types.js';

const SESSION_ID = 's-plugin-1';

const COMMAND = PLUGIN_COMMANDS[0];
if (COMMAND === undefined) throw new Error('the plugin command is not exported');

function hostError(status: number, code: string): Error {
  return Object.assign(
    new Error(`Duya Host request failed (${status}: ${code})`),
    { status, code },
  );
}

/** One catalog row: a plugin a marketplace offers. */
function catalogRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pluginId: 'com.duya.pdf',
    marketplace: 'duya-plugins',
    name: 'pdf',
    displayName: 'PDF',
    shortDescription: 'Read and verify PDF files',
    version: '1.2.0',
    installPolicy: 'available',
    requiresClone: false,
    installed: true,
    enabled: true,
    ...overrides,
  };
}

function marketplaceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'duya-plugins',
    displayName: 'Duya Plugins',
    kind: 'git',
    url: 'https://github.com/acme/plugins.git',
    hidden: false,
    pluginCount: 2,
    isDefault: false,
    ...overrides,
  };
}

interface PanelCapture {
  readonly title: string;
  readonly tabs: readonly RichPanelTab[];
  /** Every `syncTab` the command performed, in order. */
  readonly syncs: Array<{ tabId: string; items: readonly WindowItem[] }>;
  close(): void;
}

interface HarnessOptions {
  readonly catalog?: unknown;
  readonly marketplaces?: unknown;
  readonly inventory?: unknown;
  readonly catalogError?: Error;
  readonly marketplaceError?: Error;
  readonly inventoryError?: Error;
  readonly mutationError?: Error;
  /** No dock in this terminal: `showRichPanel` is absent. */
  readonly withoutPanel?: boolean;
  readonly promptAnswer?: string | null;
  readonly busy?: boolean;
}

interface Harness {
  readonly notices: string[];
  readonly errors: string[];
  readonly panels: Array<{ title: string; lines: readonly string[] }>;
  readonly panel?: PanelCapture;
  readonly calls: Record<string, unknown[]>;
  readonly run: () => Promise<{ kind: string }>;
  /** Let every queued read, write and repaint settle. */
  readonly flush: () => Promise<void>;
  readonly output: string;
}

function buildHarness(options: HarnessOptions): Harness {
  const notices: string[] = [];
  const errors: string[] = [];
  const panels: Array<{ title: string; lines: readonly string[] }> = [];
  const calls: Record<string, unknown[]> = {
    install: [],
    setEnabled: [],
    remove: [],
    addMarketplace: [],
    removeMarketplace: [],
    refresh: [],
  };
  let capture: PanelCapture | undefined;

  const fail = <T>(error: Error | undefined, value: T): Promise<T> =>
    error === undefined ? Promise.resolve(value) : Promise.reject(error);

  const client = {
    listPluginCatalog: vi.fn(() =>
      fail(options.catalogError, options.catalog ?? {
        entries: [catalogRow()],
        marketplaces: ['duya-plugins'],
        issues: [],
        revision: 'rev-1',
      }),
    ),
    listMarketplaces: vi.fn(() =>
      fail(options.marketplaceError, options.marketplaces ?? {
        marketplaces: [marketplaceRow()],
        revision: 'rev-1',
      }),
    ),
    listPlugins: vi.fn(() =>
      fail(options.inventoryError, options.inventory ?? { plugins: [] }),
    ),
    installPlugin: vi.fn(async (input: unknown) => {
      calls.install?.push(input);
      if (options.mutationError !== undefined) throw options.mutationError;
      return { pluginId: 'com.duya.pdf', marketplace: 'duya-plugins', enabled: true, installed: true, revision: 'rev-2' };
    }),
    setPluginEnabled: vi.fn(async (input: unknown) => {
      calls.setEnabled?.push(input);
      if (options.mutationError !== undefined) throw options.mutationError;
      return { pluginId: 'com.duya.pdf', marketplace: 'duya-plugins', enabled: false, installed: true, revision: 'rev-2' };
    }),
    removePlugin: vi.fn(async (input: unknown) => {
      calls.remove?.push(input);
      return { pluginId: 'com.duya.pdf', marketplace: 'duya-plugins', removedPaths: [], revision: 'rev-2' };
    }),
    addMarketplace: vi.fn(async (input: unknown) => {
      calls.addMarketplace?.push(input);
      return { marketplace: marketplaceRow({ name: 'acme' }), revision: 'rev-2' };
    }),
    removeMarketplace: vi.fn(async (input: unknown) => {
      calls.removeMarketplace?.push(input);
      return { marketplace: marketplaceRow(), revision: 'rev-2' };
    }),
    refreshMarketplace: vi.fn(async (input: unknown) => {
      calls.refresh?.push(input);
      return { outcomes: [{ marketplace: 'duya-plugins' }], revision: 'rev-2' };
    }),
  };

  const tui: TuiSlashHost = {
    printNotice: (text) => { notices.push(text); },
    printError: (text) => { errors.push(text); },
    choose: async () => null,
    showPanel: (title, lines) => { panels.push({ title, lines }); },
    promptText: async () => options.promptAnswer ?? null,
    ...(options.withoutPanel === true
      ? {}
      : {
        showRichPanel: (spec: {
          readonly title: string;
          readonly tabs: readonly RichPanelTab[];
          readonly onOpen?: (panel: RichPanelHandle) => void;
          readonly onClose?: () => void;
        }) => {
          const syncs: PanelCapture['syncs'] = [];
          capture = {
            title: spec.title,
            tabs: spec.tabs,
            syncs,
            close: () => { spec.onClose?.(); },
          };
          const handle = {
            syncTab: (tabId: string, section: { items?: readonly WindowItem[] }) => {
              syncs.push({ tabId, items: section.items ?? [] });
            },
            activeTabId: () => spec.tabs[0]?.id,
            activeSelectedValue: () => spec.tabs[0]?.items?.[0]?.value,
            close: () => { spec.onClose?.(); },
          } as unknown as RichPanelHandle;
          spec.onOpen?.(handle);
          return Promise.resolve();
        },
      }),
  };

  const ctx = {
    client: client as unknown as HostSessionHttpClient,
    session: { id: SESSION_ID },
    tui,
    busy: options.busy ?? false,
  } as unknown as TuiSlashContext;

  const flush = async (): Promise<void> => {
    for (let round = 0; round < 12; round += 1) await Promise.resolve();
  };

  return {
    notices,
    errors,
    panels,
    get panel() { return capture; },
    calls,
    run: () => COMMAND.run(ctx, '') as Promise<{ kind: string }>,
    flush,
    get output() {
      return [
        ...notices,
        ...panels.flatMap((panel) => [panel.title, ...panel.lines]),
        ...errors,
      ].join('\n');
    },
  };
}

/** Open the panel and wait for the first paint to have settled. */
async function open(options: HarnessOptions = {}): Promise<Harness> {
  const harness = buildHarness(options);
  void harness.run();
  await harness.flush();
  return harness;
}

const tab = (harness: Harness, id: string): RichPanelTab | undefined =>
  harness.panel?.tabs.find((candidate) => candidate.id === id);

describe('/plugin', () => {
  it('opens three tabs split by what the Host reported', async () => {
    const harness = await open({
      catalog: {
        entries: [
          catalogRow(),
          catalogRow({ pluginId: 'com.duya.notes', name: 'notes', displayName: 'Notes', installed: false }),
          catalogRow({ pluginId: 'com.duya.locked', name: 'locked', installPolicy: 'not_available', installed: false }),
        ],
        marketplaces: ['duya-plugins'],
        issues: [],
        revision: 'rev-1',
      },
    });

    expect(harness.panel?.title).toBe('Plugins');
    expect(harness.panel?.tabs.map((entry) => entry.id)).toEqual(['installed', 'discover', 'marketplaces']);
    expect(tab(harness, 'installed')?.items?.map((item) => item.value)).toEqual(['com.duya.pdf@duya-plugins']);
    expect(tab(harness, 'discover')?.items?.map((item) => item.value)).toEqual(['com.duya.notes@duya-plugins']);
    expect(tab(harness, 'marketplaces')?.items?.map((item) => item.value)).toEqual(['duya-plugins']);
  });

  it('labels a row with the interface name and explains the selected one', async () => {
    const harness = await open();
    const row = tab(harness, 'installed')?.items?.[0] as WindowItem | undefined;

    expect(row?.label).toBe('PDF');
    expect(row?.valueLabel).toBe('on');
    expect(row?.detail).toContain('version 1.2.0');
    expect(row?.detail).toContain('mention it as @com.duya.pdf');
  });

  it('toggles the highlighted plugin with Tab, at the revision it was read at', async () => {
    const harness = await open();
    tab(harness, 'installed')?.rowActions?.['tab']?.('com.duya.pdf@duya-plugins');
    await harness.flush();

    expect(harness.calls.setEnabled).toEqual([
      {
        pluginId: 'com.duya.pdf',
        marketplace: 'duya-plugins',
        enabled: false,
        expectedRevision: 'rev-1',
      },
    ]);
    // The repaint is the point: a toggle that only changed the file would leave
    // the panel showing `on` for a plugin that is now off.
    const repaint = harness.panel?.syncs.filter((sync) => sync.tabId === 'installed') ?? [];
    expect(repaint.length).toBeGreaterThan(0);
    expect(repaint[repaint.length - 1]?.items[0]?.valueLabel).toBe('on');
  });

  it('installs from Discover and uninstalls from Installed', async () => {
    const harness = await open();
    tab(harness, 'discover')?.rowActions?.['i']?.('com.duya.pdf@duya-plugins');
    await harness.flush();
    expect(harness.calls.install).toEqual([
      { pluginId: 'com.duya.pdf', marketplace: 'duya-plugins', expectedRevision: 'rev-1' },
    ]);

    tab(harness, 'installed')?.rowActions?.['u']?.('com.duya.pdf@duya-plugins');
    await harness.flush();
    expect(harness.calls.remove).toEqual([
      { pluginId: 'com.duya.pdf', marketplace: 'duya-plugins', expectedRevision: 'rev-1' },
    ]);
  });

  it('does not write a row the catalog no longer contains', async () => {
    const harness = await open();
    tab(harness, 'installed')?.rowActions?.['i']?.('com.duya.gone@duya-plugins');
    await harness.flush();

    // The row is not on screen, so there is nothing to say to the user about
    // it — but the silence has to be a refusal, not a write.
    expect(harness.calls.install).toEqual([]);
    expect(harness.errors.join('\n')).toBe('');
  });

  it('refuses to install what the marketplace does not offer', async () => {
    const harness = await open({
      catalog: {
        entries: [catalogRow({ pluginId: 'com.duya.locked', name: 'locked', installPolicy: 'not_available' })],
        marketplaces: ['duya-plugins'],
        issues: [],
        revision: 'rev-1',
      },
    });
    tab(harness, 'installed')?.rowActions?.['i']?.('com.duya.locked@duya-plugins');
    await harness.flush();

    expect(harness.calls.install).toEqual([]);
    expect(harness.errors.join('\n')).toContain('not offered for installation');
  });

  it('adds a marketplace from a typed source and drops the whitespace', async () => {
    const harness = await open({ promptAnswer: '  acme/plugins  ' });
    tab(harness, 'marketplaces')?.rowActions?.['a']?.('duya-plugins');
    await harness.flush();

    expect(harness.calls.addMarketplace).toEqual([
      { source: 'acme/plugins', expectedRevision: 'rev-1' },
    ]);
  });

  it('does nothing when the marketplace prompt is dismissed', async () => {
    const harness = await open({ promptAnswer: null });
    tab(harness, 'marketplaces')?.rowActions?.['a']?.('duya-plugins');
    await harness.flush();

    expect(harness.calls.addMarketplace).toEqual([]);
  });

  it('refreshes the selected marketplace and removes it by name', async () => {
    const harness = await open();
    tab(harness, 'marketplaces')?.onSubmit?.('duya-plugins');
    await harness.flush();
    expect(harness.calls.refresh).toEqual([
      { marketplace: 'duya-plugins', expectedRevision: 'rev-1' },
    ]);

    tab(harness, 'marketplaces')?.rowActions?.['x']?.('duya-plugins');
    await harness.flush();
    expect(harness.calls.removeMarketplace).toEqual([
      { marketplace: 'duya-plugins', expectedRevision: 'rev-1' },
    ]);
  });

  it('repaints after a refused write, because the file may have moved anyway', async () => {
    const harness = await open({ mutationError: hostError(409, 'plugin_revision_conflict') });
    expect(harness.panel?.syncs).toHaveLength(0);

    tab(harness, 'installed')?.rowActions?.['tab']?.('com.duya.pdf@duya-plugins');
    await harness.flush();

    expect(harness.errors.join('\n')).toContain('Could not toggle PDF');
    expect(harness.errors.join('\n')).toContain('plugin_revision_conflict');
    expect(harness.panel?.syncs.map((sync) => sync.tabId)).toEqual([
      'installed',
      'discover',
      'marketplaces',
    ]);
  });

  it('stops repainting once the user has left the panel', async () => {
    const harness = await open();
    harness.panel?.close();
    const synced = harness.panel?.syncs.length ?? 0;

    tab(harness, 'installed')?.rowActions?.['tab']?.('com.duya.pdf@duya-plugins');
    await harness.flush();

    // The write itself still goes through — leaving the panel is not undoing
    // the gesture the user made before leaving.
    expect(harness.calls.setEnabled).toHaveLength(1);
    expect(harness.panel?.syncs).toHaveLength(synced);
  });

  it('blocks the writes while a turn streams but keeps the read', async () => {
    const harness = await open({ busy: true });
    expect(harness.panel).toBeDefined();

    tab(harness, 'installed')?.rowActions?.['tab']?.('com.duya.pdf@duya-plugins');
    await harness.flush();

    expect(harness.calls.setEnabled).toEqual([]);
    expect(harness.errors.join('\n')).toContain('while a turn is streaming');
  });

  it('falls back to the inventory and says it fell back when the Host has no management surface', async () => {
    const harness = await open({
      catalogError: hostError(404, 'plugin_management_api_unavailable'),
      inventory: { plugins: [{ id: 'com.duya.pdf', name: 'pdf', displayName: 'PDF', enabled: true, marketplace: 'duya-plugins', installed: true }] },
    });

    const body = harness.panels.map((panel) => panel.lines.join('\n')).join('\n');
    expect(body).toContain('does not serve the plugin management surface');
    expect(body).toContain('1 plugin');
    expect(body).toContain('PDF');
  });

  it('names the reason when even the inventory refuses to answer', async () => {
    const harness = await open({
      catalogError: hostError(404, 'plugin_management_api_unavailable'),
      inventoryError: hostError(404, 'plugin_inventory_api_unavailable'),
    });

    const body = harness.panels.map((panel) => panel.lines.join('\n')).join('\n');
    expect(body).toContain('cannot manage plugins');
    expect(body).not.toContain('No plugins');
  });

  it('reports a catalog read that failed for another reason as an error', async () => {
    const harness = await open({ catalogError: hostError(500, 'plugin_config_unwritable') });

    expect(harness.errors.join('\n')).toContain('Could not read the plugin catalog');
    expect(harness.panel).toBeUndefined();
  });

  it('opens without the marketplace list rather than losing the panel', async () => {
    const harness = await open({ marketplaceError: hostError(500, 'plugin_config_unwritable') });

    expect(harness.panel).toBeDefined();
    expect(tab(harness, 'marketplaces')?.items).toEqual([]);
    expect(harness.errors.join('\n')).toContain('Could not read the marketplaces');
  });

  it('reads the inventory as decoration only, so its absence is not an error', async () => {
    const harness = await open({ inventoryError: hostError(404, 'plugin_inventory_api_unavailable') });

    expect(harness.panel).toBeDefined();
    expect(harness.errors).toEqual([]);
    expect(tab(harness, 'installed')?.items?.[0]?.detail).not.toContain('capabilities');
  });

  it('adds the component counts the inventory says the plugin brings', async () => {
    const harness = await open({
      inventory: {
        plugins: [{
          id: 'com.duya.pdf',
          name: 'pdf',
          enabled: true,
          marketplace: 'duya-plugins',
          installed: true,
          mcpServers: ['pdf-tools'],
          skillNames: ['read', 'verify'],
        }],
      },
    });

    const detail = tab(harness, 'installed')?.items?.[0]?.detail ?? '';
    expect(detail).toContain('capabilities: 1 MCP server · 2 skills');
  });

  it('keeps a malformed catalog record from taking the panel down', async () => {
    const harness = await open({
      catalog: {
        entries: [catalogRow(), 'not-a-record', null, { name: 'no id' }],
        marketplaces: ['duya-plugins'],
        issues: [],
        revision: 'rev-1',
      },
    });

    expect(tab(harness, 'installed')?.items).toHaveLength(1);
  });

  it('stays a read-only listing when the terminal has no dock', async () => {
    const harness = await open({
      withoutPanel: true,
      inventory: { plugins: [{ id: 'com.duya.pdf', name: 'pdf', displayName: 'PDF', enabled: true, marketplace: 'duya-plugins', installed: true }] },
    });

    const body = harness.panels.map((panel) => panel.lines.join('\n')).join('\n');
    expect(body).toContain('no tabbed panel');
    expect(body).toContain('1 plugin');
  });
});
