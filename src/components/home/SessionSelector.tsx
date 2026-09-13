"use client";

import { useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useConversationStore } from "@/stores/conversation-store";
import { useTranslation } from "@/hooks/useTranslation";
import {
  ChevronDownIcon,
  FileIcon,
  FolderOpenIcon,
  NotePencilIcon,
  MagnifyingGlassIcon,
  CheckIcon,
} from "@/components/icons";
import { DropdownMenu, type MenuAction } from "@/components/ui/DropdownMenu";
import { ReferencesPanel } from "./ReferencesPanel";

interface SessionSelectorProps {
  selectedProject: { workingDirectory: string; projectName: string } | null;
  onSelectProject: (project: { workingDirectory: string; projectName: string }) => void;
  onNewBlankProject: () => void;
  onUseExistingFolder: () => void;
  /** Optional: create a no-project session (shared ~/.duya/workspace). */
  onNewNoProjectSession?: () => void;
  onSelectThread: (threadId: string) => void;
  /**
   * When provided, replaces the "build in X" header with this greeting line
   * and moves the project selector to a row below the input area.
   */
  greeting?: string;
  showRecentThreads?: boolean;
  maxRecentThreads?: number;
  children?: React.ReactNode;
}

export function SessionSelector({
  selectedProject,
  onSelectProject,
  onNewBlankProject,
  onUseExistingFolder,
  onNewNoProjectSession,
  onSelectThread,
  greeting,
  showRecentThreads = true,
  maxRecentThreads = 8,
  children,
}: SessionSelectorProps) {
  const { threads, projects, isHydrated } = useConversationStore(
    useShallow((s) => ({
      threads: s.threads,
      projects: s.projects,
      isHydrated: s.isHydrated,
    }))
  );
  const { t, locale } = useTranslation();
  const [isProjectDropdownOpen, setIsProjectDropdownOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"threads" | "references">("threads");
  const [projectSearch, setProjectSearch] = useState("");

  const closeProjectDropdown = useCallback(() => {
    setIsProjectDropdownOpen(false);
    setProjectSearch("");
  }, []);

  const handleSelectProject = (project: { workingDirectory: string; projectName: string }) => {
    onSelectProject(project);
    closeProjectDropdown();
    setActiveTab("threads");
  };

  const handleNewBlankProject = () => {
    closeProjectDropdown();
    onNewBlankProject();
  };

  const handleUseExistingFolder = () => {
    closeProjectDropdown();
    onUseExistingFolder();
  };

  const handleNewNoProjectSession = () => {
    closeProjectDropdown();
    onNewNoProjectSession?.();
  };

  const recentThreads = threads.slice(0, maxRecentThreads);
  const filteredProjects = useMemo(() => {
    const q = projectSearch.trim().toLocaleLowerCase();
    if (!q) return projects;
    return projects.filter((p) =>
      `${p.projectName} ${p.workingDirectory}`.toLocaleLowerCase().includes(q)
    );
  }, [projects, projectSearch]);

  const formatDate = (timestamp: number): string => {
    const now = Date.now();
    const diff = now - timestamp;
    const days = Math.floor(diff / 86400000);
    const date = new Date(timestamp);
    const localeStr = locale === 'zh' ? 'zh-CN' : 'en-US';

    if (days < 7) {
      return date.toLocaleDateString(localeStr, { weekday: "short" });
    }
    return date.toLocaleDateString(localeStr, { month: "short", day: "numeric" });
  };

  // Build the menu items: one entry per matching project (with a
  // description for the working directory), then a divider + the three
  // create/import actions. The leading search field is rendered in the
  // DropdownMenu `header` slot — see `DropdownMenu.tsx` for why the host
  // owns open state and must stop click propagation on the input.
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
        label: t('project.noProjectMatches'),
        disabled: true,
        onSelect: () => undefined,
      });
    }
    items.push({ kind: "divider", id: "project-actions-divider" });
    items.push({
      kind: "action",
      id: "new-blank-project",
      label: t('project.newBlankProject'),
      iconLeft: <FileIcon size={14} />,
      onSelect: handleNewBlankProject,
    });
    items.push({
      kind: "action",
      id: "use-existing-folder",
      label: t('project.useExistingFolder'),
      iconLeft: <FolderOpenIcon size={14} />,
      onSelect: handleUseExistingFolder,
    });
    if (onNewNoProjectSession) {
      items.push({
        kind: "action",
        id: "new-no-project-session",
        label: t('project.newNoProjectSession'),
        iconLeft: <NotePencilIcon size={14} />,
        onSelect: handleNewNoProjectSession,
      });
    }
    return items;
    // t() is a stable hook reference; we depend on filteredProjects to
    // refresh the list when the search query or projects change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredProjects, projectSearch, selectedProject?.workingDirectory, onNewNoProjectSession]);

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
            closeProjectDropdown();
          } else if (e.key === "Enter") {
            e.preventDefault();
            const first = filteredProjects[0];
            if (first) handleSelectProject(first);
          }
        }}
        placeholder={t('project.searchProjects')}
        aria-label={t('project.searchProjects')}
        className="bg-transparent border-0 outline-none text-xs"
        style={{ color: "var(--text)", minWidth: 0 }}
      />
    </div>
  );

  const projectSelector = (
    <div className="welcome-project-selector">
      <DropdownMenu
        trigger={
          <button
            type="button"
            className="welcome-project-dropdown-trigger"
            disabled={!isHydrated}
          >
            <span className="welcome-project-name">
              {selectedProject?.projectName || t('chat.selectProject')}
            </span>
            <ChevronDownIcon size={14} />
          </button>
        }
        items={projectMenuItems}
        header={projectMenuHeader}
        className="welcome-project-dropdown"
        align="center"
        minWidth={320}
        maxWidth={400}
        open={isProjectDropdownOpen}
        onOpenChange={(open) => {
          if (open) {
            setIsProjectDropdownOpen(true);
          } else {
            closeProjectDropdown();
          }
        }}
      />
    </div>
  );

  return (
    <>
      {greeting ? (
        /* Time-based greeting line (welcome page header) */
        <div className="welcome-input-header">
          <span className="welcome-input-label">{greeting}</span>
        </div>
      ) : (
        /* Project selector header */
        <div className="welcome-input-header">
          <span className="welcome-input-label">{t('chat.whatToBuildIn')}</span>
          {projectSelector}
          <span className="welcome-input-label">{t('chat.whatToBuildInSuffix')}</span>
        </div>
      )}

      {/* Input area */}
      {children}

      {/* Project selector below the input (greeting layout only) */}
      {greeting && (
        <div className="welcome-project-row">{projectSelector}</div>
      )}

      {/* Tab strip: only shown when a project is selected */}
      {selectedProject && (
        <div className="welcome-tabs" role="tablist" aria-label={t('references.tab.ariaLabel')}>
          <button
            role="tab"
            aria-selected={activeTab === "threads"}
            className={`welcome-tab ${activeTab === "threads" ? "active" : ""}`}
            onClick={() => setActiveTab("threads")}
          >
            {t('references.tab.threads')}
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "references"}
            className={`welcome-tab ${activeTab === "references" ? "active" : ""}`}
            onClick={() => setActiveTab("references")}
          >
            {t('references.tab.references')}
          </button>
        </div>
      )}

      {/* Tab panels */}
      {selectedProject && activeTab === "references" ? (
        <div className="welcome-tab-panel">
          <ReferencesPanel
            workingDirectory={selectedProject.workingDirectory}
            projectName={selectedProject.projectName}
          />
        </div>
      ) : (
        showRecentThreads && recentThreads.length > 0 && (
          <div className="welcome-recent">
            <h2>{t('chat.recentThreads')}</h2>
            <div className="recent-list">
              {recentThreads.map((thread) => (
                <button
                  key={thread.id}
                  className="recent-item"
                  onClick={() => onSelectThread(thread.id)}
                >
                  <div className="recent-item-left">
                    <span className="recent-title">{thread.title}</span>
                    <span className="recent-project">{thread.projectName || thread.workingDirectory}</span>
                  </div>
                  <span className="recent-date">{formatDate(thread.updatedAt)}</span>
                </button>
              ))}
            </div>
          </div>
        )
      )}
    </>
  );
}
