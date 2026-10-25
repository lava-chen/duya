/**
 * packages/cli/src/tui/slash/__tests__/plugin.test.ts
 *
 * `/plugin` — the plugins installed on this machine.
 *
 * ## What these cases pin
 *
 *  1. Every plugin is listed with its name, marketplace, enabled state and
 *     whether its package was actually found on disk.
 *
 *  2. A plugin that is registered but whose package is gone is reported as
 *     a broken install, not as a missing one.
 *
 *  3. "No plugins" and "this Host cannot answer" are different facts and are
 *     rendered differently. A Host that answers 404
 *     `plugin_inventory_api_unavailable` must NOT be shown an empty
 *     inventory: the question was never asked of an authority that could
 *     answer it.
 *
 *  4. A client without the inventory method says so instead of crashing.
 *
 *  5. A payload that is not an inventory is an error, not an empty list.
 *
 * The handler is called directly rather than through the registry: the
 * registry entry is another writer's file, and a test that depended on it
 * would fail here for a reason that has nothing to do with this command.
 */

import { describe, expect, it, vi } from 'vitest';

import type { HostSessionHttpClient } from '@duya/host/http-client';

import { PLUGIN_COMMANDS } from '../plugin.js';
import type { TuiSlashContext, TuiSlashHost } from '../types.js';

const SESSION_ID = 's-plugin-1';

const COMMAND = PLUGIN_COMMANDS[0];
if (COMMAND === undefined) throw new Error('the plugin command is not exported');

/** A Host HTTP error, shaped like the one the client throws. */
function hostError(status: number, code: string): Error {
  return Object.assign(
    new Error(`Duya Host request failed (${status}: ${code})`),
    { status, code },
  );
}

interface Harness {
  readonly notices: string[];
  readonly errors: string[];
  readonly panels: Array<{ title: string; lines: readonly string[] }>;
  /** Everything the command put on the screen, in one string. */
  readonly output: string;
}

/** Run `/plugin` against a client whose inventory read answers or fails. */
async function run(options: {
  readonly inventory?: unknown;
  readonly error?: Error;
  /** A client that has no inventory method at all. */
  readonly withoutMethod?: boolean;
  readonly busy?: boolean;
}): Promise<Harness> {
  const notices: string[] = [];
  const errors: string[] = [];
  const panels: Array<{ title: string; lines: readonly string[] }> = [];

  const client = options.withoutMethod === true
    ? {}
    : {
      listPlugins: vi.fn(async () => {
        if (options.error !== undefined) throw options.error;
        return options.inventory ?? { plugins: [] };
      }),
    };
  const tui: TuiSlashHost = {
    printNotice: (text) => { notices.push(text); },
    printError: (text) => { errors.push(text); },
    choose: async () => null,
    showPanel: (title: string, lines: readonly string[]) => { panels.push({ title, lines }); },
  };
  const ctx = {
    client: client as unknown as HostSessionHttpClient,
    session: { id: SESSION_ID },
    tui,
    busy: options.busy ?? false,
  } as unknown as TuiSlashContext;

  await COMMAND.run(ctx, '');

  return {
    notices,
    errors,
    panels,
    output: [
      ...notices,
      ...panels.flatMap((panel) => [panel.title, ...panel.lines]),
      ...errors,
    ].join('\n'),
  };
}

/** One installed plugin. */
function plugin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p-1',
    name: 'duya-git',
    enabled: true,
    marketplace: 'duya-plugins',
    installed: true,
    ...overrides,
  };
}

describe('/plugin', () => {
  it('lists every plugin with its marketplace, state and package state', async () => {
    const harness = await run({
      inventory: {
        plugins: [
          plugin(),
          plugin({ id: 'p-2', name: 'notes', marketplace: 'local', enabled: false }),
        ],
      },
    });

    expect(harness.panels).toHaveLength(1);
    expect(harness.panels[0]?.title).toBe('Plugins');
    const body = harness.panels[0]?.lines.join('\n') ?? '';
    expect(body).toContain('2 plugins');
    expect(body).toContain('duya-git');
    expect(body).toContain('duya-plugins');
    expect(body).toContain('notes');
    expect(body).toContain('local');
    // The enabled column says no for the disabled plugin and yes for the
    // other one — the two cells differ, so a wrong column cannot pass.
    expect(body).toMatch(/duya-git\s+duya-plugins\s+yes\s+yes/);
    expect(body).toMatch(/notes\s+local\s+no\s+yes/);
  });

  it('says an empty inventory is an empty inventory', async () => {
    const harness = await run({ inventory: { plugins: [] } });

    const body = harness.panels[0]?.lines.join('\n') ?? '';
    expect(body).toContain('No plugins are installed.');
    expect(harness.output).not.toContain('cannot answer');
  });

  it('tells a Host that cannot answer apart from one with no plugins', async () => {
    const harness = await run({
      error: hostError(404, 'plugin_inventory_api_unavailable'),
    });

    const body = harness.panels[0]?.lines.join('\n') ?? '';
    expect(body).toContain('This Host does not serve the plugin inventory, so it cannot answer.');
    expect(body).toContain('plugin_inventory_api_unavailable');
    expect(body).not.toContain('No plugins are installed.');
  });

  it('reports a registered plugin whose package is gone as a broken install', async () => {
    const harness = await run({
      inventory: { plugins: [plugin({ id: 'p-2', name: 'ghost', installed: false })] },
    });

    const body = harness.panels[0]?.lines.join('\n') ?? '';
    expect(body).toContain('ghost');
    expect(body).toContain('not found on disk');
  });

  it('says so when the client has no inventory method', async () => {
    const harness = await run({ withoutMethod: true });

    expect(harness.errors.join('\n')).toContain('does not offer the inventory route');
    expect(harness.panels).toHaveLength(0);
  });

  it('reports a payload that is not an inventory as an error', async () => {
    const harness = await run({ inventory: { nothing: true } });

    expect(harness.errors.join('\n')).toContain('is not an inventory');
    expect(harness.panels).toHaveLength(0);
  });

  it('keeps a malformed record from taking the listing down', async () => {
    const harness = await run({
      inventory: { plugins: [plugin(), 'not-a-record', null] },
    });

    const body = harness.panels[0]?.lines.join('\n') ?? '';
    expect(body).toContain('1 plugin');
    expect(body).toContain('duya-git');
  });

  it('reads while a turn is streaming', async () => {
    const harness = await run({ inventory: { plugins: [plugin()] }, busy: true });

    expect(harness.errors).toEqual([]);
    expect(harness.panels).toHaveLength(1);
  });
});
