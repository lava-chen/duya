import type { PopoverItem } from './types.js';
import { fuzzyFilter } from './fuzzy.js';

/**
 * The fields filtering reads.
 *
 * Deliberately a structural minimum rather than `PopoverItem`: the desktop's
 * `PopoverItem` narrows `icon` to a React component, so a signature pinned to
 * the shared type would reject the desktop's own items in the wrong direction
 * (`unknown` is not assignable to a component) and force every surface to cast.
 * Narrowing to the fields actually read keeps each surface's item type intact in
 * both directions, which is the whole reason the shared type declares `icon` as
 * opaque in the first place.
 */
interface Filterable {
  label: string;
  description?: string;
}

/**
 * Filter popover items by substring on label or description.
 *
 * This is the desktop's existing behaviour, moved here unchanged
 * (`message-input-logic.ts:95`) so both surfaces filter `/` commands and `@`
 * context items the same way. It is case-insensitive, matches on either field,
 * and preserves input order.
 *
 * ## When to reach for `filterItemsFuzzy` instead
 *
 * For file paths. A substring filter over `src/app/useApp.ts` cannot be found
 * by typing `src/uA`, because no contiguous run of that string exists in the
 * path — see `fuzzy.ts` for why both reference implementations scored their file
 * matching instead of substring-filtering it.
 *
 * Both are exported so the choice is at the call site, where the item kind is
 * known, rather than buried in here as a guess about what the items are.
 */
export function filterItems<T extends Filterable>(items: readonly T[], filter: string): T[] {
  const q = filter.toLowerCase();
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(q) || String(item.description ?? '').toLowerCase().includes(q),
  );
}

/**
 * Rank popover items by fuzzy subsequence match on their label.
 *
 * `getText` is the field to match on. Matching the LABEL rather than the
 * `value` is deliberate: the user types what they see, and a localised label
 * (`审查代码变更`) paired with a stable value (`/review`) is what lets a Chinese
 * user type Chinese and still get the right command.
 */
export function filterItemsFuzzy<T extends Filterable>(
  items: readonly T[],
  filter: string,
  getText: (item: T) => string = (item) => item.label,
): T[] {
  return fuzzyFilter(items, filter, getText);
}

/** Compile-time reassurance that the shared type satisfies the minimum. */
type _AssertPopoverItemIsFilterable = PopoverItem extends Filterable ? true : never;
const _assert: _AssertPopoverItemIsFilterable = true;
void _assert;