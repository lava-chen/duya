# Plan 438 — Focus mode (per-session single-group display)

> Status: ✅ Implemented (2026-08-22). All phases complete.

## Goal

Add a per-session **Focus** toggle that collapses an entire agent round into
ONE big action group and shows only the final text output. The existing
grouping rule — `text` actions flush the tool/thinking run in
`computeSegments` — is suspended while focus is on. The toggle lives in the
slash-command popover (`/使用指令和技能` → Settings section) and applies only
to the current session; it is never a global setting.

## Non-goals

- No persistence (in-memory only, dropped on app restart).
- No effect on other sessions, sub-agent views, or gateway platforms.
- Widgets (viz) keep rendering as today — they are artifacts, not prose.

## Design

| Concern | Decision |
| --- | --- |
| State | New zustand store `src/stores/focus-mode-store.ts`, `enabledBySession: Record<sessionId, boolean>` (same pattern as btw-store). |
| Grouping | `computeSegments(actions, { focus })`: in focus mode text/widget are skipped entirely (run stays open) and hooks join the run instead of flushing it → one group per round. |
| Text visibility | Renderers hide any text action at or before `findLastWorkIndex` (intermediate narration); trailing texts stay visible so live-streaming final output still types out. Persisted rounds lift the trailing run into `finalText` upstream, so focus additionally filters `kind === 'text'` out of MessageItem's `actions` before passing to `ToolActionsGroup`. |
| Precedence | Focus wins over the research-stage layout (user explicitly opted in). |
| Popover | `settingsItems` gains `__focus` (`settings_action`, EyeIcon); clicking toggles in place (popover stays open) with a Check indicator like mode items. |

## Files

- `src/stores/focus-mode-store.ts` (new)
- `src/components/chat/tools/segments.ts` — focus option
- `src/components/chat/tools/flatRenderer.tsx` — focus text filtering
- `src/components/chat/ToolActionsGroup.tsx` — `focusMode` prop
- `src/components/chat/MessageItem.tsx` / `MessageList.tsx` / `StreamingMessage.tsx` — plumbing
- `src/hooks/useSlashCommands.ts` / `SlashCommandPopover.tsx` / `MessageInput.tsx` — popover toggle
- `src/components/chat/tools/__tests__/segments.test.ts` (new) — segmenter tests

## Verification

- [x] `npm run test` — all `src/` suites pass (failing suites elsewhere are pre-existing better-sqlite3 ABI / agent-build environment issues, zero overlap with this diff)
- [x] `npm run typecheck:all` — clean across web / agent / cli / conductor / voice
