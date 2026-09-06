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
  ClockCounterClockwiseIcon,
  ChromeIcon,
  ShieldCheckIcon,
  ChartBarIcon as BarChartIcon,
  CpuIcon as CubeIcon,
  ChalkboardIcon,
  RobotIcon,
  QuestionIcon,
  ChannelIcon,
  PlugIcon,
  FileIcon,
  FolderOpenIcon,
  DotsThreeIcon,
  BrainIcon,
  WebhookIcon,
  MicrophoneIcon,
  CaretRightIcon,
  CaretDownIcon,
  CheckIcon,
  NotePencilIcon,
  CircleNotchIcon,
} from "@/components/icons";
import { useConversationStore, type Thread, type ProjectGroup, type ViewType, type SettingsTab, type ProjectSortBy, type ProjectGroupBy } from "@/stores/conversation-store";
import { NewThreadDropdown } from "./sidebar/NewThreadDropdown";
import { ProjectGroupItem } from "./sidebar/ProjectGroupItem";
import { ThreadListItem } from "./sidebar/ThreadListItem";
import { SidebarSectionItem, type SectionKind } from "./sidebar/SidebarSectionItem";
import {
  bucketThreadsByKind,
  SYSTEM_SECTIONS,
} from "./sidebar/section-system";
import { useSidebarSectionsStore } from "@/stores/sidebar-sections-store";
import { useTranslation } from "@/hooks/useTranslation";
import { Button } from "@/components/ui/Button";
import { useSettings } from "@/hooks/useSettings";
import { useOptionalPanel } from "@/hooks/usePanel";
import { CreateProjectDialog } from "@/components/ui/CreateProjectDialog";
import { useBotContacts } from "./sidebar/use-bot-contacts";
import { BotContactListItem } from "./sidebar/BotContactListItem";
import { RoomContactListItem } from "./sidebar/RoomContactListItem";
import {
  resolveBotOpenThreadId,
  deriveBotPlaceholderThreadId,
  deriveRoomThreadId,
  matchesBotThread,
  type BotContact,
} from "./sidebar/bot-contacts";
import { CreateBotDialog } from "./CreateBotDialog";
import { EditBotDialog } from "./EditBotDialog";
import { GroupSettingsDialog } from "@/components/chat/bot/GroupSettingsDialog";
import { deleteConfigAgent } from "@/lib/agent-profile-ipc";

type ThemeMode = "light" | "dark";

// Type-safe label keys
type NavLabelKey = 'nav.channels' | 'nav.automation' | 'nav.conductor' | 'nav.extensions';

