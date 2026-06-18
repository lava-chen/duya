"use client";

import { useState, useEffect, useMemo, forwardRef, useCallback, useRef } from "react";
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
  PlugIcon,
  FileIcon,
  FolderOpenIcon,
} from "@/components/icons";
import { useConversationStore, type Thread, type ProjectGroup, type ViewType, type SettingsTab } from "@/stores/conversation-store";
import { NewThreadDropdown } from "./sidebar/NewThreadDropdown";
import { ProjectGroupItem } from "./sidebar/ProjectGroupItem";
import { ThreadListItem } from "./sidebar/ThreadListItem";
import { useTranslation } from "@/hooks/useTranslation";
import { useSettings } from "@/hooks/useSettings";
import { usePanel } from "@/hooks/usePanel";
import { InputDialog } from "@/components/ui/InputDialog";

type ThemeMode = "light" | "dark";

// Type-safe label keys
type NavLabelKey = 'nav.channels' | 'nav.automation' | 'nav.conductor' | 'nav.memory';

const CHILD_THREAD_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

function getChildThreadDisplayKey(thread: Thread): string {
  const displayName = thread.agentName || thread.title.replace(/^Sub:\s*/i, "");
  return `${thread.parentId || ""}:${thread.agentType || ""}:${displayName.trim().toLowerCase()}`;
}

function addChildThread(childrenMap: Map<string, Thread[]>, thread: Thread): void {
  if (!thread.parentId) return;

  const siblings = childrenMap.get(thread.parentId) ?? [];
  const threadKey = getChildThreadDisplayKey(thread);
  const duplicateIndex = siblings.findIndex((existing) => {
    if (getChildThreadDisplayKey(existing) !== threadKey) return false;
    return Math.abs(existing.createdAt - thread.createdAt) <= CHILD_THREAD_DUPLICATE_WINDOW_MS;
  });

  if (duplicateIndex >= 0) {
    if (thread.updatedAt >= siblings[duplicateIndex].updatedAt) {
      siblings[duplicateIndex] = thread;
    }
  } else {
    siblings.push(thread);
  }

  childrenMap.set(thread.parentId, siblings);
}

const mainNavItems: { view: ViewType; labelKey: NavLabelKey; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
  { view: 'conductor', labelKey: 'nav.conductor', icon: SquaresFourIcon },
  { view: 'bridge', labelKey: 'nav.channels', icon: ChannelIcon },
  { view: 'automation', labelKey: 'nav.automation', icon: ClockCounterClockwiseIcon },
  { view: 'memory', labelKey: 'nav.memory', icon: BrainIcon },
];

const settingsNavGroups: {
  id: string;
  labelKey: string;
  items: { id: SettingsTab; labelKey: string; icon: typeof HouseIcon }[];
}[] = [
  {
    id: 'application',
    labelKey: 'settings.group.application',
    items: [
      { id: 'general', labelKey: 'settings.general', icon: HouseIcon },
      { id: 'appearance', labelKey: 'settings.appearance', icon: MonitorIcon },
      { id: 'security', labelKey: 'settings.security', icon: ShieldCheckIcon },
    ],
  },
  {
    id: 'aiSetup',
    labelKey: 'settings.group.aiSetup',
    items: [
      { id: 'providers', labelKey: 'settings.providers', icon: KeyIcon },
      { id: 'agents', labelKey: 'settings.agents', icon: RobotIcon },
      { id: 'browser', labelKey: 'settings.browser', icon: ChromeIcon },
      { id: 'channels', labelKey: 'settings.channels', icon: ChannelIcon },
    ],
  },
  {
    id: 'extensions',
    labelKey: 'settings.group.extensions',
    items: [
      { id: 'plugins', labelKey: 'settings.plugins', icon: PlugIcon },
      { id: 'skills', labelKey: 'settings.skills', icon: LightningIcon },
      { id: 'mcp', labelKey: 'settings.mcp', icon: CubeIcon },
    ],
  },
  {
    id: 'system',
    labelKey: 'settings.group.system',
    items: [
      { id: 'usage', labelKey: 'settings.usage', icon: BarChartIcon },
      { id: 'support', labelKey: 'settings.support', icon: QuestionIcon },
    ],
  },
];

interface AppSidebarProps {
  isSettingsPage?: boolean;
  style?: React.CSSProperties;
}

