// apps/desktop/src/renderer/components/layout/TitleBar.tsx
"use client";

import { useMemo } from "react";
import { DropdownMenu, type MenuAction } from "@/components/ui/DropdownMenu";
import { useTranslation } from "@/hooks/useTranslation";
import { useSettings } from "@/hooks/useSettings";
import { useConversationStore } from "@/stores/conversation-store";
import { useNavHistoryStore } from "@/stores/nav-history-store";
import { useOptionalPanel } from "@/hooks/usePanel";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ListBulletsIcon,
  SidebarLeftCollapseIcon,
  SidebarLeftExpandIcon,
} from "@/components/icons";
import { ChatHeader, ChatHeaderActions } from "@/components/chat/ChatHeader";
import { PanelLaunchers } from "@/components/layout/panels/PanelLaunchers";

const GITHUB_REPO_URL = "https://github.com/lava-chen/duya";

type MenuId = "file" | "edit" | "view" | "help";

interface TitleBarProps {
  /** Sidebar collapsed to the icon rail (toggled from the icon rail). */
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}

/**
 * The icon row at the top of the sidebar.
 *
 * It carries the application icon (which doubles as the sidebar toggle), the
 * application menu (one button that opens 文件 / 编辑 / 视图 / 帮助) and the
 * back / forward buttons, so the sidebar column reads top-to-bottom: chrome
 * first, session list below.
 */
export function AppRail({ sidebarCollapsed = false, onToggleSidebar }: TitleBarProps) {
  const { t } = useTranslation();
  const canGoBack = useNavHistoryStore((s) => s.past.length > 0);
  const canGoForward = useNavHistoryStore((s) => s.future.length > 0);
  const menuItems = useAppMenuItems({ sidebarCollapsed, onToggleSidebar });
  const brandIconSrc = `${import.meta.env.BASE_URL}icon.png`;

  return (
    <nav className="app-rail" aria-label={t("titlebar.menubarAria")}>
      {/* The app icon doubles as the sidebar toggle: hovering swaps the app
          icon for the rail-toggle icon (ZCode desktop behavior). */}
      <button
        type="button"
        className="app-rail-brand"
        onClick={onToggleSidebar}
        aria-label={t("titlebar.toggleSidebar")}
        aria-pressed={sidebarCollapsed}
        title={t("titlebar.toggleSidebar")}
      >
        <img src={brandIconSrc} alt="" className="app-rail-logo" />
        <span className="app-rail-brand-toggle">
          {sidebarCollapsed ? (
            <SidebarLeftExpandIcon size={15} />
          ) : (
            <SidebarLeftCollapseIcon size={15} />
          )}
        </span>
      </button>
      <DropdownMenu
        side="below"
        align="start"
        minWidth={180}
        items={menuItems}
        trigger={
          <button
            type="button"
            className="app-rail-btn"
            title={t("titlebar.menubarAria")}
            aria-label={t("titlebar.menubarAria")}
          >
            <ListBulletsIcon size={16} stroke={1.5} />
          </button>
        }
      />
      <button
        type="button"
        className="app-rail-btn"
        onClick={() => useNavHistoryStore.getState().back()}
        disabled={!canGoBack}
        aria-label={t("titlebar.navBack")}
        title={t("titlebar.navBack")}
      >
        <ArrowLeftIcon size={16} />
      </button>
      <button
        type="button"
        className="app-rail-btn"
        onClick={() => useNavHistoryStore.getState().forward()}
        disabled={!canGoForward}
        aria-label={t("titlebar.navForward")}
        title={t("titlebar.navForward")}
      >
        <ArrowRightIcon size={16} />
      </button>
    </nav>
  );
}

/**
 * The top bar of the content area.
 *
 * It carries the session title on the left and the session actions on the
 * right, next to the native window controls. The conversation itself starts
 * right below it, so the session area runs from the bottom of the window up
 * to the top bar.
 */
export function TitleBar() {
  const { t } = useTranslation();
  const currentView = useConversationStore((s) => s.currentView);
  const thread = useConversationStore((s) => {
    const id = s.activeThreadId;
    return id ? s.threads.find((candidate) => candidate.id === id) ?? null : null;
  });
  const workspaceExpanded = useOptionalPanel()?.workspaceExpanded ?? false;
  const isMac = window.electronAPI?.versions?.platform === "darwin";

  const showSessionTitle = currentView === "chat" && !!thread && !workspaceExpanded;

  return (
    <div
      className={`titlebar${isMac ? " is-mac" : " is-win"}`}
      style={{
        "--window-controls-offset": isMac ? "70px" : "0px",
      } as React.CSSProperties}
    >
      <div className="titlebar-session">
        {showSessionTitle && thread ? <ChatHeader thread={thread} /> : null}
      </div>
      {/* The session actions sit right next to the native window controls,
          which the platform draws over the reserved right margin. */}
      <div className="titlebar-actions">
        <PanelLaunchers />
        <ChatHeaderActions />
      </div>
    </div>
  );
}

/**
 * The application menu. It is one list with one entry per menu, each entry
 * opening its own submenu — the same shape the reference product uses, and
 * it keeps the window chrome to a single button.
 */
