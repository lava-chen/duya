# 416 - Inline Task Row Inside Message Input

## Status

🟢 Implementation complete; awaiting Playwright MCP visual verification.

## Goal

Replace the floating task pill above the composer with an inline task row
that lives **inside** `message-input-surface`, so the input box grows
vertically as the row appears. Match the visual style of the slash-command
settings popover for the expanded task list.

User-facing behaviour:

- The pill is gone. When the agent publishes tasks or `git status` reports
  file changes for the current turn, the input box shows a new row above
  the textarea, separated by a divider.
- Row layout: `[ListChecksIcon] 进行中：<active subject> (已完成/总数)`
  on the left, the git file-change segment on the right (still launches
  Code Review on click).
- Clicking the row opens a popover listing every task. Popover matches
  `--command-menu-*` tokens (same as the settings popover) — bg/border/
  shadow/radius/hover/row padding.
- No animation on expand/collapse — instant toggle.

## Background

Today the chrome is owned by `FloatingTaskPanel`:

- `src/components/layout/FloatingTaskPanel.tsx:1-160` — renders a
  position-relative pill above `MessageInput` with two segments
  (`.floating-task-pill-main` + `.floating-task-pill-git`) and a
  framer-motion popover at `bottom: calc(100% + 8px)`.
- `src/components/chat/ChatView.tsx:1202-1207` and `:1322-1327` — two
  render sites (welcome-mode + active-chat-mode) wrapping the panel in
  `workspace-floating-composer` / `workspace-floating-composer-expanded`.
- `src/components/layout/FloatingTaskPanel.test.tsx` — 8 unit tests
  covering empty/file-only/task-only/expanded/toggle/code-review/outside
  click/showFileChanges=false.
- `src/styles/globals.css:13654-13807` — `.floating-task-*` rules.

The settings popover is `SlashCommandPopover.tsx`:

- Outer container: `command-menu-popover` with `padding: 3`,
  `border-radius: 10`, `--command-menu-bg` / `--command-menu-border` /
  `--command-menu-shadow`.
- Row: `command-menu-row` with `min-height: 28`, `paddingTop/Bottom: 4`,
  `paddingLeft/Right: 10` (px-2.5), `border-radius: 6`, hover
  `var(--command-menu-selected)` (CSS at `globals.css:284-310`).
- Tokens defined at `globals.css:175-179` (light) and `:233-237`
  (dark).

The input box chrome lives in `MessageInput.tsx:1573-1652`:

- `message-input-surface` is `rounded-3xl p-2` with
  `backgroundColor: var(--surface)` and a 1px inset border via
  `boxShadow: 'inset 0 0 0 1px var(--border-color)'`.
- Internal stacking: `<AttachmentBar>` (line 1591) → `<RichTextInput>`
  (line 1600) → `Bottom Toolbar` (line 1635). The new task row slots in
  between `<AttachmentBar>` and `<RichTextInput>`, divided from the
  textarea by `border-top`.

## Decisions

### D0. New file `src/components/chat/InlineTaskRow.tsx`

The component is no longer "floating" and is conceptually part of the
chat input — keep it under `chat/`, drop `layout/`. The public name
is `InlineTaskRow`. The old `FloatingTaskPanel` file is **deleted**
along with its CSS rules and test.

### D1. Position: inside `message-input-surface`, top-most slot

Render the row immediately after `<AttachmentBar>` and before
`<RichTextInput>`. The row is its own block with a top divider so the
textarea below it is visually separated. The whole row carries
`border-top: 1px solid var(--command-menu-border)` only when it has
content (no row → no divider → input box stays compact, no visual
artifact).

Padding inside the row: `px-2 py-1.5` — matches the existing
attachment-bar padding (8px / 6px). Min-height 32px so the row has
presence without dominating.

### D3. Row layout

```
[ListChecksIcon]  进行中：<active subject> (completed/total)   |git-segment|
```

- Left: `ListChecksIcon` (size 13, `color: var(--command-menu-muted)`).
  Same icon used in the git pill (`GitBranchIcon`) stays.
- Middle: subject text. Active subject = first task with
  `status === 'in_progress'`, fallback = `tasks[0]?.subject` (mirrors
  current behaviour). Prefix `进行中：` is unconditional — even when
  there is no in-progress task, the row still anchors the agent's
  current todo.
