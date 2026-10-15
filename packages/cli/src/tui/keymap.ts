/**
 * User keybinding overrides, resolved once at startup.
 *
 * ## The two sources, and their precedence
 *
 *   `~/.duya/config.toml`  →  `[tui.keys]` table   (lower precedence)
 *   `DUYA_TUI_KEY_<ID>`    →  environment variable (higher precedence)
 *
 * IDs are the `ACTION_DEFS` ids with `-` mapped to `_` in the env form
 * (`DUYA_TUI_KEY_HISTORY=Ctrl+J`). A source that fails to read or parse is
 * skipped — a broken config file must not take the TUI down, and a partial
 * override map is better than none.
 *
 * ## What an override actually touches
 *
 * Only the simple global toggles (help / history / usage / focus /
 * expand-all / clear / follow-tail) are rebound from the table. The editor
 * and completion dispatch is priority-ordered routing, not flat binding —
 * rebinding those keys from a flat table would silently break the routing
 * contract `bindKeys` documents. Overrides to non-rebindable actions are
 * kept for the help window (the display is still true — the user asked for
 * it to read that way — but the binding is not rewired); the module reports
 * which ids were actually rebound via `REBINDABLE_ACTIONS` so callers can
 * warn honestly.
 *
 * ## Display form is the interchange form
 *
 * Overrides are written the way F1 displays them (`Ctrl+J`, `F2`, `Alt+H`),
 * and `toBlessedKeys` converts to blessed's vocabulary. Writing blessed's
 * own names (`C-j`) also works — the parser accepts both and normalises.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { parse as parseToml } from '@iarna/toml';
import type { ActionDef } from './actions.js';

/** Actions whose blessed bindings follow an override. */
export const REBINDABLE_ACTIONS: ReadonlySet<string> = new Set([
  'help',
  'history',
  'usage',
  'focus',
  'expand-all',
  'clear',
  'follow-tail',
]);

/**
 * Chords an override may never claim, with the reason each one is fixed.
 *
 * Deliberately short: a key earns a place here only when losing it would cost
 * the user a path they cannot get back — not merely because it "feels
 * important". Anything that merely collides with another action is caught by
 * the duplicate check instead, which reads the effective table.
 */
export const RESERVED_KEYS: Readonly<Record<string, string>> = {
  'Ctrl+C': 'the interrupt channel, and the double-press exit out of the TUI',
  'Enter': 'the only way to submit a prompt or confirm a window selection',
  'Esc': 'the universal dismissal for windows, overlays and the completion popup',
  'Tab': 'indent in the editor and accept in the completion popup, both at once',
};

/** The config file consulted for `[tui.keys]`. */
function keyConfigPath(home: string = homedir()): string {
  return path.join(home, '.duya', 'config.toml');
}

/**
 * Display-form key chord, normalised: `Ctrl`/`C-` → Ctrl, `Alt`/`M-`/`Meta`
 * → Alt. Returns `null` for anything that is not a plausible chord, so a
 * typo in a config file is dropped rather than bound.
 *
 * Canonical output looks like `Ctrl+J`, `Alt+H`, `F2`, `Ctrl+End`.
 */
export function normalizeChord(value: string): string | null {
  let rest = value.trim();
  if (rest === '' || rest.length > 24) return null;
  if (/[\s\x00-\x1f]/.test(rest)) return null;
  let ctrl = false;
  let alt = false;
  for (;;) {
    const before = rest;
    if (/^ctrl[-+]/i.test(rest)) {
      ctrl = true;
      rest = rest.replace(/^ctrl[-+]/i, '');
    } else if (/^(?:alt|meta)[-+]/i.test(rest)) {
      alt = true;
      rest = rest.replace(/^(?:alt|meta)[-+]/i, '');
    } else if (/^c[-+]/i.test(rest)) {
      ctrl = true;
      rest = rest.replace(/^c[-+]/i, '');
    } else if (/^m[-+]/i.test(rest)) {
      alt = true;
      rest = rest.replace(/^m[-+]/i, '');
    }
    if (rest === before) break;
  }
  const key = rest.trim();
  // A single letter/digit, an F-key, or a navigation name. Anything else is
  // not a chord this module will bind.
  const single = /^[a-z0-9]$/i.test(key);
  const fkey = /^f(?:[1-9]|1[0-2])$/i.test(key);
  const nav = /^(?:end|home|pgup|pgdn|delete|insert|left|right|up|down|enter|return|tab|esc|escape)$/i.test(key);
  if (!single && !fkey && !nav) return null;

  if (!ctrl && !alt) {
    if (single) return key.toUpperCase();
    if (fkey) return key.toUpperCase();
    return NAV_CANON[namedOf(key)] ?? null;
  }
  if (ctrl && !single && !fkey && !/^(?:end|home|left|right|up|down)$/i.test(key)) return null;
  const suffix = single ? key.toUpperCase() : key.toUpperCase();
  return `${ctrl ? 'Ctrl+' : ''}${alt ? 'Alt+' : ''}${suffix}`;
}

