"use client";

import { useState, useCallback, useEffect } from "react";
import { useConversationStore, type Thread, type ProjectGroup } from "@/stores/conversation-store";
import { ThreadListItem } from "../../shared/ThreadListItem";
import {
  FolderIcon,
  FolderOpenIcon,
  ArchiveIcon,
  DotsThreeIcon,
  FolderOpenIcon as OpenFolderIcon,
  CopyIcon,
  PlusIcon,
  CaretRightIcon,
  TrashIcon,
  XIcon,
} from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import { Button } from "@/components/ui/Button";
import { DropdownMenu, type MenuAction } from "@/components/ui/DropdownMenu";
import { useSidebarSectionsStore } from "@/stores/sidebar-sections-store";
import { InputDialog } from "@/components/ui/InputDialog";
import {
  useProjectsStore,
  type ProjectEntity,
} from "@/stores/projects-store";
import {
  archiveSessionsUnderProject,
  deleteSessionsUnderProject,
  openProjectFolder,
  copyProjectPath,
} from "@/lib/project-actions";
import { RemoveProjectConfirm } from "@/components/projects/RemoveProjectConfirm";

interface ProjectGroupItemProps {
  project: ProjectGroup;
  threads: Thread[];
  activeThreadId: string | null;
}

const THREAD_COLLAPSE_THRESHOLD = 5;