const mainNavItems: { view: ViewType; labelKey: NavLabelKey; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
  { view: 'conductor', labelKey: 'nav.conductor', icon: ChalkboardIcon },
  { view: 'bridge', labelKey: 'nav.channels', icon: ChannelIcon },
  { view: 'automation', labelKey: 'nav.automation', icon: ClockCounterClockwiseIcon },
  // Extensions (plugins / marketplace / app connections) is a top-level
  // surface, not a settings sub-page — it is browsed as often as channels.
  { view: 'extensions', labelKey: 'nav.extensions', icon: PlugIcon },
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
      { id: 'hooks', labelKey: 'settings.hooks', icon: WebhookIcon },
      { id: 'memory', labelKey: 'settings.memory', icon: BrainIcon },
      { id: 'browser', labelKey: 'settings.browser', icon: ChromeIcon },
      { id: 'channels', labelKey: 'settings.channels', icon: ChannelIcon },
    ],
  },
  {
    id: 'system',
    labelKey: 'settings.group.system',
    items: [
      { id: 'usage', labelKey: 'settings.usage', icon: BarChartIcon },
      { id: 'performance', labelKey: 'settings.performance', icon: LightningIcon },
      { id: 'support', labelKey: 'settings.support', icon: QuestionIcon },
    ],
  },
  {
    id: 'tools',
    labelKey: 'settings.group.tools',
    items: [
      // Plan 453 Task H: Wake Agent (Ctrl+Shift+Space orb).
      { id: 'wake', labelKey: 'settings.wake', icon: CircleNotchIcon },
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
    // Plan 471 v7: replaced the old `isNameProjectDialogOpen` + name-only
    // dialog with `CreateProjectDialog` (project name + optional folder).
    const [isCreateProjectDialogOpen, setIsCreateProjectDialogOpen] = useState(false);
    // Plan 483: grok-style bot management sidebar
    const [isCreateBotDialogOpen, setIsCreateBotDialogOpen] = useState(false);
    const [editBotContact, setEditBotContact] = useState<BotContact | null>(null);
    const [showHiddenBots, setShowHiddenBots] = useState(false);
    const {
      pinned: pinnedBots,
      unpinned: unpinnedBots,
      hidden: hiddenBots,
      allContacts: botContacts,
      roomContacts,
      reload: reloadBots,
      togglePin,
      hide,
      unhide,
    } = useBotContacts();
    // Plan 478: shared-room create/edit dialog state (群聊 lives in the
    // Bots section as its own "群聊" group).
    const [groupDialog, setGroupDialog] = useState<
      { mode: "create" } | { mode: "edit"; roomId: string; name: string; memberIds: string[] } | null
    >(null);
    // Plan 471 v8: in "在一个列表中" (singleList) mode the flat session
    // list reveals incrementally (20 at a time — user preference, bigger
    // batch than the 5-per-project-group because it spans ALL projects
    // and would take too many clicks at 5). Kept in renderer state;
    // resets when the user toggles the view mode or a section collapse.
    const FLAT_LIST_THRESHOLD = 20;
    const [flatListVisibleCount, setFlatListVisibleCount] = useState(FLAT_LIST_THRESHOLD);
    // Plan 471: cap how many cron / etc. system sessions render in the
    // sidebar at once. The automation page owns the full history; the
    // sidebar just needs a quick "what's recent?" overview. Picking 8 →
    // fits under most viewports without forcing the user to scroll past
    // hundreds of stale runs.
    const CRON_SIDEBAR_VISIBLE = 8;

    const {
      threads,
      activeThreadId,
      loadFromDatabase,
      isHydrated,
      createThread,
      setActiveThread,
      currentView,
      setCurrentView,
      setSettingsTab,
      enterSettings,
      exitSettings,
      collapsedProjects,
      toggleProjectExpanded,
      projectSortBy,
      setProjectSortBy,
      projectGroupBy,
      setProjectGroupBy,
      noProjectWorkspace,
    } = useConversationStore();
    const panel = useOptionalPanel();
    const openOrActivatePage = panel?.openOrActivatePage ?? (() => {});

    // Plan 471: user-defined sidebar sections (loaded from SQLite). The store
    // is the renderer-side mirror of `sidebar_sections` + `sidebar_section_projects`.
    // The mirror is rebuilt from the IPC on mount; until hydration completes
    // we leave the lists empty (no flicker, no phantom entries).
    const {
      sections: userSections,
      sectionProjects,
      hydrated: sectionsHydrated,
      loadFromDatabase: loadUserSectionsFromDb,
      toggleSectionCollapsed: toggleUserSectionCollapsed,
    } = useSidebarSectionsStore();
    // In-memory collapse for system sections (cron / gateway / wakeup /
    // pinned / uncategorized). User-defined sections persist via SQLite;
    // system sections live only in renderer state because their shape is
    // fixed (you can't rename or delete `__system__:cron`).
    const [collapsedSystemSections, setCollapsedSystemSections] = useState<Set<string>>(
      () => {
        // Default-collapse system sections with high cardinality (cron can
        // easily reach hundreds of runs; gateway and wakeup are similarly
        // noisy). The user can open them on demand. Pinned stays expanded
        // because it is bounded by user choice. The project section starts
        // open so the user sees their work without an extra click.
        const initialCollapsed = new Set<string>();
        initialCollapsed.add('__system__:cron');
        initialCollapsed.add('__system__:gateway');
        initialCollapsed.add('__system__:wakeup');
        return initialCollapsed;
      },
    );
    const toggleSystemSectionCollapsed = useCallback((id: string) => {
      setCollapsedSystemSections((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }, []);

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

    // Load from SQLite database on mount
    useEffect(() => {
      if (isHydrated) {
        loadFromDatabase().finally(() => setIsLoading(false));
        // Plan 471: parallel-load user-defined sections. Independent from
        // the conversations store — sections render even when threads are
        // empty (you can build the structure first, sessions later).
        void loadUserSectionsFromDb();
      }
    }, [isHydrated, loadFromDatabase, loadUserSectionsFromDb]);

    // Apply resolved theme to <html> and keep localStorage in sync as a boot-time hint.
    useEffect(() => {
      document.documentElement.setAttribute("data-theme", resolvedTheme);
      try {
        window.localStorage.setItem("duya-theme", resolvedTheme);
      } catch {
        // localStorage may be unavailable; the boot script will fall back to system preference.
      }
      // Keep the native window material (Mica / macOS vibrancy) on the same
      // light/dark source as duya. duya themes independently of the OS, so
      // without this a dark UI would sit on a light wallpaper tint.
      window.electronAPI?.system?.setNativeThemeSource?.(
        settingsTheme ?? resolvedTheme,
      );
    }, [resolvedTheme, settingsTheme]);

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

    const handleOpenExistingFolder = async () => {
      // Plan 471 v7: the "open existing folder" entry point now also
      // goes through the unified create-project dialog, so the user can
      // pre-name the project before/after picking the folder. Direct
      // folder-only flow is gone (was redundant once the dialog
      // accepts a folder).
      setIsCreateProjectDialogOpen(true);
    };

    const handleNewBlankProject = () => {
      // Plan 471 v7: the "项目" + button opens the unified create-project
      // dialog. Name + optional folder, both editable inside one window.
      setIsCreateProjectDialogOpen(true);
    };

    const handleNewNoProjectThread = useCallback(async () => {
      const thread = await createThread({ noProject: true });
      if (thread) {
        setCurrentView('chat');
        setActiveThread(thread.id);
      }
    }, [createThread, setCurrentView, setActiveThread]);

    // Plan 483 P1.2: opening a bot contact activates the bot's bound
    // persistent session (falling back to the `bot:<agentId>` placeholder
    // while no binding exists yet). The chat surface resolves its mode by
    // the thread id prefix.
    const handleOpenBot = useCallback(
      (contact: BotContact) => {
        const threadId = resolveBotOpenThreadId(contact, threads);
        if (!threadId) return;
        setActiveThread(threadId);
        setCurrentView("chat");
      },
      [threads, setActiveThread, setCurrentView],
    );

    // Plan 491 P2.5: open a bot by agent id without needing the current
    // BotContact snapshot. Used by the post-create fast-path so we do
    // not have to wait for `botContacts` to be re-fetched into the
    // parent's render closure before navigating. Reads `threads` and
    // the contacts store via `getState()` to bypass stale closures.
    const handleOpenBotById = useCallback(
      (agentId: string) => {
        const liveThreads = useConversationStore.getState().threads;
        const bound = liveThreads.find((t) => matchesBotThread(agentId, t.id));
        const threadId = bound?.id ?? deriveBotPlaceholderThreadId(agentId);
        setActiveThread(threadId);
        setCurrentView("chat");
      },
      [setActiveThread, setCurrentView],
    );

    // Plan 478: open a shared room's transcript view (`room:<roomId>`).
    const handleOpenRoom = useCallback(
      (roomId: string) => {
        setActiveThread(deriveRoomThreadId(roomId));
        setCurrentView("chat");
      },
      [setActiveThread, setCurrentView],
    );

    // Plan 483 P2: open the edit dialog for a bot. The dialog writes the
    // runtime identity (profile.json); on save we reload the contacts.
    const handleEditBot = useCallback((contact: BotContact) => {
      setEditBotContact(contact);
    }, []);

    // Plan 483 P2: delete a bot from config (bound sessions and profile
    // history are left intact so a same-id re-create reconnects them).
    const handleDeleteBot = useCallback(
      async (contact: BotContact) => {
        if (!window.confirm(t("bot.actions.deleteConfirm", { name: contact.name }))) {
          return;
        }
        try {
          await deleteConfigAgent(contact.agentId);
          await reloadBots();
        } catch (err) {
          console.error("[AppSidebar] Failed to delete bot:", err);
        }
      },
      [reloadBots, t],
    );

    /**
     * Plan 471 v7: single submit path for the create-project dialog.
     * Branches on whether the user picked a folder or only typed a name:
     *  - folder set → use that path; pass the typed name as the project
     *    label (fall back to the folder's basename if the field is empty).
     *  - folder empty → call `app.createProjectFolder(name)` to spawn a
     *    new empty directory and create a thread tied to it.
     */
    const handleCreateProjectConfirm = async (input: { name: string; workingDirectory: string | null }) => {
      setIsCreateProjectDialogOpen(false);
      const projectName = input.name.trim();
      if (!projectName) return;
      try {
        if (input.workingDirectory) {
          // Folder picked — the project IS that folder.
          const thread = await createThread({
            workingDirectory: input.workingDirectory,
            projectName,
          });
          if (thread) setCurrentView('chat');
          return;
        }
        if (window.electronAPI?.app?.createProjectFolder) {
          const result = await window.electronAPI.app.createProjectFolder(projectName);
          if (result.success && result.path) {
            const thread = await createThread({ workingDirectory: result.path, projectName });
            if (thread) setCurrentView('chat');
          } else {
            console.error('[AppSidebar] Failed to create project folder:', result.error);
          }
        }
      } catch (error) {
        console.error('[AppSidebar] Failed to create project:', error);
      }
    };

    // Plan 471: derive the unified sidebar structure from `threads[]` and
    // the user-sections store. The structure is an ordered array of section
    // descriptors; each descriptor can host either project groups (`kind:
    // project`) or raw threads (system kinds: cron / gateway / wakeup /
    // pinned). One pass, one derived value, no render branches.
    //
    // A project's working directory is mapped to a user section via
    // `findSectionForProject`; projects with no mapping land in the
    // synthetic "__uncategorized__" section so they remain visible.
    const sidebarStructure = useMemo(() => {
      const sortThreads = (items: Thread[]) =>
        [...items].sort((a, b) => {
          if (projectSortBy === 'priority') return b.createdAt - a.createdAt;
          if (projectSortBy === 'lastActivity') return b.updatedAt - a.updatedAt;
          return a.title.localeCompare(b.title);
        });

      // Bucket threads by kind. Sub-agents are dropped in `bucketThreadsByKind`.
      const buckets = bucketThreadsByKind(threads);
      const cronThreads = sortThreads(buckets.cron);
      const gatewayThreads = sortThreads(buckets.gateway);
      const wakeupThreads = sortThreads(buckets.wakeup);
      const pinnedThreads = sortThreads(buckets.pinned);
      const projectThreads = sortThreads(buckets.project_ungrouped);

      // Build a lookup: workingDirectory → assigned user section id.
      const workingDirToSection = new Map<string, string>();
      for (const sp of sectionProjects) {
        workingDirToSection.set(sp.workingDirectory, sp.sectionId);
      }

      // Group project threads by workingDirectory, then split: assigned and
      // unassigned (uncategorized). The noProjectWorkspace path is just
      // another "unassigned workingDirectory" with a synthetic key.
      const groupsAssignedByWorkingDir = new Map<string, Thread[]>();
      const noProjectThreads: Thread[] = [];
      for (const thread of projectThreads) {
        const wd = thread.workingDirectory ?? "";
        const isUnassignedKey = !wd || wd === noProjectWorkspace;
        const key = isUnassignedKey ? "__no_project__" : wd;
        if (isUnassignedKey) {
          noProjectThreads.push(thread);
          continue;
        }
        if (!groupsAssignedByWorkingDir.has(key)) {
          groupsAssignedByWorkingDir.set(key, []);
        }
        groupsAssignedByWorkingDir.get(key)!.push(thread);
      }
      noProjectThreads.sort((a, b) => b.updatedAt - a.updatedAt);

      // Map workingDirectory → ProjectGroup
      const allProjectGroups: Map<string, ProjectGroup> = new Map();
      for (const [wd, groupThreads] of groupsAssignedByWorkingDir.entries()) {
        const lastActivity = Math.max(...groupThreads.map((t) => t.updatedAt));
        const createdAt = Math.min(...groupThreads.map((t) => t.createdAt));
        allProjectGroups.set(wd, {
          workingDirectory: wd,
          projectName: groupThreads[0]?.projectName || wd.split(/[\\/]/).pop() || "Unknown",
          threadCount: groupThreads.length,
          lastActivity,
          createdAt,
          isExpanded: !collapsedProjects.has(wd),
        });
      }

      // Build user-defined sections: for each user section, pick the
      // project groups whose workingDirectory is mapped to that section.
      const userSectionDescriptors = userSections.map((us) => {
        const sortedWds = sectionProjects
          .filter((sp) => sp.sectionId === us.id)
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((sp) => sp.workingDirectory);
        const groups: ProjectGroup[] = [];
        for (const wd of sortedWds) {
          const g = allProjectGroups.get(wd);
          if (g) groups.push(g);
        }
        // Synthetic empty placeholder so the section still renders the
        // header — a brand new section should still let the user
        // drag/drop projects in via the right-click menu.
        return {
          id: us.id,
          kind: 'user' as SectionKind,
          name: us.name,
          collapsed: us.collapsed,
          items: groups,
          isUserSection: true,
          sortable: true,
        };
      });

      // Unassigned project groups (workingDirectory not mapped to any
      // user section) → group into "__uncategorized__".
      const assignedWds = new Set(
        sectionProjects.map((sp) => sp.workingDirectory),
      );
      const unassignedGroups: ProjectGroup[] = [];
      for (const [wd, group] of allProjectGroups.entries()) {
        if (!assignedWds.has(wd)) {
          unassignedGroups.push(group);
        }
      }

      // Sort system section items by `projectSortBy` (for project group, only
      // the array of groups matters; for system kinds, the threads inside).
      const sortGroups = (groups: ProjectGroup[]) =>
        [...groups].sort((a, b) => {
          if (projectSortBy === 'priority') return b.createdAt - a.createdAt;
          if (projectSortBy === 'lastActivity') return b.lastActivity - a.lastActivity;
          return a.projectName.localeCompare(b.projectName);
        });

      /**
       * Plan 471 v5: discriminate section items at the data layer so the
       * render never has to "guess" between ProjectGroup and Thread.
       *
       * The previous shape used an `items: unknown[]` array and checked
       * `'workingDirectory' in entry` to pick a renderer — but `Thread`
       * ALSO has `workingDirectory` (the legacy field), so every cron /
       * gateway / wakeup session was incorrectly dispatched to
       * ProjectGroupItem, which then rendered only the folder icon (no
       * title, no actions). The discriminated union below eliminates the
       * ambiguity: only `project` items carry `group`, only `thread`
       * items carry `thread`, and the renderer matches on the tag.
       */
      type SectionProjectItem = { itemKind: 'project'; group: ProjectGroup };
      type SectionThreadItem = { itemKind: 'thread'; thread: Thread };
      type SectionItem = SectionProjectItem | SectionThreadItem;
      const projectItems = (groups: ProjectGroup[]): SectionProjectItem[] =>
        sortGroups(groups).map((group) => ({ itemKind: 'project' as const, group }));
      const threadItems = (threads: Thread[]): SectionThreadItem[] =>
        threads.map((thread) => ({ itemKind: 'thread' as const, thread }));

      // The order: user sections (by sortOrder) → "项目" (system default
      // group for unassigned projects) → cron → gateway → wakeup →
      // pinned. Cron / gateway / wakeup are folded by default (see
      // collapsedSystemSections initial state) so the sidebar stays calm.
      //
      // Note: there is no separate "未分组" section. Unassigned projects
      // land in the "项目" group; users drag them up into a user section
      // via the right-click menu. CRON_SIDEBAR_VISIBLE caps high-cardinality
      // runs so one hot cron job doesn't flood the sidebar.
      //
      // `projectGroupBy === 'singleList'` (⋯ menu → 在一个列表中): the
      // "项目" section renders as one flat session list (all main-agent
      // sessions by the chosen sort, no project grouping) and user
      // sections are hidden because the whole point of single-list mode
      // is to suppress the project hierarchy.
      const isSingleList = projectGroupBy === 'singleList';
      const projectSectionItems: SectionItem[] = isSingleList
        // Plan 471 v8: singleList reveals sessions 5 at a time (mirrors
        // ProjectGroupItem's THREAD_COLLAPSE_THRESHOLD behavior). When the
        // user has collapsed the section or switched back to byProject we
        // reset the reveal counter in the onToggle handler below.
        ? threadItems(projectThreads.slice(0, flatListVisibleCount))
        : projectItems(unassignedGroups);
      const projectSectionExtra: SectionThreadItem[] = isSingleList
        ? []
        : threadItems(noProjectThreads);
      // Number of sessions still hidden behind the "查看全部" reveal button
      // in singleList mode (only meaningful there).
      const flatListHiddenCount = isSingleList
        ? Math.max(0, projectThreads.length - flatListVisibleCount)
        : 0;
      return [
        ...(isSingleList ? [] : userSectionDescriptors.map((us) => ({
          ...us,
          items: projectItems(us.items as ProjectGroup[]),
        }))),
        {
          id: '__system__:project',
          kind: 'project' as SectionKind,
          name: '__PROJECT_SECTION__',
          collapsed: collapsedSystemSections.has('__system__:project'),
          items: projectSectionItems,
          extraNoProjectThreads: projectSectionExtra,
          flatListHiddenCount,
        },
        {
          id: '__system__:cron',
          kind: 'cron' as SectionKind,
          name: '__CRON_SECTION__',
          collapsed: collapsedSystemSections.has('__system__:cron'),
          items: threadItems(cronThreads.slice(0, CRON_SIDEBAR_VISIBLE)),
          hiddenCount: Math.max(0, cronThreads.length - CRON_SIDEBAR_VISIBLE),
        },
        {
          id: '__system__:gateway',
          kind: 'gateway' as SectionKind,
          name: '__GATEWAY_SECTION__',
          collapsed: collapsedSystemSections.has('__system__:gateway'),
          items: threadItems(gatewayThreads),
        },
        {
          id: '__system__:wakeup',
          kind: 'wakeup' as SectionKind,
          name: '__WAKEUP_SECTION__',
          collapsed: collapsedSystemSections.has('__system__:wakeup'),
          items: threadItems(wakeupThreads),
        },
        {
          id: '__system__:pinned',
          kind: 'pinned' as SectionKind,
          name: '__PINNED_SECTION__',
          collapsed: collapsedSystemSections.has('__system__:pinned'),
          items: threadItems(pinnedThreads),
        },
      ];
    }, [threads, projectSortBy, projectGroupBy, collapsedProjects, noProjectWorkspace, userSections, sectionProjects, collapsedSystemSections, flatListVisibleCount]);

    // Plan 471: "all collapsed" controls the ↕ toggle in the sidebar header.
    // Treat every section (user or system) as collapsed only when there is
    // at least one section AND every one is collapsed. Used to flip the
    // ↕ button between "全部收起" and "全部展开".
    const allCollapsed = useMemo(
      () =>
        sidebarStructure.length > 0 &&
        sidebarStructure.every((s) => s.collapsed === true),
      [sidebarStructure],
    );

    // Plan 471 v8: leaving singleList mode (back to 按项目) resets the flat
    // list reveal counter so the next time the user switches to 在一个列表中
    // it starts from the first batch again.
    useEffect(() => {
      if (projectGroupBy !== 'singleList') {
        setFlatListVisibleCount(FLAT_LIST_THRESHOLD);
      }
    }, [projectGroupBy]);

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
                        <Icon size={16} />
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

          {mainNavItems.map((item) => {
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

        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
          {/* Plan 471: every top-level sidebar group is a section header that
              can be toggled open/closed. The order is:
                user sections (by sortOrder)
                "项目" (system default — uncategorized projects)
                "定时任务" (cron)  — id starts with `cron:` (capped to 8 most recent)
                "网关" (gateway)    — id starts with `gw-`
                "唤醒" (wakeup)    — id starts with `wakeless-`
                "置顶" (pinned)    — thread.pinned === 1
              Each section renders its own body and has a chevron toggle in
              the header. The "项目" section also gets trailing action
              buttons (collapse-all / sort / new project) via ProjectActions.
          */}
          {/* Plan 483: bot sidebar - grok-style bot management */}
          {botContacts.length > 0 ? (
            <SidebarSectionItem
              id="__system__:bots"
              name={t("sidebar.section.bots")}
              kind="bot"
              collapsed={collapsedSystemSections.has("__system__:bots")}
              onToggleCollapsed={() => toggleSystemSectionCollapsed("__system__:bots")}
              tone="bold"
              trailing={
                <BotSectionActions
                  hiddenCount={hiddenBots.length}
                  showHidden={showHiddenBots}
                  onToggleHidden={() => setShowHiddenBots((prev) => !prev)}
                  onCreateBot={() => setIsCreateBotDialogOpen(true)}
                />
              }
            >
              {pinnedBots.length > 0 && (
                <div className="sidebar-section-group">
                  <div className="sidebar-section-group-header">{t("sidebar.section.pinned")}</div>
                  {pinnedBots.map((contact) => (
                    <BotContactListItem
                      key={contact.agentId}
                      contact={contact}
                      isActive={resolveBotOpenThreadId(contact, threads) === activeThreadId}
                      onOpen={handleOpenBot}
                      onTogglePin={(id, pinned) => togglePin(id, pinned)}
                      onEdit={handleEditBot}
                      onDelete={handleDeleteBot}
                      onHide={(c) => hide(c.agentId)}
                    />
                  ))}
                </div>
              )}
              {unpinnedBots.length > 0 && (
                <div className="sidebar-section-group">
                  {unpinnedBots.map((contact) => (
                    <BotContactListItem
                      key={contact.agentId}
                      contact={contact}
                      isActive={resolveBotOpenThreadId(contact, threads) === activeThreadId}
                      onOpen={handleOpenBot}
                      onTogglePin={(id, pinned) => togglePin(id, pinned)}
                      onEdit={handleEditBot}
                      onDelete={handleDeleteBot}
                      onHide={(c) => hide(c.agentId)}
                    />
                  ))}
                </div>
              )}
              {/* Plan 478: shared rooms (群聊) — Telegram-style group rows
                  under the same Bots section; the trailing "+" opens the
                  create-group dialog (member picker ≤6). */}
              <div className="sidebar-section-group">
                <div className="sidebar-section-group-header">
                  {t("sidebar.section.rooms")}
                  <button
                    type="button"
                    className="ml-auto rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
                    onClick={() => setGroupDialog({ mode: "create" })}
                    aria-label={t("room.create.title")}
                    data-testid="create-room-button"
                  >
                    <PlusIcon size={12} />
                  </button>
                </div>
                {roomContacts.length === 0 && (
                  <div className="px-3 py-1.5 text-[12px] text-[var(--text-muted)]">
                    {t("room.create.empty")}
                  </div>
                )}
                {roomContacts.map((room) => (
                  <RoomContactListItem
                    key={room.roomId}
                    room={room}
                    isActive={room.threadId === activeThreadId}
                    onOpen={() => handleOpenRoom(room.roomId)}
                    onEdit={() =>
                      setGroupDialog({
                        mode: "edit",
                        roomId: room.roomId,
                        name: room.name,
                        memberIds: room.memberIds,
                      })
                    }
                  />
                ))}
              </div>
            </SidebarSectionItem>
          ) : (
            <button
              className="sidebar-section-create"
              onClick={() => setIsCreateBotDialogOpen(true)}
            >
              <PlusIcon size={14} />
              <span>{t("bot.create.title")}</span>
            </button>
          )}

          {sidebarStructure.map((section) => {
            const isUser = section.kind === 'user';
            // Plan 471 v5: items are already discriminated at the data
            // layer (`{ itemKind: 'project', group } | { itemKind: 'thread', thread }`).
            // No more guessing — render dispatches off the `itemKind` tag.
            const items = (section as { items: Array<{ itemKind: 'project'; group: ProjectGroup } | { itemKind: 'thread'; thread: Thread }> }).items ?? [];
            const extraNoProjectThreads = ((section as { extraNoProjectThreads?: Array<{ thread: Thread }> }).extraNoProjectThreads ?? [])
              .map((entry) => entry.thread);
            const sectionLabelKey = (() => {
              switch (section.id) {
                case '__system__:cron':
                  return 'sidebar.section.cron';
                case '__system__:gateway':
                  return 'sidebar.section.gateway';
                case '__system__:wakeup':
                  return 'sidebar.section.wakeup';
                case '__system__:pinned':
                  return 'sidebar.section.pinned';
                case '__system__:project':
                  return 'sidebar.section.project';
                default:
                  return null;
              }
            })();
            const sectionName = sectionLabelKey
              ? t(sectionLabelKey as never)
              : section.name;
            // Empty sections are hidden except: user sections always show (so users
            // can right-click to delete or add), and the project section
            // always shows (so the user has a place for new projects). The
            // pinned system section is hidden when empty.
            const isEmpty = items.length === 0 && extraNoProjectThreads.length === 0;
            if (isEmpty) {
              if (!isUser && section.id !== '__system__:project' && section.id !== '__system__:_always-show-empty') {
                return null;
              }
            }
            // Pinned system section: only show if there is at least one entry.
            if (section.id === '__system__:pinned' && items.length === 0) {
              return null;
            }
            const sectionItemProps = {
              id: section.id,
              name: sectionName,
              kind: section.kind,
              collapsed: section.collapsed,
              onToggleCollapsed: isUser
                ? () => { void toggleUserSectionCollapsed(section.id); }
                : () => {
                    // Plan 471 v8: collapsing the "项目" section resets the
                    // singleList reveal counter so reopening shows the first
                    // batch again (same behavior as ProjectGroupItem).
                    if (section.id === '__system__:project') {
                      setFlatListVisibleCount(FLAT_LIST_THRESHOLD);
                    }
                    toggleSystemSectionCollapsed(section.id);
                  },
              tone: section.id === '__system__:project' ? 'soft' as const : 'bold' as const,
            };
            // The "项目" section gets a trailing "⋯ +" action group — matching
            // Codex's header pattern. The "⋯" opens a popup menu with
            // layout (按项目 / 在一个列表中) and sort (优先级 / 最近更新 /
            // 手动排序) options; the "+" creates a new blank project.
            const isProjectSection = section.id === '__system__:project';
            return (
              <SidebarSectionItem
                key={section.id}
                {...sectionItemProps}
                trailing={isProjectSection ? (
                  <ProjectSectionActions
                    onNewBlankProject={handleNewBlankProject}
                    projectSortBy={projectSortBy}
                    onProjectSortBy={setProjectSortBy}
                    projectGroupBy={projectGroupBy}
                    onProjectGroupBy={setProjectGroupBy}
                  />
                ) : undefined}
              >
                {items.map((entry) => {
                  if (entry.itemKind === 'project') {
                    const project = entry.group;
                    const projectThreads = threads.filter(
                      (t) => t.workingDirectory === project.workingDirectory
                        && t.agentType !== 'sub-agent'
                        && t.pinned !== 1
                        && !t.id.startsWith('cron:')
                        && !t.id.startsWith('gw-')
                        && !t.id.startsWith('wakeless-'),
                    );
                    return (
                      <ProjectGroupItem
                        key={project.workingDirectory}
                        project={project}
                        threads={projectThreads}
                        activeThreadId={activeThreadId}
                      />
                    );
                  }
                  return (
                    <ThreadListItem
                      key={entry.thread.id}
                      thread={entry.thread}
                      isActive={entry.thread.id === activeThreadId}
                    />
                  );
                })}
                {extraNoProjectThreads.map((thread) => (
                  <ThreadListItem
                    key={thread.id}
                    thread={thread}
                    isActive={thread.id === activeThreadId}
                  />
                ))}
                {(() => {
                  // "View all N more" link — for cron (routes to the
                  // Automation page for full history) and for the flat
                  // singleList session list (reveals 5 more inline, mirroring
                  // ProjectGroupItem's THREAD_COLLAPSE_THRESHOLD reveal).
                  const cronHidden = (section as { hiddenCount?: number }).hiddenCount;
                  if (cronHidden) {
                    return (
                      <button
                        type="button"
                        className="sidebar-section-view-all"
                        onClick={() => setCurrentView('automation')}
                      >
                        <CaretRightIcon size={10} />
                        <span>{t('common.showAll', { count: cronHidden })}</span>
                      </button>
                    );
                  }
                  const flatHidden = (section as { flatListHiddenCount?: number }).flatListHiddenCount;
                  if (flatHidden) {
                    const reveal = Math.min(FLAT_LIST_THRESHOLD, flatHidden);
                    return (
                      <button
                        type="button"
                        className="sidebar-section-view-all"
                        onClick={() => setFlatListVisibleCount((c) => c + FLAT_LIST_THRESHOLD)}
                      >
                        <CaretRightIcon size={10} />
                        <span>{t('common.showAll', { count: reveal })}</span>
                      </button>
                    );
                  }
                  return null;
                })()}
              </SidebarSectionItem>
            );
          })}

          {sidebarStructure.every((s) => {
            const items = (s as { items?: unknown[] }).items ?? [];
            return items.length === 0
              && ((s as { extraNoProjectThreads?: Thread[] }).extraNoProjectThreads ?? []).length === 0;
          })
            && userSections.length === 0
            && (
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
                  <button
                    type="button"
                    className="empty-state-action"
                    onClick={handleNewNoProjectThread}
                  >
                    <NotePencilIcon size={16} />
                    <span>{t('project.newNoProjectSession')}</span>
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
              <GearSixIcon size={16} />
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
              <SunIcon size={16} />
            ) : (
              <MoonStarsIcon size={16} />
            )}
          </button>
        </div>

        <CreateProjectDialog
          isOpen={isCreateProjectDialogOpen}
          onCancel={() => setIsCreateProjectDialogOpen(false)}
          onConfirm={handleCreateProjectConfirm}
        />
        <CreateBotDialog
          isOpen={isCreateBotDialogOpen}
          onCancel={() => setIsCreateBotDialogOpen(false)}
          existingIds={botContacts.map((c) => c.agentId)}
          onCreated={(agentId) => {
            // Plan 491 P2.5: navigate to the new bot's empty chat shell
            // immediately after creation. The await on reloadBots
            // refreshes the contact list for subsequent renders (it is
            // NOT a gate for navigation — handleOpenBotById reads the
            // latest threads from the store directly), but we navigate
            // first so the user does not see a flash of "still on the
            // previous view" while the network round-trip completes.
            handleOpenBotById(agentId);
            setIsCreateBotDialogOpen(false);
            void reloadBots();
          }}
        />

        {/* Plan 478: shared-room create/edit dialog (groups.toml write side). */}
        <GroupSettingsDialog
          isOpen={groupDialog !== null}
          mode={groupDialog?.mode ?? "create"}
          groupId={groupDialog?.mode === "edit" ? groupDialog.roomId : undefined}
          initialName={groupDialog?.mode === "edit" ? groupDialog.name : ""}
          initialMemberIds={groupDialog?.mode === "edit" ? groupDialog.memberIds : []}
          onCancel={() => setGroupDialog(null)}
          onSaved={() => {
            setGroupDialog(null);
            void reloadBots();
          }}
          onDeleted={() => {
            setGroupDialog(null);
            void reloadBots();
          }}
        />
        <EditBotDialog
          isOpen={editBotContact !== null}
          contact={editBotContact}
          onCancel={() => setEditBotContact(null)}
          onSaved={(agentId) => {
            setEditBotContact(null);
            void reloadBots();
          }}
        />
      </aside>
    );
  }
);

interface ProjectSectionActionsProps {
  onNewBlankProject: () => void;
  projectSortBy: ProjectSortBy;
  onProjectSortBy: (sortBy: ProjectSortBy) => void;
  projectGroupBy: ProjectGroupBy;
  onProjectGroupBy: (groupBy: ProjectGroupBy) => void;
}

/**
 * Plan 471: the "项目" section header's trailing "⋯ +" action group.
 *
 * The "⋯" opens a popup menu with two option groups:
 *   - 整理 (organize): 按项目 / 在一个列表中  — project layout toggle
 *   - 排序方式 (sortBy): 优先级 / 最近更新 / 手动排序
 *
 * The "+" creates a new blank project. This is the same control surface
 * the old `SidebarProjectHeader` exposed, but relocated into the section
 * header's trailing slot so the header itself stays a plain
 * "name + caret + [⋯ +]" row that matches the Codex reference.
 */
function ProjectSectionActions({
  onNewBlankProject,
  projectSortBy,
  onProjectSortBy,
  projectGroupBy,
  onProjectGroupBy,
}: ProjectSectionActionsProps) {
  const { t } = useTranslation();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isMenuOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isMenuOpen]);

  const closeMenu = () => {
    setIsMenuOpen(false);
  };

  const menuPosition = useMemo(() => {
    if (!menuButtonRef.current) return { top: 0, left: 0 };
    const rect = menuButtonRef.current.getBoundingClientRect();
    return {
      top: rect.bottom + 6,
      left: rect.right - 168,
    };
  }, [isMenuOpen]);

  return (
    <div className="relative flex items-center gap-1" ref={menuRef}>
      <button
        type="button"
        className="sidebar-section-action"
        ref={menuButtonRef}
        onClick={() => setIsMenuOpen((prev) => !prev)}
        title={t('common.more')}
        aria-expanded={isMenuOpen}
      >
        <DotsThreeIcon size={16} />
      </button>
      <button
        type="button"
        className="sidebar-section-action"
        onClick={onNewBlankProject}
        title={t('project.newProject')}
        aria-label={t('project.newProject')}
      >
        <PlusIcon size={14} />
      </button>

      {isMenuOpen && (
        <div className="sidebar-project-menu" style={menuPosition}>
          <div className="sidebar-project-menu-section">
            <span className="sidebar-project-menu-section-title">{t('project.organize')}</span>
            <button
              type="button"
              className="sidebar-project-menu-item"
              onClick={() => { onProjectGroupBy('byProject'); closeMenu(); }}
            >
              {projectGroupBy === 'byProject' ? <CheckIcon size={12} /> : <span className="sidebar-project-menu-check" />}
              <span>{t('project.byProject')}</span>
            </button>
            <button
              type="button"
              className="sidebar-project-menu-item"
              onClick={() => { onProjectGroupBy('singleList'); closeMenu(); }}
            >
              {projectGroupBy === 'singleList' ? <CheckIcon size={12} /> : <span className="sidebar-project-menu-check" />}
              <span>{t('project.inOneList')}</span>
            </button>
          </div>
          <div className="sidebar-project-menu-divider" />
          <div className="sidebar-project-menu-section">
            <span className="sidebar-project-menu-section-title">{t('project.sortBy')}</span>
            <button
              type="button"
              className="sidebar-project-menu-item"
              onClick={() => { onProjectSortBy('priority'); closeMenu(); }}
            >
              {projectSortBy === 'priority' ? <CheckIcon size={12} /> : <span className="sidebar-project-menu-check" />}
              <span>{t('project.priority')}</span>
            </button>
            <button
              type="button"
              className="sidebar-project-menu-item"
              onClick={() => { onProjectSortBy('lastActivity'); closeMenu(); }}
            >
              {projectSortBy === 'lastActivity' ? <CheckIcon size={12} /> : <span className="sidebar-project-menu-check" />}
              <span>{t('project.lastUpdated')}</span>
            </button>
            <button
              type="button"
              className="sidebar-project-menu-item"
              onClick={() => { onProjectSortBy('manual'); closeMenu(); }}
            >
              {projectSortBy === 'manual' ? <CheckIcon size={12} /> : <span className="sidebar-project-menu-check" />}
              <span>{t('project.manualSort')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Plan 483: bot section trailing actions (grok-style)
function BotSectionActions({
  hiddenCount,
  showHidden,
  onToggleHidden,
  onCreateBot,
}: {
  hiddenCount: number;
  showHidden: boolean;
  onToggleHidden: () => void;
  onCreateBot: () => void;
}) {
  const { t } = useTranslation();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const menuPosition = { top: '100%', right: 0 };

  return (
    <div className="relative flex items-center gap-1" ref={menuRef}>
      <button
        type="button"
        className="sidebar-section-action"
        onClick={onCreateBot}
        title={t('bot.create.title')}
        aria-label={t('bot.create.title')}
      >
        <PlusIcon size={14} />
      </button>
      <button
        type="button"
        className="sidebar-section-action"
        onClick={() => setIsMenuOpen((prev) => !prev)}
        title={t('common.more')}
        aria-expanded={isMenuOpen}
      >
        <DotsThreeIcon size={16} />
      </button>
      {isMenuOpen && (
        <div className="sidebar-project-menu" style={menuPosition}>
          <div className="sidebar-project-menu-section">
            <button
              type="button"
              className="sidebar-project-menu-item"
              onClick={() => {
                setIsMenuOpen(false);
                onToggleHidden();
              }}
            >
              {showHidden ? t('bot.actions.hideFromList') : t('bot.actions.showHidden')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
