/**
 * The action registry: ONE table describing every keybinding.
 *
 * ## What this table is for
 *
 * grok's TUI derives three surfaces from one action table — key dispatch, the
 * hint bar, and the command palette. This wave adopts the first payoff that
 * costs nothing: the F1 help window renders from this table, so the help text
 * cannot drift from what the keys actually do. The dispatchers themselves
 * remain imperative in `TUIApp.bindKeys` (its routing is priority-ordered:
 * prompt > window > overlay > completion > editor, which a flat table does not
 * express) — that migration is Wave 2.
 *
 * ## Contract
 *
 * An entry here documents a binding that EXISTS. When a binding is added to
 * `bindKeys`, it is added here in the same change; the help window is the
 * enforcement surface a reviewer can eyeball.
 */

/** How a key chord is displayed in help text. */
export interface ActionDef {
  /** Stable identifier, so tests and future dispatch tables can reference it. */
  readonly id: string;
  /** Display form, e.g. `Ctrl+R`. Not the blessed key name. */
  readonly keys: readonly string[];
  /** What it does, one line. */
  readonly label: string;
  /** Where it applies, so help can group. */
  readonly context: 'global' | 'editor' | 'transcript';
}

export const ACTION_DEFS: readonly ActionDef[] = [
  { id: 'help', keys: ['F1'], label: 'Open this help window', context: 'global' },
  { id: 'history', keys: ['Ctrl+R'], label: 'Search and recall input history', context: 'global' },
  { id: 'usage', keys: ['Ctrl+P'], label: 'Token usage and context window', context: 'global' },
  { id: 'interrupt', keys: ['Ctrl+C'], label: 'Interrupt the running turn · press twice to exit', context: 'global' },
  { id: 'stop-or-send', keys: ['Esc'], label: 'Stop the run · stop and send the draft · recall a queued draft when empty', context: 'editor' },
  { id: 'clear', keys: ['Ctrl+L'], label: 'Clear the transcript', context: 'global' },
  { id: 'expand-all', keys: ['Ctrl+T'], label: 'Expand / collapse every block', context: 'global' },
  { id: 'focus', keys: ['F6'], label: 'Move focus between input and transcript', context: 'global' },
  { id: 'scroll', keys: ['PgUp', 'PgDn'], label: 'Scroll the transcript (page)', context: 'global' },
  { id: 'wheel-scroll', keys: ['Wheel'], label: 'Scroll the transcript / window (3 lines per tick)', context: 'global' },
  { id: 'follow-tail', keys: ['Ctrl+End'], label: 'Jump back to the newest output', context: 'global' },
  { id: 'submit', keys: ['Enter'], label: 'Submit the prompt', context: 'editor' },
  { id: 'history-recall', keys: ['↑', '↓'], label: 'Walk input history (draft is kept)', context: 'editor' },
  { id: 'line-home-end', keys: ['Ctrl+A', 'Ctrl+E'], label: 'Move to line start / end', context: 'editor' },
  { id: 'word-move', keys: ['Ctrl+←', 'Ctrl+→'], label: 'Move one word left / right', context: 'editor' },
  { id: 'kill-line', keys: ['Ctrl+U', 'Ctrl+K'], label: 'Kill to line start / end (into kill ring)', context: 'editor' },
  { id: 'kill-word', keys: ['Ctrl+W'], label: 'Kill the word before the cursor (into kill ring)', context: 'editor' },
  { id: 'undo', keys: ['Ctrl+Z'], label: 'Undo the last edit', context: 'editor' },
  { id: 'yank', keys: ['Ctrl+Y'], label: 'Yank back the last kill', context: 'editor' },
  { id: 'yank-pop', keys: ['Alt+Y'], label: 'Cycle the yank through older kills', context: 'editor' },
  { id: 'indent', keys: ['Tab'], label: 'Indent · queue while a turn runs · history recall when empty', context: 'editor' },
  { id: 'complete', keys: ['/', '@'], label: 'Trigger command / file completion', context: 'editor' },
  // Ctrl+D is deliberately NOT a delete-forward. Every line editor makes it
  // one, and every one of them also makes it the exit gesture on an empty
  // line — so here it only exits, and never on a line with text in it: a
  // reflexive press that costs half a sentence is the worse trade.
  { id: 'exit', keys: ['Ctrl+D'], label: 'Exit chat (only when the input is empty)', context: 'editor' },
  { id: 'block-select', keys: ['↑', '↓'], label: 'Move through transcript blocks', context: 'transcript' },
  { id: 'block-fold', keys: ['←', '→'], label: 'Fold / unfold the selected block', context: 'transcript' },
];

/**
 * Context → heading, shared by F1 and `/hotkeys`.
 *
 * Exported rather than repeated because the two surfaces must not disagree
 * about what a group is called; `helpGroups` returns contexts, this maps them.
 */
export const KEYMAP_HEADINGS: Readonly<Record<string, string>> = {
  global: 'Global',
  editor: 'Editor',
  transcript: 'Transcript',
};

/** Fixed width of the keys column in the help window. */
const KEYS_COLUMN_WIDTH = 16;

/** Pad a chord list for the two-column help layout. */
function keysColumn(def: ActionDef): string {
  const text = def.keys.join(' ');
  const chars = Array.from(text);
  const padded = chars.length < KEYS_COLUMN_WIDTH
    ? text + ' '.repeat(KEYS_COLUMN_WIDTH - chars.length)
    : `${chars.slice(0, KEYS_COLUMN_WIDTH - 1).join('')}…`;
  return padded;
}

/**
 * The help window body: bindings grouped by context.
 *
 * Returns plain lines; the caller applies theme styles. `defs` defaults to
 * the module table; a TUIApp instance passes its override-applied copy so
 * the help window shows what the keys actually are this session.
 */
export function helpGroups(
  defs: readonly ActionDef[] = ACTION_DEFS,
): ReadonlyArray<{ readonly heading: string; readonly rows: readonly ActionDef[] }> {
  const order: ReadonlyArray<ActionDef['context']> = ['global', 'editor', 'transcript'];
  return order.map((context) => ({
    heading: context,
    rows: defs.filter((def) => def.context === context),
  })).filter((group) => group.rows.length > 0);
}

export { keysColumn };
