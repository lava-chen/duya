/**
 * packages/cli/src/tui/slash/__tests__/display.test.ts
 *
 * `/display` — the transcript shape menu.
 *
 * ## What these cases pin
 *
 *  1. The list names the four profiles and then shows the same switches
 *     `/settings` shows, taken from the same row objects rather than
 *     re-described — two menus that disagree about `Tool groups` is the failure
 *     this file exists to prevent.
 *
 *  2. Choosing a profile writes ALL FOUR keys and patches the renderer with the
 *     same vector. A delta write would leave a stale fourth key behind.
 *
 *  3. `Current` is derived from the live vector, so a hand-tuned transcript
 *     marks nothing.
 *
 *  4. The arg form and the headless form reach the same state as the list.
 *
 * The handler is called directly rather than through the registry, like the
 * other command files here.
 */

import { describe, expect, it, vi } from 'vitest';

import type { HostSessionHttpClient } from '@duya/host/http-client';

import { DISPLAY_COMMANDS, displayRows } from '../display.js';
import { SettingsState } from '../settings.js';
import type { TuiSlashContext, TuiSlashHost } from '../types.js';
import type { TuiSettingsRow } from '../../TUIApp.js';
import { parseTuiPreferences, DEFAULT_TUI_PREFERENCES, type TuiPreferences } from '../../preferences.js';
import type { ToolGroupMode } from '../../transcript-view.js';

const COMMAND = DISPLAY_COMMANDS[0];
if (COMMAND === undefined) throw new Error('the display command is not exported');

/** What a live TUI reports back through `liveTuiPreferences`. */
interface LiveVector {
  readonly theme: string;
  readonly showThinking: boolean;
  readonly expandBlocks: boolean;
  readonly showToolResults: boolean;
  readonly toolGroupMode: ToolGroupMode;
  readonly completionRows: number;
  readonly inputRows: number;
}

interface Harness {
  readonly notices: string[];
  readonly errors: string[];
  readonly saved: Array<[string, string]>;
  readonly patches: Array<Record<string, unknown>>;
  readonly rows: readonly TuiSettingsRow[];
}

/**
 * Run the command against a settings endpoint and a live list.
 *
 * `activations` are fed to `onActivate` in order, which is how the list is
 * actually driven: one Enter per row, the list repainted between them.
 */
async function run(options: {
  readonly settings?: Readonly<Record<string, string>>;
  readonly args?: string;
  readonly activations?: readonly string[];
  /** A host with no live list: the headless shape. */
  readonly withoutList?: boolean;
  readonly choice?: string | null;
  readonly live?: LiveVector;
}): Promise<Harness> {
  const notices: string[] = [];
  const errors: string[] = [];
  const saved: Array<[string, string]> = [];
  const patches: Array<Record<string, unknown>> = [];
  let lastRows: readonly TuiSettingsRow[] = [];

  const live = options.live ?? liveVector();
  const client = {
    getSettings: vi.fn(async () => options.settings ?? {}),
    setSetting: vi.fn(async (key: string, value: string) => {
      saved.push([key, value]);
      return { key, value };
    }),
  };
  const tui: TuiSlashHost = {
    printNotice: (text) => { notices.push(text); },
    printError: (text) => { errors.push(text); },
    choose: async () => options.choice ?? null,
    ...(options.withoutList === true ? {} : {
      openSettings: async (open: { readonly rows: readonly TuiSettingsRow[]; readonly onActivate: (id: string) => readonly TuiSettingsRow[] | void }) => {
        lastRows = open.rows;
        for (const id of options.activations ?? []) lastRows = open.onActivate(id) ?? lastRows;
      },
    }),
    applyTuiPreferences: (patch) => { patches.push(patch as Record<string, unknown>); },
    liveTuiPreferences: () => live,
    refresh: () => {},
  };
  const ctx = {
    client: client as unknown as HostSessionHttpClient,
    session: { id: 's-display-1', model: 'm-1' },
    tui,
    busy: false,
  } as unknown as TuiSlashContext;

  await COMMAND.run(ctx, options.args ?? '');

  return { notices, errors, saved, patches, rows: lastRows };
}

