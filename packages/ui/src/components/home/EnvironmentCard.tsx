/**
 * EnvironmentCard — the always-visible project / environment picker that sits
 * in the middle of the new-chat page.
 *
 * ## Why this is a card and not a dropdown
 *
 * Claude Code's "New session" page shows one wide panel in the middle of the
 * empty canvas: an editable path field on top, the matching project row under
 * it, a hairline, and a "Choose environment" disclosure at the bottom. The
 * point is that the working directory is the first decision of a new session,
 * so it is stated plainly instead of being hidden behind a button.
 *
 * The measurements behind the styling were taken off a Claude Code 3.6556.2.0
 * capture (1920x1141 image pixels, ~1.385 image px per CSS px):
 *
 *   panel            431x155 image px -> ~311x112 CSS px
 *   panel border     #2C2C2C, 1 px, transparent interior (canvas shows through)
 *   path field pill  #1C1C1C fill, #2F2F2F border, text #DEDDDB
 *   hairline         #292929
 *   canvas           #151515
 *   primary text     #D1CEC5 (project name / "Choose environment")
 *   muted icon       #D1CBCB (folder glyph)
 *
 * The card keeps duya's own theme variables for the fill so it also reads
 * correctly in the light theme; only the geometry comes from the reference.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useConversationStore } from "@/stores/conversation-store";
import { useTranslation } from "@/hooks/useTranslation";
import {
  CheckIcon,
  ChevronDownIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
} from "@/components/icons";
import { DropdownMenu, type MenuAction } from "@/components/ui/DropdownMenu";

export interface EnvironmentCardProject {
  workingDirectory: string;
  projectName: string;
}

interface EnvironmentCardProps {
  selectedProject: EnvironmentCardProject | null;
  onSelectProject: (project: EnvironmentCardProject) => void;
  onNewBlankProject: () => void;
  onUseExistingFolder: () => void;
  /** Optional: create a no-project session (shared ~/.duya/workspace). */
  onNewNoProjectSession?: () => void;
  /** When false the page cannot pick a workspace, so the card shows a notice. */
  workspaceSelectionEnabled?: boolean;
}

