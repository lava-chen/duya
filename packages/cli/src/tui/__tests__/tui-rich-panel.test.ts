/**
 * 630a: the tabbed rich panel.
 *
 * Two levels, because the two failure modes are different. The controller is
 * tested as a state machine — focus, per-tab navigation, the staged exit —
 * since that is where a panel goes subtly wrong (a tab that loses your query,
 * an Esc that leaves instead of clearing). The rest is driven through a REAL
 * `TUIApp` with injected bytes, because the part 631 and 632 depend on is not
 * the controller but the fact that a keystroke reaches it instead of the
 * editor underneath: that is decided by TUIApp's dispatch order, which no
 * pure unit test can see.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'node:stream';

import {
  TUIApp,
  type RichPanelHandle,
} from '../TUIApp.js';
import {
  ListState,
  RichPanelController,
  WindowManager,
  type ListSection,
  type RichPanelTab,
  type WindowItem,
} from '../window.js';
import { press } from './key-injection.js';

const plain = (value: string): string => value.replace(/\{[^}]*\}/gu, '');

const INSTALLED: readonly WindowItem[] = [
  { label: 'alpha', value: 'alpha' },
  { label: 'beta', value: 'beta', description: 'enabled' },
];
const AVAILABLE: readonly WindowItem[] = [
  { label: 'super-search', value: 'super-search' },
];

function tabs(overrides: Partial<Record<string, Partial<RichPanelTab>>> = {}): RichPanelTab[] {
  const base: RichPanelTab[] = [
    { id: 'installed', label: 'Installed', items: INSTALLED, filterable: true, footer: 'i install · Esc leave' },
    { id: 'available', label: 'Available', items: AVAILABLE, filterable: true, footer: 'Enter install' },
  ];
  return base.map((tab) => ({ ...tab, ...overrides[tab.id] }));
}

function panel(tabsOverride: readonly RichPanelTab[]): { mgr: WindowManager; ctrl: RichPanelController } {
  const mgr = new WindowManager();
  const ctrl = new RichPanelController({ title: 'Plugins', tabs: tabsOverride });
  mgr.open({ title: 'Plugins', controller: ctrl });
  return { mgr, ctrl };
}

/** The dock as plain text, the way the app paints it. */
const dock = (mgr: WindowManager, rows = 30, width = 90): string =>
  (mgr.renderDocked(rows, width) ?? []).map(plain).join('\n');

