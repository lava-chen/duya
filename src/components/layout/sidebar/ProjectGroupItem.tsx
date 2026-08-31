"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useConversationStore, type Thread, type ProjectGroup } from "@/stores/conversation-store";
import { ThreadListItem } from "./ThreadListItem";
import { FolderIcon, FolderOpenIcon, ArchiveIcon, DotsThreeIcon, FolderOpenIcon as OpenFolderIcon, CopyIcon, PlusIcon, CaretRightIcon, XIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import { Button } from "@/components/ui/Button";
import { useSidebarSectionsStore } from "@/stores/sidebar-sections-store";
import { InputDialog } from "@/components/ui/InputDialog";

interface ProjectGroupItemProps {
  project: ProjectGroup;
  threads: Thread[];
  activeThreadId: string | null;
}

const THREAD_COLLAPSE_THRESHOLD = 5;

export function ProjectGroupItem({ project, threads, activeThreadId }: ProjectGroupItemProps) {
  const { t } = useTranslation();
  const { deleteThread, startNewChat, collapsedProjects, toggleProjectExpanded } = useConversationStore();
  // Plan 471: project ↔ section assignment. The selector subscribes to the
  // store so the right-click menu label flips to "添加 / 移动" the moment a
  // project is assigned via the sidebar UI. Reading via getState() (the
  // previous shape) would never re-render after a store change.
  const currentSectionId = useSidebarSectionsStore((state) =>
    state.findSectionForProject(project.workingDirectory),
  );
  const {
    sections: userSections,
    assignProjectToSection,
    unassignProject,
    createSection,
  } = useSidebarSectionsStore();
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  // Plan 471 v4: when the context menu sits in the right ~180px of the
  // viewport, the cascading "分区" submenu would overflow past the screen
  // edge. We flip it to render on the left of the parent menu instead.
  const [submenuFlipLeft, setSubmenuFlipLeft] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [visibleCount, setVisibleCount] = useState(THREAD_COLLAPSE_THRESHOLD);
  // Section submenu state. Two-state machine:
  //  - "closed": submenu not shown
  //  - `sectionSubmenuOpen`: hover/select state. The parent menu stays open
  //    while the submenu floats to the right.
  const [sectionSubmenuOpen, setSectionSubmenuOpen] = useState(false);
  // Inline dialog for creating a brand-new section from the project menu.
  const [isNewSectionDialogOpen, setIsNewSectionDialogOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const sectionMenuRef = useRef<HTMLDivElement>(null);

  // Sort threads by updatedAt, most recent first
  const sortedThreads = [...threads].sort((a, b) => b.updatedAt - a.updatedAt);

  // Reveal sessions incrementally (5 at a time) so expanding never jumps
  // straight from 5 to the full list.
  const hasMoreThreads = sortedThreads.length > visibleCount;
  const visibleThreads = sortedThreads.slice(0, visibleCount);
  const revealCount = Math.min(THREAD_COLLAPSE_THRESHOLD, sortedThreads.length - visibleCount);

  const isExpanded = !collapsedProjects.has(project.workingDirectory);

  const handleToggle = useCallback(() => {
    toggleProjectExpanded(project.workingDirectory);
    // Re-opening the group always starts from the base limit instead of
    // continuing the previous reveal count.
    setVisibleCount(THREAD_COLLAPSE_THRESHOLD);
  }, [toggleProjectExpanded, project.workingDirectory]);

  const closeAllMenus = useCallback(() => {
    setShowMenu(false);
    setSectionSubmenuOpen(false);
  }, []);

  // ─── Section actions ───
  // These callbacks are stable so the menu items can be declared as
  // plain DOM without recreating closures on every render.

  const handleNewSection = useCallback(() => {
    setShowMenu(false);
    setSectionSubmenuOpen(false);
    setIsNewSectionDialogOpen(true);
  }, []);

  const handleNewSectionConfirm = useCallback(
    async (name: string) => {
      setIsNewSectionDialogOpen(false);
      const created = await createSection({ name });
      if (created) {
        await assignProjectToSection(created.id, project.workingDirectory);
      }
    },
    [createSection, assignProjectToSection, project.workingDirectory],
  );

  const handleMoveToSection = useCallback(
    (sectionId: string) => {
      setShowMenu(false);
      setSectionSubmenuOpen(false);
      void assignProjectToSection(sectionId, project.workingDirectory);
    },
    [assignProjectToSection, project.workingDirectory],
  );

  const handleRemoveFromSection = useCallback(() => {
    setShowMenu(false);
    setSectionSubmenuOpen(false);
    void unassignProject(project.workingDirectory);
  }, [unassignProject, project.workingDirectory]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const menuWidth = 220;
    const menuHeight = 240;
    let x = e.clientX;
    let y = e.clientY;

    // Adjust position if menu would go off screen
    if (x + menuWidth > window.innerWidth) {
      x = window.innerWidth - menuWidth - 8;
    }
    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight - 8;
    }

    // Plan 471 v4: if the parent menu sits within the right gutter that
    // would clip the cascading submenu (parent.right + submenuWidth ≥
    // viewport), flip the submenu to render on the left of the parent.
    // The submenu is min-width 180px so we reserve exactly that plus a
    // 12px gutter; anything tighter triggers the flip.
    const SUBMENU_MIN_WIDTH = 180;
    const SUBMENU_GUTTER = 12;
    const wouldOverflowRight =
      x + menuWidth + SUBMENU_MIN_WIDTH + SUBMENU_GUTTER >
      window.innerWidth;
    setSubmenuFlipLeft(wouldOverflowRight);

    setMenuPos({ x, y });
    // Same reset as the ⋯ button: clean submenu state on every open.
    setSectionSubmenuOpen(false);
    setShowMenu(true);
  }, []);

  const handleOpenFolder = useCallback(() => {
    closeAllMenus();
    if (project.workingDirectory && window.electronAPI?.shell?.openPath) {
      window.electronAPI.shell.openPath(project.workingDirectory);
    }
  }, [project.workingDirectory, closeAllMenus]);

  const handleCopyPath = useCallback(() => {
    closeAllMenus();
    if (project.workingDirectory) {
      navigator.clipboard.writeText(project.workingDirectory);
    }
  }, [project.workingDirectory, closeAllMenus]);

  const handleDeleteProject = useCallback(() => {
    closeAllMenus();
    // Delete all threads in this project
    for (const thread of sortedThreads) {
      deleteThread(thread.id);
    }
  }, [deleteThread, sortedThreads, closeAllMenus]);

  const handleMenuClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const menuWidth = 220;
      const menuHeight = 240;
      let x = rect.right - menuWidth;
      let y = rect.bottom + 4;

      // Adjust position if menu would go off screen
      if (x < 0) {
        x = 8;
      }
      if (x + menuWidth > window.innerWidth) {
        x = window.innerWidth - menuWidth - 8;
      }
      if (y + menuHeight > window.innerHeight) {
        y = rect.top - menuHeight - 4;
      }

      // Plan 471 v4: same submenu overflow guard as handleContextMenu.
      // See notes there for why 180+12 are the magic numbers.
      const SUBMENU_MIN_WIDTH = 180;
      const SUBMENU_GUTTER = 12;
      const wouldOverflowRight =
        x + menuWidth + SUBMENU_MIN_WIDTH + SUBMENU_GUTTER >
        window.innerWidth;
      setSubmenuFlipLeft(wouldOverflowRight);

      setMenuPos({ x, y });
    }
    // Reset the submenu state on every open: users get a clean slate.
    setSectionSubmenuOpen(false);
    setShowMenu((prev) => !prev);
  }, []);

  const handleNewThread = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    // Unify with the sidebar "new chat" entry: open the lazy NewChatView
    // composer with this project preselected instead of eagerly creating a
    // thread. The real session appears in the sidebar only after the user
    // sends, so an unsent draft never pollutes the project group.
    startNewChat({
      workingDirectory: project.workingDirectory,
      projectName: project.projectName,
    });
  }, [startNewChat, project.workingDirectory, project.projectName]);

  // Close menu on click outside
  useEffect(() => {
    if (!showMenu) return;

    const handleClickOutside = (e: MouseEvent) => {
      const inMainMenu = menuRef.current?.contains(e.target as Node);
      const inSubMenu = sectionMenuRef.current?.contains(e.target as Node);
      if (!inMainMenu && !inSubMenu) {
        closeAllMenus();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showMenu, closeAllMenus]);

  // Submenu hover intent: when the user mouses into the section row, the
  // submenu floats to the right. `intent` delays the close so a brief
  // diagonal movement does not collapse the submenu immediately.
  const submenuHoverIntent = useRef<number | null>(null);
  const handleSubmenuEnter = useCallback(() => {
    if (submenuHoverIntent.current) {
      window.clearTimeout(submenuHoverIntent.current);
      submenuHoverIntent.current = null;
    }
    setSectionSubmenuOpen(true);
  }, []);
  const handleSubmenuLeave = useCallback(() => {
    if (submenuHoverIntent.current) {
      window.clearTimeout(submenuHoverIntent.current);
    }
    submenuHoverIntent.current = window.setTimeout(() => {
      setSectionSubmenuOpen(false);
      submenuHoverIntent.current = null;
    }, 200);
  }, []);
  useEffect(() => {
    return () => {
      if (submenuHoverIntent.current) window.clearTimeout(submenuHoverIntent.current);
    };
  }, []);

  return (
    <>
      <div className="project-group-item" onContextMenu={handleContextMenu}>
        {/* Project Header */}
        <div
          className="project-group-header"
          title={project.workingDirectory}
          onClick={handleToggle}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          {isExpanded ? (
            <FolderOpenIcon size={14} className="project-group-icon" />
          ) : (
            <FolderIcon size={14} className="project-group-icon" />
          )}
          <span className="project-group-name">{project.projectName}</span>

          {/* Plus button - visible on hover, for creating new thread */}
          <button
            type="button"
            className="project-group-add-btn"
            onClick={handleNewThread}
            style={{ opacity: isHovered ? 1 : 0 }}
            aria-label={t('thread.newThread')}
            title={t('thread.newThread')}
          >
            <PlusIcon size={14} stroke={2.5} />
          </button>

          {/* Three dots menu button - visible on hover */}
          <button
            ref={buttonRef}
            type="button"
            className="project-group-menu-btn"
            onClick={handleMenuClick}
            style={{ opacity: isHovered || showMenu ? 1 : 0 }}
            aria-label={t('project.options')}
          >
            <DotsThreeIcon size={16} stroke={2.5} />
          </button>
        </div>

        {/* Thread List */}
        {isExpanded && (
          <div className="project-group-threads">
            {visibleThreads.map((thread) => (
              <ThreadListItem
                key={thread.id}
                thread={thread}
                isActive={thread.id === activeThreadId}
              />
            ))}
            {hasMoreThreads && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="project-group-expand-all justify-start"
                onClick={() => setVisibleCount((c) => c + THREAD_COLLAPSE_THRESHOLD)}
              >
                <CaretRightIcon size={10} />
                <span>{t('common.showAll', { count: revealCount })}</span>
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Dropdown Menu */}
      {showMenu && (
        <div
          ref={menuRef}
          className="project-dropdown-menu"
          style={{ top: menuPos.y, left: menuPos.x }}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="project-dropdown-item"
            onClick={handleOpenFolder}
          >
            <OpenFolderIcon size={14} />
            <span>{t("project.openFolder")}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="project-dropdown-item"
            onClick={handleCopyPath}
          >
            <CopyIcon size={14} />
            <span>{t("project.copyFolderPath")}</span>
          </Button>
          {/* Plan 471: section submenu trigger row. The popover floats to
              the right of this row when the cursor enters (it stays open
              briefly after the cursor leaves so a diagonal move does not
              collapse it). */}
          <div
            className="project-dropdown-section-row"
            onMouseEnter={handleSubmenuEnter}
            onMouseLeave={handleSubmenuLeave}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="project-dropdown-item project-dropdown-item-with-caret"
              onClick={() => setSectionSubmenuOpen((p) => !p)}
              aria-expanded={sectionSubmenuOpen}
            >
              <FolderIcon size={14} />
              <span>
                {currentSectionId
                  ? t('sidebar.section.moveToSection')
                  : t('sidebar.section.addToSection')}
              </span>
              <CaretRightIcon
                  size={12}
                  className="ml-auto"
                  // Plan 471 v4: when the submenu flips left, mirror the
                  // caret so it visually points at the submenu opening
                  // (matching the user's mental model).
                  style={submenuFlipLeft ? { transform: 'scaleX(-1)' } : undefined}
                />
            </Button>
            {sectionSubmenuOpen && (
              <div
                ref={sectionMenuRef}
                className={`project-dropdown-submenu${submenuFlipLeft ? ' project-dropdown-submenu-flip-left' : ''}`}
                onMouseEnter={handleSubmenuEnter}
                onMouseLeave={handleSubmenuLeave}
              >
                {/* The first row is always the "新建分区…" entry. From
                    there the user can build a section on the fly and
                    immediately move this project into it. */}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="project-dropdown-item"
                  onClick={handleNewSection}
                  data-section-action="new"
                >
                  <PlusIcon size={14} />
                  <span>{t('sidebar.section.newSection')}</span>
                </Button>
                {userSections.length > 0 && <div className="project-dropdown-divider" />}
                {userSections.map((s) => (
                  <Button
                    key={s.id}
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={`project-dropdown-item project-dropdown-item-checkable ${
                      s.id === currentSectionId ? 'is-current' : ''
                    }`}
                    onClick={() => handleMoveToSection(s.id)}
                    data-section-id={s.id}
                  >
                    <FolderIcon size={14} />
                    <span>{s.name}</span>
                  </Button>
                ))}
                {currentSectionId && (
                  <>
                    <div className="project-dropdown-divider" />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="project-dropdown-item danger"
                      onClick={handleRemoveFromSection}
                    >
                      <XIcon size={14} />
                      <span>{t('sidebar.section.removeFromSection')}</span>
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="project-dropdown-divider" />
          <Button
            type="button"
            variant="danger"
            size="sm"
            className="project-dropdown-item danger"
            onClick={handleDeleteProject}
          >
            <ArchiveIcon size={14} />
            <span>{t("project.removeProject")}</span>
          </Button>
        </div>
      )}
      {/* Plan 471: dialog for creating a section on the fly from the
          project context menu. The new section is committed and then the
          current project is assigned to it in one shot. */}
      <InputDialog
        isOpen={isNewSectionDialogOpen}
        title={t('sidebar.dialog.newSection.title')}
        description={t('sidebar.dialog.newSection.description')}
        placeholder={t('sidebar.dialog.newSection.placeholder')}
        onConfirm={handleNewSectionConfirm}
        onCancel={() => setIsNewSectionDialogOpen(false)}
      />
    </>
  );
}
