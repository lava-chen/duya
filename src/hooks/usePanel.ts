"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import { getPageDescriptor, isPageId, type PageId, type PageTab } from "@/components/layout/panels/registry";
import { useConversationStore } from "@/stores/conversation-store";

export type { PageId, PageTab } from "@/components/layout/panels/registry";

export type PanelView = "content" | "picker";

export interface PanelContextValue {
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  panelWidth: number;
  setPanelWidth: (width: number) => void;

  workspaceExpanded: boolean;
  setWorkspaceExpanded: (expanded: boolean) => void;
  workspaceTreeOpen: boolean;
  setWorkspaceTreeOpen: (open: boolean) => void;

  panelView: PanelView;
  setPanelView: (view: PanelView) => void;

  tabs: PageTab[];
  activeTabId: string | null;

  openPanel: (pageId: PageId, params?: Record<string, unknown>) => string;
  closePanel: (tabId: string) => void;
  activateTab: (tabId: string) => void;
  updateTabTitle: (tabId: string, title: string) => void;
  updateTabFavicon: (tabId: string, favicon: string | undefined) => void;
  openOrActivatePage: (pageId: PageId, params?: Record<string, unknown>) => string;
  reorderTabs: (fromId: string, toId: string, position: "before" | "after") => void;
}

export const PanelContext = createContext<PanelContextValue | null>(null);

const MIN_PANEL_WIDTH = 300;
// Hard ceiling keeps the panel from eating the main column on extra-wide
// windows. The real cap is the workspace ratio (see `MAX_PANEL_RATIO`).
const MAX_PANEL_WIDTH = 1120;
const DEFAULT_PANEL_WIDTH = 340;
// Allow the chat column to shrink further on small screens. The previous
// 680px floor made the minimum window width too large when a side panel
// was open; 420px keeps input readable while freeing horizontal space.
const MIN_CHAT_WIDTH = 420;
// The panel must not exceed this share of the workspace. Keeps the
// chat column readable on both 1280px and 4K windows.
const MAX_PANEL_RATIO = 0.6;
// Re-export the layout constants for siblings (e.g. PanelZone) that need
// the same caps when computing drag-resize bounds.
export { MIN_PANEL_WIDTH, MAX_PANEL_WIDTH, MAX_PANEL_RATIO, MIN_CHAT_WIDTH };

const PANEL_STORAGE_PREFIX = "duya:panel:v2:";
const HOME_PANEL_KEY = "__home__";

interface PersistedPanelState {
  tabs: PageTab[];
  activeTabId: string | null;
  panelOpen: boolean;
  panelView: PanelView;
  workspaceExpanded: boolean;
  workspaceTreeOpen: boolean;
}

function emptyPanelState(): PersistedPanelState {
  return {
    tabs: [],
    activeTabId: null,
    panelOpen: false,
    panelView: "picker",
    workspaceExpanded: false,
    workspaceTreeOpen: false,
  };
}

function panelStorageKey(sessionKey: string): string {
  return `${PANEL_STORAGE_PREFIX}${sessionKey}`;
}

function isTransientAgentBrowserTab(tab: PageTab): boolean {
  return tab.pageId === "browser" && tab.params?.kind === "agent";
}

/**
 * Agent browser guests belong to a live tool process, not to a conversation's
 * saved layout. Persisting them recreates an empty webview when returning to a
 * thread and lets stale tool retries revive a browser the user already closed.
 */
export function persistablePanelState(state: PersistedPanelState): PersistedPanelState {
  const tabs = state.tabs.filter((tab) => !isTransientAgentBrowserTab(tab));
  const removedOnlyTransientAgentTabs = tabs.length === 0 && state.tabs.length > 0;
  return {
    ...state,
    tabs,
    activeTabId: tabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : null,
    panelOpen: removedOnlyTransientAgentTabs ? false : state.panelOpen,
    panelView: removedOnlyTransientAgentTabs ? "picker" : state.panelView,
    workspaceExpanded: removedOnlyTransientAgentTabs ? false : state.workspaceExpanded,
  };
}

