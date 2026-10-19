"use client";

import { AppSidebar } from "@/components/layout/app-sidebar";
import { TitleBar } from "@/components/layout/TitleBar";
import { UpdateBadge } from "@/components/update/UpdateBadge";
import { lazy, Suspense, useState, useCallback, useRef, useEffect, type CSSProperties } from "react";
import { useConversationStore } from "@/stores/conversation-store";
import { useNavHistoryStore, registerNavApplier, type NavHistoryEntry } from "@/stores/nav-history-store";
import { PanelProvider, usePanel } from "@/hooks/usePanel";
import { PanelZone } from "@/components/layout/PanelZone";
import { TaskDrawerToggle } from "@/components/layout/TaskDrawerToggle";
import { useBackdropRepair } from "@/lib/backdrop-repair";

// Custom event for triggering onboarding reset
const RESET_ONBOARDING_EVENT = "duya:reset-onboarding";

// Lazily import OnboardingFlow to avoid loading issues with @lobehub/icons
const OnboardingFlow = lazy(() => import("@/components/onboarding/OnboardingFlow").then((mod) => ({ default: mod.OnboardingFlow })));

interface AppShellProps {
  children: any;
}

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 400;
const DEFAULT_SIDEBAR_WIDTH = 260;
// Collapsed sidebar (title-bar toggle): icon-only rail. Icons are ~34px
// wide plus the sidebar's horizontal padding.
const SIDEBAR_RAIL_WIDTH = 56;
const SIDEBAR_COLLAPSED_KEY = "duya-sidebar-collapsed";
// Invisible edge resizer: drag starts only within this many px of the
// sidebar's right edge. No dedicated strip element, no layout footprint.
const RESIZER_EDGE_PX = 4;

