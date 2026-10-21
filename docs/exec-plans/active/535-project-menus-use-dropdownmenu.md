# Plan 535 — Project / Bot context menus reuse the shared `DropdownMenu`

> Status: Planning · Created 2026-09-14
> Owner: TBD
> Scope: refactor — visual-equivalent menu consolidation

## Problem

Two project-related menus and one bot-related menu each ship a hand-rolled
popover instead of reusing the shared `DropdownMenu` component. The
divergence causes drift: visual bugs that get fixed in one place don't reach
the others, keyboard navigation is inconsistent, click-outside / Esc behavior
varies, and the codebase carries three near-identical implementations of the
same primitive.

| File                                                              | Where                                                              | State                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------- |
| [src/components/projects/ProjectsView.tsx](../src/components/projects/ProjectsView.tsx)        | inline `<div className="absolute right-0 top-full z-50 ...">` (≈L362) | hand-rolled `absolute` div  |
| [src/components/layout/sidebar/ProjectGroupItem.tsx](../src/components/layout/sidebar/ProjectGroupItem.tsx)  | inline `<div className="project-dropdown-menu">` (≈L329)          | hand-rolled `fixed` div     |
| [src/components/layout/sidebar/BotContactListItem.tsx](../src/components/layout/sidebar/BotContactListItem.tsx) | inline `<div className="project-dropdown-submenu">` inside the section row (≈L670) | hand-rolled `absolute` div |

The shared component already supports everything they need:

- [src/components/ui/DropdownMenu.tsx](../src/components/ui/DropdownMenu.tsx)
  supports `action | submenu | divider | section` via the `MenuAction` union,
  controlled `open` / `onOpenChange`, anchored positioning with `align="end"`
  and `minWidth`, viewport-cap, click-outside, Escape, submenu hover intent,
  and an optional `portalClassName` to retain the existing project-dropdown
  CSS classes.

The other four callers — `SessionSelector`, `app-sidebar` (3 sites) — already
use it. Net win is removing ≈ 250 lines of menu plumbing.

## Non-goals

- **No visual change**. The existing `.project-dropdown-menu`,
  `.project-dropdown-item`, `.project-dropdown-divider`,
  `.project-dropdown-submenu`, `.project-dropdown-submenu-flip-left`,
  `.project-dropdown-item-checkable`, `.project-dropdown-item-with-caret`,
  `.project-dropdown-section-row` CSS in
  [src/styles/sidebar.css](../src/styles/sidebar.css) +
  [src/styles/sidebar-sections.css](../src/styles/sidebar-sections.css)
  must keep rendering identically. Tests must not regress.
- No i18n key changes (every existing translation must keep working).
- No behavior changes to section creation / project move / archive flows.
- No Electron preload or IPC changes (the menus are pure renderer).

## Approach

**Visual-equivalent port**: each hand-rolled menu is replaced with a
`<DropdownMenu>` whose `className` / `portalClassName` re-applies the
existing project-dropdown CSS classes so the look is byte-for-byte
unchanged. The `MenuAction` items carry the same `iconLeft`, `danger`,
`disabled`, and onSelect semantics; the section submenu becomes a
`MenuAction` with `kind: "submenu"`.

### Phase 1 — `ProjectsView` ⋯ menu

File: [src/components/projects/ProjectsView.tsx](../src/components/projects/ProjectsView.tsx)

- Delete `menuFor` state, `menuRef`, and the click-outside effect (lines
  ≈118, 122-138, 362-417).
- Replace the trigger `<button onClick={...}>` and inline `<div>` body with
  a `<DropdownMenu>` whose `items` is built from `row`-scoped handlers:

  ```tsx
  const projectRowMenuItems: MenuAction[] = useMemo(() => [
    { kind: "action", id: "new-chat", label: t("projects.newChatInProject"),
      iconLeft: <ChatCirclePlusIcon size={14} />,
      onSelect: () => handleNewChatInProject(row) },
    ...(row.kind === "entity" ? [{
      kind: "action" as const, id: "edit", label: t("projects.editProject"),
      iconLeft: <PencilSimpleIcon size={14} />,
      onSelect: () => { const entity = projects.find(p => p.project_id === row.projectId);
                         if (entity) setEditing(entity); },
    }] : []),
    { kind: "action", id: "archive", label: t("projects.archiveChats"),
      iconLeft: <ArchiveIcon size={14} />,
      disabled: row.sessions.length === 0,
      onSelect: () => handleArchiveChats(row) },
    { kind: "divider", id: "sep" },
    { kind: "action", id: "remove", label: t("projects.removeProject"),
      iconLeft: <TrashIcon size={14} />, danger: true,
      onSelect: () => void handleRemove(row) },
  ], [row, projects, t]);
  ```

