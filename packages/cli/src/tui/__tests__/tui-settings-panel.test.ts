/**
 * `/settings` against the real TUI.
 *
 * The point of these is the shape, not the storage: the list has to paint a
 * value column and a selected-row explanation in the composer's slot, and Enter
 * has to change the value where the user is looking rather than walk them into
 * a second menu. Both were the reasons the old menu of menus felt nothing like
 * pi's settings.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'node:stream';

import { TUIApp } from '../TUIApp.js';
import { resolveTuiSlashCommand } from '../slash/index.js';
import { detectTerminalEnvironment, type TerminalEnvironment } from '../terminal-env.js';
import { press } from './key-injection.js';

const ALT_BUFFER_ON = '\x1b[?1049h';
const plain = (value: string): string => value.replace(/\{[^}]*\}/gu, '');

/**
 * A terminal that can render the light palette, so a theme assertion is about
 * the switch and not about whatever `TERM` the test runner inherited.
 */
function richTerminal(): TerminalEnvironment {
  return detectTerminalEnvironment({ TERM: 'xterm-256color', COLORTERM: 'truecolor' } as NodeJS.ProcessEnv);
}

function makeApp(
  options: { readonly terminalEnv?: TerminalEnvironment } = {},
): { app: TUIApp; out: () => string; input: PassThrough } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  (stream as unknown as { columns: number }).columns = 100;
  (stream as unknown as { rows: number }).rows = 30;
  const input = new PassThrough();
  const app = new TUIApp({
    output: stream,
    input,
    inline: true,
    theme: 'dark',
    terminalEnv: options.terminalEnv ?? richTerminal(),
    modelLabel: () => ({ provider: 'deepseek', model: 'deepseek-flash' }),
    onSubmit: () => {},
  });
  return {
    app,
    out: () => Buffer.concat(chunks).toString('utf8'),
    input,
  };
}

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 60));
};

const SESSION = { id: 's1', providerId: 'deepseek', model: 'deepseek-flash' };

/**
 * Just the three Host calls `/settings` makes, and nothing else.
 *
 * A fuller stub would let the command start depending on a fourth call without
 * this test noticing, which is how a menu quietly turns into something that
 * needs the whole client to open.
 */
function client(saved: Readonly<Record<string, string>> = {}) {
  const store: Record<string, string> = { ...saved };
  const calls: Array<readonly [string, string]> = [];
  return {
    saved: store,
    calls,
    getSettings: async () => ({ ...store }),
    setSetting: async (key: string, value: string) => {
      calls.push([key, value]);
      store[key] = value;
    },
    getProviderModelCapability: async () => null,
  };
}

describe('/settings in the TUI', () => {
  it('paints one list with a value column, an explanation, and filtering', async () => {
    const { app, out, input } = makeApp();
    app.start();
    await settle();

    const command = resolveTuiSlashCommand('settings');
    if (command === undefined) throw new Error('/settings is not registered');
    const running = command.run({ client: client() as never, session: SESSION as never, tui: app, busy: false }, '');
    await settle();

    // The SELECTED row explains itself, and the panel prints only that row's
    // detail. Language is the first row; Theme is the one the assertion is
    // about — it switched in place, so a panel that still promised a restart
    // would be a regression disguised as a passing test.
    press(input, 'down');
    await settle();

    const panel = (app as unknown as { inlineInputLines: string[] }).inlineInputLines.map(plain).join('\n');
    // Values are on the row, not hidden behind a submenu.
    expect(panel).toContain('Theme');
    expect(panel).toContain('Match terminal');
    expect(panel).toContain('Reasoning effort');
    expect(panel).toContain('Completion rows');
    expect(panel).toContain('8 rows');
    expect(panel).toContain('Switches immediately');
    expect(panel).not.toContain('Applies on the next launch');
    expect(panel).toContain('type to filter');
    expect(out()).not.toContain(ALT_BUFFER_ON);

    press(input, 'escape');
    await running;
    app.stop();
  });

  it('reports the theme it fell back to, not the one that was asked for', async () => {
    // A light theme on a 16-colour terminal falls back to dark. The row must
    // say `dark`: a menu that claims `light` while the screen paints dark is
    // the exact "one value stored, two places believed" failure.
    const { app } = makeApp({
      terminalEnv: { ...richTerminal(), supportsLightPalette: false },
    });
    app.start();
    await settle();

    app.setTheme('light');
    expect(app.activeThemeName()).toBe('dark');
    expect(app.liveTuiPreferences().theme).toBe('dark');
    app.stop();
  });

  it('cycles a row in place and saves it without closing the list', async () => {
    const { app, input } = makeApp();
    app.start();
    await settle();

    const command = resolveTuiSlashCommand('settings');
    if (command === undefined) throw new Error('/settings is not registered');
    const fake = client();
    const running = command.run({ client: fake as never, session: SESSION as never, tui: app, busy: false }, '');
    await settle();

    // Theme is the second row (Language is the first), saved as `system`:
    // one Enter is `dark`.
    press(input, 'down');
    await settle();
    press(input, 'return');
    await settle();
    expect(fake.calls).toEqual([['cli.tui.theme', 'dark']]);

    const panel = (app as unknown as { inlineInputLines: string[] }).inlineInputLines.map(plain).join('\n');
    expect(panel).toContain('Dark');
    // Still open: a settings list you have to leave to change a second value
    // is the menu of menus again.
    expect((app as unknown as { windowMgr: { isActive: boolean } }).windowMgr.isActive).toBe(true);

    // And the switch reached the SCREEN, not just the row: `dark` was already
    // in force, so the claim is only worth anything on the next step.
    expect(app.activeThemeName()).toBe('dark');
    press(input, 'return');
    await settle();
    expect(app.activeThemeName()).toBe('light');
    expect(app.liveTuiPreferences().theme).toBe('light');

    press(input, 'escape');
    await running;
    app.stop();
  });

  it('moves a transcript preference live and tells the TUI about it', async () => {
    const { app, input } = makeApp();
    app.start();
    await settle();
    expect(app.liveTuiPreferences().showThinking).toBe(true);

    const command = resolveTuiSlashCommand('settings');
    if (command === undefined) throw new Error('/settings is not registered');
    const fake = client();
    const running = command.run({ client: fake as never, session: SESSION as never, tui: app, busy: false }, '');
    await settle();

    // Row six is Thinking blocks: language, theme, display mode, effort,
    // per-model effort, then it. The count is the assertion — a row inserted
    // above this one silently moves this test onto the wrong switch.
    for (let step = 0; step < 5; step += 1) press(input, 'down');
    await settle();
    press(input, 'return');
    await settle();

    expect(fake.calls).toEqual([['cli.tui.showThinking', 'false']]);
    expect(app.liveTuiPreferences().showThinking).toBe(false);

    press(input, 'escape');
    await running;
    app.stop();
  });
});

