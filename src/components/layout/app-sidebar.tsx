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
  DotsThreeIcon,
  CaretRightIcon,
  CaretDownIcon,
  CheckIcon,
  CornersInIcon,
  CornersOutIcon,
  NotePencilIcon,
} from "@/components/icons";
import { useConversationStore, type Thread, type ProjectGroup, type ViewType, type SettingsTab, type ProjectSortBy, type ProjectFilter } from "@/stores/conversation-store";
import { NewThreadDropdown } from "./sidebar/NewThreadDropdown";
import { ProjectGroupItem } from "./sidebar/ProjectGroupItem";
import { ThreadListItem } from "./sidebar/ThreadListItem";
import { useTranslation } from "@/hooks/useTranslation";
import { useSettings } from "@/hooks/useSettings";
import { useOptionalPanel } from "@/hooks/usePanel";
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

function isOrphanSubAgentThread(thread: Thread): boolean {
  return thread.agentType === "sub-agent" && !thread.parentId;
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
    const [isNameProjectDialogOpen, setIsNameProjectDialogOpen] = useState(false);

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
      collapsedProjects,
      collapseAllProjects,
      expandAllProjects,
      projectSortBy,
      setProjectSortBy,
      projectFilter,
      setProjectFilter,
    } = useConversationStore();
    const panel = useOptionalPanel();
    const openOrActivatePage = panel?.openOrActivatePage ?? (() => {});
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
        // Sub-agent sessions without a parent are malformed/orphaned. Do not
        // render them as top-level project chats; otherwise the sidebar shows
        // agent children that do not belong to any visible session.
        if (isOrphanSubAgentThread(thread)) {
          continue;
        }

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

      const RECENT_DAYS = 14;
      const recentThreshold = Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000;

      const projectGroups: ProjectGroup[] = Array.from(groups.entries())
        .map(([wd, groupThreads]) => {
          const lastActivity = Math.max(...groupThreads.map((t) => t.updatedAt));
          const createdAt = Math.min(...groupThreads.map((t) => t.createdAt));
          return {
            workingDirectory: wd,
            projectName: groupThreads[0]?.projectName || wd.split(/[\\/]/).pop() || "Unknown",
            threadCount: groupThreads.length,
            lastActivity,
            createdAt,
            isExpanded: !collapsedProjects.has(wd),
          };
        })
        .filter((group) => {
          if (projectFilter === 'all') return true;
          return group.lastActivity >= recentThreshold;
        })
        .sort((a, b) => {
          if (projectSortBy === 'lastActivity') {
            return b.lastActivity - a.lastActivity;
          }
          if (projectSortBy === 'createdAt') {
            return b.createdAt - a.createdAt;
          }
          return a.projectName.localeCompare(b.projectName);
        });

      return { projectGroups, noProjectThreads, threadChildren: childrenMap };
    }, [threads, projectSortBy, projectFilter, collapsedProjects]);

    const allCollapsed = useMemo(
      () => projectGroups.length > 0 && projectGroups.every((p) => collapsedProjects.has(p.workingDirectory)),
      [projectGroups, collapsedProjects]
    );

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
          <SidebarProjectHeader
            onNewBlankProject={handleNewBlankProject}
            onUseExistingFolder={handleOpenExistingFolder}
            onCollapseAll={collapseAllProjects}
            onExpandAll={expandAllProjects}
            allCollapsed={allCollapsed}
            projectSortBy={projectSortBy}
            onProjectSortBy={setProjectSortBy}
            projectFilter={projectFilter}
            onProjectFilter={setProjectFilter}
          />
        )}

        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
          {projectGroups.length > 0 && (
            <div className="project-list">
              {projectGroups.map((project) => {
                const projectThreads = threads.filter(
                  (t) => t.workingDirectory === project.workingDirectory && !t.parentId && !isOrphanSubAgentThread(t)
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
            aria-label={t('sidebar.toggleThemeAria')}
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
          title={t('project.enterFolderPath')}
          placeholder={
            // Show a platform-appropriate path example so macOS/Linux users
            // are not shown a Windows C:\ path. Falls back to the i18n string
            // when the platform is unknown.
            window.electronAPI?.versions?.platform === 'darwin'
              ? t('project.folderPathPlaceholderMac')
              : window.electronAPI?.versions?.platform === 'linux'
                ? t('project.folderPathPlaceholderLinux')
                : t('project.folderPathPlaceholder')
          }
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

interface SidebarProjectHeaderProps {
  onNewBlankProject: () => void;
  onUseExistingFolder: () => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  allCollapsed: boolean;
  projectSortBy: ProjectSortBy;
  onProjectSortBy: (sortBy: ProjectSortBy) => void;
  projectFilter: ProjectFilter;
  onProjectFilter: (filter: ProjectFilter) => void;
}

type SubmenuPanel = 'organize' | 'sort' | null;

function SidebarProjectHeader({
  onNewBlankProject,
  onUseExistingFolder,
  onCollapseAll,
  onExpandAll,
  allCollapsed,
  projectSortBy,
  onProjectSortBy,
  projectFilter,
  onProjectFilter,
}: SidebarProjectHeaderProps) {
  const { t } = useTranslation();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [openSubmenu, setOpenSubmenu] = useState<SubmenuPanel>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isMenuOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
        setOpenSubmenu(null);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isMenuOpen]);

  const closeMenu = () => {
    setIsMenuOpen(false);
    setOpenSubmenu(null);
  };

  const handleToggleAll = () => {
    if (allCollapsed) {
      onExpandAll();
    } else {
      onCollapseAll();
    }
  };

  const menuPosition = useMemo(() => {
    if (!menuButtonRef.current) return { top: 0, left: 0 };
    const rect = menuButtonRef.current.getBoundingClientRect();
    return {
      top: rect.bottom + 6,
      left: rect.right - 180,
    };
  }, [isMenuOpen]);

  return (
    <div className="sidebar-section-header">
      <span className="sidebar-section-label">{t('common.projects')}</span>
      <div className="relative flex items-center gap-1" ref={menuRef}>
        <button
          type="button"
          className="sidebar-section-action"
          onClick={handleToggleAll}
          title={allCollapsed ? t('project.expandAll') : t('project.collapseAll')}
        >
          {allCollapsed ? <CornersOutIcon size={14} /> : <CornersInIcon size={14} />}
        </button>
        <button
          type="button"
          className="sidebar-section-action"
          ref={menuButtonRef}
          onClick={() => setIsMenuOpen((prev) => !prev)}
          title={t('common.more')}
        >
          <DotsThreeIcon size={16} />
        </button>
        <button
          type="button"
          className="sidebar-section-action"
          onClick={onUseExistingFolder}
          title={t('project.useExistingFolder')}
        >
          <FolderOpenIcon size={14} />
        </button>
        <button
          type="button"
          className="sidebar-section-action"
          onClick={onNewBlankProject}
          title={t('project.newProject')}
        >
          <NotePencilIcon size={14} />
        </button>

        {isMenuOpen && (
          <div className="sidebar-project-menu" style={menuPosition}>
            <div
              className="sidebar-project-menu-item has-submenu"
              onMouseEnter={() => setOpenSubmenu('organize')}
              onMouseLeave={() => setOpenSubmenu((prev) => (prev === 'organize' ? null : prev))}
            >
              <SquaresFourIcon size={15} />
              <span className="flex-1">{t('project.organizeSidebar')}</span>
              <CaretRightIcon size={12} />
              {openSubmenu === 'organize' && (
                <div className="sidebar-project-submenu">
                  <button
                    type="button"
                    className="sidebar-project-menu-item"
                    onClick={() => { onProjectFilter('all'); closeMenu(); }}
                  >
                    <span className="flex-1">{t('project.filterAll')}</span>
                    {projectFilter === 'all' && <CheckIcon size={14} />}
                  </button>
                  <button
                    type="button"
                    className="sidebar-project-menu-item"
                    onClick={() => { onProjectFilter('recent'); closeMenu(); }}
                  >
                    <span className="flex-1">{t('project.filterRecent')}</span>
                    {projectFilter === 'recent' && <CheckIcon size={14} />}
                  </button>
                </div>
              )}
            </div>
            <div
              className="sidebar-project-menu-item has-submenu"
              onMouseEnter={() => setOpenSubmenu('sort')}
              onMouseLeave={() => setOpenSubmenu((prev) => (prev === 'sort' ? null : prev))}
            >
              <ClockCounterClockwiseIcon size={15} />
              <span className="flex-1">{t('project.sortBy')}</span>
              <CaretRightIcon size={12} />
              {openSubmenu === 'sort' && (
                <div className="sidebar-project-submenu">
                  <button
                    type="button"
                    className="sidebar-project-menu-item"
                    onClick={() => { onProjectSortBy('lastActivity'); closeMenu(); }}
                  >
                    <span className="flex-1">{t('project.sortLastUpdated')}</span>
                    {projectSortBy === 'lastActivity' && <CheckIcon size={14} />}
                  </button>
                  <button
                    type="button"
                    className="sidebar-project-menu-item"
                    onClick={() => { onProjectSortBy('createdAt'); closeMenu(); }}
                  >
                    <span className="flex-1">{t('project.sortCreatedAt')}</span>
                    {projectSortBy === 'createdAt' && <CheckIcon size={14} />}
                  </button>
                  <button
                    type="button"
                    className="sidebar-project-menu-item"
                    onClick={() => { onProjectSortBy('name'); closeMenu(); }}
                  >
                    <span className="flex-1">{t('project.sortName')}</span>
                    {projectSortBy === 'name' && <CheckIcon size={14} />}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