/** The live vector a normal TUI reports: the saved defaults, nothing tuned. */
function liveVector(preferences: TuiPreferences = DEFAULT_TUI_PREFERENCES): LiveVector {
  return {
    theme: preferences.theme,
    showThinking: preferences.showThinking,
    expandBlocks: preferences.expandBlocks,
    showToolResults: preferences.showToolResults,
    toolGroupMode: preferences.toolGroupMode,
    completionRows: preferences.completionRows,
    inputRows: preferences.inputRows,
  };
}

describe('/display', () => {
  it('lists the four profiles and then the transcript switches', async () => {
    const harness = await run({});
    expect(harness.rows.map((row) => row.id)).toEqual([
      'detailed',
      'standard',
      'compact',
      'running',
      'show-thinking',
      'expand-blocks',
      'tool-results',
      'tool-groups',
    ]);
  });

  it('marks the profile the live vector actually is', async () => {
    const harness = await run({});
    const marked = harness.rows.filter((row) => row.valueLabel === 'Current').map((row) => row.id);
    expect(marked).toEqual(['standard']);
  });

  it('marks no profile once a switch has been moved by hand', async () => {
    // The row reports what is ON SCREEN, so a live vector that matches no
    // profile marks none of them — not the saved one that still says standard.
    const harness = await run({
      live: { ...liveVector(), showToolResults: true },
    });
    expect(harness.rows.filter((row) => row.valueLabel === 'Current')).toEqual([]);
  });

  it('applies a profile as all four keys and one live patch', async () => {
    const harness = await run({ activations: ['compact'] });
    expect(Object.fromEntries(harness.saved)).toEqual({
      'cli.tui.showThinking': 'false',
      'cli.tui.expandBlocks': 'false',
      'cli.tui.showToolResults': 'false',
      'cli.tui.toolGroupMode': 'names',
    });
    expect(harness.patches.at(-1)).toMatchObject({
      showThinking: false,
      expandBlocks: false,
      showToolResults: false,
      toolGroupMode: 'names',
    });
    // And the list now reports itself: the row the user just chose is current.
    expect(harness.rows.filter((row) => row.valueLabel === 'Current').map((row) => row.id)).toEqual(['compact']);
  });

  it('cycles a switch row through one key without touching the others', async () => {
    const harness = await run({ activations: ['tool-groups'] });
    expect(harness.saved).toEqual([['cli.tui.toolGroupMode', 'names']]);
    const row = harness.rows.find((entry) => entry.id === 'tool-groups');
    expect(row?.valueLabel).toBe('Names only');
  });

  it('applies the arg form without opening the list', async () => {
    const harness = await run({ args: 'running' });
    expect(harness.saved.map(([key]) => key).sort()).toEqual([
      'cli.tui.expandBlocks',
      'cli.tui.showThinking',
      'cli.tui.showToolResults',
      'cli.tui.toolGroupMode',
    ]);
    expect(harness.notices.join('\n')).toContain('Live only');
  });

  it('rejects an unknown profile and writes nothing', async () => {
    const harness = await run({ args: 'quiet' });
    expect(harness.saved).toEqual([]);
    expect(harness.notices.join('\n')).toContain('Unknown display profile');
  });

  it('offers the profiles on a host with no live list', async () => {
    const harness = await run({ withoutList: true, choice: 'detailed' });
    expect(Object.fromEntries(harness.saved)).toMatchObject({ 'cli.tui.toolGroupMode': 'full' });
    expect(harness.saved).toHaveLength(4);
    expect(harness.patches.at(-1)).toMatchObject({ showThinking: true, expandBlocks: true });
  });

  it('reads the rows from the same state the settings menu uses', () => {
    const state = new SettingsState(parseTuiPreferences({}), liveVector(), 'm-1');
    const ids = displayRows(state).map((row) => row.id);
    // The four switch rows must be the settings menu's own, in its order.
    expect(ids.slice(4)).toEqual(['show-thinking', 'expand-blocks', 'tool-results', 'tool-groups']);
  });
});
