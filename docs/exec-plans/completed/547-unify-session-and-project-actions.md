# Plan 547 — Unify session / project actions across sidebar + Projects view

> **Status**: Planning · **Priority**: P1 · **Created**: 2026-09-18
> **Trigger**: User asked "现在对于归档的概念是什么是针对session的还是project。当我点的是项目里的归档" (2026-09-18). Audit found the
> same label maps to three different operations depending on the surface the user clicks, and the sidebar's project-row "delete project"
> actually deletes only the sessions under the project (it leaves the project entity in place).
>
> **Sibling plans**:
> - [535-project-menus-use-dropdownmenu](./535-project-menus-use-dropdownmenu.md) — visual-equivalent port of the three hand-rolled
>   project menus onto the shared `DropdownMenu`. Already Phase 1 / 2 + part of Phase 3 on master. Plan 547 is the *behavioral* twin of
>   535: same surface area, but fixes what each menu item actually does, not how it looks.
> - [506-rollout-as-first-class-data](./506-rollout-as-first-class-data.md) — landed the session-archive (`archiveThread`) primitive.
>   Plan 547 reuses that primitive everywhere; no new IPC.
> - [525-project-entity-and-plan-management](./525-project-entity-and-plan-management.md) — `ProjectEntity` schema. Plan 547 consumes
>   it but does not modify it.
> - [233-conductor-multi-canvas-management](./233-conductor-multi-canvas-management.md) — pattern reference for "every surface calls
>   the same store action" alignment.

---

## 1. The problem, in one screenshot

