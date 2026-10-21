/**
 * `/hotkeys` — every binding, written into the transcript.
 *
 * ## Why this is not just F1
 *
 * F1 already shows this table, and reuses the same renderer. What it does not
 * do is leave anything behind: it is a modal, so the moment a user reaches for
 * a key the list is gone, and F1 itself is a key many keyboards and remote
 * terminals never deliver. pi answers the same complaint by writing `/hotkeys`
 * into the transcript, and that is what this does.
 *
 * ## Why it quotes the EFFECTIVE table
 *
 * `[tui.keys]` in `~/.duya/config.toml` can rebind part of this list, and a
 * list that printed the defaults while the session used an override would be
 * describing a TUI that is not on the screen. `TUIApp.effectiveKeyBindings()`
 * is the override-applied table; `ACTION_DEFS` is only the fallback when the
 * host has none to offer (a headless caller, or a future non-TUI surface).
 */

import { ACTION_DEFS, helpGroups, KEYMAP_HEADINGS, keysColumn, type ActionDef } from '../actions.js';
import type { TuiSlashCommandDef, TuiSlashContext, TuiSlashOutcome } from './types.js';

/** The rendered lines: headings and two-column rows, no styling. */
export function hotkeyLines(defs: readonly ActionDef[] = ACTION_DEFS): readonly string[] {
  const lines: string[] = [];
  for (const group of helpGroups(defs)) {
    lines.push(KEYMAP_HEADINGS[group.heading] ?? group.heading);
    for (const def of group.rows) lines.push(`  ${keysColumn(def)}${def.label}`);
    lines.push('');
  }
  return lines;
}

const HOTKEYS_COMMAND: TuiSlashCommandDef = {
  name: 'hotkeys',
  description: 'Show every keyboard shortcut',
  group: 'Settings',
  async run(ctx: TuiSlashContext, args: string): Promise<TuiSlashOutcome> {
    if (args.trim() !== '') {
      ctx.tui.printNotice('Use /hotkeys to list key bindings.');
      return { kind: 'handled' };
    }
    const defs = ctx.tui.effectiveKeyBindings?.() ?? ACTION_DEFS;
    const lines = hotkeyLines(defs);
    if (ctx.tui.showPanel === undefined) {
      // No panel (a headless host): the lines are still the answer, and a
      // notice per line keeps every binding readable.
      for (const line of lines) ctx.tui.printNotice(line);
      return { kind: 'handled' };
    }
    ctx.tui.showPanel('Key bindings', lines, {
      footer: 'Esc close · rebind in ~/.duya/config.toml [tui.keys]',
      scrollable: true,
    });
    return { kind: 'handled' };
  },
};

export const HOTKEYS_COMMANDS: readonly TuiSlashCommandDef[] = [HOTKEYS_COMMAND];
