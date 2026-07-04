// ForceExpandedContext — broadcasts an outer "force expand" or "force
// collapse" signal from `ToolActionsGroup`'s caret to every tool row
// underneath it. When the value is non-null, every row's body
// visibility is overridden:
//   - `'open'`   → body always shown, row's own toggle is disabled.
//   - `'close'`  → body always hidden, row's own toggle is disabled.
//   - `null`     → rows use their own per-row `useState` (free mode).
//
// This is the prototype for the "all rows default collapsed" UX. The
// outer caret on `ToolActionsGroup` cycles three states
// (`null → 'open' → 'close' → null`) to give the user both a
// one-click "expand everything" shortcut and an escape hatch back to
// free per-row toggling. See `docs/exec-plans/active/219-tool-row-
// auto-collapse.md` for the full decision log.

'use client';

import { createContext, useContext } from 'react';

export type ForceExpanded = 'open' | 'close' | null;

const ForceExpandedContext = createContext<ForceExpanded>(null);

export const ForceExpandedProvider = ForceExpandedContext.Provider;

/**
 * Read the outer caret's force mode. Returns `null` when the caller
 * is not inside a `ForceExpandedProvider` (e.g. tests, or row
 * components rendered outside `ToolActionsGroup`).
 */
export function useForceExpanded(): ForceExpanded {
  return useContext(ForceExpandedContext);
}
