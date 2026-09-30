# Turn Review History

## Goal

Persist the working-tree delta made during each completed DUYA chat turn and
open the Code Review sidebar on the latest completed turn by default.

## Scope

- Capture an isolated Git tree at the start and end of a chat turn without
  touching the user's real index.
- Persist a bounded patch and file summary per session/turn.
- Expose the latest stored turn through the existing Git preload bridge.
- Let the sidebar switch between **Last turn** and **HEAD to working tree**.

## Plan

- [x] Add the main-database schema and Agent DB action.
- [x] Capture and persist snapshots around Agent turns.
- [x] Add the typed IPC bridge and default sidebar range.
- [x] Add focused regression tests.
- [ ] Exercise the Code Review panel in the Electron E2E renderer.

## Phase 2 — Pill unification + turn history (2026-09-03)

User-reported defects after shipping Phase 1: the input-box file-change
pill counts other sessions' changes (it displays repo-wide
`git:status` totals), it sometimes does not show at all, its click lands
on the wrong review scope, and only the single latest turn is browsable.

- [x] `git:status` merges untracked files from porcelain (diff misses
  them) so a turn that only creates new files still surfaces.
- [x] `readLatestTurnReview` matches by `session_id` only — the exact
  `working_directory` string filter silently missed on Windows path
  separator/case drift between agent and renderer cwd.
- [x] Pill prefers the persisted per-turn review after streaming ends
  (ChatView fetches `git:review-latest-turn` on the streaming→idle
  edge); live `gitStatus` remains the in-stream / fallback source.
- [x] Baseline captured at send time (before the agent can write), not
  on the first streaming tick — closes the early-edit race.
- [x] `useGitStatus` keeps the previous status on transient poll errors
  instead of resetting to EMPTY (no more pill flicker).
- [x] Pill click passes `sessionId` so the panel opens on the
  `latest-turn` scope; during streaming it keeps the repo-wide view.
- [x] New IPC `git:review-turn-history` + `git:review-turn-detail` and a
  turn selector in the Code Review panel (browse older turns).
- [x] Tests updated (git-handlers, InlineTaskRow, CodeReviewPanel).

Known limitation (unchanged): the per-turn tree diff attributes every
write inside the turn window to the turn, including concurrent sessions
working in the same directory — document, do not fix here.

## Verification note

Focused unit and IPC tests pass. The existing Electron smoke launch starts its
main process but the renderer does not finish loading in this environment
before the command runner's 64-second limit, so the final renderer exercise is
left explicitly pending.