/**
 * Read previously-persisted panel state. Validates `pageId` values
 * against the live registry and silently drops unknown entries so a
 * stale `localStorage` payload (e.g. after removing a page) cannot
 * crash the provider.
 */
function loadPersistedState(sessionKey: string, t: TFunc): PersistedPanelState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(panelStorageKey(sessionKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedPanelState> | null;
    if (!parsed || !Array.isArray(parsed.tabs)) return null;
    const tabs: PageTab[] = [];
    let droppedTransientAgentTab = false;
    for (const tab of parsed.tabs) {
      if (!tab || typeof tab.id !== "string" || !isPageId(tab.pageId)) continue;
      const normalizedTab: PageTab = {
        id: tab.id,
        pageId: tab.pageId,
        title: typeof tab.title === "string" ? tab.title : defaultPanelTitle(t, tab.pageId),
        favicon: typeof tab.favicon === "string" ? tab.favicon : undefined,
        params:
          tab.params && typeof tab.params === "object" && !Array.isArray(tab.params)
            ? (tab.params as Record<string, unknown>)
            : undefined,
      };
      if (isTransientAgentBrowserTab(normalizedTab)) {
        droppedTransientAgentTab = true;
        continue;
      }
      tabs.push(normalizedTab);
    }
    return {
      tabs,
      activeTabId:
        typeof parsed.activeTabId === "string" &&
        tabs.some((t) => t.id === parsed.activeTabId)
          ? parsed.activeTabId
          : null,
      panelOpen: droppedTransientAgentTab && tabs.length === 0 ? false : !!parsed.panelOpen,
      panelView: droppedTransientAgentTab && tabs.length === 0
        ? "picker"
        : parsed.panelView === "picker" ? "picker" : "content",
      workspaceExpanded: droppedTransientAgentTab && tabs.length === 0 ? false : parsed.workspaceExpanded === true,
      workspaceTreeOpen: parsed.workspaceTreeOpen === true,
    };
  } catch {
    return null;
  }
}

function savePersistedState(sessionKey: string, state: PersistedPanelState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(panelStorageKey(sessionKey), JSON.stringify(persistablePanelState(state)));
  } catch {
    // Quota / private mode — fail silently, the in-memory state still works.
  }
}

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function dedupKey(pageId: PageId, params?: Record<string, unknown>): string {
  switch (pageId) {
    case "files":
      return `files::${(params?.workingDirectory as string | undefined) ?? ""}`;
    case "conductor":
      return `conductor::${(params?.canvasId as string | undefined) ?? "__active__"}`;
    case "office":
      return `office::${(params?.filePath as string | undefined) ?? "__picker__"}`;
    case "preview":
      return `preview::${(params?.filePath as string | undefined) ?? "__picker__"}`;
    case "browser":
      // Agent tabs dedup by sessionId; manual tabs dedup by url.
      if (params?.kind === "agent") {
        return `browser::agent::${(params?.sessionId as string | undefined) ?? ""}`;
      }
      return `browser::${(params?.url as string | undefined) ?? ""}`;
    default:
      return `${pageId}::${JSON.stringify(params ?? {})}`;
  }
}

function panelMaxWidth(maxWidth?: number | null): number {
  return maxWidth === null ? Number.POSITIVE_INFINITY : maxWidth ?? MAX_PANEL_WIDTH;
}

function clampPanelWidth(width: number, maxWidth?: number | null): number {
  return Math.min(panelMaxWidth(maxWidth), Math.max(MIN_PANEL_WIDTH, width));
}

function getWorkspaceWidth(): number {
  if (typeof document === "undefined") return window.innerWidth ?? 0;
  const workspace = document.querySelector(".app-workspace-row");
  return workspace?.getBoundingClientRect().width ?? window.innerWidth;
}

export interface PanelWidthOptions {
  workspaceWidth: number;
  preferredWidth?: number;
  minWidth: number;
  widthRatio?: number;
  maxWidthRatio?: number;
  maxWidth?: number | null;
}

