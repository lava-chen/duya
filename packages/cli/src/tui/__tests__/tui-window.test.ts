import { describe, it, expect } from 'vitest';
import { WindowManager } from '../window.js';
import { ACTION_DEFS, helpGroups, keysColumn } from '../actions.js';

/**
 * The window manager is pure: spec + navigation state in, tagged lines out.
 * Everything the F1/Ctrl+R/Ctrl+P windows do that is not "which blessed box
 * paints it" is asserted here.
 */

function historyWindow() {
  const mgr = new WindowManager();
  const submitted: string[] = [];
  mgr.open({
    title: 'Input history',
    items: [
      { label: 'newest prompt', value: 'newest prompt' },
      { label: 'middle prompt', value: 'middle prompt' },
      { label: 'oldest prompt', value: 'oldest prompt' },
    ],
    filterable: true,
    onSubmit: (value) => submitted.push(value),
  });
  return { mgr, submitted };
}

describe('WindowManager', () => {
  it('renders nothing when closed', () => {
    const mgr = new WindowManager();
    expect(mgr.isActive).toBe(false);
    expect(mgr.render(20)).toBeNull();
  });

  it('renders static lines and the footer, capped to maxRows', () => {
    const mgr = new WindowManager();
    mgr.open({ title: 'Usage', lines: ['a', 'b', 'c'], footer: 'Esc close' });
    const body = mgr.render(20);
    expect(body).toContain('Usage');
    expect(body).toContain('Esc close');

    const capped = mgr.render(3);
    expect(capped?.split('\n')).toHaveLength(3);
    expect(capped).toContain('…');
  });

  it('filters items as the user types and resets the selection', () => {
    const { mgr } = historyWindow();
    expect(mgr.feedCharacter('m')).toBe(true);
    mgr.feedCharacter('i');
    mgr.feedCharacter('d');
    expect(mgr.filterText).toBe('mid');

    const body = mgr.render(20);
    expect(body).toContain('middle prompt');
    expect(body).not.toContain('newest prompt');
  });

  it('matches a scattered query and ranks the best fuzzy match first', () => {
    const mgr = new WindowManager();
    mgr.open({
      title: 'History',
      items: [
        // 'tg' only as a scattered subsequence (t…ool, g…et).
        { label: 'tool get', value: 'b' },
        // 'tg' contiguous at the start — must outrank the scattered hit.
        { label: 'tg config', value: 'a' },
      ],
      filterable: true,
    });
    mgr.feedCharacter('t');
    mgr.feedCharacter('g');

    const body = mgr.render(20) ?? '';
    const ranked = body.split('\n');
    const contiguous = ranked.findIndex((line) => line.includes('tg config'));
    const scattered = ranked.findIndex((line) => line.includes('tool get'));
    expect(contiguous).toBeGreaterThan(-1);
    expect(scattered).toBeGreaterThan(-1);
    expect(contiguous).toBeLessThan(scattered);
  });

  it('does not consume typing in a non-filterable window', () => {
    const mgr = new WindowManager();
    mgr.open({ title: 'Help', lines: ['keys'] });
    expect(mgr.feedCharacter('x')).toBe(false);
  });

  it('navigates with wrap-around and submits the selected row', () => {
    const { mgr, submitted } = historyWindow();
    mgr.handleKey('down');
    mgr.handleKey('down');
    mgr.handleKey('down'); // wraps to the first row
    mgr.handleKey('return');

    expect(submitted).toEqual(['newest prompt']);
    expect(mgr.isActive).toBe(false);
  });

  it('closes on Enter even with an empty filtered list', () => {
    const { mgr, submitted } = historyWindow();
    mgr.feedCharacter('zzz');
    expect(mgr.handleKey('return')).toBe(true);
    expect(mgr.isActive).toBe(false);
    expect(submitted).toEqual([]);
  });

  it('backspace trims the filter', () => {
    const { mgr } = historyWindow();
    mgr.feedCharacter('o');
    mgr.feedCharacter('l');
    mgr.handleKey('backspace');
    expect(mgr.filterText).toBe('o');
  });

  it('scrolls the viewport to keep the selection visible', () => {
    const mgr = new WindowManager();
    const items = Array.from({ length: 30 }, (_, i) => ({ label: `item-${i}`, value: `item-${i}` }));
    mgr.open({ title: 'History', items });
    for (let i = 0; i < 20; i += 1) mgr.handleKey('down');

    const body = mgr.render(20) ?? '';
    expect(body).toContain('item-20');
    expect(body).not.toContain('item-0');
    expect(body).toContain('…');
  });
});

describe('action registry', () => {
  it('documents every window-open key it renders', () => {
    const ids = new Set(ACTION_DEFS.map((def) => def.id));
    expect(ids.has('help')).toBe(true);
    expect(ids.has('history')).toBe(true);
    expect(ids.has('usage')).toBe(true);
  });

  it('groups the registry for the help window without empty groups', () => {
    const groups = helpGroups();
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) expect(group.rows.length).toBeGreaterThan(0);
  });

  it('pads the keys column to a fixed width', () => {
    expect(keysColumn({ id: 'x', keys: ['F1'], label: '', context: 'global' })).toHaveLength(16);
  });
});