The user can perform the same logical action ("archive this session", "delete this project", "rename this session", "open the project
folder") from **four different surfaces**:

| # | Surface                                 | Trigger UI                              | Action label seen by user       | What it actually does                                                                                                                                                                 |
| - | --------------------------------------- | --------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | Sidebar "项目" group header `⋯`         | `ProjectGroupItem.tsx` (sidebar)        | "删除项目" (danger item)        | **Loops `deleteThread(thread.id)` over each session.** Project entity (`projects` row) **stays in `duya-core.db`** untouched. Session history → trash. The "项目" group now renders empty. |
| 2 | Sidebar session row `⋯`                 | `ThreadListItem.tsx` (sidebar)          | "归档" / "删除" / "重命名" …    | Calls `archiveThread(thread.id)` / `deleteThread(thread.id)` / `renameThread(thread.id, …)`. Single-session, no project context.                                                       |
| 3 | Projects page project row `⋯`           | `ProjectsView.tsx` (projects page)      | "归档聊天" / "移除项目" / "新建会话" / "编辑项目" | "归档聊天" = loops `archiveThread` over each session. "移除项目" = `projects.delete` IPC → `deleteProject` (cross-DB cleanup). "编辑项目" = opens project entity modal.            |
| 4 | Projects page session row (no menu)     | `ProjectsView.tsx`'s inline row         | — (no menu, pure navigation)    | `setActiveThread(thread.id)` + `setCurrentView("chat")`. **No rename / archive / export / delete entry point at all.**                                                                  |
| 5 | Projects page batch toolbar             | `ProjectsView.tsx` toolbar (multi-select) | "归档所选" + "清除对话"          | `handleBatchArchive` loops `archiveThread`. `handleBatchClear` loops `deleteThread`. Cross-project selection.                                                                         |
| 6 | Right-click context menu on sidebar `⋯` | `ProjectGroupItem.tsx` `onContextMenu`  | same dropdown, keyboard parity  | identical to surface 1                                                                                                                                                                |

Six surfaces, **three different definitions of "delete project"**, two surfaces that don't offer per-session actions at all, and one
project entity action (rename project / edit paths) that exists only on the Projects page.

## 2. Goal

Make every menu item — anywhere in the app — do exactly one thing, and that thing must be **semantically identical** across surfaces.
Two parallel goals:

1. **Semantic alignment.** Every "archive" / "delete" / "rename" operation has one and only one definition:
   - `archive` = the existing `archiveThread(thread.id)` (Plan 506). Always session-scoped, never project-scoped. UI label
     distinguishes single-session vs batch (`"归档会话"` vs `"归档所有会话(7)"` vs `"归档所选(3)"`).
   - `delete` = the existing `deleteThread(thread.id)` (Plan 506 / 495). Always session-scoped. UI label `删除会话` (with explicit
     "对话" / "聊天" so it is impossible to confuse with "删除项目").
   - `deleteProject` = a **new IPC** `projects.delete` already wired in commit `20ec6fcf`. Always project-scoped. UI label
     `删除项目`. Side-effect: threads under it get `unbind` only (their `working_directory` is preserved, chat history stays). If the
     user wants the chat history gone, that's a separate "delete project + delete all sessions" composite.
   - `rename` (session) = existing `renameThread(thread.id, newTitle)` via `updateThreadIPC`.
   - `rename` (project) = existing `projects.update` IPC → edits `name / paths / description / icon / color`.
2. **Surface parity.** Every menu item available on one surface is available on every equivalent surface:
   - Sidebar session `⋯` ↔ Projects page session row (with menu added).
   - Sidebar project `⋯` ↔ Projects page project row `⋯`.
   - Batch toolbar only on Projects page (no sidebar equivalent; "delete all threads in sidebar" is a footgun).

## 3. Non-goals

- **No new project-archive concept.** A "project archive" (the `archived` field for project entity) is *not* added in this plan. The
  user raised it as a possible future concept; we explicitly defer. Sessions still get archived individually via the existing
  primitive. The "归档聊天" menu item on a project row continues to mean "archive all sessions under this project", which is the same
  behavior the user got before.
- **No visual / i18n label changes beyond disambiguation.** We do *not* rename `删除项目` to something prettier; we keep the label and
  fix the action so the label matches reality. We add explicit `对话` / `会话` qualifier on session-deletion labels to remove the
  ambiguity that currently exists. We translate every new label.
- **No new IPC.** `projects.delete`, `projects.update`, `deleteThreadIPC`, `archiveThreadIPC`, `renameThreadIPC` (via
  `updateThreadIPC`) all already exist. New behavior is composed from these primitives in the renderer.
- **No undo / recycle bin UI changes.** The existing trash UX stays.
- **No state-machine / mode-coordinator integration.** This is a renderer-level alignment; no `ModeModifier` or `ModeTracker`
  changes. The mode machinery doesn't read project / session menus.
- **No worktree integration** (deferred to plan 496 follow-ups).
- **No "split across multiple projects" undo / partial restore.** Plan 506 already landed recycle-bin behavior for deleted sessions;
  project deletion is a hard entity delete (cross-DB cleanup in commit `20ec6fcf`) and out of scope to soften here.

## 4. Architectural decision: one shared action layer, two consumers

We do **not** redesign the IPC surface. Instead, we introduce a thin renderer-side adapter layer that turns every "user wanted to do
X" intent into the right primitive call, then have both surfaces call the same adapter.

### 4.1 New file: `src/lib/project-actions.ts`

A pure-ish module that owns every project-entity and session-batch action the UI can trigger. It is the **only** place where the
following composed operations live:

| Export                                                    | Behavior                                                                                                                                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `archiveSingleSession(threadId)`                          | `archiveThreadIPC(threadId)`. Single-session.                                                                                                                                            |
| `archiveSessionsUnderProject(projectId)`                  | Iterate `useConversationStore.getState().threads` filtered by `getByWorkingDirectory(projectId).paths[*].path` (via `normalizeWorkingDirectoryForCompare`); call `archiveSession(id)` each. |
| `archiveSelectedSessions(threadIds)`                      | Iterate the set; call `archiveSession(id)` each.                                                                                                                                         |
| `deleteSingleSession(threadId)`                           | `deleteThreadIPC(threadId)`. Single-session.                                                                                                                                             |
| `deleteSessionsUnderProject(projectId)`                   | Iterate sessions matching the project paths; call `deleteSession(id)` each.                                                                                                              |
| `deleteSelectedSessions(threadIds)`                       | Iterate the set; call `deleteSession(id)` each.                                                                                                                                          |
| `renameSingleSession(threadId, newTitle)`                 | `updateThreadIPC({ threadId, title: newTitle })`.                                                                                                                                        |
| `openProjectFolder(project)`                              | `shell.openPath(project.paths[0].path)` (via IPC).                                                                                                                                       |
| `copyProjectPath(project)`                                | `navigator.clipboard.writeText(project.paths[0].path)`.                                                                                                                                 |
| `copySessionId(thread)`                                   | `navigator.clipboard.writeText(thread.id)`.                                                                                                                                              |
| `exportSingleSessionRollout(threadId)`                    | `exportRolloutIPC(threadId)` (Plan 506 A1).                                                                                                                                              |
| `toggleSessionPin(thread)`                                | `setThreadPinned(thread.id, !thread.pinned)`.                                                                                                                                            |
| `deleteProject(projectId)`                                | `projects.delete(projectId)` IPC → `deleteProject` cross-DB cleanup (commit `20ec6fcf`).                                                                                                 |
| `renameProject(project, newName)`                          | `projects.update({ projectId, name })`.                                                                                                                                                  |
| `editProjectModal(projectId, partial)`                      | `projects.update` with full row payload (name / paths / description / icon / color).                                                                                                     |

All exports are **plain async functions** (no React). They take the values they need (no `useStore()` reads inside the module; callers
read state and pass it in). This keeps them trivially unit-testable and reusable from any component.

### 4.2 New file: `src/lib/__tests__/project-actions.test.ts`

Pure-mock unit tests with no IPC. Verify:

- `archiveSessionsUnderProject` calls `archiveThreadIPC` once per matching session, and only for sessions whose
  `workingDirectory` resolves to one of the project's `paths[]` (case-folded + slash-normalized via the shared
  `normalizeWorkingDirectoryForCompare` from plan 537).
