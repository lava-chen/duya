/**
 * packages/cli/src/tui/slash/__tests__/interactive-list.test.ts
 *
 * The interactive list the view commands (`/plugin` `/apps` `/skills` `/mcp`)
 * render when the host offers the browser methods.
 *
 * ## What these cases pin
 *
 *  1. The list opens with one selectable row per entry, carrying the right
 *     state column and the per-row summary. A plugin row LABELS with its
 *     interface display name and DESCRIBES with its short description,
 *     while the row's value (the mention token) stays the plugin id.
 *
 *  2. Enter opens the selected entry's DETAIL page; the detail page's Esc
 *     (`onBack`) re-opens the list ON THE ROW THAT OPENED THE DETAIL — the
 *     browser cycle, not a picker.
 *
 *  3. The detail page carries the facts a detail page exists for: a plugin's
 *     component summaries and its mention form, a connection's scopes and
 *     last error.
 *
 * The harness supplies the two optional methods directly; the commands'
 * fallback (no methods → static panel) is what the sibling command tests
 * already pin, so it is not repeated here.
 */

import { describe, expect, it, vi } from 'vitest';

import { PLUGIN_COMMANDS } from '../plugin.js';
import { APPS_COMMANDS } from '../apps.js';
import type { HostSessionHttpClient } from '@duya/host/http-client';
import type { TuiSlashContext, TuiSlashHost } from '../types.js';
import type { WindowItem } from '../../window.js';

const PLUGIN_COMMAND = PLUGIN_COMMANDS[0];
if (PLUGIN_COMMAND === undefined) throw new Error('the plugin command is not exported');
const APPS_COMMAND = APPS_COMMANDS[0];
if (APPS_COMMAND === undefined) throw new Error('the apps command is not exported');

interface ListHarness {
  readonly ctx: TuiSlashContext;
  readonly lists: Array<{ title: string; items: readonly WindowItem[]; options: { readonly initialSelected?: number } }>;
  readonly details: Array<{ title: string; lines: readonly string[] }>;
  /** Leave the CURRENT detail page (the Esc path). */
  readonly back: () => void;
  /** Enter on the list's currently selected row (the command tracks rows itself). */
  readonly enter: (value: string) => void;
}

/** A TuiSlashHost with the browser methods, recording what the command opened. */
function interactiveHarness(payload: { plugins?: unknown; connections?: unknown }): ListHarness {
  const lists: ListHarness['lists'] = [];
  const details: ListHarness['details'] = [];
  let currentEnter: ((value: string) => void) | undefined;
  let currentBack: (() => void) | undefined;

  const tui: TuiSlashHost = {
    printNotice: () => undefined,
    printError: () => undefined,
    choose: async () => null,
    showListPanel: (title, items, options = {}) => {
      lists.push({ title, items, options });
      currentEnter = options.onEnter;
    },
    showDetailPanel: (title, lines, options = {}) => {
      details.push({ title, lines });
      currentBack = options.onBack;
    },
  };

  const client = {
    listPlugins: async () => payload.plugins ?? { plugins: [] },
    listAppConnections: async () => payload.connections ?? [],
  } as unknown as HostSessionHttpClient;

  return {
    ctx: { client, session: { id: 's-list-1' } as TuiSlashContext['session'], tui, busy: false },
    lists,
    details,
    back: () => currentBack?.(),
    enter: (value) => currentEnter?.(value),
  };
}

describe('the interactive view lists', () => {
  it('lists plugins with their state and opens the detail page on Enter', async () => {
    const harness = interactiveHarness({
      plugins: {
        plugins: [
          {
            id: 'com.duya.documents',
            name: 'com.duya.documents',
            displayName: 'Documents',
            shortDescription: 'Document workflows at a glance',
            longDescription: 'A long-form description of the document plugin.',
            enabled: true,
            marketplace: 'official',
            installed: true,
            description: 'Short registry blurb',
            appConnections: ['slack'],
            mcpServers: ['documents'],
            skillNames: ['doc-review'],
          },
          {
            id: 'com.duya.broken',
            name: 'Broken',
            enabled: true,
            marketplace: 'official',
            installed: false,
          },
        ],
      },
    });

    await PLUGIN_COMMAND.run(harness.ctx, '');

    expect(harness.lists).toHaveLength(1);
    const list = harness.lists[0]!;
    expect(list.title).toBe('Plugins');
    // Rows read like the product, not the package: the display name is what
    // the user sees, while the row's VALUE (the mention token) stays the id.
    expect(list.items.map((item) => item.label)).toEqual(['Documents', 'Broken']);
    expect(list.items.map((item) => item.valueLabel)).toEqual(['on', 'missing']);
    expect(list.items[0]?.description).toContain('Document workflows at a glance');
    expect(list.items[0]?.description).not.toContain('Short registry blurb');

    harness.enter('com.duya.documents');
    expect(harness.details).toHaveLength(1);
    const detail = harness.details[0]!;
    expect(detail.title).toBe('Plugins · Documents');
    const body = detail.lines.join('\n');
    expect(body).toContain('A long-form description of the document plugin.');
    expect(body).not.toContain('Short registry blurb');
    expect(body).toContain('app: slack');
    expect(body).toContain('MCP server: documents');
    expect(body).toContain('skill: doc-review');
    expect(body).toContain('@com.duya.documents');
  });

  it('returns from a detail page to the list on the row that opened it', async () => {
    const harness = interactiveHarness({
      plugins: {
        plugins: [
          { id: 'a', name: 'Alpha', enabled: true, marketplace: 'm', installed: true },
          { id: 'b', name: 'Beta', enabled: false, marketplace: 'm', installed: true },
        ],
      },
    });
    await PLUGIN_COMMAND.run(harness.ctx, '');

    harness.enter('b');
    expect(harness.details).toHaveLength(1);
    harness.back();

    expect(harness.lists).toHaveLength(2);
    expect(harness.lists[1]!.options.initialSelected).toBe(1);
  });

  it('lists app connections with scopes in the detail page', async () => {
    const harness = interactiveHarness({
      connections: [
        {
          provider: 'slack',
          accountLabel: 'acme workspace',
          accountId: 'T123',
          status: 'connected',
          scopes: ['chat:write', 'channels:read'],
          lastError: null,
        },
        {
          provider: 'google',
          accountLabel: '',
          accountId: 'user@gmail.com',
          status: 'error',
          scopes: [],
          lastError: 'token expired',
        },
      ],
    });

    await APPS_COMMAND.run(harness.ctx, '');

    const list = harness.lists[0]!;
    expect(list.title).toBe('App connections');
    expect(list.items.map((item) => item.valueLabel)).toEqual(['connected', 'error']);

    harness.enter('google:user@gmail.com');
    const body = harness.details[0]!.lines.join('\n');
    expect(body).toContain('token expired');
    expect(body).toContain('(none granted)');
  });
});