export function ProjectGroupItem({ project, threads, activeThreadId }: ProjectGroupItemProps) {
  const { t } = useTranslation();
  const { startNewChat, collapsedProjects, toggleProjectExpanded } = useConversationStore();
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
  const [isHovered, setIsHovered] = useState(false);
  const [visibleCount, setVisibleCount] = useState(THREAD_COLLAPSE_THRESHOLD);
  // Inline dialog for creating a brand-new section from the project menu.
  const [isNewSectionDialogOpen, setIsNewSectionDialogOpen] = useState(false);
  // Plan 535: anchor position for the shared DropdownMenu when opened from
  // the right-click context menu. The ⋯ button does not need this — its
  // anchor is computed from the button rect inside DropdownMenu.
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  // Plan 535: controlled open state. The ⋯ button toggles via the
  // DropdownMenu's own click handler; the right-click path forces `true`
  // after computing `menuAnchor`.
  const [menuOpen, setMenuOpen] = useState(false);
  // Plan 547: the shared RemoveProjectConfirm dialog state. Replaces the
  // old `handleDeleteProject` which looped `deleteThread` over the project's
  // sessions and left the project entity in place (the bug behind the
  // "删除项目" label doing the wrong thing).
  const [removeDialogProject, setRemoveDialogProject] = useState<ProjectEntity | null>(null);

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

  // ─── Section actions ───
  // The shared DropdownMenu already handles close-on-select, so these
  // callbacks only need to flip the InputDialog where needed.

  const handleNewSection = useCallback(() => {
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
      void assignProjectToSection(sectionId, project.workingDirectory);
    },
    [assignProjectToSection, project.workingDirectory],
  );

  const handleRemoveFromSection = useCallback(() => {
    void unassignProject(project.workingDirectory);
  }, [unassignProject, project.workingDirectory]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenuAnchor({ x: e.clientX, y: e.clientY });
    setMenuOpen(true);
  }, []);

  // Plan 547: project entity lookup. The sidebar's ProjectGroup is the legacy
  // shape (workingDirectory + projectName). Project actions consume the
  // new ProjectEntity shape (multi-path + name + icon + color). The lookup
  // falls back to a minimal synthetic entity when the project is path-only
  // (recent folder, no entity registered yet), so the menu still works.
  const resolveProjectEntity = useCallback((): ProjectEntity | null => {
    const found = useProjectsStore
      .getState()
      .getByWorkingDirectory(project.workingDirectory);
    if (found) return found;
    if (!project.workingDirectory) return null;
    return {
      project_id: `path:${project.workingDirectory}`,
      canonical_root: project.workingDirectory,
      name: project.projectName,
      description: null,
      paths: [{ path: project.workingDirectory, description: null }],
      icon: null,
      color: null,
      created_at: project.createdAt,
      last_seen_at: project.lastActivity,
    };
  }, [project.workingDirectory, project.projectName, project.createdAt, project.lastActivity]);

  const handleOpenFolder = useCallback(() => {
    void openProjectFolder({
      project_id: project.workingDirectory,
      canonical_root: project.workingDirectory,
      name: project.projectName,
      description: null,
      paths: [{ path: project.workingDirectory, description: null }],
      icon: null,
      color: null,
      created_at: project.createdAt,
      last_seen_at: project.lastActivity,
    });
  }, [project.workingDirectory, project.projectName, project.createdAt, project.lastActivity]);

  const handleCopyPath = useCallback(() => {
    void copyProjectPath({
      project_id: project.workingDirectory,
      canonical_root: project.workingDirectory,
      name: project.projectName,
      description: null,
      paths: [{ path: project.workingDirectory, description: null }],
      icon: null,
      color: null,
      created_at: project.createdAt,
      last_seen_at: project.lastActivity,
    });
  }, [project.workingDirectory, project.projectName, project.createdAt, project.lastActivity]);

  // Plan 547: the old `handleDeleteProject` is gone. The three project-scoped
  // danger operations are now split into explicit, well-labeled handlers
  // composed from `project-actions.ts` (the shared adapter). All three
  // surface the same verbs as the Projects page.
  const handleArchiveAllSessions = useCallback(() => {
    const entity = resolveProjectEntity();
    if (entity) void archiveSessionsUnderProject(entity);
  }, [resolveProjectEntity]);

  const handleDeleteAllSessions = useCallback(() => {
    const entity = resolveProjectEntity();
    if (entity) void deleteSessionsUnderProject(entity);
  }, [resolveProjectEntity]);

  const handleDeleteProject = useCallback(() => {
    const entity = resolveProjectEntity();
    if (entity) setRemoveDialogProject(entity);
  }, [resolveProjectEntity]);

  const handleNewThread = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    startNewChat({
      workingDirectory: project.workingDirectory,
      projectName: project.projectName,
    });
  }, [startNewChat, project.workingDirectory, project.projectName]);

  // Plan 535: build the project context menu as MenuActions so the shared
  // DropdownMenu can render it. The "section" item is a submenu that mirrors
  // Plan 471 v4's "Move to / Add to section" flow. Plan 547 splits the previous
  // single "delete project" item into three explicit danger-labeled operations
  // (archive all sessions / delete all sessions / delete project entity),
  // each composed from `project-actions.ts`.
  const projectMenuItems: MenuAction[] = [
    {
      kind: "action",
      id: "open-folder",
      label: t("project.openFolder"),
      className: "project-dropdown-item",
      iconLeft: <OpenFolderIcon size={14} />,
      onSelect: handleOpenFolder,
    },
    {
      kind: "action",
      id: "copy-path",
      label: t("project.copyFolderPath"),
      className: "project-dropdown-item",
      iconLeft: <CopyIcon size={14} />,
      onSelect: handleCopyPath,
    },
    {
      kind: "submenu",
      id: "section",
      label: currentSectionId
        ? t("sidebar.section.moveToSection")
        : t("sidebar.section.addToSection"),
      iconLeft: <FolderIcon size={14} />,
      className: "project-dropdown-submenu",
      items: [
        {
          kind: "action",
          id: "section-new",
          label: t("sidebar.section.newSection"),
          className: "project-dropdown-item",
          iconLeft: <PlusIcon size={14} />,
          onSelect: handleNewSection,
        },
        ...(userSections.length > 0 ? [{ kind: "divider", id: "section-list-sep" } as const] : []),
        ...userSections.map<MenuAction>((s) => ({
          kind: "action" as const,
          id: `section-${s.id}`,
          label: s.name,
          iconLeft: <FolderIcon size={14} />,
          description: s.id === currentSectionId ? "•" : undefined,
          onSelect: () => handleMoveToSection(s.id),
        })),
        ...(currentSectionId
          ? [
              { kind: "divider", id: "section-remove-sep" } as const,
              {
                kind: "action" as const,
                id: "section-remove",
                label: t("sidebar.section.removeFromSection"),
                className: "project-dropdown-item",
                iconLeft: <XIcon size={14} />,
                danger: true,
                onSelect: handleRemoveFromSection,
              },
            ]
          : []),
      ],
    },
    { kind: "divider", id: "danger-sep" },
    {
      kind: "action",
      id: "archive-sessions",
      label: t("project.archiveProjectSessions"),
      className: "project-dropdown-item",
      iconLeft: <ArchiveIcon size={14} />,
      onSelect: handleArchiveAllSessions,
    },
    {
      kind: "action",
      id: "delete-sessions",
      label: t("project.deleteProjectSessions"),
      className: "project-dropdown-item",
      iconLeft: <TrashIcon size={14} />,
      danger: true,
      onSelect: handleDeleteAllSessions,
    },
    {
      kind: "action",
      id: "delete-project",
      label: t("projects.removeProject"),
      className: "project-dropdown-item",
      iconLeft: <TrashIcon size={14} />,
      danger: true,
      onSelect: handleDeleteProject,
    },
  ];

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
          <DropdownMenu
            className="project-dropdown-menu"
            align="start"
            minWidth={220}
            open={menuOpen}
            onOpenChange={(next) => {
              setMenuOpen(next);
              if (!next) setMenuAnchor(null);
            }}
            anchorPosition={menuAnchor ?? undefined}
            items={projectMenuItems}
            trigger={
              <button
                type="button"
                className="project-group-menu-btn"
                style={{ opacity: isHovered || menuOpen ? 1 : 0 }}
                aria-label={t('project.options')}
              >
                <DotsThreeIcon size={16} stroke={2.5} />
              </button>
            }
          />
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

      <InputDialog
        isOpen={isNewSectionDialogOpen}
        title={t('sidebar.dialog.newSection.title')}
        description={t('sidebar.dialog.newSection.description')}
        placeholder={t('sidebar.dialog.newSection.placeholder')}
        onConfirm={handleNewSectionConfirm}
        onCancel={() => setIsNewSectionDialogOpen(false)}
      />

      <RemoveProjectConfirm
        open={removeDialogProject !== null}
        project={removeDialogProject}
        onCancel={() => setRemoveDialogProject(null)}
      />
    </>
  );
}