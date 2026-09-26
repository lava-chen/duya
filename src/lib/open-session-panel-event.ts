// src/lib/open-session-panel-event.ts
// Broadcast intent to open a session's message view in the sidebar
// (`session-messages` panel page). Mirrors the ZCode subagent-session
// side-pane contract: emitters only carry { sessionId, title? }; the
// panel provider resolves dedup/focus (tabs dedup on sessionId), so
// emitters never touch panel state directly.

export const OPEN_SESSION_PANEL_EVENT = "duya:open-session-panel";

export function dispatchOpenSessionPanel(sessionId: string, title?: string): void {
  if (typeof window === "undefined") return;
  const id = sessionId.trim();
  if (!id) return;
  window.dispatchEvent(
    new CustomEvent(OPEN_SESSION_PANEL_EVENT, {
      detail: { sessionId: id, ...(title && title.trim() ? { title: title.trim() } : {}) },
    }),
  );
}