export function resolvePanelWidth({
  workspaceWidth,
  preferredWidth,
  minWidth,
  widthRatio,
  maxWidthRatio,
  maxWidth,
}: PanelWidthOptions): number {
  // Undefined preferred width falls back to the page's minimum, so we never
  // propagate NaN into setPanelWidth (CSS would silently drop `NaNpx`).
  const maximumWidth = panelMaxWidth(maxWidth);
  const fallback = clampPanelWidth(minWidth, maxWidth);

  let desired: number;
  if (typeof widthRatio === "number" && Number.isFinite(widthRatio) && widthRatio > 0) {
    // Ratio-driven sizing: panel claims `widthRatio` of the workspace and
    // the chat column gets the rest. Ignore `preferredWidth` so callers can't
    // accidentally pass a fixed pixel value and override the ratio.
    desired = clampPanelWidth(workspaceWidth * widthRatio, maxWidth);
  } else {
    desired = clampPanelWidth(
      typeof preferredWidth === "number" && Number.isFinite(preferredWidth) ? preferredWidth : minWidth,
      maxWidth,
    );
  }

  const ratioCap =
    typeof maxWidthRatio === "number" && Number.isFinite(maxWidthRatio) && maxWidthRatio > 0
      ? maxWidthRatio
      : MAX_PANEL_RATIO;
  const maxByRatio = workspaceWidth * ratioCap;
  // The chat column is always protected. When the two minimum widths cannot
  // coexist, the responsive layout overlays the panel instead of squeezing
  // the chat below this minimum.
  const maxWithChat = workspaceWidth - MIN_CHAT_WIDTH;

  // The tightest of: page ceiling, ratio cap, and chat-minimum cap.
  const upperBound = Math.min(maximumWidth, maxByRatio, maxWithChat);
  return Math.max(fallback, Math.min(desired, upperBound));
}

