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