- Right of subject: `(completed/total)` — completed count over total
  task count. Same shape as `(0/3)`. Font size 11, color
  `var(--command-menu-muted)`, font-family mono for tabular feel.
- Optional git segment to the right: identical to today's
  `.floating-task-pill-git` — `GitBranchIcon` + `N 个文件已更改` +
  `+X/-Y` chips. Click opens Code Review. The git segment only renders
  when `showFileChanges && gitStatus.totals.fileCount > 0`. Same
  divider rule as today.
- When the task pill is the only segment (no git changes), no divider
  in front of the (completed/total) — just spacing.

### D4. Popover uses `--command-menu-*` tokens

No new CSS variables. Popover container:

```css
background: var(--command-menu-bg);
border: 1px solid var(--command-menu-border);
border-radius: 10px;
box-shadow: var(--command-menu-shadow);
padding: 3px;
max-height: 28 * 6 + 24; /* ~6 rows visible */
overflow-y: auto;
```

Anchored above the row with `position: absolute; bottom: calc(100% + 6px)`
inside a `position: relative` wrapper that wraps the whole row. Width
`min(420px, calc(100vw - 48px))`.

Each row:

- `min-height: 28px`, `padding: 4px 10px`, `border-radius: 6px`,
  gap 8.
- Hover `background: var(--command-menu-selected)`.
- Status button: 18px circle (same as today), icon 12px.
- Title: flex-1, completed → `color: var(--command-menu-muted)` +
  `text-decoration: line-through`.

No `motion.div`, no `AnimatePresence`. The popover is rendered
conditionally with `{expanded && hasTasks && <div className="...">}`.

### D5. Outside-click close + Escape

Keep today's outside-click behaviour (mousedown on `document`,
`contains(target)` guard). Add Escape-to-close while focused on the
popover (no current behaviour — reasonable addition since the
SlashCommandPopover uses the same pattern).

### D6. `MessageInput` accepts task props

Add to `MessageInputProps`:

```ts
tasks?: Task[];
gitStatus?: UseGitStatusResult;
onToggleTaskStatus?: (task: Task) => void;
workingDirectory?: string | null;
showFileChanges?: boolean;
```

Defaults: `[]`, empty status, `undefined`, `null`, `true`. When all
are absent/empty, no row renders and the input box looks identical to
today.

ChatView passes the same props it currently gives `<FloatingTaskPanel>`.

### D7. Delete the old FloatingTaskPanel

- Remove `src/components/layout/FloatingTaskPanel.tsx`.
- Remove `src/components/layout/FloatingTaskPanel.test.tsx`.
- Remove `.floating-task-*` rules from `src/styles/globals.css`.
- Remove both `<FloatingTaskPanel>` blocks in `ChatView.tsx`
  (`1202-1207`, `1322-1327`).

### D8. No `framer-motion` dependency for this row

The new `InlineTaskRow` does not import framer-motion. The only
remaining consumer of `framer-motion` in this layout area is
`SlashCommandPopover`, which is unchanged.

## Phase 1 — Component skeleton + new CSS

- [x] Create `src/components/chat/InlineTaskRow.tsx` with the public
      `InlineTaskRowProps` (same shape as today's
      `FloatingTaskPanelProps` minus the old `tasks` wording). Default
      exports the component. Internal `expanded` state, outside-click
      effect, Escape key handler, git pill conditional.
- [x] Render the row markup: `<div className="inline-task-row">`
      containing `<button className="inline-task-row-main">` (icon +
      subject + count) and conditional `<button
      className="inline-task-row-git">` (git stats). The row button
      toggles `expanded`. The git button keeps its own onClick
      (`panel.openOrActivatePage('review', { workingDirectory })`).
- [x] Render the popover conditionally. Position: absolute, above the
      row, class `inline-task-popover`. Popover rows: `<button>` with
      status icon + title (status toggle on click).
- [x] Add the CSS for `.inline-task-row`, `.inline-task-row-main`,
      `.inline-task-row-git`, `.inline-task-row-divider`, and
      `.inline-task-popover`, `.inline-task-popover-row`,
      `.inline-task-popover-row:hover`,
      `.inline-task-popover-status`,
      `.inline-task-popover-title`, `.inline-task-popover-title-done`
      in `src/styles/globals.css`. All visual values come from
      `--command-menu-*` tokens.