describe('RichPanelController', () => {
  it('starts in the strip and hands the cursor to the list', () => {
    const { mgr, ctrl } = panel(tabs());
    expect(ctrl.contentFocused()).toBe(false);
    expect(dock(mgr)).toContain('↓ list · Tab ⇄');

    expect(mgr.handleKey('down')).toBe(true);
    expect(ctrl.contentFocused()).toBe(true);
    expect(dock(mgr)).toContain('Tab ⇄ tab');
    // `up` from the list is the way back, and it must not also scroll a
    // one-row strip.
    expect(mgr.handleKey('up')).toBe(true);
    expect(ctrl.contentFocused()).toBe(true);
  });

  it('gives each tab its own filter and cursor', () => {
    const { mgr, ctrl } = panel(tabs());
    mgr.handleKey('down');
    mgr.feedCharacter('b');
    expect(ctrl.activeSelectedValue()).toBe('beta');

    mgr.handleKey('tab');
    expect(ctrl.activeTabId()).toBe('available');
    expect(ctrl.activeList().filterText).toBe('');
    expect(dock(mgr)).toContain('super-search');

    mgr.handleKey('S-tab', { shift: true });
    expect(ctrl.activeTabId()).toBe('installed');
    expect(ctrl.activeList().filterText).toBe('b');
    expect(ctrl.activeSelectedValue()).toBe('beta');
  });

  it('moves with Tab and skips a disabled tab', () => {
    const { mgr, ctrl } = panel(tabs({ available: { disabled: true } }));
    mgr.handleKey('tab');
    expect(ctrl.activeTabId()).toBe('installed');
    expect(mgr.handleKey('right')).toBe(true);
    expect(ctrl.activeTabId()).toBe('installed');
  });

  it('fires a row action only while the strip holds the cursor', () => {
    const hit: string[] = [];
    const { mgr, ctrl } = panel(tabs({
      installed: { rowActions: { i: (value) => { hit.push(value); } } },
    }));
    expect(ctrl.hasRowAction('i')).toBe(true);
    expect(mgr.handleKey('i')).toBe(true);
    expect(hit).toEqual(['alpha']);

    mgr.handleKey('down');
    expect(mgr.handleKey('i')).toBe(false);
    // In the list the letter belongs to the query, or `install` could never
    // be typed to find a plugin called `i18n`.
    mgr.feedCharacter('i');
    expect(ctrl.activeList().filterText).toBe('i');
    expect(hit).toEqual(['alpha']);
  });

  it('runs a control chord bound as a row action', () => {
    const gone: string[] = [];
    const { mgr } = panel(tabs({
      installed: { rowActions: { 'C-d': (value) => { gone.push(value); } } },
    }));
    expect(mgr.handleKey('C-d')).toBe(true);
    expect(gone).toEqual(['alpha']);
  });

  it('backs out one layer per Esc and leaves last', () => {
    let closed = 0;
    const mgr = new WindowManager();
    const ctrl = new RichPanelController({
      title: 'Plugins',
      tabs: tabs(),
      onClose: () => { closed += 1; },
    });
    mgr.open({ title: 'Plugins', controller: ctrl });

    mgr.handleKey('down');
    mgr.feedCharacter('b');
    expect(mgr.handleKey('escape')).toBe(true);
    expect(ctrl.activeList().filterText).toBe('');
    expect(closed).toBe(0);

    expect(mgr.handleKey('escape')).toBe(true);
    expect(ctrl.contentFocused()).toBe(false);
    expect(closed).toBe(0);

    expect(mgr.handleKey('escape')).toBe(true);
    expect(mgr.isActive).toBe(false);
    expect(closed).toBe(1);
  });

  it('flushes on every way of leaving the dock', () => {
    // F1 taking the window, a permission ask closing it, a command calling
    // `close()`: the panel queued writes on the assumption that it WILL be
    // told when it is gone, so no close path may skip the hook.
    let closed = 0;
    const mgr = new WindowManager();
    mgr.open({
      title: 'Plugins',
      controller: new RichPanelController({ title: 'Plugins', tabs: tabs(), onClose: () => { closed += 1; } }),
    });
    mgr.close();
    expect(closed).toBe(1);
    expect(mgr.isActive).toBe(false);
  });

  it('clearing the filter keeps the row the cursor was on', () => {
    const { mgr, ctrl } = panel(tabs());
    mgr.handleKey('down');
    mgr.feedCharacter('b');
    expect(ctrl.activeSelectedValue()).toBe('beta');
    mgr.handleKey('escape');
    // The query is gone but the list still has two rows; the cursor must not
    // snap back to the first one.
    expect(ctrl.activeSelectedValue()).toBe('beta');
  });

  it('keeps the query and the row when a tab is refreshed', () => {
    const { mgr, ctrl } = panel(tabs());
    mgr.handleKey('down');
    mgr.feedCharacter('a');
    const before = ctrl.activeSelectedValue();
    ctrl.syncTab('installed', { items: [{ label: 'alpha', value: 'alpha' }, { label: 'beta', value: 'beta' }] });
    expect(ctrl.activeList().filterText).toBe('a');
    expect(ctrl.activeSelectedValue()).toBe(before);
  });

  it('submits from a picker tab and stays open on a control tab', () => {
    const submitted: string[] = [];
    const activated: string[] = [];
    const { mgr } = panel(tabs({
      installed: { onActivate: (value) => { activated.push(value); } },
      available: { onSubmit: (value) => { submitted.push(value); } },
    }));
    mgr.handleKey('down');
    mgr.handleKey('return');
    expect(activated).toEqual(['alpha']);
    expect(mgr.isActive).toBe(true);

    mgr.handleKey('tab');
    mgr.handleKey('return');
    expect(submitted).toEqual(['super-search']);
    expect(mgr.isActive).toBe(false);
  });

  it('paints a header with per-tab counts and trims to the height budget', () => {
    const many: readonly WindowItem[] = Array.from({ length: 20 }, (_, i) => ({
      label: `model ${i}`,
      value: `m${i}`,
    }));
    const { mgr } = panel([{ id: 'a', label: 'All', items: many, filterable: true, footer: 'Enter pick' }]);
    const wide = dock(mgr, 30);
    expect(wide).toContain('All 20');
    expect(wide).toContain('Enter pick');

    const short = (mgr.renderDocked(8, 90) ?? []).map(plain);
    expect(short).toHaveLength(8);
    expect(short.join('\n')).toContain('…');
    // The footer is the line that says how to leave; it is the one row the
    // trim always keeps.
    expect(short[short.length - 1]).toContain('Enter pick');
  });
});

