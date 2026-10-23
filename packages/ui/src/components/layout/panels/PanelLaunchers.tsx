"use client";

import { useTranslation } from "@/hooks/useTranslation";
import { useOptionalPanel } from "@/hooks/usePanel";
import { useConversationStore } from "@/stores/conversation-store";
import type { PageId } from "./page-tab";
import { PAGE_REGISTRY } from "./registry";
import { WALL_PAGE_IDS } from "./wall-pages";
import { panelParamsFor, shortcutFor } from "./launch";

/**
 * One icon per panel type, sitting in the session's top bar next to the
 * window controls — the reference product's launcher row.
 *
 * Each icon is an independent toggle for its panel type, like the reference
 * (several can be on at once). Clicking an open, focused type closes that
 * tab; clicking an open but unfocused type focuses it; clicking a closed
 * type opens it.
 */
export function PanelLaunchers() {
  const { t } = useTranslation();
  const panel = useOptionalPanel();
  const currentView = useConversationStore((s) => s.currentView);
  const activeThreadId = useConversationStore((s) => s.activeThreadId);
  const cwd = useConversationStore(
    (s) => s.threads.find((thread) => thread.id === s.activeThreadId)?.workingDirectory,
  ) ?? undefined;

  if (!panel || currentView !== "chat" || !activeThreadId) return null;

  const activePageId = panel.panelOpen
    ? panel.tabs.find((tab) => tab.id === panel.activeTabId)?.pageId ?? null
    : null;

  const handleLaunch = (pageId: PageId) => {
    const pageTabs = panel.tabs.filter((tab) => tab.pageId === pageId);
    if (panel.panelOpen && activePageId === pageId && panel.activeTabId) {
      panel.closePanel(panel.activeTabId);
      return;
    }
    if (pageTabs.length > 0) {
      panel.activateTab(pageTabs[0].id);
      return;
    }
    panel.openOrActivatePage(
      pageId,
      panelParamsFor(pageId, { workingDirectory: cwd, sessionId: activeThreadId }),
    );
  };

  return (
    <div className="titlebar-panel-launchers" role="toolbar" aria-label={t("panel.launchersAria")}>
      {WALL_PAGE_IDS.map((pageId) => {
        const entry = PAGE_REGISTRY[pageId];
        const Icon = entry.icon;
        const label = t(entry.labelKey);
        const shortcut = shortcutFor(pageId);
        const open = panel.panelOpen && panel.tabs.some((tab) => tab.pageId === pageId);
        return (
          <button
            key={pageId}
            type="button"
            className={`titlebar-panel-launcher${open ? " active" : ""}`}
            onClick={() => handleLaunch(pageId)}
            disabled={!entry.available}
            aria-label={label}
            aria-pressed={open}
            data-page-id={pageId}
            title={shortcut ? `${label} (${shortcut})` : label}
          >
            <Icon size={16} stroke={1.5} />
          </button>
        );
      })}
    </div>
  );
}