export const AppSidebar = forwardRef<HTMLDivElement, AppSidebarProps>(
  function AppSidebar({ isSettingsPage = false, style }, ref) {
    const { t } = useTranslation();
    const { settings, loading, error, save } = useSettings();
    const [isLoading, setIsLoading] = useState(true);
    const [isInputDialogOpen, setIsInputDialogOpen] = useState(false);
    const [isProjectMenuOpen, setIsProjectMenuOpen] = useState(false);
    const [isNameProjectDialogOpen, setIsNameProjectDialogOpen] = useState(false);
    const projectMenuRef = useRef<HTMLDivElement>(null);

    const {
      threads,
      activeThreadId,
      loadFromDatabase,
      isHydrated,
      createThread,
      currentView,
      setCurrentView,
      setSettingsTab,
      enterSettings,
      exitSettings,
    } = useConversationStore();
    const { openOrActivatePage } = usePanel();
    const wikiAgentEnabled = settings?.wikiAgentEnabled === true;

    const systemDark = useMemo(
      () =>
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches,
      []
    );
    const bootTheme: ThemeMode | undefined = useMemo(() => {
      if (typeof window === "undefined") return undefined;
      try {
        const stored = window.localStorage.getItem("duya-theme");
        if (stored === "light" || stored === "dark") return stored;
      } catch {
        /* ignore */
      }
      return undefined;
    }, []);
    // Settings are trustworthy only after a successful load. While loading
    // (Electron IPC in flight) or when the IPC failed (dev browser without
    // settings API), fall back to the boot script's localStorage hint or
    // system preference so the app doesn't flash to the useSettings default.
    const settingsLoaded = !loading && !error;
    const settingsTheme = settingsLoaded && settings
      ? (settings.theme as "light" | "dark" | "system" | undefined)
      : undefined;
    const resolvedTheme: ThemeMode =
      settingsTheme === "light" || settingsTheme === "dark"
        ? settingsTheme
        : settingsTheme === "system"
        ? systemDark
          ? "dark"
          : "light"
        : bootTheme ?? (systemDark ? "dark" : "light");

    useEffect(() => {
      if (!wikiAgentEnabled && currentView === 'memory') {
        setCurrentView('home');
      }
    }, [wikiAgentEnabled, currentView, setCurrentView]);

    // Load from SQLite database on mount
    useEffect(() => {
      if (isHydrated) {
        loadFromDatabase().finally(() => setIsLoading(false));
      }
    }, [isHydrated, loadFromDatabase]);

    // Apply resolved theme to <html> and keep localStorage in sync as a boot-time hint.
    useEffect(() => {
      document.documentElement.setAttribute("data-theme", resolvedTheme);
      try {
        window.localStorage.setItem("duya-theme", resolvedTheme);
      } catch {
        // localStorage may be unavailable; the boot script will fall back to system preference.
      }
    }, [resolvedTheme]);

    // Keep "system" mode live: track OS-level preference changes.
    useEffect(() => {
      if (settingsTheme !== "system") return;
      const mql = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => {
        document.documentElement.setAttribute(
          "data-theme",
          mql.matches ? "dark" : "light"
        );
      };
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }, [settingsTheme]);

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
      void save({ theme: resolvedTheme === "dark" ? "light" : "dark" });
    };

    // Close project menu when clicking outside
    useEffect(() => {
      function handleClickOutside(event: MouseEvent) {
        if (projectMenuRef.current && !projectMenuRef.current.contains(event.target as Node)) {
          setIsProjectMenuOpen(false);
        }
      }
      if (isProjectMenuOpen) {
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
      }
    }, [isProjectMenuOpen]);

    const handleCreateProjectFromPath = useCallback(async (workingDirectory: string) => {
      if (workingDirectory.trim()) {
        const projectName = workingDirectory.trim().split(/[\\/]/).pop() || "Untitled";
        const thread = await createThread({ workingDirectory: workingDirectory.trim(), projectName });
        if (thread) {
          setCurrentView('chat');
        }
      }
    }, [createThread, setCurrentView]);

    const handleOpenExistingFolder = async () => {
      setIsProjectMenuOpen(false);
      try {
        if (window.electronAPI?.dialog?.openFolder) {
          const result = await window.electronAPI.dialog.openFolder({
            title: t('project.selectNewProjectFolder'),
          });

          if (!result.canceled && result.filePaths.length > 0) {
            const workingDirectory = result.filePaths[0];
            handleCreateProjectFromPath(workingDirectory);
          }
        } else {
          setIsInputDialogOpen(true);
        }
      } catch (error) {
        console.error("[AppSidebar] Failed to open existing folder:", error);
      }
    };

    const handleNewBlankProject = () => {
      setIsProjectMenuOpen(false);
      setIsNameProjectDialogOpen(true);
    };

    const handleCreateNamedProject = async (projectName: string) => {
      setIsNameProjectDialogOpen(false);
      if (!projectName.trim()) return;
      try {
        if (window.electronAPI?.app?.createProjectFolder) {
          const result = await window.electronAPI.app.createProjectFolder(projectName.trim());
          if (result.success && result.path) {
            const thread = await createThread({ workingDirectory: result.path, projectName: projectName.trim() });
            if (thread) {
              setCurrentView('chat');
            }
          } else {
            console.error("[AppSidebar] Failed to create project folder:", result.error);
          }
        }
      } catch (error) {
        console.error("[AppSidebar] Failed to create blank project:", error);
      }
    };

    // Group threads by project (only main threads, sub-agents are nested under parents)
    const { projectGroups, noProjectThreads, threadChildren } = useMemo(() => {
      const groups = new Map<string, Thread[]>();
      const childrenMap = new Map<string, Thread[]>();

      for (const thread of threads) {
        // Sub-agent threads are nested under their parent, not shown independently
        if (thread.parentId) {
          addChildThread(childrenMap, thread);
          continue;
        }
        const key = thread.workingDirectory || "__no_project__";
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        groups.get(key)!.push(thread);
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
      enterSettings();
    };

    // Settings mode sidebar
    if (currentView === 'settings') {
      return (
        <aside className="app-sidebar" ref={ref} style={style}>
          <button
            className="sidebar-back-link"
            onClick={exitSettings}
          >
            <span className="nav-icon">
              <ArrowLeftIcon size={16} />
            </span>
            <span>{t('common.backToApp')}</span>
          </button>

          <div className="sidebar-divider" />

          <nav className="sidebar-settings-nav" aria-label="Settings Navigation">
            {settingsNavGroups.map((group) => (
              <div key={group.id} className="sidebar-settings-group">
                <div className="sidebar-section-header">
                  <span className="sidebar-section-label">{t(group.labelKey as never)}</span>
                </div>
                {group.items.map((item) => {
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
              </div>
            ))}
          </nav>
        </aside>
      );
    }

    // Normal mode sidebar
    return (
      <aside className="app-sidebar" ref={ref} style={style}>
        <nav className="sidebar-primary-nav" aria-label="Primary Navigation">
          <NewThreadDropdown />

          {mainNavItems
            .filter((item) => wikiAgentEnabled || item.view !== 'memory')
            .map((item) => {
            const Icon = item.icon;
            const isActive = currentView === item.view;

            const handleNavClick = () => {
              setCurrentView(item.view);
              if (item.view === 'conductor') {
                openOrActivatePage('conductor');
              }
            };

            return (
              <button
                key={item.view}
                type="button"
                onClick={handleNavClick}
                data-testid={`nav-${item.view}`}
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
            <div className="relative" ref={projectMenuRef}>
              <button
                type="button"
                className="sidebar-section-action"
                onClick={() => setIsProjectMenuOpen(!isProjectMenuOpen)}
                title={t('project.newProject')}
              >
                <PlusIcon size={14} />
              </button>
              {isProjectMenuOpen && (
                <div
                  className="absolute right-0 top-full mt-1.5 py-1.5 rounded-lg z-50"
                  style={{
                    backgroundColor: 'var(--bg-canvas)',
                    border: '1px solid var(--border)',
                    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25), 0 2px 8px rgba(0, 0, 0, 0.15)',
                    minWidth: '200px',
                  }}
                >
                  <button
                    type="button"
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left rounded-md mx-1"
                    style={{ color: 'var(--text)', width: 'calc(100% - 8px)' }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = 'var(--surface-hover)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    onClick={handleNewBlankProject}
                  >
                    <span className="flex-shrink-0" style={{ color: 'var(--muted)' }}>
                      <FileIcon size={15} />
                    </span>
                    <span className="whitespace-nowrap">{t('project.newBlankProject')}</span>
                  </button>
                  <div className="mx-3 my-1" style={{ height: '1px', backgroundColor: 'var(--border)' }} />
                  <button
                    type="button"
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left rounded-md mx-1"
                    style={{ color: 'var(--text)', width: 'calc(100% - 8px)' }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = 'var(--surface-hover)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    onClick={handleOpenExistingFolder}
                  >
                    <span className="flex-shrink-0" style={{ color: 'var(--muted)' }}>
                      <FolderOpenIcon size={15} />
                    </span>
                    <span className="whitespace-nowrap">{t('project.useExistingFolder')}</span>
                  </button>
                </div>
              )}
            </div>
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
              <div className="flex flex-col gap-2 mt-3">
                <button
                  type="button"
                  className="empty-state-action"
                  onClick={handleNewBlankProject}
                >
                  <FileIcon size={16} />
                  <span>{t('project.newBlankProject')}</span>
                </button>
                <button
                  type="button"
                  className="empty-state-action"
                  onClick={handleOpenExistingFolder}
                >
                  <FolderOpenIcon size={16} />
                  <span>{t('project.useExistingFolder')}</span>
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="sidebar-bottom">
          <button
            type="button"
            className="sidebar-settings"
            onClick={enterSettings}
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
            {resolvedTheme === "dark" ? (
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

        <InputDialog
          isOpen={isNameProjectDialogOpen}
          title={t('project.nameProject')}
          description={t('project.nameProjectDescription')}
          placeholder={t('project.nameProjectPlaceholder')}
          onConfirm={(value) => {
            handleCreateNamedProject(value);
          }}
          onCancel={() => setIsNameProjectDialogOpen(false)}
        />
      </aside>
    );
  }
);
