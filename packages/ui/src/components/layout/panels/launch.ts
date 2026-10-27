// Launch metadata shared by the panel wall and the title-bar launchers.
//
// Both entry points open the same pages with the same session context, so the
// shortcut labels and the params mapping live here instead of being copied
// into each caller.

import type { PageId } from "./page-tab";

/** The shortcut label advertised for a wall page, if it has one. */
export function shortcutFor(id: PageId): string | null {
  switch (id) {
    case "terminal": return "Ctrl+`";
    case "browser": return "Ctrl+T";
    case "review": return "Ctrl+Shift+G";
    case "workspace": return "Ctrl+P";
    default: return null;
  }
}

/**
 * Params a launcher passes so the page opens on the active session's
 * project. Pages without a project scope (the browser starts on its own
 * home page) get no params.
 */
export function panelParamsFor(
  id: PageId,
  context: { workingDirectory?: string; sessionId?: string | null },
): Record<string, unknown> | undefined {
  const { workingDirectory: cwd, sessionId } = context;
  if (!cwd) return undefined;
  if (id === "terminal") return { cwd };
  if (id === "workspace") return { workingDirectory: cwd };
  if (id === "review") return { workingDirectory: cwd, sessionId: sessionId ?? undefined };
  return undefined;
}