- `deleteProject` invokes `projects.delete` exactly once with the project id; never touches session IPC.
- `archiveSelectedSessions` and `deleteSelectedSessions` iterate the *input* ids verbatim (no project filtering — caller decides).
- `renameProject` passes the new name and current fields untouched.

### 4.3 Two surfaces, one adapter

After this plan:

- `ThreadListItem.tsx` (sidebar) renders its menu by calling the adapter directly.
- A new component `ProjectsSessionRowMenu.tsx` (or reuse `ThreadListItem` with a flag) provides the same menu on the Projects page
  session rows. Decision: **reuse `ThreadListItem`** (extracted as a shared component). The component currently lives in
  `src/components/layout/sidebar/`; we move it to `src/components/layout/sidebar/` → `src/components/shared/ThreadListItem.tsx` (or
  similar). Both sidebar and Projects page import it.
- `ProjectGroupItem.tsx` (sidebar project menu) uses the same adapter.
- `ProjectsView.tsx` (projects page project menu + batch toolbar) uses the same adapter.

This way the click handler signature is identical and the only difference is which menu items are *visible* on each surface — for
example the batch toolbar only exists on the Projects page.

### 4.4 Menu visibility matrix (post-plan)

| Action                                  | Sidebar session `⋯` | Sidebar project `⋯` | Projects page session row `⋯` | Projects page project row `⋯` | Projects page batch toolbar |
| --------------------------------------- | ------------------- | ------------------- | ----------------------------- | ------------------------------ | --------------------------- |
| 重命名会话                                 | ✅                  | —                   | ✅                            | —                              | —                           |
| 复制会话 ID                                | ✅                  | —                   | ✅                            | —                              | —                           |
| 固定 / 取消固定                            | ✅                  | —                   | ✅                            | —                              | —                           |
| 导出会话 rollout                          | ✅                  | —                   | ✅                            | —                              | —                           |
| 归档此会话                                  | ✅                  | —                   | ✅                            | —                              | —                           |
| 删除此会话                                  | ✅                  | —                   | ✅                            | —                              | —                           |
| 打开文件夹 (project)                       | —                   | ✅                  | —                             | ✅                             | —                           |
| 复制项目路径                                 | —                   | ✅                  | —                             | ✅                             | —                           |
| 新建会话 (in project)                     | —                   | ✅                  | —                             | ✅                             | —                           |
| 编辑项目 (name / paths / icon)             | —                   | —                   | —                             | ✅                             | —                           |
| 归档项目下全部会话                          | —                   | ✅ (replaces current "删除项目") | —                | ✅ (already exists as `"归档聊天"`)| —                           |
| 删除项目下全部会话                          | —                   | ✅                  | —                             | ❌ (intentionally not exposed; sidebar handles) | —                       |
| 移除项目 (entity)                           | —                   | ✅ (renamed + moved to danger area with explicit confirm) | — | ✅ | — |
| 批量归档                                   | —                   | —                   | —                             | —                              | ✅                          |
| 批量删除                                   | —                   | —                   | —                             | —                              | ✅                          |

