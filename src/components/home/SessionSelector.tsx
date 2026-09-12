"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useConversationStore } from "@/stores/conversation-store";
import { useTranslation } from "@/hooks/useTranslation";
import { ChevronDownIcon, FileIcon, FolderOpenIcon, NotePencilIcon } from "@/components/icons";
import {
  OptionPanel,
  type OptionPanelItem,
  useOptionPanelPlacement,
} from "@/components/ui/OptionPanel";
import { ReferencesPanel } from "./ReferencesPanel";
import { Button } from "@/components/ui/Button";

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
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { placement, maxListHeight } = useOptionPanelPlacement(isProjectDropdownOpen, dropdownRef);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsProjectDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelectProject = (project: { workingDirectory: string; projectName: string }) => {
    onSelectProject(project);
    setIsProjectDropdownOpen(false);
    setActiveTab("threads");
  };

  const handleNewBlankProject = () => {
    setIsProjectDropdownOpen(false);
    onNewBlankProject();
  };

  const handleUseExistingFolder = () => {
    setIsProjectDropdownOpen(false);
    onUseExistingFolder();
  };

  const handleNewNoProjectSession = () => {
    setIsProjectDropdownOpen(false);
    onNewNoProjectSession?.();
  };

  const recentThreads = threads.slice(0, maxRecentThreads);
  const projectItems: OptionPanelItem[] = projects.map((project) => ({
    id: project.workingDirectory,
    label: project.projectName,
    description: project.workingDirectory,
    searchText: `${project.projectName} ${project.workingDirectory}`,
  }));

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

  const projectSelector = (
    <div className="welcome-project-selector" ref={dropdownRef}>
      <button
        className="welcome-project-dropdown-trigger"
        onClick={() => setIsProjectDropdownOpen(!isProjectDropdownOpen)}
        disabled={!isHydrated}
      >
        <span className="welcome-project-name">
          {selectedProject?.projectName || t('chat.selectProject')}
        </span>
        <ChevronDownIcon size={14} />
      </button>
      {isProjectDropdownOpen && (
        <OptionPanel
          className={`welcome-project-dropdown option-panel--${placement}`}
          title={t('chat.selectProject')}
          items={projectItems}
          selectedId={selectedProject?.workingDirectory}
          onSelect={(item) => {
            const project = projects.find(({ workingDirectory }) => workingDirectory === item.id);
            if (project) handleSelectProject(project);
          }}
          onClose={() => setIsProjectDropdownOpen(false)}
          maxListHeight={maxListHeight}
          searchPlaceholder={t('project.searchProjects')}
          emptyMessage={t('project.noProjectMatches')}
          footer={
            <div className="grid gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start px-2 text-left"
                onClick={handleNewBlankProject}
              >
                <FileIcon size={14} className="text-[var(--muted)]" />
                <span>{t('project.newBlankProject')}</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start px-2 text-left"
                onClick={handleUseExistingFolder}
              >
                <FolderOpenIcon size={14} className="text-[var(--muted)]" />
                <span>{t('project.useExistingFolder')}</span>
              </Button>
              {onNewNoProjectSession && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start px-2 text-left"
                  onClick={handleNewNoProjectSession}
                >
                  <NotePencilIcon size={14} className="text-[var(--muted)]" />
                  <span>{t('project.newNoProjectSession')}</span>
                </Button>
              )}
            </div>
          }
        />
      )}
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
