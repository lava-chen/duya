"use client";

import { useState, useEffect, useMemo, forwardRef, useCallback } from "react";
import {
  GearSixIcon,
  PlusIcon,
  MoonStarsIcon,
  SunIcon,
  FolderIcon,
  ArrowLeftIcon,
  HouseIcon,
  KeyIcon,
  MonitorIcon,
  WifiHighIcon,
  LightningIcon,
  BrainIcon,
  ClockCounterClockwiseIcon,
  ChromeIcon,
  ShieldCheckIcon,
  ChartBarIcon as BarChartIcon,
  CpuIcon as CubeIcon,
  SquaresFourIcon,
  RobotIcon,
  QuestionIcon,
  ChannelIcon,
} from "@/components/icons";
import { useConversationStore, type Thread, type ProjectGroup, type ViewType, type SettingsTab } from "@/stores/conversation-store";
import { NewThreadDropdown } from "./sidebar/NewThreadDropdown";
import { ProjectGroupItem } from "./sidebar/ProjectGroupItem";
import { ThreadListItem } from "./sidebar/ThreadListItem";
import { useTranslation } from "@/hooks/useTranslation";
import { InputDialog } from "@/components/ui/InputDialog";

type ThemeMode = "light" | "dark";

// Type-safe label keys
type NavLabelKey = 'nav.channels' | 'nav.automation' | 'nav.conductor';

const mainNavItems: { view: ViewType; labelKey: NavLabelKey; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
  { view: 'conductor', labelKey: 'nav.conductor', icon: SquaresFourIcon },
  { view: 'bridge', labelKey: 'nav.channels', icon: ChannelIcon },
  { view: 'automation', labelKey: 'nav.automation', icon: ClockCounterClockwiseIcon },
];

const settingsNavItems: { id: SettingsTab; labelKey: string; icon: typeof HouseIcon }[] = [
  { id: 'general', labelKey: 'settings.general', icon: HouseIcon },
  { id: 'appearance', labelKey: 'settings.appearance', icon: MonitorIcon },
  { id: 'providers', labelKey: 'settings.providers', icon: KeyIcon },
  { id: 'agents', labelKey: 'settings.agents', icon: RobotIcon },
  { id: 'skills', labelKey: 'settings.skills', icon: LightningIcon },
  { id: 'mcp', labelKey: 'settings.mcp', icon: CubeIcon },
  { id: 'channels', labelKey: 'settings.channels', icon: ChannelIcon },
  { id: 'browser', labelKey: 'settings.browser', icon: ChromeIcon },
  { id: 'security', labelKey: 'settings.security', icon: ShieldCheckIcon },
  { id: 'usage', labelKey: 'settings.usage', icon: BarChartIcon },
  { id: 'support', labelKey: 'settings.support', icon: QuestionIcon },
];

interface AppSidebarProps {
  isSettingsPage?: boolean;
  style?: React.CSSProperties;
}