/** Navigation aliases → canonical display suffix. */
const NAV_CANON: Readonly<Record<string, string>> = {
  end: 'End', home: 'Home', pgup: 'PgUp', pgdn: 'PgDn',
  delete: 'Delete', insert: 'Insert',
  left: 'Left', right: 'Right', up: 'Up', down: 'Down',
  enter: 'Enter', tab: 'Tab', esc: 'Esc',
};

/** Lower-case alias key for `NAV_CANON`. */
function namedOf(key: string): string {
  return key.toLowerCase()
    .replace(/^return$/, 'enter')
    .replace(/^escape$/, 'esc')
    .replace(/^pageup$/, 'pgup')
    .replace(/^pagedown$/, 'pgdn')
    .replace(/^del$/, 'delete');
}

/** Parse one config file's `[tui.keys]` table. Absent table → empty. */
export function parseKeyConfigToml(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(content) as Record<string, unknown>;
  } catch {
    return out;
  }
  const tui = parsed['tui'];
  if (typeof tui !== 'object' || tui === null) return out;
  const keys = (tui as Record<string, unknown>)['keys'];
  if (typeof keys !== 'object' || keys === null) return out;
  for (const [id, value] of Object.entries(keys as Record<string, unknown>)) {
    if (typeof value === 'string') {
      const chord = normalizeChord(value);
      if (chord !== null) out[id] = chord;
    }
  }
  return out;
}

/** Read the config file's overrides, tolerating every failure mode. */
export function loadKeyOverrides(
  env: Readonly<Record<string, string | undefined>> = process.env,
  readFile: (file: string) => string = (file) => fs.readFileSync(file, 'utf-8'),
): Record<string, string> {
  const merged: Record<string, string> = {};
  try {
    Object.assign(merged, parseKeyConfigToml(readFile(keyConfigPath())));
  } catch {
    // No config, or unreadable: the defaults stand.
  }
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('DUYA_TUI_KEY_') || typeof value !== 'string') continue;
    const id = name.slice('DUYA_TUI_KEY_'.length).toLowerCase().replace(/_/g, '-');
    const chord = normalizeChord(value);
    if (id !== '' && chord !== null) merged[id] = chord;
  }
  return merged;
}

/**
 * Overlay overrides onto the action table.
 *
 * Non-rebindable ids keep their override for DISPLAY only — the help window
 * must not show a binding the user replaced and then have the old key fire.
 * Actually rewiring is the caller's job, keyed on `REBINDABLE_ACTIONS`.
 */
export function applyKeyOverrides(
  defs: readonly ActionDef[],
  overrides: Readonly<Record<string, string>>,
): readonly ActionDef[] {
  if (Object.keys(overrides).length === 0) return defs;
  return defs.map((def) => {
    const chord = overrides[def.id];
    if (chord === undefined) return def;
    return { ...def, keys: [chord] };
  });
}

/**
 * One problem with the requested keybinding overrides.
 *
 * `code` is the machine-readable class; `message` is what a user reads and
 * always names the config file they have to edit, because "your key does not
 * work" without a file to open is the failure this whole module exists to
 * prevent.
 */
export interface KeymapIssue {
  /**
   * Every issue is an error, and the field exists only so a consumer can route
   * on it. It was briefly `'error' | 'warning'`, but nothing produced a
   * warning: all five detections mean the user asked for a key and did not get
   * it, which is the same failure. Widening the union without a producer would
   * have invited handling logic for a branch that can never run, so this
   * narrows to the single level that exists until a real warning arrives.
   */
  readonly severity: 'error';
  /** `reserved` | `duplicate` | `not-rebindable` | `unexpressible` | `unknown-action` */
  readonly code: string;
  /** The actions involved; a whole-table clash names both. */
  readonly actionIds: readonly string[];
  /** The chord at fault, or `null` when the problem is the id, not the key. */
  readonly chord: string | null;
  /** One sentence for the user, naming `~/.duya/config.toml`. */
  readonly message: string;
  /** What to do about it. */
  readonly remedy: string;
}

/**
 * Report everything wrong with `overrides` against `defs`.
 *
 * ## Why only the overrides
 *
 * The shipped table is not audited: it legitimately binds `↑`/`↓` in two
 * contexts at once, and a validator that reported that would cry wolf on every
 * start. Every issue below is traceable to one key the user typed, so a run
 * with no overrides returns an empty list by construction.
 *
 * ## Why duplicates read the effective table
 *
 * The clash that matters is the one the user *produced*, so the comparison is
 * made on `applyKeyOverrides(defs, overrides)` — the keys the session actually
 * dispatches — not on the shipped defaults. Context is deliberately ignored
 * here, unlike the reference implementation: duya binds its global toggles on
 * the screen, so a rebound `↑` genuinely fires next to the editor's history
 * recall rather than in a disjoint context.
 *
 * Pure: neither argument is mutated, and the caller may still apply the
 * overrides or discard them.
 */