function useAppMenuItems({
  sidebarCollapsed,
  onToggleSidebar,
}: {
  sidebarCollapsed: boolean;
  onToggleSidebar?: () => void;
}): MenuAction[] {
  const { t } = useTranslation();
  const { settings, save } = useSettings();

  // Theme state for the View menu checkbox. `settings.theme` is the
  // persisted preference; "system" resolves against the live OS preference.
  const systemDark =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = settings?.theme;
  const isDarkTheme =
    theme === "dark" ||
    ((theme === "system" || !theme) && systemDark);

  return useMemo<MenuAction[]>(() => {
    const edit = (action: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll") => () => {
      void window.electronAPI?.appChrome?.editCommand?.(action).catch(() => undefined);
    };
    const menus: Array<{ id: MenuId; label: string; items: MenuAction[] }> = [
      {
        id: "file",
        label: t("titlebar.menu.file"),
        items: [
          {
            kind: "action",
            id: "new-chat",
            label: t("nav.newChat"),
            onSelect: () => {
              void useConversationStore.getState().startNewChat();
            },
          },
          {
            kind: "action",
            id: "new-project",
            label: t("project.newProject"),
            // The create dialog lives in AppSidebar; cross-component entry
            // points (this menu, future global shortcuts) go through the
            // same window event the app already uses for onboarding/rooms.
            onSelect: () => {
              window.dispatchEvent(new CustomEvent("duya:new-project"));
            },
          },
        ],
      },
      {
        id: "edit",
        label: t("titlebar.menu.edit"),
        items: [
          // Shortcut labels mirror the native application menu's role
          // accelerators (registered in apps/desktop/src/main/core/menu-manager.ts), so
          // they are real even though this HTML menu does not register keys.
          { kind: "action", id: "undo", label: t("titlebar.edit.undo"), shortcut: "Ctrl+Z", onSelect: edit("undo") },
          { kind: "action", id: "redo", label: t("titlebar.edit.redo"), shortcut: "Ctrl+Y", onSelect: edit("redo") },
          { kind: "divider", id: "divider-1" },
          { kind: "action", id: "cut", label: t("titlebar.edit.cut"), shortcut: "Ctrl+X", onSelect: edit("cut") },
          { kind: "action", id: "copy", label: t("titlebar.edit.copy"), shortcut: "Ctrl+C", onSelect: edit("copy") },
          { kind: "action", id: "paste", label: t("titlebar.edit.paste"), shortcut: "Ctrl+V", onSelect: edit("paste") },
          { kind: "divider", id: "divider-2" },
          { kind: "action", id: "select-all", label: t("titlebar.edit.selectAll"), shortcut: "Ctrl+A", onSelect: edit("selectAll") },
          {
            kind: "action",
            id: "settings",
            label: t("common.settings"),
            onSelect: () => {
              useConversationStore.getState().enterSettings();
            },
          },
        ],
      },
      {
        id: "view",
        label: t("titlebar.menu.view"),
        items: [
          {
            kind: "checkbox",
            id: "sidebar",
            label: t("titlebar.menu.showSidebar"),
            checked: !sidebarCollapsed,
            onToggle: () => onToggleSidebar?.(),
          },
          {
            kind: "checkbox",
            id: "dark-theme",
            label: t("titlebar.menu.darkTheme"),
            checked: isDarkTheme,
            onToggle: () => {
              void save({ theme: isDarkTheme ? "light" : "dark" });
            },
          },
          { kind: "divider", id: "divider-1" },
          {
            kind: "action",
            id: "zoom-in",
            label: t("titlebar.menu.zoomIn"),
            shortcut: "Ctrl+Shift+=",
            onSelect: () => {
              void window.electronAPI?.appChrome?.zoom?.("in").catch(() => undefined);
            },
          },
          {
            kind: "action",
            id: "zoom-out",
            label: t("titlebar.menu.zoomOut"),
            shortcut: "Ctrl+-",
            onSelect: () => {
              void window.electronAPI?.appChrome?.zoom?.("out").catch(() => undefined);
            },
          },
          {
            kind: "action",
            id: "zoom-reset",
            label: t("titlebar.menu.resetZoom"),
            shortcut: "Ctrl+0",
            onSelect: () => {
              void window.electronAPI?.appChrome?.zoom?.("reset").catch(() => undefined);
            },
          },
          { kind: "divider", id: "divider-2" },
          {
            kind: "action",
            id: "fullscreen",
            label: t("titlebar.menu.fullscreen"),
            onSelect: () => {
              void window.electronAPI?.appChrome?.toggleFullscreen?.().catch(() => undefined);
            },
          },
        ],
      },
      {
        id: "help",
        label: t("titlebar.menu.help"),
        items: [
          {
            kind: "action",
            id: "check-updates",
            label: t("titlebar.menu.checkUpdates"),
            onSelect: () => {
              void window.electronAPI?.updater?.check?.().catch(() => undefined);
            },
          },
          {
            kind: "action",
            id: "github",
            label: t("titlebar.menu.githubRepo"),
            onSelect: () => {
              void window.electronAPI?.shell?.openExternal?.(GITHUB_REPO_URL).catch(() => undefined);
            },
          },
        ],
      },
    ];
    return menus.map((menu) => ({
      kind: "submenu" as const,
      id: menu.id,
      label: menu.label,
      items: menu.items,
    }));
  }, [t, isDarkTheme, save, sidebarCollapsed, onToggleSidebar]);
}
