# Sidebar Session Management Refactor

> Status: in-progress. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the sidebar session management to use a unified **Section** abstraction. Sections sit at the same level as the existing system grouping. There are two flavors:

- **System sections** (`cron`, `gateway`, `wakeup`, `project (uncategorized)`, `pinned`). They are derived from session kind and are always rendered.
- **User sections**. The user can create groups, name them, and assign projects (`workingDirectory`s) to them. Unassigned projects fall through to the `__uncategorized__` system section.

Both flavors share the same render path; the only difference is whether you can drag projects between them and rename them.

**Architecture:**

- **DB**: new tables `sidebar_sections` and `sidebar_section_projects` (Migration #53). The mapping is many-to-many: a `workingDirectory` may belong to zero or one user section. System sections are not stored — they are derived from session-kind prefixes (`cron:`, `gw-`, `wakeless-`) and pinned flags.
- **Store**: new `src/stores/sidebar-sections-store.ts` + core-db `SidebarSectionsStore`. The existing `conversation-store.ts` is preserved (sessions are still flat in `threads[]`); what changes is **how the sidebar consumes** `threads`.
- **Render**: replace the existing `byProject` / `singleList` switches in `app-sidebar.tsx` with a `sidebarStructure` derived value: `[systemSection('cron'), ...userSections, systemSection('gateway'), systemSection('wakeup'), systemSection('uncategorized'), systemSection('pinned')]`.
- **Context menu**: `ProjectGroupItem`'s right-click menu gains a "分区" submenu with: "新建分区…", "移动到 → <list of sections>", "移出 section".

**Tech Stack:** React 19, Zustand (existing), Vitest (existing), better-sqlite3 (existing), Tailwind + globals.css (existing).

**Open-question defaults applied** (user-confirmed via AskUserQuestion):
- Section ⇔ Project relationship: **Section wraps Projects**.
- Gateway sessions: **shown in a built-in Gateway section** (previously fully filtered).
- Wakeup sessions: **shown in a built-in Wakeup section, collapsed by default**.

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `electron/db/schema.ts` | modify | Migration #53: `sidebar_sections` + `sidebar_section_projects` |
| `electron/db/core/sidebar-sections-store.ts` | new | CRUD for `sidebar_sections` + `sidebar_section_projects` |
| `electron/db/core/stores.ts` | modify | Wire `SidebarSectionsStore` into `getCoreStores()` |
| `electron/ipc/sidebar-sections-handlers.ts` | new | `ipcMain.handle('sidebar-sections:*')` |
| `electron/ipc/index.ts` | modify | Register the new handlers |
| `electron/preload.ts` | modify | Expose `window.electronAPI.sidebarSections.*` |
| `src/lib/sidebar-sections-ipc.ts` | new | Thin wrappers around preload |
| `src/stores/sidebar-sections-store.ts` | new | Zustand store for sections + section projects |
| `src/components/layout/sidebar/section-system.ts` | new | Pure data: list of system sections, kind detection |
| `src/components/layout/sidebar/SidebarSectionItem.tsx` | new | Render a section (header + list of projects or threads) |
| `src/components/layout/sidebar/SidebarThreadItem.tsx` | new | Render a thread for cron/gateway/wakeup sections (reuses ThreadListItem where possible) |
| `src/components/layout/sidebar/ProjectGroupItem.tsx` | modify | Add "分区" submenu |
| `src/components/layout/app-sidebar.tsx` | modify | New render structure; drop `projectGroupBy` (or keep as fallback) |
| `src/stores/conversation-store.ts` | modify | Remove the old "cron sidebar group" hardcoded `__cron__` branch (replaced by system section) |
| `src/i18n/zh.ts` / `en.ts` | modify | New keys for section UX |
| `src/styles/globals.css` | modify | `.sidebar-section-item`, `.sidebar-section-header`, etc. |

---

## Tasks

### Task 1 — Database schema (Migration #53)

**Files:**
- `electron/db/schema.ts` — add Migration #53 at the end of the `migrations` array.

Add Migration #53: `create_sidebar_sections_tables`. Create:
- `sidebar_sections (id, name, icon, color, sort_order, collapsed, created_at, updated_at)`
- `sidebar_section_projects (section_id, working_directory, sort_order, created_at)` with composite PK and `ON DELETE CASCADE`.

Indexes:
- `idx_sidebar_sections_sort_order` on `sidebar_sections(sort_order)`.
- `idx_sidebar_section_projects_section` on `sidebar_section_projects(section_id)`.

The migration must be idempotent — guard the `CREATE TABLE`/`CREATE INDEX` with `IF NOT EXISTS`, and the composite PK with the same.

### Task 2 — Backend store + IPC

**Files:**
- `electron/db/core/sidebar-sections-store.ts` (new) — `SidebarSectionsStore` class with: `listSections`, `createSection`, `updateSection`, `deleteSection`, `listSectionProjects`, `assignProject`, `unassignProject`, `reorderSections`, `reorderProjectsInSection`.
- `electron/db/core/stores.ts` — add the new store to `getCoreStores()` next to `sessions` / `messages` / etc.
- `electron/ipc/sidebar-sections-handlers.ts` (new) — wire each `SidebarSectionsStore` method to a `ipcMain.handle('sidebar-sections:<method>', ...)` channel.
- `electron/ipc/index.ts` — `registerSidebarSectionsHandlers(getCoreStores)`.
- `electron/preload.ts` — expose `window.electronAPI.sidebarSections.{list, create, update, remove, reorder, assignProject, unassignProject, reorderProjects}`.

### Task 3 — Frontend Zustand store

**Files:**
- `src/lib/sidebar-sections-ipc.ts` (new) — thin async wrappers around `window.electronAPI.sidebarSections.*`.
- `src/stores/sidebar-sections-store.ts` (new) — Zustand store with: `sections`, `sectionProjects`, `hydrated`, `loadFromDatabase`, `createSection`, `updateSection`, `removeSection`, `assignProject`, `unassignProject`, `reorderSections`, `reorderProjectsInSection`, `toggleSectionCollapsed`. No `persist()` middleware — this lives in SQLite.

### Task 4 — System section helpers

**Files:**
- `src/components/layout/sidebar/section-system.ts` (new) — define `systemSectionIds` and `detectSystemSectionKind(thread)`:
  - `cron:` id prefix → `'cron'`
  - `gw-` id prefix → `'gateway'`
  - `wakeless-` id prefix → `'wakeup'`
  - pinned → `'pinned'`
  - else → `'project'` (works through `workingDirectory` grouping)

Exports `getThreadKind(thread): ThreadKind` and `groupKindThreadIds(threads, kind)`.

### Task 5 — Render components

**Files:**
- `src/components/layout/sidebar/SidebarSectionItem.tsx` (new) — props: `section: SidebarSectionDisplay`, children. Renders a header with the section name, a collapse caret, and the body content. Header click → toggles `collapsed` (in-store).
- `src/components/layout/app-sidebar.tsx` (modify) — replace the existing `pinnedThreads / cronThreads / projectGroupBy / singleList / noProjectThreads` cascade with a single `sidebarGroups` derived value that yields an ordered array of section descriptors. Each descriptor is `{ id, name, kind, items: (Thread | ProjectGroup)[], collapsed }`. Items are passed to either `SidebarSectionItem` + child dispatch (`ProjectGroupItem` for `'project'` kind, `ThreadListItem` for system kinds).

### Task 6 — Project right-click menu

**Files:**
- `src/components/layout/sidebar/ProjectGroupItem.tsx` (modify) — add a "分区" submenu to `project-dropdown-menu`:
  - "新建分区…" → opens `InputDialog` to name a new section, then `assignProject(section.id, project.workingDirectory)`.
  - "移动到 → ..." → list of all user sections; clicking moves the project.
  - "移出分区" → only rendered when `currentSectionId !== null`.

### Task 7 — i18n

**Files:**
- `src/i18n/zh.ts`
- `src/i18n/en.ts`

Add under `sidebar.*` namespace:
- `sidebar.section.cron`: `定时任务`
- `sidebar.section.gateway`: `网关`
- `sidebar.section.wakeup`: `唤醒`
- `sidebar.section.pinned`: `置顶`
- `sidebar.section.uncategorized`: `未分组`
- `sidebar.section.newSection`: `新建分区`
- `sidebar.section.moveToSection`: `移动到…`
- `sidebar.section.removeFromSection`: `移出分区`
- `sidebar.section.uncategorizedHint`: `把项目拖入分区，或在右击菜单中选择 "新建分区"`
- `sidebar.dialog.newSection.title`: `为分区命名`
- `sidebar.dialog.newSection.placeholder`: `例：工作 / 学习 / 副业`

### Task 8 — CSS

**Files:**
- `src/styles/globals.css`

Add `.sidebar-section-item`, `.sidebar-section-header`, `.sidebar-section-title`, `.sidebar-section-actions`, `.sidebar-section-collapse`, and reuse `.project-group-*` / `.thread-list` for children.

### Task 9 — Verify

- `npm run typecheck:all` must pass before commit.
- Boot the app, create a new section, drag a project into it. Delete the section, verify project returns to uncategorized.
- Trigger a cron run via the Automation page, verify it appears under "定时任务" section.
- (Optional, deferred to follow-up) Drag-and-drop reorder using HTML5 DnD; first iteration uses the right-click menu only.

---

## Plan 471 v3 — decisions after user screenshots (implemented)

User feedback came in three rounds; the following final decisions supersede the original draft:

1. **No count badge on section headers.** Removed `count` from `SidebarSectionItem`. The Codex reference has plain "name + chevron" headers.
2. **Header order is `name → chevron → trailing`** (NOT chevron first). CSS: `.sidebar-section-name { flex: 0 1 auto }` keeps the chevron glued to the label; `.sidebar-section-trailing { margin-left: auto }` right-aligns actions.
3. **No separate "未分组" (uncategorized) section.** Renamed to `__system__:project` using the "项目" label; unassigned projects land there.
4. **No stale `SidebarProjectHeader`.** It was replaced by `ProjectSectionActions`, which now renders in the "项目" section's `trailing` slot as a `⋯ +` group:
   - `⋯` opens the popup menu with **整理** (按项目 / 在一个列表中) and **排序方式** (优先级 / 最近更新 / 手动排序) — the old layout/sort controls, relocated into a popup (user requested: "放到一个弹窗选项列表里").
   - `+` creates a new blank project.
5. **Cron section is capped** at `CRON_SIDEBAR_VISIBLE = 8` most-recent runs, default collapsed (as are gateway + wakeup), with a "查看全部 N 个" link that routes to the Automation page. Prevents a 200+-run job from flooding the sidebar.
6. **Pinned section** stays expanded and visible only when non-empty.

---

## Out of scope (deferred)

- Drag-and-drop reorder of sections / projects within sections (right-click menu reorder is enough for v1).
- Renaming a section inline (use right-click → 重命名).
- Per-section overrides for `projectGroupBy` / `projectSortBy` (single global for now).
- Migration shim for existing `__cron__` collapsed state — `collapsedProjects` Set still works because each system section has its own synthetic collapse state, derived from an in-memory Set keyed by section id (`sys:project`, `sys:cron`, etc.).