- `className="project-dropdown-menu"`, `align="end"`, `minWidth={180}`,
  uncontrolled open (the click-outside is now DropdownMenu's job).
- `anchorPosition` is not needed: the trigger button is the trigger, so
  DropdownMenu's `useLayoutEffect` will auto-place relative to the button
  (matches today's right-edge anchor since `align="end"` aligns the menu's
  right edge with the trigger's right edge).

### Phase 2 — `ProjectGroupItem` ⋯ menu

File: [src/components/layout/sidebar/ProjectGroupItem.tsx](../src/components/layout/sidebar/ProjectGroupItem.tsx)

- Delete `showMenu`, `menuPos`, `menuRef`, `buttonRef`, `submenuFlipLeft`,
  `closeAllMenus`, `handleContextMenu`, `handleMenuClick`, the click-outside
  effect, the submenu hover intent refs, and the entire `project-dropdown-menu`
  JSX block (≈ 100 LOC).
- Replace the trigger `buttonRef` button with a `<DropdownMenu>` whose
  `trigger` is the existing `DotsThreeIcon` button.
- Items:

  ```tsx
  const projectMenuItems: MenuAction[] = useMemo(() => [
    { kind: "action", id: "open", label: t("project.openFolder"),
      iconLeft: <OpenFolderIcon size={14} />, onSelect: handleOpenFolder },
    { kind: "action", id: "copy", label: t("project.copyFolderPath"),
      iconLeft: <CopyIcon size={14} />, onSelect: handleCopyPath },
    {
      kind: "submenu", id: "section",
      label: currentSectionId
        ? t("sidebar.section.moveToSection")
        : t("sidebar.section.addToSection"),
      iconLeft: <FolderIcon size={14} />,
      items: [
        { kind: "action", id: "new-section",
          label: t("sidebar.section.newSection"),
          iconLeft: <PlusIcon size={14} />, onSelect: handleNewSection },
        ...(userSections.length > 0 ? [{ kind: "divider", id: "sep-sections" }] : []),
        ...userSections.map<MenuAction>(s => ({
          kind: "action", id: `section-${s.id}`, label: s.name,
          iconLeft: <FolderIcon size={14} />, description: s.id === currentSectionId ? "•" : undefined,
          onSelect: () => handleMoveToSection(s.id),
        })),
        ...(currentSectionId ? [
          { kind: "divider", id: "sep-remove" } as const,
          { kind: "action", id: "remove-section",
            label: t("sidebar.section.removeFromSection"),
            iconLeft: <XIcon size={14} />, danger: true,
            onSelect: handleRemoveFromSection } as const,
        ] : []),
      ],
    },
    { kind: "divider", id: "sep-delete" },
    { kind: "action", id: "delete", label: t("project.removeProject"),
      iconLeft: <ArchiveIcon size={14} />, danger: true, onSelect: handleDeleteProject },
  ], [...]);
  ```

- Visual fidelity: pass `className="project-dropdown-menu"`,
  `portalClassName="project-dropdown-section-row"` so the submenu uses the
  existing `.project-dropdown-submenu` styles; keep
  `align="start"` (current default for sidebar menus) and the current
  220px width.
- The "right-gutter → flip submenu left" logic from
  `Plan 471 v4` is automatically handled by `DropdownMenu`'s `useLayoutEffect`
  viewport-edge clamping — verify against today's behavior with the Playwright
  MCP once the change lands.
- Right-click context menu (`onContextMenu` on the row header) stays as-is;
  if needed we can re-anchor it via `anchorPosition`, but the existing UX is
  a separate surface from the ⋯ popover, so leave it for now.

### Phase 3 — `BotContactListItem` "Move to" section submenu

File: [src/components/layout/sidebar/BotContactListItem.tsx](../src/components/layout/sidebar/BotContactListItem.tsx)

- The bot list item already uses `<DropdownMenu>` for the main popover (lines
  to confirm) — confirm by reading the surrounding code.
- Replace the inline section-row JSX (L648-727) with a nested `submenu`
  `MenuAction` inside the same `items` array. The bot list item's main menu
  is therefore a single `DropdownMenu` call; no separate hover intent refs.
- Same `portalClassName="project-dropdown-submenu"` strategy keeps the visual
  identical. The flip-left logic is built into `DropdownMenu`.

### Phase 4 — Verification

- `npm run typecheck:all` (gate; AGENTS.md "Gates" rule).
- `npm run test` — no test files for these three components today, but the
  existing `*.test.ts` files that exercise `DropdownMenu` indirectly must
  stay green.
- Playwright MCP smoke (AGENTS.md "Gates" rule):
  - Sidebar project header ⋯ → menu opens, items clickable, submenu
    hover-intent behaves like before (the user reports any regression).
  - Sidebar bot contact ⋯ → "Move to" submenu opens to the right (or left
    when near right gutter).
  - Projects page row ⋯ → menu opens, the four actions work, archive stays
    disabled when sessions === 0.
- `grep -rn "project-dropdown-menu\|project-dropdown-section-row\|project-dropdown-submenu\b" src/` must return only CSS + (legacy) BotContactListItem
  references until Phase 3 lands. After Phase 3 it returns only CSS.
- Drop the unused `menuRef`, `buttonRef`, `submenuFlipLeft` state and the
  click-outside effects — fewer LOC than before.

## Decision log

- **(2026-09-14)** Plan opened. User confirms scope: ProjectsView +
  ProjectGroupItem + BotContactListItem, submenu via `MenuAction.submenu` +
  `portalClassName` to preserve existing CSS. No visual change.
- **(2026-09-14)** Non-goal: do NOT rename the `.project-dropdown-*` CSS
  classes in this plan. They are referenced from
  `BotContactListItem` and the stylesheet is shared with the sidebar's
  command-menu look-and-feel. A future plan can rename the CSS as a
  follow-up if desired.
- **(2026-09-14)** Decision: extend `MenuAction` with two optional
  `className` fields (action + submenu) so callers can inject legacy
  `.project-dropdown-item` / `.bot-dropdown-item` /
  `.project-dropdown-submenu` classes onto DropdownMenu's
  `.sidebar-project-menu-*` defaults. Both fields are **complete overrides
  on submenu** (replaces the default class) and **appended on action**
  (CSS cascade lets the legacy class win because it loads later). This
  keeps the visual byte-for-byte equivalent to the prior hand-rolled
  menus.

## Progress

- [x] Phase 1 — ProjectsView. Net −27 lines.
- [x] Phase 2 — ProjectGroupItem. Net −159 lines.
- [x] Phase 3 (partial) — DropdownMenu API extension (`submenu.className`,
      `action.className`).
- [ ] Phase 3 (BotContactListItem) — **blocked**: `master` has unrelated
      dirty changes from plan 534 (`packages/agent` tool search refactor,
      plans plugin removal, etc.) totaling ~3k lines. Stacking plan 535 on
      top makes the diff unreadable and the resulting `git add` would mix
      unrelated plans. Resume after the user either commits plan 534 or
      moves plan 535 into a worktree branch off `origin/master`.
- [ ] Playwright MCP visual verification (AGENTS.md "Gates" rule for UI
      changes) — depends on Phase 3 + a clean checkout.

## Verification so far

- `npm run typecheck:web` is clean for the four plan-535 files:
  `ProjectsView.tsx`, `ProjectGroupItem.tsx`, `DropdownMenu.tsx`,
  `BotContactListItem.tsx` (not yet modified). Pre-existing i18n / test
  type errors in `ExtensionInstallPrompt`, `MessageList.test.tsx`,
  `TodoToolRow`, etc. are unrelated to this plan.

## Open questions

- None at planning time. All three files share the same migration shape.