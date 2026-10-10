import type { TriggerResult } from './types.js';

/**
 * Where a completion popup should open, given the text and the caret.
 *
 * Moved verbatim in behaviour from
 * `apps/desktop/src/renderer/lib/message-input-logic.ts:63`. The desktop is the
 * only surface that had this, and the CLI had none — so "make them behave the
 * same" starts by having one definition rather than two that drift.
 *
 * ## Why `beforeCursor` and not the whole string
 *
 * Both regexes anchor on `$` against the text BEFORE the caret, which is what
 * makes a popup close when the caret moves out of the trigger span rather than
 * following it around. A slash command typed in the middle of a sentence still
 * completes — the desktop's own spec asserts exactly that
 * (`message-input-logic.spec.ts:22-25`).
 */
export function detectPopoverTrigger(text: string, cursorPos: number): TriggerResult | null {
  const beforeCursor = text.slice(0, cursorPos);

  // `@` wins when both match: `foo/@ba` satisfies both patterns, and the
  // context popup is the narrower reading of that position.
  const atMatch = beforeCursor.match(/@([^\s@]*)$/);
  if (atMatch) {
    return {
      mode: 'context',
      filter: atMatch[1] ?? '',
      triggerPos: cursorPos - atMatch[0].length,
    };
  }

  // `/` only at the start of the line or after whitespace, so a URL or a path
  // (`src/index.ts`, `http://x/y`) does not open a command popup.
  const slashMatch = beforeCursor.match(/(^|\s)\/([^\s]*)$/);
  if (slashMatch) {
    return {
      mode: 'skill',
      filter: slashMatch[2] ?? '',
      triggerPos: cursorPos - (slashMatch[2]?.length ?? 0) - 1,
    };
  }

  return null;
}