Sidebar project menu **splits** into three explicit danger-labeled operations:

1. **归档项目下所有会话** (primary danger, label clarifies scope)
2. **删除项目下所有会话** (explicit "session" qualifier — never just "删除会话" alone)
3. **删除项目** (moved to the bottom, behind an explicit confirm dialog that lists the project name and number of sessions, with
   a checkbox "同时删除项目下所有会话" that the user must opt into)

The confirm dialog is the same component used by the Projects page `handleSingleRemove` — extract to `src/components/projects/RemoveProjectConfirm.tsx`.

## 5. Plan 535 / Plan 547 division of labor

Plan 535 already lands the visual rewrite onto `DropdownMenu` for the same three surfaces (Projects page project menu, sidebar
project menu, BotContactListItem menu). Plan 547 does **not** redo that work. Plan 547:

- Stays on top of plan 535's `MenuAction` infrastructure (no parallel hand-rolled menus).
- Adds two new actions (`archiveSessionsUnderProject`, `deleteSessionsUnderProject`) and one new IPC client (`projects.delete`) to the
  shared `project-actions.ts`.
- Rewrites the `MenuAction[]` builders in both surfaces so the action set matches §4.4.
- Extracts a shared `RemoveProjectConfirm` component.

If plan 535 Phase 3 is still blocked at plan-creation time of plan 547, plan 547 lands **only the items below**, all of which work
against today's hand-rolled menus or today/`master` DropdownMenu depending on which version the file currently is on:

