// Module-level expansion-state store for the chat tool chrome.
//
// Both the group header (tools/group/Group.tsx) and the round-level
// summary row (ToolActionsGroup.tsx) need their "expanded" flag to
// survive re-renders: streaming updates rebuild the `entries` / `actions`
// arrays, which can remount the subtree and reset local `useState`.
// Keying the flag by a stable identity (first tool id) and keeping it
// in a module-level Map makes the expansion stick — the user expands a
// round, another message arrives, the list re-renders, and the round is
// still expanded.
//
// The Map is bounded to prevent unbounded growth across a long session;
// when it exceeds the limit the oldest entry is evicted (Map preserves
// insertion order in JS).

const EXPANSION_LIMIT = 500;
const expansionState = new Map<string, boolean>();

function storageKey(scope: string, key: string): string {
  return `${scope}::${key}`;
}

/**
 * Read a persisted expansion flag.
 *
 * Returns `undefined` when the key was never written, so callers can
 * tell "the user collapsed this" apart from "the user never touched
 * this".
 */
export function getExpansion(scope: string, key: string): boolean | undefined {
  return expansionState.get(storageKey(scope, key));
}

/** Persist an expansion flag. */
export function writeExpansion(scope: string, key: string, value: boolean): void {
  const storage = storageKey(scope, key);
  // Only evict when a *new* key is about to be added — re-writing an
  // existing key must not push out a live entry.
  if (!expansionState.has(storage) && expansionState.size >= EXPANSION_LIMIT) {
    const firstKey = expansionState.keys().next().value;
    if (firstKey !== undefined) expansionState.delete(firstKey);
  }
  expansionState.set(storage, value);
}