export function EnvironmentCard({
  selectedProject,
  onSelectProject,
  onNewBlankProject,
  onUseExistingFolder,
  onNewNoProjectSession,
  workspaceSelectionEnabled = true,
}: EnvironmentCardProps) {
  const { projects, isHydrated, addProjectFolder } = useConversationStore(
    useShallow((s) => ({
      projects: s.projects,
      isHydrated: s.isHydrated,
      addProjectFolder: s.addProjectFolder,
    }))
  );
  const { t } = useTranslation();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [pathDraft, setPathDraft] = useState(selectedProject?.workingDirectory ?? "");
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [isCommittingPath, setIsCommittingPath] = useState(false);
  const pathInputRef = useRef<HTMLInputElement>(null);

  // The path field mirrors the selection until the user starts editing it.
  useEffect(() => {
    if (!isEditingPath) {
      setPathDraft(selectedProject?.workingDirectory ?? "");
    }
  }, [selectedProject?.workingDirectory, isEditingPath]);

  useEffect(() => {
    if (isEditingPath) pathInputRef.current?.focus();
  }, [isEditingPath]);

  const closeMenu = useCallback(() => {
    setIsMenuOpen(false);
    setProjectSearch("");
  }, []);

  const handleSelectProject = useCallback(
    (project: EnvironmentCardProject) => {
      onSelectProject(project);
      closeMenu();
    },
    [onSelectProject, closeMenu]
  );

  /**
   * Commit the typed path. A path that already belongs to a known project just
   * switches the selection; anything else is registered as a new project folder
   * first, so the session starts in a directory duya knows about.
   */
  const commitPath = useCallback(async () => {
    const trimmed = pathDraft.trim();
    if (!trimmed || isCommittingPath) {
      setPathDraft(selectedProject?.workingDirectory ?? "");
      setIsEditingPath(false);
      pathInputRef.current?.blur();
      return;
    }
    const known = projects.find((p) => p.workingDirectory === trimmed);
    if (known) {
      onSelectProject({ workingDirectory: known.workingDirectory, projectName: known.projectName });
      setPathDraft(known.workingDirectory);
      setIsEditingPath(false);
      pathInputRef.current?.blur();
      return;
    }
    setIsCommittingPath(true);
    try {
      const project = await addProjectFolder(trimmed);
      if (project) {
        onSelectProject({ workingDirectory: project.workingDirectory, projectName: project.projectName });
        setPathDraft(project.workingDirectory);
      } else {
        setPathDraft(selectedProject?.workingDirectory ?? "");
      }
    } catch {
      setPathDraft(selectedProject?.workingDirectory ?? "");
    } finally {
      setIsCommittingPath(false);
      setIsEditingPath(false);
      // Drop focus so the field shows the path from its start instead of
      // scrolling to the caret at the end of a long directory.
      pathInputRef.current?.blur();
    }
  }, [addProjectFolder, isCommittingPath, onSelectProject, pathDraft, projects, selectedProject?.workingDirectory]);

  const filteredProjects = useMemo(() => {
    const q = projectSearch.trim().toLocaleLowerCase();
    if (!q) return projects;
    return projects.filter((p) =>
      `${p.projectName} ${p.workingDirectory}`.toLocaleLowerCase().includes(q)
    );
  }, [projects, projectSearch]);

  // The project whose folder the typed path belongs to. When the path matches
  // a known project exactly, the card shows that project instead of inventing
  // a name from the path.
  const matchedProject = useMemo(() => {
    const trimmed = pathDraft.trim();
    if (!trimmed) return null;
    return (
      projects.find((p) => p.workingDirectory === trimmed) ??
      projects.find((p) => trimmed.startsWith(`${p.workingDirectory}/`) || trimmed.startsWith(`${p.workingDirectory}\\`)) ??
      null
    );
  }, [pathDraft, projects]);

  const displayProjectName = matchedProject?.projectName ?? selectedProject?.projectName ?? "";

  const projectMenuItems: MenuAction[] = useMemo(() => {
    const items: MenuAction[] = filteredProjects.map((project) => ({
      kind: "action",
      id: project.workingDirectory,
      label: project.projectName,
      description: project.workingDirectory,
      iconLeft:
        selectedProject?.workingDirectory === project.workingDirectory ? (
          <CheckIcon size={12} />
        ) : (
          <span className="sidebar-project-menu-check" />
        ),
      onSelect: () => handleSelectProject(project),
    }));
    if (filteredProjects.length === 0 && projectSearch.trim()) {
      items.push({
        kind: "action",
        id: "no-match",
        label: t("project.noProjectMatches"),
        disabled: true,
        onSelect: () => undefined,
      });
    }
    items.push({ kind: "divider", id: "project-actions-divider" });
    items.push({
      kind: "action",
      id: "new-blank-project",
      label: t("project.newBlankProject"),
      iconLeft: <FileIcon size={14} />,
      onSelect: () => {
        closeMenu();
        onNewBlankProject();
      },
    });
    items.push({
      kind: "action",
      id: "use-existing-folder",
      label: t("project.useExistingFolder"),
      iconLeft: <FolderOpenIcon size={14} />,
      onSelect: () => {
        closeMenu();
        onUseExistingFolder();
      },
    });
    if (onNewNoProjectSession) {
      items.push({
        kind: "action",
        id: "new-no-project-session",
        label: t("project.newNoProjectSession"),
        iconLeft: <NotePencilIcon size={14} />,
        onSelect: () => {
          closeMenu();
          onNewNoProjectSession();
        },
      });
    }
    return items;
  }, [
    filteredProjects,
    projectSearch,
    selectedProject?.workingDirectory,
    onNewNoProjectSession,
    onNewBlankProject,
    onUseExistingFolder,
    closeMenu,
    t,
  ]);

  const projectMenuHeader = (
    <div
      className="flex items-center gap-2"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <MagnifyingGlassIcon size={12} style={{ color: "var(--muted)", flexShrink: 0 }} />
      <input
        autoFocus
        type="text"
        value={projectSearch}
        onChange={(e) => setProjectSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            closeMenu();
          } else if (e.key === "Enter") {
            e.preventDefault();
            const first = filteredProjects[0];
            if (first) handleSelectProject(first);
          }
        }}
        placeholder={t("project.searchProjects")}
        aria-label={t("project.searchProjects")}
        className="bg-transparent border-0 outline-none text-xs"
        style={{ color: "var(--text)", minWidth: 0 }}
      />
    </div>
  );

  if (!workspaceSelectionEnabled) {
    return (
      <div className="environment-card" role="status">
        <div className="environment-card-notice">{t("chat.workspaceInherited")}</div>
      </div>
    );
  }

  return (
    <div className="environment-card" data-testid="environment-card">
      {/* Editable working directory — the field Claude puts on top. */}
      <div className="environment-card-path">
        <input
          ref={pathInputRef}
          className="environment-card-path-input"
          value={pathDraft}
          spellCheck={false}
          disabled={!isHydrated || isCommittingPath}
          aria-label={t("chat.workingDirectory")}
          title={t("chat.workingDirectory")}
          onChange={(e) => setPathDraft(e.target.value)}
          onFocus={() => setIsEditingPath(true)}
          onBlur={() => setIsEditingPath(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setPathDraft(selectedProject?.workingDirectory ?? "");
              setIsEditingPath(false);
            } else if (e.key === "Enter") {
              e.preventDefault();
              void commitPath();
            }
          }}
        />
        <span className="environment-card-path-check" aria-hidden="true">
          <CheckIcon size={14} />
        </span>
      </div>

      {/* The project that owns that directory. */}
      <div className="environment-card-project">
        <FolderIcon size={14} className="environment-card-project-icon" />
        <span className="environment-card-project-name">{displayProjectName}</span>
      </div>

      <div className="environment-card-divider" role="separator" />

      {/* The disclosure that opens the full project list. */}
      <DropdownMenu
        trigger={
          <button
            type="button"
            className="environment-card-choose"
            disabled={!isHydrated}
            aria-expanded={isMenuOpen}
          >
            <span className="environment-card-choose-label">{t("chat.chooseEnvironment")}</span>
            <ChevronDownIcon size={14} />
          </button>
        }
        items={projectMenuItems}
        header={projectMenuHeader}
        className="environment-card-menu"
        align="start"
        minWidth={320}
        maxWidth={400}
        maxHeight={320}
        open={isMenuOpen}
        onOpenChange={(open) => {
          if (open) {
            setIsMenuOpen(true);
          } else {
            closeMenu();
          }
        }}
      />
    </div>
  );
}
