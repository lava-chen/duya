"use client";

import { AppSidebar } from "@/components/layout/app-sidebar";
import { TitleBar } from "@/components/layout/TitleBar";
import { UpdateBadge } from "@/components/update/UpdateBadge";
import { lazy, Suspense, useState, useCallback, useRef, useEffect } from "react";
import { useConversationStore } from "@/stores/conversation-store";
import { PanelProvider } from "@/hooks/usePanel";
import { PanelZone } from "@/components/layout/PanelZone";

// Lazily import OnboardingFlow to avoid loading issues with @lobehub/icons
const OnboardingFlow = lazy(() => import("@/components/onboarding/OnboardingFlow").then((mod) => ({ default: mod.OnboardingFlow })));

interface AppShellProps {
  children: any;
}

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 400;
const DEFAULT_SIDEBAR_WIDTH = 260;

export function AppShell({ children }: AppShellProps) {
  const [showOnboarding, setShowOnboarding] = useState(false);
  const { currentView, isHydrated } = useConversationStore();

  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    startXRef.current = e.clientX;
    startWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

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

  return (
    <PanelProvider>
      <div className="app-shell-root">
        {showOnboarding && (
          <Suspense fallback={null}>
            <OnboardingFlow onComplete={() => setShowOnboarding(false)} />
          </Suspense>
        )}
        <div className="app-shell">
          <TitleBar sidebarWidth={sidebarWidth} />
          <div className="app-body">
            <AppSidebar ref={sidebarRef} style={{ width: sidebarWidth, minWidth: sidebarWidth, maxWidth: sidebarWidth }} />
            <div className="sidebar-resizer" onMouseDown={handleMouseDown}>
              <div className="sidebar-resizer-handle" />
            </div>
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
          </div>
        </div>
      </div>
    </PanelProvider>
  );
}
