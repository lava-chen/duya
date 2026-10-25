// Root of a detached panel window.
//
// A detached window loads the same renderer bundle as the main window; the
// preload context is what tells it apart. This component renders ONLY the
// one panel that window hosts — no shell, no sidebar, no chat — with a slim
// header carrying the two actions the native title bar cannot: pinning and
// returning the pane to the main window. Closing via the native X is
// translated to the same "return" by the main process, so the pane never
// dies here.

"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownLeftIcon, PinIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import { getPageDescriptor, PAGE_REGISTRY } from "./registry";
import type { PageId, PageTab } from "./page-tab";

interface PanelWindowBridge {
  context: {
    paneId: string | null;
    pageId: string | null;
    params: Record<string, unknown> | null;
  };
  close: (paneId?: string) => Promise<unknown>;
  setAlwaysOnTop: (paneId: string, alwaysOnTop: boolean) => Promise<unknown>;
  getState: (paneId: string) => Promise<{ ok: boolean; alwaysOnTop?: boolean }>;
  onEvent: (callback: (event: { type: string; paneId?: string; alwaysOnTop?: boolean }) => void) => () => void;
}

/** The bridge of this window, or null outside Electron. */
function bridge(): PanelWindowBridge | null {
  if (typeof window === "undefined") return null;
  const api = window.electronAPI?.panelWindow;
  return api ?? null;
}

export function DetachedPanelRoot() {
  const { t } = useTranslation();
  const context = useMemo(() => bridge()?.context ?? null, []);
  const paneId = context?.paneId ?? null;
  const pageId = context?.pageId ?? null;
  const [pinned, setPinned] = useState(false);

  // Seed the pin state from the main process (it persists the preference per
  // pane) and follow live changes from any surface.
  useEffect(() => {
    const api = bridge();
    if (!api || !paneId) return;
    let cancelled = false;
    void api.getState(paneId).then((state) => {
      if (!cancelled && state.ok) setPinned(state.alwaysOnTop === true);
    }).catch(() => {});
    const unsubscribe = api.onEvent((event) => {
      if (event.type === "always-on-top-changed" && event.paneId === paneId) {
        setPinned(event.alwaysOnTop === true);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [paneId]);

  const handleTogglePin = useCallback(() => {
    const api = bridge();
    if (!api || !paneId) return;
    void api.setAlwaysOnTop(paneId, !pinned).catch(() => {});
  }, [paneId, pinned]);

  const handleReturn = useCallback(() => {
    const api = bridge();
    if (!api) return;
    void api.close().catch(() => {});
  }, []);

  if (!paneId || !pageId || !(pageId in PAGE_REGISTRY)) {
    // Reachable only when the window was opened without a valid context;
    // keep a blank surface instead of mounting the whole app shell.
    return <div className="detached-panel-root" />;
  }

  const descriptor = getPageDescriptor(pageId as PageId);
  const Icon = descriptor.icon;
  const tab: PageTab = {
    id: paneId,
    pageId: pageId as PageId,
    title: t(descriptor.labelKey),
    params: context?.params ?? undefined,
  };
  const Component = descriptor.component;

  return (
    <div className="detached-panel-root">
      <header className="detached-panel-header">
        <span className="detached-panel-icon">
          <Icon size={14} stroke={1.5} />
        </span>
        <span className="detached-panel-title">{tab.title}</span>
        <span className="detached-panel-actions">
          <button
            type="button"
            className="detached-panel-action"
            onClick={handleTogglePin}
            aria-pressed={pinned}
            title={pinned ? t("panel.alwaysOnTopOff") : t("panel.alwaysOnTop")}
            aria-label={pinned ? t("panel.alwaysOnTopOff") : t("panel.alwaysOnTop")}
            data-testid="detached-panel-pin"
          >
            <PinIcon size={14} stroke={pinned ? 2.2 : 1.5} />
          </button>
          <button
            type="button"
            className="detached-panel-action"
            onClick={handleReturn}
            title={t("panel.returnToMain")}
            aria-label={t("panel.returnToMain")}
            data-testid="detached-panel-return"
          >
            <ArrowDownLeftIcon size={14} stroke={1.5} />
          </button>
        </span>
      </header>
      <div className="detached-panel-body">
        <Suspense fallback={<div className="sidebar-panel-lazy-fallback" />}>
          <Component tab={tab} embedded />
        </Suspense>
      </div>
    </div>
  );
}