export function validateKeyOverrides(
  defs: readonly ActionDef[],
  overrides: Readonly<Record<string, string>>,
): readonly KeymapIssue[] {
  const issues: KeymapIssue[] = [];
  const ids = new Set(defs.map((def) => def.id));
  /** Overrides that name a real action with a chord the TUI can bind. */
  const usable: Record<string, string> = {};

  for (const [id, raw] of Object.entries(overrides)) {
    if (!ids.has(id)) {
      issues.push({
        severity: 'error',
        code: 'unknown-action',
        actionIds: [id],
        chord: null,
        message: `No action named "${id}" exists, so the "${id}" entry in ~/.duya/config.toml is ignored.`,
        remedy: `Rename it to one of: ${[...ids].sort().join(', ')}.`,
      });
      continue;
    }
    const chord = normalizeChord(raw);
    if (chord === null || toBlessedKeys([chord]).length === 0) {
      issues.push({
        severity: 'error',
        code: 'unexpressible',
        actionIds: [id],
        chord: raw,
        message: `"${raw}" is not a key this TUI can bind, so the "${id}" entry in ~/.duya/config.toml is ignored and the default key still fires.`,
        remedy: `Use a chord like Ctrl+J, Alt+H, F2 or Ctrl+End.`,
      });
      continue;
    }
    if (!REBINDABLE_ACTIONS.has(id)) {
      issues.push({
        severity: 'error',
        code: 'not-rebindable',
        actionIds: [id],
        chord,
        message: `"${id}" is dispatched by priority-ordered routing and cannot be rebound: ~/.duya/config.toml sets it to ${chord}, the help window will show ${chord}, but pressing it will not run "${id}".`,
        remedy: `Drop that entry — the default key for "${id}" is unchanged — or pick a different action.`,
      });
    }
    const reservedReason = RESERVED_KEYS[chord];
    if (reservedReason !== undefined) {
      issues.push({
        severity: 'error',
        code: 'reserved',
        actionIds: [id],
        chord,
        message: `${chord} is reserved and cannot be taken by "${id}": it is ${reservedReason}. "~/.duya/config.toml" cannot reassign it.`,
        remedy: `Give "${id}" a different key.`,
      });
    }
    usable[id] = chord;
  }

  // Clashes are computed over the keys this session will actually dispatch.
  // Chords that already failed above are excluded: a chord nothing can bind
  // cannot clash with anything, and reporting it twice only adds noise.
  const overridden = new Set(Object.keys(usable));
  const effective = applyKeyOverrides(defs, usable);
  const byChord = new Map<string, string[]>();
  for (const def of effective) {
    for (const chord of def.keys) {
      const owners = byChord.get(chord);
      if (owners === undefined) byChord.set(chord, [def.id]);
      else if (!owners.includes(def.id)) owners.push(def.id);
    }
  }
  for (const [chord, owners] of byChord) {
    // Only report clashes the user introduced; the shipped table may share a
    // chord across contexts by design.
    if (owners.length < 2) continue;
    const blamed = owners.filter((id) => overridden.has(id));
    if (blamed.length === 0) continue;
    issues.push({
      severity: 'error',
      code: 'duplicate',
      actionIds: owners,
      chord,
      message: `${chord} is bound to ${owners.join(' and ')} at once, so only one of them will respond; ~/.duya/config.toml cannot disambiguate it.`,
      remedy: `Give "${blamed[0]}" a key nothing else uses.`,
    });
  }

  return issues;
}

/** Display form → blessed key names. Unknown display forms bind nothing. */
export function toBlessedKeys(display: readonly string[]): string[] {
  const out: string[] = [];
  for (const chord of display) {
    const blessed = toBlessedKey(chord);
    if (blessed !== null) out.push(blessed);
  }
  return out;
}

function toBlessedKey(display: string): string | null {
  const text = display.trim();
  const ctrl = /^Ctrl\+/i.test(text);
  const alt = /^Alt\+/i.test(text);
  const key = text.replace(/^(Ctrl|Alt)\+/i, '');
  const named = key.toLowerCase();
  if (ctrl) {
    if (alt) return null; // blessed cannot express C-M-x portably
    if (/^[a-z]$/.test(named)) return `C-${named}`;
    if (named === 'left' || named === 'right' || named === 'up' || named === 'down') return `C-${named}`;
    if (named === 'end' || named === 'home') return `C-${named}`;
    return null;
  }
  if (alt) {
    if (/^[a-z]$/.test(named)) return `M-${named}`;
    return null;
  }
  switch (named) {
    case 'f1': case 'f2': case 'f3': case 'f4': case 'f5': case 'f6':
    case 'f7': case 'f8': case 'f9': case 'f10': case 'f11': case 'f12':
    case 'pageup': case 'pagedown': case 'home': case 'end':
    case 'delete': case 'insert':
      return named;
    case 'esc': case 'escape':
      return 'escape';
    case 'enter': case 'return':
      return 'return';
    case 'tab':
      return 'tab';
    default:
      return null;
  }
}
