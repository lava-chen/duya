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
  RESERVED_KEYS,
  applyKeyOverrides,
  loadKeyOverrides,
  normalizeChord,
  parseKeyConfigToml,
  toBlessedKeys,
  validateKeyOverrides,
  type KeymapIssue,
} from '../keymap.js';

/** Every issue of one class, for order-independent assertions. */
function issuesOfCode(issues: readonly KeymapIssue[], code: string): readonly KeymapIssue[] {
  return issues.filter((issue) => issue.code === code);
}

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

describe('validateKeyOverrides', () => {
  it('has nothing to say about an untouched keymap', () => {
    // The shipped table binds ↑/↓ in two contexts at once. A validator that
    // audited it would report that on every start, so it must not.
    expect(validateKeyOverrides(ACTION_DEFS, {})).toEqual([]);
  });

  it('rejects a reserved chord with a message naming the config file', () => {
    const issues = validateKeyOverrides(ACTION_DEFS, { history: 'Ctrl+C' });
    const reserved = issuesOfCode(issues, 'reserved');
    expect(reserved).toHaveLength(1);
    expect(reserved[0].severity).toBe('error');
    expect(reserved[0].actionIds).toEqual(['history']);
    expect(reserved[0].chord).toBe('Ctrl+C');
    expect(reserved[0].message).toContain('~/.duya/config.toml');
    expect(reserved[0].message).toContain('Ctrl+C');
    expect(reserved[0].remedy).not.toBe('');
  });

  // Table-driven, so adding a chord to RESERVED_KEYS cannot ship untested.
  it('rejects every reserved chord in the table', () => {
    const chords = Object.keys(RESERVED_KEYS);
    expect(chords.length).toBeGreaterThan(0);
    for (const chord of chords) {
      const issues = validateKeyOverrides(ACTION_DEFS, { history: chord });
      const reserved = issuesOfCode(issues, 'reserved');
      expect(reserved, chord).toHaveLength(1);
      expect(reserved[0].chord, chord).toBe(chord);
      // The reason must reach the user, not just the chord name.
      expect(reserved[0].message, chord).toContain(RESERVED_KEYS[chord]);
    }
  });

  it('rejects overriding an action that cannot be rebound', () => {
    const issues = validateKeyOverrides(ACTION_DEFS, { interrupt: 'Ctrl+X' });
    const notRebindable = issuesOfCode(issues, 'not-rebindable');
    expect(notRebindable).toHaveLength(1);
    expect(notRebindable[0].actionIds).toEqual(['interrupt']);
    expect(notRebindable[0].chord).toBe('Ctrl+X');
    expect(notRebindable[0].message).toContain('~/.duya/config.toml');
  });

  it('rejects a chord blessed cannot express', () => {
    const issues = validateKeyOverrides(ACTION_DEFS, { history: 'Wheel' });
    expect(issuesOfCode(issues, 'unexpressible')).toHaveLength(1);
    expect(issuesOfCode(issues, 'unexpressible')[0].chord).toBe('Wheel');
  });

  it('still reports an unexpressible chord that survives loading from config', () => {
    // `Wheel` above proves the validator rejects it, but it is unreachable in
    // production: `normalizeChord` rejects `Wheel` too, so `loadKeyOverrides`
    // drops it before validation ever runs. That makes the case above a test of
    // the injection seam only.
    //
    // `Alt+End` is the shape that is genuinely reachable — `normalizeChord`
    // accepts it (it parses as a plausible Alt chord) while `toBlessedKeys`
    // cannot name it, so it survives loading and then binds nothing. Without
    // this case the `unexpressible` code could be deleted and the suite would
    // stay green.
    const loaded = loadKeyOverrides(
      { DUYA_TUI_KEY_HISTORY: 'Alt+End' },
      () => {
        throw new Error('no config file');
      },
    );
    // Loading stores the normalised chord, so the stored form is `Alt+END`.
    expect(loaded.history).toBe('Alt+END');

    const issues = validateKeyOverrides(ACTION_DEFS, loaded);
    const unexpressible = issuesOfCode(issues, 'unexpressible');
    expect(unexpressible).toHaveLength(1);
    expect(unexpressible[0].chord).toBe('Alt+END');
  });

  it('rejects an id that names no action', () => {
    const issues = validateKeyOverrides(ACTION_DEFS, { histroy: 'F2' });
    const unknown = issuesOfCode(issues, 'unknown-action');
    expect(unknown).toHaveLength(1);
    expect(unknown[0].actionIds).toEqual(['histroy']);
    // A typo must list the ids that do exist, or the user cannot recover.
    expect(unknown[0].remedy).toContain('history');
  });

  it('reports a clash against the keys that are in effect AFTER the override', () => {
    // `history` defaults to Ctrl+R and `usage` is rebound onto it. Comparing
    // the shipped defaults instead of the effective table would miss this.
    const issues = validateKeyOverrides(ACTION_DEFS, { usage: 'Ctrl+R' });
    const dupes = issuesOfCode(issues, 'duplicate');
    expect(dupes).toHaveLength(1);
    expect(dupes[0].chord).toBe('Ctrl+R');
    expect([...dupes[0].actionIds].sort()).toEqual(['history', 'usage']);
  });

  it('reports two overrides that pick the same key', () => {
    const issues = validateKeyOverrides(ACTION_DEFS, { history: 'F4', usage: 'F4' });
    const dupes = issuesOfCode(issues, 'duplicate');
    expect(dupes).toHaveLength(1);
    expect([...dupes[0].actionIds].sort()).toEqual(['history', 'usage']);
  });

  it('accepts a rebind that is genuinely fine', () => {
    expect(validateKeyOverrides(ACTION_DEFS, { history: 'F2', usage: 'F4' })).toEqual([]);
  });

  it('does not mutate its inputs', () => {
    const defs = ACTION_DEFS.map((def) => ({ ...def, keys: [...def.keys] }));
    const overrides = { history: 'Ctrl+C' };
    const snapshotDefs = JSON.stringify(defs);
    const snapshotOverrides = JSON.stringify(overrides);
    validateKeyOverrides(defs, overrides);
    expect(JSON.stringify(defs)).toBe(snapshotDefs);
    expect(JSON.stringify(overrides)).toBe(snapshotOverrides);
  });
});

describe('the DUYA_TUI_KEY_INTERRUPT case', () => {
  it('refuses the override, so the help panel cannot claim a key that does nothing', () => {
    const overrides = loadKeyOverrides({ DUYA_TUI_KEY_INTERRUPT: 'Ctrl+X' }, () => {
      throw new Error('ENOENT');
    });
    const issues = validateKeyOverrides(ACTION_DEFS, overrides);
    expect(issuesOfCode(issues, 'not-rebindable')).toHaveLength(1);
    // The user is told the same sentence the transcript shows at startup.
    const notice = issues.map((issue) => `${issue.message} ${issue.remedy}`).join('\n');
    expect(notice).toContain('~/.duya/config.toml');
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
