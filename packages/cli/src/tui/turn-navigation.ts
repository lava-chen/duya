/**
 * Turn navigation: jump between the prompts of a session.
 *
 * pi marks every user prompt (OSC 133) and jumps between them with
 * `Ctrl+Shift+Up/Down`; Claude Code's transcript viewer jumps with `{`/`}`.
 * Duya's anchors are the transcript's user blocks themselves — the same
 * rendered document the pane paints, profile filtering included — so a jump
 * always lands on a prompt row that is actually on screen to be landed on,
 * and a hidden thinking block can never shift where a prompt sits.
 *
 * The chords are `Alt+Up`/`Alt+Down`: pi's `Ctrl+Shift+` chord is not one
 * this keymap can express (`normalizeChord` rejects shifted control chords
 * outright, because most terminals cannot deliver them distinctly), and
 * Alt+arrows parse on the own key path as `M-up`/`M-down`.
 *
 * ## Stateless navigation
 *
 * There is no cursor to store: "previous" is the last anchor strictly ABOVE
 * the viewport's top line, "next" the first anchor beyond the context rows
 * below it. The viewport position IS the cursor, so scrolling manually and
 * jumping agree with each other by construction, and a stale cursor can
 * never disagree with what is on screen.
 */

/**
 * One prompt anchor: the block id and the document line the prompt's band
 * starts on — the block's first non-empty row, so a jump lands on the prompt
 * itself, not on the stanza gap that opens its block.
 */
export interface TurnAnchor {
  readonly blockId: string;
  readonly line: number;
}

/**
 * The anchor to jump to on "previous": the last one strictly above the
 * viewport top. Sitting exactly on an anchor therefore moves to the one
 * before it, never to the line already at the top.
 */
export function previousTurnAnchor(
  anchors: readonly TurnAnchor[],
  scrollTop: number,
): TurnAnchor | null {
  let best: TurnAnchor | null = null;
  for (const anchor of anchors) {
    if (anchor.line < scrollTop) best = anchor;
    else break;
  }
  return best;
}

/**
 * The anchor to jump to on "next": the first one beyond the context rows
 * below the viewport top. The `contextRows` slack is what makes the jump
 * forward from a landed anchor move to the NEXT prompt instead of settling
 * on the one already two rows up.
 */
export function nextTurnAnchor(
  anchors: readonly TurnAnchor[],
  scrollTop: number,
  contextRows: number,
): TurnAnchor | null {
  const boundary = scrollTop + Math.max(0, contextRows);
  for (const anchor of anchors) {
    if (anchor.line > boundary) return anchor;
  }
  return null;
}
