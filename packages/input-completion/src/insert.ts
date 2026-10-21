import type { InsertResult, PopoverItem, PopoverMode } from './types.js';

/**
 * Replace the trigger span with an accepted item.
 *
 * Moved from `apps/desktop/src/renderer/lib/message-input-logic.ts:107`. The
 * arithmetic is the part worth sharing: both surfaces must replace exactly the
 * span from the trigger character to the end of what was typed, leaving the text
 * before and after untouched.
 *
 * ## Why the trailing space is conditional
 *
 * `/doctor| world` must become `/doctor world`, not `/doctor  world`. So the
 * space is added only when nothing usable follows the span — and "usable" means
 * the very next character is not already whitespace. Without that check every
 * accept inside a sentence doubles the space.
 */
export function resolveItemSelection(
  item: PopoverItem,
  popoverMode: PopoverMode,
  triggerPos: number,
  inputValue: string,
  popoverFilter: string,
): InsertResult {
  const before = inputValue.slice(0, triggerPos);
  const cursorEnd = triggerPos + popoverFilter.length + 1;
  const after = inputValue.slice(cursorEnd);

  if (popoverMode === 'skill') {
    const needsTrailingSpace = after.length === 0 || !/^\s/.test(after);
    return {
      action: 'insert_slash_command',
      commandValue: item.value,
      newInputValue: `${before}${item.value}${needsTrailingSpace ? ' ' : ''}${after}`,
    };
  }

  return {
    action: 'insert_file_mention',
    newInputValue: `${before}@${item.value} ${after}`,
  };
}

/**
 * Move a selection index, wrapping at both ends.
 *
 * Wrapping rather than clamping is the desktop's behaviour
 * (`message-input-logic.ts:140`) and the reason holding ArrowDown never gets
 * stuck at the bottom of the list.
 *
 * `length === 0` returns 0 rather than NaN, because the callers compute a
 * selection index before they know whether the filtered list is empty.
 */
export function cycleIndex(current: number, direction: 'up' | 'down', length: number): number {
  if (length === 0) return 0;
  if (direction === 'down') return (current + 1) % length;
  return (current - 1 + length) % length;
}