## Phase 2 — Wire into MessageInput

- [x] Add props to `MessageInputProps`:
      `tasks`, `gitStatus`, `onToggleTaskStatus`, `workingDirectory`,
      `showFileChanges`.
- [x] Inside `message-input-surface`, between `<AttachmentBar>` and
      `<RichTextInput>`, render `<InlineTaskRow>` wrapped in a
      `<div className="inline-task-row-wrap">` that provides the
      relative positioning context. Wrap only when there are tasks or
      file changes (the component already returns `null` then, but
      the wrapper must not leave a stray border when the row is
      absent).
- [x] Update `ChatView.tsx` to drop both `<FloatingTaskPanel>` blocks
      and pass `tasks`, `gitStatus`, `onToggleTaskStatus`,
      `workingDirectory`, `showFileChanges` into both `<MessageInput>`
      render sites (welcome + active).
- [x] Delete `src/components/layout/FloatingTaskPanel.tsx` and its
      `.test.tsx`. Delete `.floating-task-*` CSS rules.

## Phase 3 — Tests

- [x] Add `src/components/chat/InlineTaskRow.test.tsx` (replacement for
      the old test file). Cover:
  - Returns `null` when no tasks and no file changes.
  - File-change segment only when `tasks=[]` and git has changes.
  - Task row only when tasks exist and git empty.
  - Subject + `(completed/total)` rendered correctly when one task is
    `in_progress` and two are `completed`.
  - Click row → popover with N status buttons.
  - Click status button → `onToggleTaskStatus` called with the task.
  - Click git button → `panel.openOrActivatePage('review', ...)`
    called.
  - Click outside → popover closes.
  - `showFileChanges={false}` → file-change segment hidden even when
    git has changes.
  - `Escape` key while popover open → popover closes.
- [x] Mock framer-motion is **not** needed (D8). Mock
      `@/components/icons` and `@/hooks/usePanel` as today.

## Phase 4 — Type safety & visual verification

- [x] `npm run typecheck:all` clean (full pipeline including agent/
      conductor/voice workspaces).
- [x] `npm run test` for InlineTaskRow + MessageInput test files
      green (10 + 6 = 16 tests passing). Other failing tests in the
      suite (`packages/agent/tests/integration/DuyaAgent.test.ts`,
      `ChatView.permission-race.test.tsx`) are pre-existing and
      unrelated to plan 416 (verified by stashing changes).
- [ ] `npm run dev` (or `electron:dev`); trigger an agent run with
      multi-step tasks + git changes. Verify:
  - Row appears inside the input box above the textarea as soon as the
    first task arrives.
  - Input box visibly grows taller — no leftover floating pill above.
  - Click row → popover shows task list with completed state muted +
    line-through.
  - Git segment on the right shows `+X/-Y` and opens Code Review.
  - Refresh → row collapses (no persisted tasks).
- [ ] Screenshot before/after the change for the change log.

## Phase 5 — Review decision

- [ ] If the inline row eats too much vertical real-estate for users
      without active tasks → revert the row to floating (re-open this
      plan and adjust D1/D3).
- [ ] If users miss the floating affordance → add a thin horizontal
      band above the row (`height: 2px`, accent colour) when an
      in-progress task is active.

## Verification

- `npm run typecheck:all` ✅
- `npm run test` ✅
- Manual smoke: agent does multi-step plan → row appears in input box
  → click row → popover → click a status icon → status updates in
  TaskDrawer too.
- No regression: typing in the textarea, sending messages, slash
  commands, file attachments, plan-mode glow all unchanged.

## Out of Scope (deferred)

- Persisting the row's `expanded` state across sessions.
- Animating the row's height when tasks arrive / clear (today the row
  appears/disappears instantly with the input box growing/shrinking —
  that's acceptable).
- Migrating `TaskListSection.tsx`'s chrome (the sidebar TaskDrawer) to
  the same `--command-menu-*` style — separate plan if desired.
- A keyboard shortcut to open the popover (e.g. `Cmd+Shift+T`).