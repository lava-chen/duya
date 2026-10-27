// The "more" menu at the end of the panel launcher row.
//
// The launcher row carries one icon per panel type, so a panel that is
// rarely opened (or that has to be picked from a list first) does not get
// an icon of its own — it lives behind this menu:
//
//   Mini Apps       — a second level that lists the installed apps; picking
//                     one opens it in the side panel.
//   Background tasks — a side panel that lists the running commands and
//                     sub-agents.
//
// Reference parity (Claude Code desktop): the background-tasks entry is a
// one-time opener — once the panel is open the entry leaves the menu and
// the panel's own close button owns the lifecycle.
//
// The menu owns its own open state so the app catalogue is only read when
// the user actually asks for it.

"use client";

import { useMemo, useState } from "react";
import { DropdownMenu, type MenuAction } from "@/components/ui/DropdownMenu";
import { ClockFaceIcon, DotsThreeIcon, PlugIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import { useOptionalPanel } from "@/hooks/usePanel";
import { useConversationStore } from "@/stores/conversation-store";
import { useMiniAppCatalog } from "@/components/plugin-apps/useMiniAppCatalog";
import { getPluginUiSurfaceIcon } from "@/components/plugin-apps/plugin-ui-surface-icons";

export function PanelMoreMenu() {
  const { t, locale } = useTranslation();
  const panel = useOptionalPanel();
  const activeThreadId = useConversationStore((s) => s.activeThreadId);
  const setCurrentView = useConversationStore((s) => s.setCurrentView);
  const [open, setOpen] = useState(false);

  // The background-tasks panel is a one-time entry: while it is open the
  // menu does not offer it again.
  const backgroundTasksOpen = Boolean(
    panel?.tabs.some((tab) => tab.pageId === "background-tasks"),
  );

  // Read the catalogue the first time the menu opens, not when the launcher
  // row mounts: the row is on screen for every chat, the apps are not.
  const { plugins, surfaces, loading, error } = useMiniAppCatalog({ enabled: open });

  const miniAppItems = useMemo<MenuAction[]>(() => {
    const surfaceItems: MenuAction[] = surfaces
      // A session-scoped surface needs a chat to bind to.
      .filter((surface) => surface.availability !== "session" || Boolean(activeThreadId))
      .map((surface) => {
        const Icon = getPluginUiSurfaceIcon(surface.icon);
        const title = surface.title[locale] ?? surface.title.en;
        return {
          kind: "action",
          id: `mini-app:${surface.pluginId}:${surface.id}`,
          label: title,
          iconLeft: <Icon size={14} stroke={1.5} />,
          onSelect: () => {
            panel?.openOrActivatePage("plugin-app", {
              pluginId: surface.pluginId,
              appId: surface.appId,
              surfaceId: surface.id,
              server: surface.server,
              title,
              icon: surface.icon,
              availability: surface.availability,
            });
          },
        };
      });

    const entryItems: MenuAction[] = plugins
      .filter((plugin) => plugin.enabled)
      .flatMap((plugin) =>
        (plugin.apps ?? [])
          .filter((app) => app.entry !== undefined)
          .map((app) => {
            // An agent-run App acts inside a chat session; a standalone App
            // owns its runtime and needs none.
            const standalone = app.runtime === "standalone";
            return {
              kind: "action",
              id: `mini-app:${plugin.id}:${app.appId}`,
              label: app.appId,
              disabled: !standalone && !activeThreadId,
              onSelect: () => {
                panel?.openOrActivatePage("plugin-app", {
                  pluginId: plugin.id,
                  appId: app.appId,
                  title: app.appId,
                  availability: standalone ? "always" : "session",
                });
              },
            };
          }),
      );

    if (surfaceItems.length === 0 && entryItems.length === 0) {
      if (loading) {
        return [{
          kind: "action",
          id: "mini-apps-loading",
          label: t("apps.loading"),
          disabled: true,
          onSelect: () => {},
        }];
      }
      if (error) {
        return [{
          kind: "action",
          id: "mini-apps-error",
          label: error,
          disabled: true,
          onSelect: () => {},
        }];
      }
      return [{
        kind: "action",
        id: "mini-apps-empty",
        label: t("apps.emptyTitle"),
        disabled: true,
        onSelect: () => {},
      }];
    }

    return [
      ...surfaceItems,
      ...entryItems,
      { kind: "divider", id: "mini-apps-divider" },
      {
        kind: "action",
        id: "mini-apps-all",
        label: t("apps.openAll"),
        onSelect: () => {
          setCurrentView("apps");
        },
      },
    ];
  }, [surfaces, plugins, activeThreadId, loading, error, locale, panel, setCurrentView, t]);

  const items: MenuAction[] = [
    {
      kind: "submenu",
      id: "mini-apps",
      label: t("apps.title"),
      iconLeft: <PlugIcon size={14} stroke={1.5} />,
      items: miniAppItems,
    },
    { kind: "divider", id: "div-background-tasks" },
    ...(backgroundTasksOpen
      ? []
      : [{
          kind: "action" as const,
          id: "background-tasks",
          label: t("panel.backgroundTasks"),
          iconLeft: <ClockFaceIcon size={14} stroke={1.5} />,
          onSelect: () => {
            panel?.openOrActivatePage("background-tasks");
          },
        }]),
  ];
  // The divider only earns its place when the entry under it is there.
  const visibleItems = backgroundTasksOpen
    ? items.filter((item) => item.id !== "div-background-tasks")
    : items;
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      align="end"
      minWidth={200}
      items={visibleItems}
      trigger={
        <button
          type="button"
          className="titlebar-panel-launcher titlebar-panel-launcher-more"
          aria-label={t("panel.more")}
          title={t("panel.more")}
        >
          <DotsThreeIcon size={16} stroke={1.5} />
        </button>
      }
    />
  );
}