describe('/settings per-model effort', () => {
  /** Row five: language, theme, display mode, effort, then this one. */
  async function openOnModelEffort(saved: Readonly<Record<string, string>> = {}) {
    const { app, input } = makeApp();
    app.start();
    await settle();
    const command = resolveTuiSlashCommand('settings');
    if (command === undefined) throw new Error('/settings is not registered');
    const fake = client(saved);
    const running = command.run({ client: fake as never, session: SESSION as never, tui: app, busy: false }, '');
    await settle();
    return {
      app,
      fake,
      input,
      panel: () => (app as unknown as { inlineInputLines: string[] }).inlineInputLines.map(plain).join('\n'),
      close: async () => {
        press(input, 'escape');
        await running;
        app.stop();
      },
    };
  }

  it('names the model and says it follows the default until told otherwise', async () => {
    const open = await openOnModelEffort({ 'cli.tui.effort': 'high' });
    expect(open.panel()).toContain('Effort · deepseek-flash');
    expect(open.panel()).toContain('Follows default · High');
    await open.close();
  });

  it('writes one JSON key, not a per-model setting that could never be listed', async () => {
    const open = await openOnModelEffort();
    for (let step = 0; step < 4; step += 1) press(open.input, 'down');
    await settle();
    press(open.input, 'return');
    await settle();

    // `auto` → `low`, and the whole map under one key: the settings endpoint
    // is a flat string map, so a `cli.tui.effort.<model>` key could be written
    // but never enumerated — and an override you cannot list is one you cannot
    // clear.
    expect(open.fake.calls).toEqual([['cli.tui.effortByModel', '{"deepseek-flash":"low"}']]);
    expect(open.panel()).toContain('Low');
    await open.close();
  });

  it('clears the override by cycling back to auto, and says so on the global row', async () => {
    const open = await openOnModelEffort({
      'cli.tui.effort': 'low',
      'cli.tui.effortByModel': '{"deepseek-flash":"high"}',
    });
    // The global row explains itself, and the panel only prints the SELECTED
    // row's detail — so walk down to it before reading its explanation. Two
    // effort rows showing different values with no note reads as a menu that
    // disagrees with itself.
    for (let step = 0; step < 3; step += 1) press(open.input, 'down');
    await settle();
    expect(open.panel()).toContain('overrides it with High');

    press(open.input, 'down');
    await settle();
    // high → max
    press(open.input, 'return');
    await settle();
    expect(open.fake.calls).toEqual([['cli.tui.effortByModel', '{"deepseek-flash":"max"}']]);

    // max → auto, which is the "no override" answer: the key is written empty
    // rather than with an `auto` entry, so absence is the only spelling.
    press(open.input, 'return');
    await settle();
    expect(open.fake.calls.at(-1)).toEqual(['cli.tui.effortByModel', '{}']);
    expect(open.panel()).toContain('Follows default · Low');
    await open.close();
  });
});

describe('/thinking is /effort under pi’s name', () => {
  it('resolves to the same handler and sets the level', async () => {
    const thinking = resolveTuiSlashCommand('thinking');
    const effort = resolveTuiSlashCommand('effort');
    expect(thinking).toBeDefined();
    // Same behaviour, different spelling: the alias must not grow a second
    // implementation that can drift from the one it was copied from.
    expect(thinking?.run).toBe(effort?.run);
    expect(thinking?.name).toBe('thinking');

    const { app } = makeApp();
    app.start();
    await settle();

    const fake = client();
    const outcome = await (thinking as NonNullable<typeof thinking>).run(
      { client: fake as never, session: SESSION as never, tui: app, busy: false },
      'high',
    );
    app.stop();

    expect(outcome).toEqual({ kind: 'effort_changed', effort: 'high' });
  });
});