function AppShellInner({ children }: AppShellProps) {
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [forceShowOnboarding, setForceShowOnboarding] = useState(false);
  const { currentView, isHydrated, activeThreadId, settingsTab } = useConversationStore();
  const { panelOpen, tabs, activeTabId, setPanelOpen, activateTab, workspaceExpanded } = usePanel();

  // Title-bar back/forward: commit every navigation-relevant transition
  // (view, session, settings tab, side-panel page) into the nav history.
  // The store coalesces multi-pass commits and swallows the echo of its own
  // back()/forward() applies — see nav-history-store.ts.
  useEffect(() => {
    if (!isHydrated) return;
    useNavHistoryStore.getState().commit({
      view: currentView,
      threadId: activeThreadId ?? null,
      settingsTab: settingsTab ?? null,
      panel: { open: panelOpen, activeTabId },
    });
  }, [currentView, activeThreadId, settingsTab, panelOpen, activeTabId, isHydrated]);

  // Restore a history snapshot. The conversation slice is written directly
  // (synchronous, exact — setActiveThread is async and id-only, wrong for
  // restoring a "no session" state). The panel is only steered when the
  // session didn't change: a thread switch swaps in that session's persisted
  // layout via the sessionKey effect, which is the correct panel state.
  const applyNavEntry = useCallback((target: NavHistoryEntry) => {
    const threadChanged = useConversationStore.getState().activeThreadId !== target.threadId;
    useConversationStore.setState({
      activeThreadId: target.threadId,
      currentView: target.view,
      ...(target.view === "settings" && target.settingsTab
        ? { settingsTab: target.settingsTab }
        : {}),
    });
    if (threadChanged) return;
    if (target.panel.open) {
      const targetTabId = target.panel.activeTabId;
      const tabExists = targetTabId !== null && tabs.some((tab) => tab.id === targetTabId);
      if (tabExists && targetTabId !== activeTabId) {
        activateTab(targetTabId);
      } else if (!tabExists && !panelOpen) {
        setPanelOpen(true);
      }
    } else if (panelOpen) {
      setPanelOpen(false);
    }
  }, [tabs, activeTabId, panelOpen, activateTab, setPanelOpen]);

  useEffect(() => {
    registerNavApplier(applyNavEntry);
    return () => registerNavApplier(null);
  }, [applyNavEntry]);

  // macOS uses the system hiddenInset titlebar (traffic lights on the top-left),
  // so we skip the custom TitleBar there and let the window chrome blend with
  // the vibrancy backdrop. On Windows/Linux we keep the custom drag region.
  const isMac =
    typeof window !== "undefined" &&
    window.electronAPI?.versions?.platform === "darwin";

  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  // Sidebar collapse (icon rail). Renderer-local with a localStorage hint so
  // the choice survives restarts; plan 571 will move it into the tab shell.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((collapsed) => !collapsed);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? "1" : "0");
    } catch {
      // localStorage unavailable — collapse just won't persist.
    }
  }, [sidebarCollapsed]);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);
  const effectiveSidebarWidth = sidebarCollapsed ? SIDEBAR_RAIL_WIDTH : sidebarWidth;

  // Windows/Mica: force the glass layers to re-composite when the window
  // leaves fullscreen, or they can render stuck on a stale backdrop.
  useBackdropRepair();

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    startXRef.current = e.clientX;
    startWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  // Starts a resize only when the press lands on the sidebar's right edge.
  // The collapsed rail has a fixed width — no edge resize while collapsed.
  const handleBodyMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (sidebarCollapsed) return;
      const el = sidebarRef.current;
      if (!el) return;
      const edge = el.getBoundingClientRect().right;
      if (Math.abs(e.clientX - edge) > RESIZER_EDGE_PX) return;
      handleMouseDown(e);
    },
    [handleMouseDown, sidebarCollapsed]
  );

  // Cursor affordance for the invisible edge zone (no visual footprint).
  const handleBodyMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isResizing || sidebarCollapsed) return;
      const el = sidebarRef.current;
      if (!el) return;
      const edge = el.getBoundingClientRect().right;
      document.body.style.cursor =
        Math.abs(e.clientX - edge) <= RESIZER_EDGE_PX ? "col-resize" : "";
    },
    [isResizing, sidebarCollapsed]
  );

  const handleBodyMouseLeave = useCallback(() => {
    if (!isResizing) document.body.style.cursor = "";
  }, [isResizing]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizing) return;

    const delta = e.clientX - startXRef.current;
    const newWidth = Math.max(
      MIN_SIDEBAR_WIDTH,
      Math.min(MAX_SIDEBAR_WIDTH, startWidthRef.current + delta)
    );
    setSidebarWidth(newWidth);
  }, [isResizing]);

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  useEffect(() => {
    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    } else {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, handleMouseMove, handleMouseUp]);

  // Check if onboarding should be shown (only once on mount)
  useEffect(() => {
    if (isHydrated) {
      const onboardingCompleted = localStorage.getItem("duya-onboarding-completed");
      if (!onboardingCompleted) {
        const timer = setTimeout(() => setShowOnboarding(true), 500);
        return () => clearTimeout(timer);
      }
    }
  }, [isHydrated]);

  // Listen for reset onboarding event from Settings
  useEffect(() => {
    const handleResetOnboarding = () => {
      localStorage.removeItem("duya-onboarding-completed");
      setForceShowOnboarding(true);
      setShowOnboarding(true);
    };

    window.addEventListener(RESET_ONBOARDING_EVENT, handleResetOnboarding);
    return () => window.removeEventListener(RESET_ONBOARDING_EVENT, handleResetOnboarding);
  }, []);

  // Conductor has a dedicated top-level view; close the side panel when
  // entering it so we don't render a duplicate canvas in the panel zone.
  useEffect(() => {
    if (currentView === 'conductor' && panelOpen) {
      setPanelOpen(false);
    }
  }, [currentView, panelOpen, setPanelOpen]);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activePageId = activeTab?.pageId;
  const isConductorOpen = panelOpen && activePageId === 'conductor';

  return (
    <div
      className="app-shell-root"
      data-conductor-open={isConductorOpen ? "true" : undefined}
      data-panel-expanded={workspaceExpanded ? "true" : undefined}
      data-platform={isMac ? "mac" : "win"}
      style={{ "--app-sidebar-width": `${effectiveSidebarWidth}px` } as CSSProperties}
    >
      {showOnboarding && (
        <Suspense fallback={null}>
          <OnboardingFlow
            forceShow={forceShowOnboarding}
            onComplete={() => {
              setShowOnboarding(false);
              setForceShowOnboarding(false);
            }}
          />
        </Suspense>
      )}
      <div className="app-shell">
        {!isMac && (
          <TitleBar
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={toggleSidebarCollapsed}
          />
        )}
        <div
          className="app-body"
          onMouseDown={handleBodyMouseDown}
          onMouseMove={handleBodyMouseMove}
          onMouseLeave={handleBodyMouseLeave}
        >
          <AppSidebar
            ref={sidebarRef}
            collapsed={sidebarCollapsed}
            onExpand={() => setSidebarCollapsed(false)}
            style={{
              width: effectiveSidebarWidth,
              minWidth: effectiveSidebarWidth,
              maxWidth: effectiveSidebarWidth,
            }}
          />
          <div className="app-workspace-row">
            <div className="app-main-wrapper">
              <div className="app-main">
                <div className="app-main-inner">
                  <main className="app-content">{children}</main>
                </div>
              </div>
              <div className="app-status-bar">
                <UpdateBadge />
              </div>
            </div>
            <PanelZone />
            <TaskDrawerToggle />
          </div>
        </div>
      </div>
    </div>
  );
}

export function AppShell({ children }: AppShellProps) {
  return (
    <PanelProvider>
      <AppShellInner>{children}</AppShellInner>
    </PanelProvider>
  );
}