export const AppSidebar = forwardRef<HTMLDivElement, AppSidebarProps>(
  function AppSidebar({ isSettingsPage = false, style }, ref) {
    const { t } = useTranslation();
    const [theme, setTheme] = useState<ThemeMode>("dark");
    const [isLoading, setIsLoading] = useState(true);
    const [isInputDialogOpen, setIsInputDialogOpen] = useState(false);

    const {
      threads,
      activeThreadId,
      loadFromDatabase,
      isHydrated,
      createThread,
      currentView,
      setCurrentView,
      setSettingsTab,
    } = useConversationStore();

    // Load from SQLite database on mount
    useEffect(() => {
      if (isHydrated) {
        loadFromDatabase().finally(() => setIsLoading(false));
      }
    }, [isHydrated, loadFromDatabase]);

    useEffect(() => {
      const stored = window.localStorage.getItem("duya-theme");
      const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const resolvedTheme: ThemeMode =
        stored === "light" || stored === "dark"
          ? stored
          : systemDark
          ? "dark"
          : "light";

      setTheme(resolvedTheme);
      document.documentElement.setAttribute("data-theme", resolvedTheme);
    }, []);

    // Initialize compact mode from settings on mount
    useEffect(() => {
      const initCompactMode = async () => {
        try {
          if (window.electronAPI?.settingsDb?.getJson) {
            const compactMode = await window.electronAPI.settingsDb.getJson<boolean>('compactMode', false);
            if (compactMode) {
              document.documentElement.classList.add('compact');
            }
          }
        } catch {
          // Ignore errors
        }
      };
      void initCompactMode();
    }, []);

    const toggleTheme = () => {
      setTheme((prev) => {
        const next = prev === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        window.localStorage.setItem("duya-theme", next);
        return next;
      });
    };

    const handleCreateProjectFromPath = useCallback(async (workingDirectory: string) => {
      if (workingDirectory.trim()) {
        const projectName = workingDirectory.trim().split(/[\\/]/).pop() || "Untitled";
        const thread = await createThread({ workingDirectory: workingDirectory.trim(), projectName });
        if (thread) {
          setCurrentView('chat');
        }
      }
    }, [createThread, setCurrentView]);

    const handleNewProject = async () => {
      try {
        if (window.electronAPI?.dialog?.openFolder) {
          const result = await window.electronAPI.dialog.openFolder({
            title: "Select New Project Folder",
          });

          if (!result.canceled && result.filePaths.length > 0) {
            const workingDirectory = result.filePaths[0];
            handleCreateProjectFromPath(workingDirectory);
          }
        } else {
          setIsInputDialogOpen(true);
        }
      } catch (error) {
        console.error("[AppSidebar] Failed to create new project:", error);
      }
    };

    // Group threads by project (only main threads, sub-agents are nested under parents)
    const { projectGroups, noProjectThreads, threadChildren } = useMemo(() => {
      const groups = new Map<string, Thread[]>();
      const childrenMap = new Map<string, Thread[]>();

      for (const thread of threads) {
        // Sub-agent threads are nested under their parent, not shown independently
        if (thread.parentId) {
          if (!childrenMap.has(thread.parentId)) {
            childrenMap.set(thread.parentId, []);
          }
          childrenMap.get(thread.parentId)!.push(thread);
          continue;
        }
        const key = thread.workingDirectory || "__no_project__";
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        groups.get(key)!.push(thread);
      }

      // Debug logging
      if (childrenMap.size > 0) {
        console.log('[AppSidebar] threadChildren:', Array.from(childrenMap.entries()).map(([k, v]) => [k, v.length]));
      }

      const noProjectThreads = groups.get("__no_project__") || [];
      groups.delete("__no_project__");

      const projectGroups: ProjectGroup[] = Array.from(groups.entries())
        .map(([wd, groupThreads]) => ({
          workingDirectory: wd,
          projectName: groupThreads[0]?.projectName || wd.split(/[\\/]/).pop() || "Unknown",
          threadCount: groupThreads.length,
          lastActivity: Math.max(...groupThreads.map((t) => t.updatedAt)),
          isExpanded: true,
        }))
        .sort((a, b) => b.lastActivity - a.lastActivity);

      return { projectGroups, noProjectThreads, threadChildren: childrenMap };
    }, [threads]);

    // Handle settings tab change
    const handleSettingsTabChange = (tabId: SettingsTab) => {
      setSettingsTab(tabId);
      setCurrentView('settings');
    };

    // Settings mode sidebar
    if (currentView === 'settings') {
      return (
        <aside className="app-sidebar" ref={ref} style={style}>
          <button
            className="sidebar-back-link"
            onClick={() => setCurrentView('home')}
          >
            <span className="nav-icon">
              <ArrowLeftIcon size={16} />
            </span>
            <span>{t('common.backToApp')}</span>
          </button>

          <div className="sidebar-divider" />

          <nav className="sidebar-settings-nav" aria-label="Settings Navigation">
            {settingsNavItems.map((item) => {
              const Icon = item.icon;
              const isActive = useConversationStore.getState().settingsTab === item.id;

              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSettingsTabChange(item.id)}
                  className={`sidebar-settings-link${isActive ? " active" : ""}`}
                >
                  <span className="nav-icon">
                    <Icon size={16} weight="regular" />
                  </span>
                  <span>{t(item.labelKey as never)}</span>
                </button>
              );
            })}
          </nav>
        </aside>
      );
    }

    // Normal mode sidebar
    return (
      <aside className="app-sidebar" ref={ref} style={style}>
        <nav className="sidebar-primary-nav" aria-label="Primary Navigation">
          <NewThreadDropdown />

          {mainNavItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentView === item.view;

            return (
              <button
                key={item.view}
                type="button"
                onClick={() => setCurrentView(item.view)}
                className={`sidebar-primary-link${isActive ? " active" : ""}`}
              >
                <span className="nav-icon">
                  <Icon size={16} />
                </span>
                <span>{t(item.labelKey)}</span>
              </button>
            );
          })}
        </nav>

        {projectGroups.length > 0 && (
          <div className="sidebar-section-header">
            <span className="sidebar-section-label">{t('common.projects')}</span>
            <button
              type="button"
              className="sidebar-section-action"
              onClick={handleNewProject}
              title="New Project"
            >
              <PlusIcon size={14} />
            </button>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
          {projectGroups.length > 0 && (
            <div className="project-list">
              {projectGroups.map((project) => {
                const projectThreads = threads.filter(
                  (t) => t.workingDirectory === project.workingDirectory && !t.parentId
                );
                return (
                  <ProjectGroupItem
                    key={project.workingDirectory}
                    project={project}
                    threads={projectThreads}
                    activeThreadId={activeThreadId}
                    threadChildren={threadChildren}
                  />
                );
              })}
            </div>
          )}

          {noProjectThreads.length > 0 && (
            <>
              <div className="sidebar-section-label">{t('common.noProject')}</div>
              <div className="thread-list">
                {noProjectThreads.map((thread) => (
                  <ThreadListItem
                    key={thread.id}
                    thread={thread}
                    isActive={thread.id === activeThreadId}
                    childrenThreads={threadChildren.get(thread.id) || []}
                  />
                ))}
              </div>
            </>
          )}

          {projectGroups.length === 0 && noProjectThreads.length === 0 && (
            <div className="empty-state">
              <p>{t('common.noProjectsYet')}</p>
              <button
                type="button"
                className="empty-state-action"
                onClick={handleNewProject}
              >
                <FolderIcon size={16} />
                <span>{t('common.openProjectFolder')}</span>
              </button>
            </div>
          )}
        </div>

        <div className="sidebar-bottom">
          <button
            type="button"
            className="sidebar-settings"
            onClick={() => setCurrentView('settings')}
          >
            <span className="nav-icon">
              <GearSixIcon size={16} weight="regular" />
            </span>
            <span>{t('common.settings')}</span>
          </button>

          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? (
              <SunIcon size={16} weight="regular" />
            ) : (
              <MoonStarsIcon size={16} weight="regular" />
            )}
          </button>
        </div>

        <InputDialog
          isOpen={isInputDialogOpen}
          title="Enter Project Folder Path"
          placeholder="e.g., C:\\Users\\name\\Projects\\my-project"
          onConfirm={(value) => {
            setIsInputDialogOpen(false);
            handleCreateProjectFromPath(value);
          }}
          onCancel={() => setIsInputDialogOpen(false)}
        />
      </aside>
    );
  }
);
