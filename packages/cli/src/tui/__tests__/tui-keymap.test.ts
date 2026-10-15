/**
 * The keybinding override chain: chord normalisation, blessed-name mapping,
 * config parsing, and the effective action table.
 *
 * Plan 611 Wave 4 (P1-b): the action registry gains its dispatch half — the
 * rebindable global toggles bind from the table, and the table itself can be
 * overridden from `~/.duya/config.toml` (`[tui.keys]`) or
 * `DUYA_TUI_KEY_<ID>`.
 */

import { describe, it, expect } from 'vitest';

import { ACTION_DEFS } from '../actions.js';
import {
  REBINDABLE_ACTIONS,
  applyKeyOverrides,
  loadKeyOverrides,
  normalizeChord,
  parseKeyConfigToml,
  toBlessedKeys,
} from '../keymap.js';

describe('normalizeChord', () => {
  it('canonises the accepted forms', () => {
    expect(normalizeChord('Ctrl+J')).toBe('Ctrl+J');
    expect(normalizeChord('ctrl+j')).toBe('Ctrl+J');
    expect(normalizeChord('C-j')).toBe('Ctrl+J');
    expect(normalizeChord('alt+h')).toBe('Alt+H');
    expect(normalizeChord('M-h')).toBe('Alt+H');
    expect(normalizeChord('meta+h')).toBe('Alt+H');
    expect(normalizeChord('F2')).toBe('F2');
    expect(normalizeChord('f12')).toBe('F12');
    expect(normalizeChord('Ctrl+End')).toBe('Ctrl+END');
    expect(normalizeChord('PgUp')).toBe('PgUp');
    expect(normalizeChord('Esc')).toBe('Esc');
  });

  it('rejects implausible chords', () => {
    expect(normalizeChord('')).toBeNull();
    expect(normalizeChord('hello world')).toBeNull();
    expect(normalizeChord('Ctrl+')).toBeNull();
    expect(normalizeChord('Ctrl+Shift+J')).toBeNull();
    expect(normalizeChord('Ctrl+Enter')).toBeNull();
  });
});

describe('toBlessedKeys', () => {
  it('maps display forms to blessed key names', () => {
    expect(toBlessedKeys(['Ctrl+R'])).toEqual(['C-r']);
    expect(toBlessedKeys(['F1'])).toEqual(['f1']);
    expect(toBlessedKeys(['Alt+Y'])).toEqual(['M-y']);
    expect(toBlessedKeys(['Ctrl+End'])).toEqual(['C-end']);
    expect(toBlessedKeys(['Ctrl+Left'])).toEqual(['C-left']);
    expect(toBlessedKeys(['F2'])).toEqual(['f2']);
  });

  it('drops forms blessed cannot express', () => {
    expect(toBlessedKeys(['Wheel'])).toEqual([]);
    expect(toBlessedKeys(['Ctrl+Alt+X'])).toEqual([]);
    // The default table's display forms all bind: a regression here would
    // silently unbind a global toggle.
    for (const def of ACTION_DEFS) {
      if (!REBINDABLE_ACTIONS.has(def.id)) continue;
      expect(toBlessedKeys(def.keys).length, def.id).toBeGreaterThan(0);
    }
  });
});

describe('parseKeyConfigToml', () => {
  it('reads the [tui.keys] table', () => {
    const content = [
      'storage = { database_path = "x" }',
      '[tui.keys]',
      'history = "Ctrl+J"',
      'usage = "F4"',
      '',
    ].join('\n');
    expect(parseKeyConfigToml(content)).toEqual({ history: 'Ctrl+J', usage: 'F4' });
  });

  it('returns empty for a broken file or a missing table', () => {
    expect(parseKeyConfigToml('not [valid toml ====')).toEqual({});
    expect(parseKeyConfigToml('[tui]\nother = 1')).toEqual({});
    expect(parseKeyConfigToml('[tui.keys]\nhistory = 42')).toEqual({});
  });

  it('drops malformed chords from the table', () => {
    expect(parseKeyConfigToml('[tui.keys]\nhelp = "banana"')).toEqual({});
  });
});

describe('loadKeyOverrides', () => {
  it('merges config then env, env winning', () => {
    const overrides = loadKeyOverrides(
      { DUYA_TUI_KEY_HISTORY: 'F3' },
      () => '[tui.keys]\nhistory = "Ctrl+J"\nusage = "F4"\n',
    );
    expect(overrides['history']).toBe('F3');
    expect(overrides['usage']).toBe('F4');
  });

  it('tolerates a missing config file', () => {
    const overrides = loadKeyOverrides({}, () => {
      throw new Error('ENOENT');
    });
    expect(overrides).toEqual({});
  });

  it('maps DUYA_TUI_KEY_<ID> to action ids', () => {
    const overrides = loadKeyOverrides({ DUYA_TUI_KEY_EXPAND_ALL: 'Ctrl+E' }, () => {
      throw new Error('ENOENT');
    });
    expect(overrides['expand-all']).toBe('Ctrl+E');
  });
});

describe('applyKeyOverrides', () => {
  it('replaces the keys of overridden actions and leaves the rest', () => {
    const defs = applyKeyOverrides(ACTION_DEFS, { history: 'Ctrl+J' });
    const history = defs.find((def) => def.id === 'history');
    const usage = defs.find((def) => def.id === 'usage');
    expect(history?.keys).toEqual(['Ctrl+J']);
    expect(usage?.keys).toEqual(['Ctrl+P']);
  });

  it('is the identity when nothing is overridden', () => {
    expect(applyKeyOverrides(ACTION_DEFS, {})).toBe(ACTION_DEFS);
  });
});

describe('the rebindable surface', () => {
  it('covers exactly the simple global toggles', () => {
    expect([...REBINDABLE_ACTIONS].sort()).toEqual([
      'clear', 'expand-all', 'follow-tail', 'focus', 'help', 'history', 'usage',
    ].sort());
    // Ctrl+C stays out: the interrupt channel is never rebindable.
    expect(REBINDABLE_ACTIONS.has('interrupt')).toBe(false);
  });
});
