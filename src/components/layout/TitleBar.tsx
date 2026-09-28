"use client";

import { useMemo, useState } from "react";
import { DropdownMenu, type MenuAction } from "@/components/ui/DropdownMenu";
import { useTranslation } from "@/hooks/useTranslation";
import { useSettings } from "@/hooks/useSettings";
import { useConversationStore } from "@/stores/conversation-store";
import { useNavHistoryStore } from "@/stores/nav-history-store";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  SidebarLeftCollapseIcon,
  SidebarLeftExpandIcon,
} from "@/components/icons";

const GITHUB_REPO_URL = "https://github.com/lava-chen/duya";

type MenuId = "file" | "edit" | "view" | "help";

interface TitleBarProps {
  /** Sidebar collapsed to the icon rail (toggled from the title bar). */
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}

/**
 * Custom window title bar (Windows/Linux — macOS uses the native hiddenInset
 * chrome). Layout mirrors the desktop reference: compact brand chip, sidebar
 * rail toggle, then a native-style menu bar (文件 / 编辑 / 视图 / 帮助).
 *
 * Menu rows map to real duya actions; Edit/View rows that need webContents
 * access (paste, zoom, fullscreen) route through the `appChrome` IPC.
 */
export function TitleBar({ sidebarCollapsed = false, onToggleSidebar }: TitleBarProps) {
  const { t } = useTranslation();
  const { settings, save } = useSettings();
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const canGoBack = useNavHistoryStore((s) => s.past.length > 0);
  const canGoForward = useNavHistoryStore((s) => s.future.length > 0);

  const brandIconSrc = `${import.meta.env.BASE_URL}icon.png`;

  // Detect platform for window controls layout (macOS traffic lights on left, Windows on right)
  const isMac = window.electronAPI?.versions?.platform === "darwin";

  // Theme state for the View menu checkbox. `settings.theme` is the
  // persisted preference; "system" resolves against the live OS preference.
  const systemDark =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = settings?.theme;
  const isDarkTheme =
    theme === "dark" ||
    ((theme === "system" || !theme) && systemDark);

  const menus = useMemo<Array<{ id: MenuId; label: string; items: MenuAction[] }>>(() => {
    const edit = (action: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll") => () => {
      void window.electronAPI?.appChrome?.editCommand?.(action).catch(() => undefined);
    };
    return [
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
          // accelerators (registered in electron/core/menu-manager.ts), so
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
  }, [t, sidebarCollapsed, onToggleSidebar, isDarkTheme, save]);

  return (
    <div
      className={`titlebar-drag-region${isMac ? " is-mac" : " is-win"}`}
      style={{
        "--window-controls-offset": isMac ? "70px" : "0px",
      } as React.CSSProperties}
    >
      {/* Brand chip doubles as the sidebar toggle: hovering swaps the app
          icon for the rail-toggle icon (ZCode desktop behavior). The chip is
          centered on the sidebar rail's icon axis so it lines up with the
          icon column underneath in both sidebar states. */}
      <button
        type="button"
        className="titlebar-brand"
        onClick={onToggleSidebar}
        aria-label={t("titlebar.toggleSidebar")}
        aria-pressed={sidebarCollapsed}
        title={t("titlebar.toggleSidebar")}
      >
        <img src={brandIconSrc} alt="" className="titlebar-logo" />
        <span className="titlebar-brand-toggle">
          {sidebarCollapsed ? (
            <SidebarLeftExpandIcon size={15} />
          ) : (
            <SidebarLeftCollapseIcon size={15} />
          )}
        </span>
      </button>
      <button
        type="button"
        className="titlebar-nav-btn"
        onClick={() => useNavHistoryStore.getState().back()}
        disabled={!canGoBack}
        aria-label={t("titlebar.navBack")}
        title={t("titlebar.navBack")}
      >
        <ArrowLeftIcon size={16} />
      </button>
      <button
        type="button"
        className="titlebar-nav-btn"
        onClick={() => useNavHistoryStore.getState().forward()}
        disabled={!canGoForward}
        aria-label={t("titlebar.navForward")}
        title={t("titlebar.navForward")}
      >
        <ArrowRightIcon size={16} />
      </button>
      <nav className="titlebar-menubar" role="menubar" aria-label={t("titlebar.menubarAria")}>
        {menus.map((menu) => (
          <DropdownMenu
            key={menu.id}
            open={openMenu === menu.id}
            onOpenChange={(open) => setOpenMenu(open ? menu.id : null)}
            side="below"
            align="start"
            minWidth={200}
            items={menu.items}
            trigger={
              <button
                type="button"
                className={`titlebar-menubar-item${openMenu === menu.id ? " active" : ""}`}
                onMouseEnter={() => {
                  // Native menubar affordance: once a menu is open, moving
                  // the pointer across the bar switches to the hovered menu.
                  if (openMenu !== null && openMenu !== menu.id) {
                    setOpenMenu(menu.id);
                  }
                }}
              >
                {menu.label}
              </button>
            }
          />
        ))}
      </nav>
      <div className="titlebar-drag-fill" />
    </div>
  );
}