describe('ListState', () => {
  it('keeps navigation across a refresh and clamps when the row is gone', () => {
    const list = new ListState();
    list.openSection({ items: INSTALLED, filterable: true });
    list.feedCharacter('b');
    expect(list.selectedRow()?.value).toBe('beta');
    list.refresh({ items: [{ label: 'beta', value: 'beta' }] });
    expect(list.filterText).toBe('b');
    expect(list.selectedRow()?.value).toBe('beta');

    list.refresh({ items: [] });
    expect(list.selectedRow()).toBeUndefined();
  });

  it('does not eat space in a list with nothing to activate', () => {
    const list = new ListState();
    const section: ListSection = { items: INSTALLED, filterable: true };
    list.openSection(section);
    expect(list.handleKey('space')).toBe(false);
  });
});

// ── Through the real app ──────────────────────────────────────────────────

function makeApp(options: { readonly onExit?: () => void } = {}): {
  app: TUIApp;
  out: () => string;
  input: PassThrough;
} {
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
    onSubmit: () => {},
    ...(options.onExit === undefined ? {} : { onExit: options.onExit }),
  });
  return { app, out: () => Buffer.concat(chunks).toString('utf8'), input };
}

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 60));
};

const inputLines = (app: TUIApp): string => (app as unknown as {
  inlineInputLines: string[];
}).inlineInputLines.map(plain).join('\n');

const windowState = (app: TUIApp): { isActive: boolean } =>
  (app as unknown as { windowMgr: { isActive: boolean } }).windowMgr;

const editorText = (app: TUIApp): string =>
  (app as unknown as { editor: { text: string } }).editor.text;

/**
 * Back out of the panel one layer at a time.
 *
 * Each Esc is its own write AND its own tick: two escapes in one burst reach
 * the parser as `M-escape`, which is not the key the panel binds. That is the
 * parser being faithful to a terminal, so the test waits instead of teaching
 * the app a second escape name.
 */
const escapeOut = async (input: PassThrough, times: number): Promise<void> => {
  for (let i = 0; i < times; i += 1) {
    press(input, 'escape');
    await settle();
  }
};

