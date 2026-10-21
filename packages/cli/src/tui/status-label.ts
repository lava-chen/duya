/**
 * Labels for the activity row.
 *
 * ## Why this exists
 *
 * `assistant.status` carries CHROME, not transcript content: a turn counter and
 * a "preparing" placeholder say what the agent is doing right now, and both are
 * useless a minute later. Two separate things used to go wrong with them:
 *
 * 1. They were appended to the transcript as permanent notice rows, so a
 *    status signal became something the reader scrolls past forever. Codex,
 *    minimax-code and claude-code all keep status OUT of history — it is a
 *    widget slot that gets hidden again, not a cell.
 * 2. `@i18n:streaming.preparing` is a DESKTOP convention. The desktop renderer
 *    resolves the prefix in `StreamingMessage.tsx`; the CLI had no resolver, so
 *    the raw key reached the screen verbatim.
 *
 * So the key is resolved here, once, at the one place status is consumed — and
 * an unknown key resolves to NOTHING rather than to its own name. Printing an
 * unresolvable key is strictly worse than printing nothing.
 */

/** The desktop renderer's i18n key marker, which a CLI surface must resolve. */
const I18N_PREFIX = '@i18n:';

/**
 * The keys the Host actually sends.
 *
 * Deliberately short. This is not a second i18n system: the desktop owns the
 * full catalogue (`apps/desktop/src/renderer/i18n/`), and the CLI carries only
 * what it has to be able to render. An unknown key drops out of the activity
 * row rather than growing this table — see the module comment.
 */
const STATUS_LABELS: Readonly<Record<string, string>> = {
  'streaming.preparing': 'Preparing response',
};

/** `Turn 3` — the counter the Host publishes on every turn. */
const TURN_COUNTER = /^Turn\s+\d+$/u;

/**
 * The activity-row label for one status message, or `null` to show nothing.
 *
 * A bare turn counter passes through: on a long multi-turn run it is the only
 * signal of how far the run has got, and on the activity row it costs nothing
 * and leaves no residue. It is the TRANSCRIPT that rejects it.
 */
export function resolveStatusLabel(message: string): string | null {
  const text = message.trim();
  if (text === '') return null;
  if (text.startsWith(I18N_PREFIX)) return STATUS_LABELS[text.slice(I18N_PREFIX.length)] ?? null;
  if (TURN_COUNTER.test(text)) return text;
  return text;
}