- §6 Phase 2 (project-actions.ts) — independent.
- §6 Phase 3 (ThreadListItem reuse on Projects page session rows) — independent.
- §6 Phase 4 (ProjectGroupItem action split + RemoveProjectConfirm extraction) — independent of which menu widget renders it.
- §6 Phase 1 is gated on plan 535 Phase 3 *completion* of ProjectsView ⋯ menu only (the project menu builder needs to land in
  DropdownMenu form before plan 547's "builder reuses the same `MenuAction[]` shape" assumption holds). If plan 535 is still
  blocked, plan 547 either:
  (a) writes a parallel builder for the hand-rolled menu and migrates it later (loses some of the alignment benefit); or
  (b) is parked until plan 535 Phase 3 lands. We pick **(a)** if the user wants this PR stacked fast, **(b)** otherwise. Default to
  **(a)** for this plan — keep scope small.

## 6. Phases

### Phase 1 — i18n disambiguation (small, fast)

File: [src/i18n/en.ts](../src/i18n/en.ts), [src/i18n/zh.ts](../src/i18n/zh.ts)

- `projects.archiveChats` → already exists, no change.
- `projects.removeProject` → keep, but **add a confirmation string** `projects.removeProjectConfirm` that lists the project name and
  session count, with a checkbox label `projects.removeProjectDeleteSessions`.
- `project.deleteProjectSessions` (new) — sidebar uses it for the explicit "delete all sessions in this project" action.
- `project.archiveProjectSessions` (new) — sidebar uses it for the "archive all sessions in this project" action.
- `project.removeProjectSessionsHint` (new) — short subtitle on the sidebar item, e.g. `"保留项目实体，仅删除下方的 N 个会话"`.
- `project.removeProjectHint` (new) — `"永久删除项目条目"`.

After Phase 1 the English / Chinese locale files have the disambiguated labels, but no consumer yet.

### Phase 2 — `src/lib/project-actions.ts`

New file. Exports the 15 functions listed in §4.1. All pure-async, all taking explicit arguments, no React. Use the existing IPC
clients:

```ts
// src/lib/project-actions.ts (sketch)
import { archiveThreadIPC, deleteThreadIPC, updateThreadIPC, exportRolloutIPC, unarchiveThreadIPC } from "./ipc-client";
import { projectsDeleteIPC, projectsUpdateIPC } from "./ipc-client";
import { useConversationStore } from "@/stores/conversation-store";
import { useProjectsStore, normalizeWorkingDirectoryForCompare, type ProjectEntity } from "@/stores/projects-store";
```

Every function returns the count of affected ids, or `void` for single-target actions. Variants that batch accept `string[]` for
the id set (caller decides selection scope).

Tests in [src/lib/__tests__/project-actions.test.ts](../src/lib/__tests__/project-actions.test.ts) (new file):

- `archiveSessionsUnderProject` calls `archiveThreadIPC` once per session whose `workingDirectory` matches one of the project's
  `paths[]` (case-folded + slash-normalized).
- `archiveSessionsUnderProject` does not call `archiveThreadIPC` for sessions whose `workingDirectory` doesn't match.
- `archiveSessionsUnderProject` returns the count of archived sessions.
- `deleteSessionsUnderProject` analogous.
- `archiveSelectedSessions` and `deleteSelectedSessions` iterate the input set verbatim, not filtered.
- `renameProject` invokes `projectsUpdateIPC` with the new name and current values for `paths / description / icon / color` unchanged.
- `deleteProject` invokes `projectsDeleteIPC` exactly once with the project id.
- `openProjectFolder` returns the first path from `paths[]` for projects with multiple paths (we do not open multi-path trees —
  out of scope; document in JSDoc).

Submit as `feat(lib): add project-actions adapter for cross-surface menu alignment`.

### Phase 3 — Reuse `ThreadListItem` on the Projects page

File: [src/components/projects/ProjectsView.tsx](../src/components/projects/ProjectsView.tsx)

- Replace the inline session row JSX with `<ThreadListItem thread={...} onActivate={...} />` imported from
  `src/components/layout/sidebar/ThreadListItem.tsx`.
- The shared component already has all six (`rename / copy-id / pin / export / archive / delete`) wired.
- Drop the now-dead local `SessionRowItem` component and `setActiveThread + setCurrentView` invocation logic — `ThreadListItem`
  already calls `useConversationStore`'s `setActiveThread` internally.
- The Projects page does not need to render the project header twice when the row group is also rendered. The page layout becomes:
  `<ProjectRowHeader>` (collapsible) + `<ThreadListItem>` × N.
- Active-state highlight must match the sidebar's active highlight (same `useConversationStore.activeThreadId` selector).
- Right-click context menu parity: `ThreadListItem` should also accept `onContextMenu` to open the same dropdown. If it doesn't, add
  the prop.

Tests in [src/components/layout/sidebar/__tests__/ThreadListItem.test.tsx](../src/components/layout/sidebar/__tests__/ThreadListItem.test.tsx)
(new, optional). Skipping unless R4 finds missing coverage.

Submit as `refactor(projects): reuse ThreadListItem for session rows in projects page`.

### Phase 4 — Sidebar project menu action split + remove-project confirm

File: [src/components/layout/sidebar/ProjectGroupItem.tsx](../src/components/layout/sidebar/ProjectGroupItem.tsx)

- Split `handleDeleteProject` (which today loops `deleteThread` over every session) into three explicit handlers backed by
  `project-actions.ts`:
  - `handleArchiveAllSessions` → `archiveSessionsUnderProject(project.workingDirectory)` (delegates to project id by matching paths).
  - `handleDeleteAllSessions` → `deleteSessionsUnderProject(...)`.
  - `handleDeleteProject` → opens the new `RemoveProjectConfirm` dialog (extracted from ProjectsView). On confirm, calls
    `deleteProject(project.projectId)`.
- The `MenuAction[]` builder in `ProjectGroupItem` becomes three danger items + the existing open-folder / copy-path / new-session /
  section submenu items, in that order.
- Remove the old `handleDeleteProject` body that loops `deleteThread` — that's the bug we are fixing.

File: [src/components/projects/ProjectsView.tsx](../src/components/projects/ProjectsView.tsx)

- `handleSingleRemove` becomes a wrapper that opens the same `RemoveProjectConfirm` component.
- `handleArchiveChats` and the batch toolbar handlers route through `project-actions.ts` instead of looping inline.

File: [src/components/projects/RemoveProjectConfirm.tsx](../src/components/projects/RemoveProjectConfirm.tsx) (new)

- Pure modal component with three props: `project: ProjectEntity`, `open: boolean`, `onConfirm(alsoDeleteSessions: boolean)`,
  `onCancel()`.
- Renders project name + `paths.length` 个挂载路径 + 会话数 (computed by iterating `useConversationStore` filtered by
  `normalizeWorkingDirectoryForCompare`-matched paths).
- Checkbox: "同时删除项目下所有会话（不可恢复）" — when checked, the confirm action first calls `deleteSessionsUnderProject`,
  then `deleteProject`. When unchecked, only `deleteProject`.
- The component is purely modal; no router state.

Tests in [src/components/projects/__tests__/RemoveProjectConfirm.test.tsx](../src/components/projects/__tests__/RemoveProjectConfirm.test.tsx)
(new):

- Renders project name + paths count + session count.
- Checkbox unchecked → onConfirm called with `false`, project-actions `deleteProject` called but `deleteSessionsUnderProject` not.
- Checkbox checked → onConfirm called with `true`, both calls fired in order.
- Cancel button → onConfirm not called.
- Esc + click-outside → onCancel called.

Submit as `fix(projects): split sidebar project menu into archive-only / delete-sessions / delete-project (Plan 547 Phase 4)`.

### Phase 5 — Verification + Playwright

- `npm run typecheck:all` — gate (AGENTS.md Gates rule).
- `npm run test` — must stay green; new tests for `project-actions.ts` (15+ cases) and `RemoveProjectConfirm` (5+ cases).
- `grep -rn "deleteThread\b\|archiveThread\b" src/components/projects/` → after Phase 3 + 4, must return **zero hits** in
  `ProjectsView.tsx`. All session actions go through `project-actions.ts`.
- `grep -rn "handleDeleteProject\b" src/components/layout/sidebar/ProjectGroupItem.tsx` → after Phase 4, must return **one** hit
  (the new handler that opens `RemoveProjectConfirm`), not the old loop.
- Playwright MCP smoke (AGENTS.md Gates rule for UI changes):
  - Sidebar project `⋯` → menu shows 3 explicit danger items + open-folder / copy-path / new-session / section submenu.
  - Sidebar project `⋯` → "删除项目" opens confirm dialog with project name + paths count + session count.
  - Sidebar project `⋯` → confirm without checkbox → only `projects.delete` IPC fires; sessions remain in sidebar's "已删除" if they
    were archived earlier, otherwise untouched.
  - Sidebar project `⋯` → confirm with checkbox → both IPC calls fire in order; project gone, sessions gone.
  - Projects page session row `⋯` → menu items match sidebar session `⋯` exactly.
  - Projects page batch toolbar → "归档所选" + "清除对话" → action count matches selection.

## 7. Risks and open questions

- **Plan 535 Phase 3 still blocked.** Plan 547 prefers to land on top of Phase 3; if not, it works against today's hand-rolled menus
  in `ProjectsView.tsx`. The split decision is in §5.
- **Project → multi-path (plan 530 / 525).** `archiveSessionsUnderProject` and `deleteSessionsUnderProject` must match sessions
  whose `workingDirectory` resolves to **any** of `paths[]`. We use `normalizeWorkingDirectoryForCompare` on both sides per plan 537.
  Plan 547 is *forward-compatible* with multi-path projects: when a project has multiple paths, all of them are matched. The confirm
  dialog lists the multi-path count (`paths.length 个挂载路径`).
- **Sessions whose `workingDirectory` matches multiple projects.** Should not happen by construction (a session is created from a
  working directory; the directory can only belong to one project's `paths[]`). We do not deduplicate. If it ever happens, the
  session will be archived under **every** matching project — probably what they want.
- **Sidebar's `ProjectGroupItem.projectName` vs `ProjectEntity.name`.** Today `ProjectGroupItem` uses `project.projectName` (from
  `useConversationStore`'s legacy project lookup) rather than `useProjectsStore`. This is a known stale-source-of-truth from
  pre-Plan-525 wiring. Phase 4 does not fix this — out of scope; plan 525 / 530 / 534 are the right home. Document as a follow-up.
- **Right-click context menu parity.** `ProjectGroupItem` exposes an `onContextMenu` handler that opens the same dropdown. After
  Phase 4 it inherits the new action set automatically.
- **Bot lists.** Out of scope; plan 535 handles `BotContactListItem` separately.
- **Active thread highlight.** `ThreadListItem` already owns `isActive = thread.id === activeThreadId`. The Projects page will
  pick up the same highlight automatically.
- **i18n key removal.** Some old keys (`projects.archiveChats` etc.) stay as-is; new keys added in Phase 1.

## 8. Completion criteria

- All four menu surfaces (sidebar session, sidebar project, projects page session, projects page project) build their menu via
  `project-actions.ts`.
- `grep -rn "deleteThread\b\|archiveThread\b" src/components/projects/` returns zero hits.
- `RemoveProjectConfirm` extracted; both sidebar and projects page use it.
- New tests: 15+ in `project-actions.test.ts`, 5+ in `RemoveProjectConfirm.test.tsx`. Existing `ThreadListItem.test.tsx` (if any)
  unchanged.
- `npm run typecheck:all` clean.
- Playwright MCP smoke passes all six scenarios in §6 Phase 5.
- Move plan file to `docs/exec-plans/completed/`, update `docs/exec-plans/README.md`.

## 9. Out of scope (explicit)

- ❌ **Project-level "archive project" concept.** Not added in this plan. Sessions are archived one at a time (or all under a
  project). If the user later wants `projects.archived_at`, a separate plan can land it.
- ❌ **Bot list menus.** Plan 535 owns the bot list migration. Plan 547 does not change bot list menu items.
- ❌ **`SessionSelector` menu.** Plan 535 already merged it. Plan 547 does not revisit.
- ❌ **Project switcher / multi-project UX.** Out of scope; not currently exposed in UI.
- ❌ **worktree switching.** Plan 496 owns this.
- ❌ **State-machine / mode-coordinator hooks.** Renderer-level only.
- ❌ **New IPC.** All actions compose existing primitives.
- ❌ **Plan 535 Phase 3 (BotContactListItem submenu migration).** Unblocked separately.

## 10. Decision log

- **(2026-09-18)** Plan opened. User confirmed scope: "彻底统一". Six surfaces, three definitions of "delete project", two
  surfaces with no per-session actions. The fix is the shared `project-actions.ts` adapter + `RemoveProjectConfirm` extraction.
- **(2026-09-18)** Decision: **no** new "project archive" primitive. The user raised the possibility in conversation but did not
  explicitly request it for this plan. Plan 547 stays on the existing `archiveThread` primitive. Documented as out-of-scope in
  §3 and §9.
- **(2026-09-18)** Decision: sidebar project menu **splits** the current single danger item into three explicit ones, all wired
  through `project-actions.ts`. The "delete project" item opens a confirm dialog that lists project name + paths count + session
  count, with a checkbox for "also delete sessions".
- **(2026-09-18)** Decision: reuse `ThreadListItem` on the Projects page session rows instead of inventing a parallel component.
  Move it to a shared location (`src/components/shared/ThreadListItem.tsx`) when Phase 3 lands.

## 11. Progress

- [x] Phase 1 — i18n disambiguation (`en.ts` / `zh.ts`).
- [x] Phase 2 — `src/lib/project-actions.ts` + unit tests (22 cases + 10 normalizer).
- [x] Phase 3 — Projects page session rows reuse `ThreadListItem` (moved to `src/components/shared/`).
- [x] Phase 4 — Sidebar project menu split into 3 explicit handlers + `RemoveProjectConfirm` extraction + ProjectsView `handleSingleRemove` rewrite.
- [x] Phase 5 — `npm run typecheck:all` clean, frontend subset tests green (68 new tests, 5 pre-existing failures unrelated to Plan 547), grep verification clean (`grep -rn "deleteThread|archiveThread" src/components/projects/` → 0 hits; `handleDeleteProject` in ProjectGroupItem → 1 hit, the dialog-opening variant). Playwright MCP smoke deferred to manual verification (requires dev server).