describe('showRichPanel in the TUI', () => {
  it('paints the panel in the composer slot and keeps the transcript underneath', async () => {
    const { app, out, input } = makeApp();
    app.start();
    await settle();

    let handle: RichPanelHandle | undefined;
    app.showRichPanel({
      title: 'Plugins',
      tabs: tabs(),
      onOpen: (panel2) => { handle = panel2; },
    });
    await settle();

    const painted = inputLines(app);
    expect(painted).toContain('Plugins');
    expect(painted).toContain('Installed 2');
    expect(painted).toContain('Available 1');
    expect(painted).toContain('i install · Esc leave');
    expect(handle?.activeTabId()).toBe('installed');
    // The dock replaces the composer; it must not jump the app into the
    // alternate screen, which is why the conversation stays scrollable.
    expect(out()).not.toContain('\x1b[?1049h');

    app.printNotice('a turn landed while the panel was open');
    await settle();
    expect(windowState(app).isActive).toBe(true);
    expect(handle?.activeTabId()).toBe('installed');

    input.write('x');
    await settle();
    expect(editorText(app)).toBe('');
    expect(inputLines(app)).toContain('filter: x');

    app.stop();
  });

  it('routes Tab into the panel and gives the prompt back on the last Esc', async () => {
    const { app, input } = makeApp();
    app.start();
    await settle();

    const leaving = app.showRichPanel({ title: 'Plugins', tabs: tabs() });
    await settle();

    press(input, 'tab', 'down');
    await settle();
    expect(inputLines(app)).toContain('super-search');

    // Two presses, because the cursor is in the list with nothing to clear:
    // back to the strip first, leave second.
    await escapeOut(input, 2);
    await leaving;
    expect(windowState(app).isActive).toBe(false);

    // The editor owns typing again — the panel is gone, not merely hidden.
    input.write('hi');
    await settle();
    expect(editorText(app)).toBe('hi');
    app.stop();
  });

  it('runs a row action from the strip and a filter letter from the list', async () => {
    const { app, input } = makeApp();
    app.start();
    await settle();

    const hit: string[] = [];
    const leaving = app.showRichPanel({
      title: 'Plugins',
      tabs: tabs({ installed: { rowActions: { i: (value) => { hit.push(value); } } } }),
    });
    await settle();

    input.write('i');
    await settle();
    expect(hit).toEqual(['alpha']);
    expect(editorText(app)).toBe('');

    press(input, 'down');
    await settle();
    input.write('i');
    await settle();
    expect(hit).toEqual(['alpha']);
    expect(inputLines(app)).toContain('filter: i');

    press(input, 'space');
    await settle();
    // Nothing to toggle on this tab: the space is query text, not a no-op.
    expect(inputLines(app)).toContain('filter: i ');

    await escapeOut(input, 3);
    await leaving;
    app.stop();
  });

  it('keeps Ctrl+D a row action while the panel is open', async () => {
    let exits = 0;
    const { app, input } = makeApp({ onExit: () => { exits += 1; } });
    app.start();
    await settle();

    const gone: string[] = [];
    const leaving = app.showRichPanel({
      title: 'Plugins',
      tabs: tabs({ installed: { rowActions: { 'C-d': (value) => { gone.push(value); } } } }),
    });
    await settle();

    press(input, 'C-d');
    await settle();
    expect(gone).toEqual(['alpha']);
    expect(exits).toBe(0);

    // The cursor never left the strip, so one Esc is the whole exit.
    await escapeOut(input, 1);
    await leaving;
    // Back at an empty prompt, Ctrl+D is the exit chord again — the panel
    // borrowed it, it did not take it.
    press(input, 'C-d');
    await settle();
    expect(exits).toBe(1);
    app.stop();
  });

  it('keeps the hidden draft out of reach of a chord the panel does not claim', async () => {
    const { app, input } = makeApp();
    app.start();
    await settle();
    input.write('keep me');
    await settle();
    expect(editorText(app)).toBe('keep me');

    const leaving = app.showRichPanel({ title: 'Plugins', tabs: tabs() });
    await settle();
    press(input, 'C-u');
    await settle();
    // C-u is kill-to-start and no tab binds it. Under the dock the composer
    // is not visible, so a chord that edited it would only show up later, as
    // a submitted prompt that lost its beginning.
    expect(editorText(app)).toBe('keep me');

    await escapeOut(input, 1);
    await leaving;
    press(input, 'C-u');
    await settle();
    expect(editorText(app)).toBe('');
    app.stop();
  });
});
