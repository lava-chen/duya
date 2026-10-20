// apps/desktop/src/renderer/lib/open-session-panel-event.ts
// Broadcast intent to open a session's message view in the sidebar
// (`session-messages` panel page). Mirrors the ZCode subagent-session
// side-pane contract: emitters only carry the view's identity; the
// panel provider resolves dedup/focus (tabs dedup on sessionId), so
// emitters never touch panel state directly.
//
// Plan 571 Phase 2 added two OPTIONAL context fields the panel needs to be a
// runtime view instead of a transcript viewer:
//   - `parentSessionId`: the parent thread. The stop control is a
//     `POST /sessions/:parentSessionId/subagents/kill` request, so the kill is
//     routed at the worker that owns the child.
//   - `taskId`: which child of that parent to stop. Two sub-agents of the same
//     type can run concurrently, so the panel must not guess.
// Both are optional: workflow-node sessions have no sub-agent run, and a
// pre-571 emitter passes neither.

export const OPEN_SESSION_PANEL_EVENT = "duya:open-session-panel";

export interface OpenSessionPanelContext {
  parentSessionId?: string;
  taskId?: string;
}

export function dispatchOpenSessionPanel(
  sessionId: string,
  title?: string,
  context?: OpenSessionPanelContext,
): void {
  if (typeof window === "undefined") return;
  const id = sessionId.trim();
  if (!id) return;
  const parentSessionId = context?.parentSessionId?.trim();
  const taskId = context?.taskId?.trim();
  window.dispatchEvent(
    new CustomEvent(OPEN_SESSION_PANEL_EVENT, {
      detail: {
        sessionId: id,
        ...(title && title.trim() ? { title: title.trim() } : {}),
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(taskId ? { taskId } : {}),
      },
    }),
  );
}