export function PanelProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const activeThreadId = useConversationStore((s) => s.activeThreadId);
  const sessionKey = activeThreadId ?? HOME_PANEL_KEY;

  // Load persisted state exactly once. `useRef(undefined)` lets us
  // distinguish "haven't tried yet" from "loaded null" so subsequent
  // renders (e.g. React strict mode double-invoke) don't re-read
  // localStorage.
  const initialRef = useRef<PersistedPanelState | null | undefined>(undefined);
  if (initialRef.current === undefined) {
    initialRef.current = loadPersistedState(sessionKey, t);
  }
  const initial = initialRef.current ?? emptyPanelState();

  const [panelOpen, setPanelOpen] = useState<boolean>(initial.panelOpen);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [panelView, setPanelView] = useState<PanelView>(initial.panelView);
  const [workspaceExpanded, setWorkspaceExpandedState] = useState(initial.workspaceExpanded);
  const [workspaceTreeOpen, setWorkspaceTreeOpen] = useState(initial.workspaceTreeOpen);
  const [tabs, setTabs] = useState<PageTab[]>(initial.tabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(initial.activeTabId);

  const currentSessionKeyRef = useRef(sessionKey);
  const panelStateRef = useRef<PersistedPanelState>(initial);
  panelStateRef.current = { tabs, activeTabId, panelOpen, panelView, workspaceExpanded, workspaceTreeOpen };

  // Tracks the active thread id for IPC handlers that are set up once but
  // need to know whether an incoming agent-browser request belongs to the
  // session the user is currently viewing.
  const activeThreadIdRef = useRef(activeThreadId);
  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  const tabsRef = useRef<PageTab[]>(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  // Persist the slice of state that needs to survive a reload.
  // `panelWidth` is intentionally excluded — it's a transient UI
  // affordance, not part of the panel "contents".
  useEffect(() => {
    savePersistedState(currentSessionKeyRef.current, { tabs, activeTabId, panelOpen, panelView, workspaceExpanded, workspaceTreeOpen });
  }, [tabs, activeTabId, panelOpen, panelView, workspaceExpanded, workspaceTreeOpen]);

  useEffect(() => {
    const previousSessionKey = currentSessionKeyRef.current;
    if (previousSessionKey === sessionKey) return;

    savePersistedState(previousSessionKey, panelStateRef.current);

    const next = loadPersistedState(sessionKey, t) ?? emptyPanelState();
    currentSessionKeyRef.current = sessionKey;

    // Live agent browser tabs belong to a running tool process, not to a
    // conversation's saved layout. Destroying them on switch would unregister
    // the webview from the daemon, so the agent's next browser command would
    // fail (404) and re-create the tab in whatever session is now visible —
    // popping the sidebar in the wrong session. Keep them mounted instead.
    const preservedAgentTabs = tabsRef.current.filter(isTransientAgentBrowserTab);
    setTabs([...next.tabs, ...preservedAgentTabs]);
    setActiveTabId(next.activeTabId);
    setPanelOpen(next.panelOpen);
    setPanelView(next.panelView);
    setWorkspaceExpandedState(next.workspaceExpanded);
    setWorkspaceTreeOpen(next.workspaceTreeOpen);
  }, [sessionKey]);

  const setWorkspaceExpanded = useCallback((expanded: boolean) => {
    setWorkspaceExpandedState(expanded);
    if (expanded) {
      setPanelOpen(true);
      setPanelView("content");
    }
  }, []);

  const applyPageLayout = useCallback((pageId: PageId) => {
    const descriptor = getPageDescriptor(pageId);
    const nextWidth = resolvePanelWidth({
      workspaceWidth: getWorkspaceWidth(),
      preferredWidth: descriptor.preferredWidth,
      minWidth: descriptor.minWidth,
      widthRatio: descriptor.widthRatio,
      maxWidthRatio: descriptor.maxWidthRatio,
      maxWidth: descriptor.maxWidth,
    });
    setPanelWidth(nextWidth);
    setWorkspaceExpandedState(descriptor.defaultExpanded);
    setPanelOpen(true);
    setPanelView("content");
  }, []);

  const togglePanel = useCallback(() => {
    setPanelOpen((prev) => {
      const next = !prev;
      if (next) {
        setPanelView("content");
      }
      return next;
    });
  }, []);

  const handleSetWidth = useCallback((width: number) => {
    setPanelWidth(clampPanelWidth(width));
  }, []);

  const openPanel = useCallback<PanelContextValue["openPanel"]>((pageId, params) => {
    const id = genId();
    const newTab: PageTab = {
      id,
      pageId,
      title: typeof params?.title === "string" ? params.title : defaultPanelTitle(t, pageId),
      params,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(id);
    applyPageLayout(pageId);
    return id;
  }, [applyPageLayout, t]);

  const openOrActivatePage = useCallback<PanelContextValue["openOrActivatePage"]>(
    (pageId, params) => {
      const key = dedupKey(pageId, params);
      const existing = tabsRef.current.find(
        (t) => t.pageId === pageId && dedupKey(t.pageId, t.params) === key
      );
      if (existing) {
        setActiveTabId(existing.id);
        const providedTitle = typeof params?.title === "string" ? params.title : undefined;
        if (providedTitle && providedTitle !== existing.title) {
          setTabs((prev) => prev.map((tab) => (
            tab.id === existing.id ? { ...tab, title: providedTitle } : tab
          )));
        }
        applyPageLayout(pageId);
        return existing.id;
      }
      return openPanel(pageId, params);
    },
    [applyPageLayout, openPanel]
  );

  useEffect(() => {
    const handleOpenBrowserPanel = (event: Event) => {
      const detail = (event as CustomEvent<{ url?: string; title?: string }>).detail;
      const url = typeof detail?.url === "string" ? detail.url : "";
      if (!url.trim()) return;
      openOrActivatePage("browser", {
        url,
        title: typeof detail?.title === "string" ? detail.title : undefined,
      });
    };

    window.addEventListener("duya:open-browser-panel", handleOpenBrowserPanel as EventListener);
    return () => {
      window.removeEventListener("duya:open-browser-panel", handleOpenBrowserPanel as EventListener);
    };
  }, [openOrActivatePage]);

  // Listen for agent-driven browser tab requests from the daemon.
  // When the agent issues a browser command but no webview is registered,
  // the daemon sends 'browser:open-agent-tab' IPC to trigger tab creation.
  useEffect(() => {
    const cleanup = window.electronAPI?.browserWebview?.onOpenAgentTab((sessionId: string, focus: boolean) => {
      const isActiveSession = sessionId === activeThreadIdRef.current;
      const existing = tabsRef.current.find(
        (tab) => tab.pageId === "browser" && tab.params?.kind === "agent" && tab.params.sessionId === sessionId,
      );
      if (existing) {
        // Only focus/open the sidebar when the agent belongs to the session
        // the user is currently viewing. Other sessions' agent browsers stay
        // mounted (so the tool keeps working) but never auto-open the sidebar.
        if (focus && isActiveSession) openOrActivatePage("browser", existing.params);
        return;
      }

      const params = {
        kind: "agent",
        sessionId,
        title: "Agent Browser",
      };
      const hasVisibleAgentBrowser = tabsRef.current.some(
        (tab) => tab.pageId === "browser" && tab.params?.kind === "agent",
      );
      // Mount the webview without stealing the sidebar when:
      //   - the agent runs in a session the user isn't viewing, OR
      //   - the tool explicitly requested a background tab and one is already visible.
      if (!isActiveSession || (!focus && hasVisibleAgentBrowser)) {
        setTabs((previous) => [...previous, {
          id: genId(),
          pageId: "browser",
          title: "Agent Browser",
          params,
        }]);
        return;
      }
      openOrActivatePage("browser", {
        ...params,
      });
    });
    return () => cleanup?.();
  }, [openOrActivatePage]);

  useEffect(() => {
    const handleOpenFilePreview = (event: Event) => {
      const detail = (event as CustomEvent<{
        filePath?: string;
        workingDirectory?: string;
        lineStart?: number;
        lineEnd?: number;
      }>).detail;
      const filePath = typeof detail?.filePath === "string" ? detail.filePath : "";
      const workingDirectory = typeof detail?.workingDirectory === "string" ? detail.workingDirectory : "";
      if (!filePath.trim() || !workingDirectory.trim()) return;
      const params: Record<string, unknown> = {
        filePath,
        workingDirectory,
        title: filePath.split(/[/\\]/).pop() || t('panel.preview'),
      };
      // Forward the agent's read line range so the preview panel can
      // scroll to and highlight the exact lines on first mount. The
      // follow-up `duya:preview-focus-lines` event handles re-focus on
      // an already-open tab (see openLocalArtifactTarget).
      if (typeof detail?.lineStart === "number" && Number.isFinite(detail.lineStart)) {
        params.lineStart = detail.lineStart;
        if (typeof detail?.lineEnd === "number" && Number.isFinite(detail.lineEnd)) {
          params.lineEnd = detail.lineEnd;
        }
      }
      // Reset the embedded file tree to closed so the preview opens as a
      // focused editor (per PanelFileTreeSplit design intent), not a split
      // browser. Users can still expand it via the toolbar toggle.
      setWorkspaceTreeOpen(false);
      openOrActivatePage("preview", params);
    };

    window.addEventListener("duya:open-file-preview-panel", handleOpenFilePreview as EventListener);
    return () => {
      window.removeEventListener("duya:open-file-preview-panel", handleOpenFilePreview as EventListener);
    };
  }, [openOrActivatePage]);

  useEffect(() => {
    const handleOpenSkillPreview = async (event: Event) => {
      const detail = (event as CustomEvent<{ skillName?: string }>).detail;
      const skillName = typeof detail?.skillName === "string" ? detail.skillName : "";
      if (!skillName.trim()) return;

      const api = (window as unknown as {
        electronAPI?: {
          skills?: {
            list: () => Promise<{ success?: boolean; skills?: unknown[]; error?: string }>;
          };
        };
      }).electronAPI;
      if (!api?.skills?.list) return;

      try {
        const result = await api.skills.list();
        if (!result.success || !Array.isArray(result.skills)) return;

        const skill = result.skills.find((s): s is { name: string; skillRoot: string } => {
          const maybe = s as Record<string, unknown> | undefined;
          return (
            maybe != null &&
            typeof maybe.name === "string" &&
            maybe.name === skillName &&
            typeof maybe.skillRoot === "string" &&
            maybe.skillRoot.length > 0
          );
        });
        if (!skill) return;

        const filePath = `${skill.skillRoot.replace(/[\\/]+$/, "")}/SKILL.md`;
        window.dispatchEvent(new CustomEvent("duya:open-file-preview-panel", {
          detail: {
            filePath,
            workingDirectory: skill.skillRoot,
          },
        }));
      } catch {
        // Ignore skill lookup failures.
      }
    };

    window.addEventListener("duya:open-skill-preview", handleOpenSkillPreview as EventListener);
    return () => {
      window.removeEventListener("duya:open-skill-preview", handleOpenSkillPreview as EventListener);
    };
  }, []);

  useEffect(() => {
    const handleOpenOfficePanel = (event: Event) => {
      const detail = (event as CustomEvent<{ filePath?: string; workingDirectory?: string }>).detail;
      const filePath = typeof detail?.filePath === "string" ? detail.filePath : "";
      const workingDirectory = typeof detail?.workingDirectory === "string" ? detail.workingDirectory : "";
      if (!filePath.trim()) return;
      openOrActivatePage("office", {
        filePath,
        workingDirectory,
        title: filePath.split(/[/\\]/).pop() || t('panel.office'),
      });
    };

    window.addEventListener("duya:open-office-panel", handleOpenOfficePanel as EventListener);
    return () => {
      window.removeEventListener("duya:open-office-panel", handleOpenOfficePanel as EventListener);
    };
  }, [openOrActivatePage]);

  const closePanel = useCallback<PanelContextValue["closePanel"]>((tabId) => {
    const closingTab = tabsRef.current.find((tab) => tab.id === tabId);
    if (
      closingTab?.pageId === "browser" &&
      closingTab.params?.kind === "agent" &&
      typeof closingTab.params.sessionId === "string"
    ) {
      // A visible close is authoritative: suppress in-flight tool retries so
      // they cannot recreate a blank agent browser after this tab disappears.
      void window.electronAPI?.browserWebview?.closeAgentBrowser(closingTab.params.sessionId).catch(() => {});
    }
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx === -1) return prev;
      const closing = prev[idx];
      if (closing.pageId === "terminal" && typeof window !== "undefined") {
        void window.electronAPI?.terminal?.kill?.(tabId).catch(() => {});
      }
      const next = prev.filter((t) => t.id !== tabId);
      setActiveTabId((current) => {
        if (current !== tabId) return current;
        if (next.length === 0) return null;
        const fallback = next[Math.min(idx, next.length - 1)];
        return fallback.id;
      });
      if (next.length === 0) {
        setPanelView("picker");
        setPanelOpen(false);
        setWorkspaceExpandedState(false);
      }
      return next;
    });
  }, []);

  const activateTab = useCallback<PanelContextValue["activateTab"]>((tabId) => {
    const tab = tabsRef.current.find((t) => t.id === tabId);
    setActiveTabId(tabId);
    if (tab) {
      applyPageLayout(tab.pageId);
    } else {
      setPanelOpen(true);
      setPanelView("content");
    }
  }, [applyPageLayout]);

  useEffect(() => {
    const api = window.electronAPI?.browserWebview;
    const findAgentTab = (sessionId: string) => tabsRef.current.find(
      (tab) => tab.pageId === "browser" && tab.params?.kind === "agent" && tab.params.sessionId === sessionId,
    );
    const stopClose = api?.onCloseAgentTab((sessionId) => {
      const tab = findAgentTab(sessionId);
      if (tab) closePanel(tab.id);
    });
    const stopActivate = api?.onActivateAgentTab((sessionId, focus) => {
      if (!focus) return;
      // The daemon sends activate on every browser command. Only steal the
      // sidebar focus when the agent belongs to the session the user is
      // viewing — otherwise the sidebar would pop open in every session the
      // user switches to while a background agent is browsing.
      if (sessionId !== activeThreadIdRef.current) return;
      const tab = findAgentTab(sessionId);
      if (tab) activateTab(tab.id);
    });
    return () => {
      stopClose?.();
      stopActivate?.();
    };
  }, [activateTab, closePanel]);

  const updateTabTitle = useCallback<PanelContextValue["updateTabTitle"]>((tabId, title) => {
    const nextTitle = title.trim();
    if (!nextTitle) return;
    setTabs((prev) => prev.map((tab) => (
      tab.id === tabId && tab.title !== nextTitle
        ? { ...tab, title: nextTitle }
        : tab
    )));
  }, []);

  const updateTabFavicon = useCallback<PanelContextValue["updateTabFavicon"]>((tabId, favicon) => {
    setTabs((prev) => prev.map((tab) => (
      tab.id === tabId && tab.favicon !== favicon
        ? { ...tab, favicon }
        : tab
    )));
  }, []);

  const reorderTabs = useCallback<PanelContextValue["reorderTabs"]>(
    (fromId, toId, position) => {
      setTabs((prev) => {
        const fromIdx = prev.findIndex((t) => t.id === fromId);
        const toIdxRaw = prev.findIndex((t) => t.id === toId);
        if (fromIdx === -1 || toIdxRaw === -1 || fromIdx === toIdxRaw) return prev;
        const insertAt =
          position === "after" && toIdxRaw > fromIdx
            ? toIdxRaw
            : position === "after" && toIdxRaw < fromIdx
              ? toIdxRaw + 1
              : position === "before" && toIdxRaw > fromIdx
                ? toIdxRaw - 1
                : toIdxRaw;
        if (insertAt === fromIdx) return prev;
        const next = prev.slice();
        const [moved] = next.splice(fromIdx, 1);
        next.splice(insertAt, 0, moved);
        return next;
      });
    },
    []
  );

  const value = useMemo<PanelContextValue>(
    () => ({
      panelOpen,
      setPanelOpen,
      togglePanel,
      panelWidth,
      setPanelWidth: handleSetWidth,
      workspaceExpanded,
      setWorkspaceExpanded,
      workspaceTreeOpen,
      setWorkspaceTreeOpen,
      panelView,
      setPanelView,
      tabs,
      activeTabId,
      openPanel,
      closePanel,
      activateTab,
      updateTabTitle,
      updateTabFavicon,
      openOrActivatePage,
      reorderTabs,
    }),
    [
      panelOpen,
      togglePanel,
      panelWidth,
      handleSetWidth,
      workspaceExpanded,
      setWorkspaceExpanded,
      workspaceTreeOpen,
      panelView,
      tabs,
      activeTabId,
      openPanel,
      closePanel,
      activateTab,
      updateTabTitle,
      updateTabFavicon,
      openOrActivatePage,
      reorderTabs,
    ],
  );

  return React.createElement(PanelContext.Provider, { value }, children);
}

export function usePanel(): PanelContextValue {
  const ctx = useContext(PanelContext);
  if (!ctx) {
    throw new Error("usePanel must be used within a PanelProvider");
  }
  return ctx;
}

/**
 * Non-throwing variant of {@link usePanel}. Returns `null` when no
 * `PanelProvider` is mounted above the consumer, instead of throwing.
 * Useful for components that are rendered both inside and outside the
 * panel subtree (e.g. integrated file tree used standalone).
 */
export function useOptionalPanel(): PanelContextValue | null {
  return useContext(PanelContext);
}

type TFunc = (key: TranslationKey, params?: Record<string, string | number>) => string;

function defaultPanelTitle(t: TFunc, pageId: PageId): string {
  return t(`panel.${pageId}` as TranslationKey);
}
