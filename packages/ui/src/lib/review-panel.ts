// Turn-scoped review side panel — the one entry point for opening a single
// round's diff in the right-hand panel.
//
// Why two window events instead of a direct `usePanel()` call: the
// transcript's file-change card renders deep inside the message list, and
// that tree is also mounted by surfaces that sit outside the `PanelProvider`
// (stories, the task drawer). The provider owns the tab list, so it subscribes
// to these events exactly the way it already does for
// `duya:open-file-preview-panel` / `duya:preview-focus-lines`.
//
//   duya:open-review-panel  → open (or activate) the round's review tab
//   duya:review-focus-file  → re-target the file inside an already-open tab
//
// The split is load-bearing: tabs are deduped per round, so clicking a second
// file row reuses the existing tab — and a reused tab keeps its original
// params. The focus event is the only channel that can reach it.
//
// This mirrors ZCode, where clicking a changed file or its 审查 button calls
// `openDiff` and lands in the side pane's code viewer; nothing expands inline
// in the message.

/** Event name: open (or activate) the review panel for one round. */
export const OPEN_REVIEW_PANEL_EVENT = 'duya:open-review-panel';
/** Event name: select and scroll to a file inside the review panel. */
export const REVIEW_FOCUS_FILE_EVENT = 'duya:review-focus-file';

export interface OpenTurnReviewOptions {
  /** Thread working directory — the git scope root the panel reviews. */
  workingDirectory?: string | null;
  /** Active session id. Turn reviews are stored per session. */
  sessionId?: string | null;
  /**
   * Id of the user message that opened the round. The agent persists that id
   * as `chat_turn_reviews.turn_id`, so passing it loads exactly this round
   * instead of the session's latest one. Omit to follow the latest round.
   */
  turnId?: string | null;
  /** File to select and scroll to once the round's diff loads. */
  filePath?: string | null;
  /** Tab title override. */
  title?: string | null;
}

/**
 * Open this round's review in the side panel.
 *
 * Returns `false` when the request cannot be honoured — no workspace root, or
 * no session to scope the lookup to — so callers can disable their control or
 * fall back instead of appearing to do nothing.
 */
export function openTurnReviewInSidePanel(options: OpenTurnReviewOptions): boolean {
  const workingDirectory = options.workingDirectory?.trim() ?? '';
  const sessionId = options.sessionId?.trim() ?? '';
  if (!workingDirectory || !sessionId) return false;

  const detail: Record<string, string> = { workingDirectory, sessionId };
  const turnId = options.turnId?.trim() ?? '';
  if (turnId) detail.turnId = turnId;
  const filePath = options.filePath?.trim() ?? '';
  if (filePath) detail.filePath = filePath;
  const title = options.title?.trim() ?? '';
  if (title) detail.title = title;

  window.dispatchEvent(new CustomEvent(OPEN_REVIEW_PANEL_EVENT, { detail }));
  return true;
}

/**
 * Re-target the file shown by an already-open review tab. The panel ignores
 * the request when the file is not part of the round it is currently showing,
 * so a stale dispatch from another round is harmless.
 */
export function focusReviewFile(filePath: string): void {
  const target = filePath.trim();
  if (!target) return;
  window.dispatchEvent(new CustomEvent(REVIEW_FOCUS_FILE_EVENT, { detail: { filePath: target } }));
}
