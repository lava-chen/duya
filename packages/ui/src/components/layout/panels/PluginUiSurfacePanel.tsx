"use client";

import { PluginAppHost } from "@/components/plugin-apps/PluginAppHost";
import { useTranslation } from "@/hooks/useTranslation";
import { useConversationStore } from "@/stores/conversation-store";
import type { PageTab } from "./page-tab";

/**
 * The panel page hosting one Plugin App.
 *
 * Two launch shapes share this page: a surface App reads its HTML document
 * from a declared MCP resource (`surfaceId` + `server` present), while an
 * entry App loads the package's entry file directly (ids only). The launch
 * params decide which — the host component treats the missing surface as the
 * entry flow.
 */
export function PluginUiSurfacePanel({ tab }: { tab: PageTab; embedded: boolean }) {
  const { t } = useTranslation();
  const activeThreadId = useConversationStore((state) => state.activeThreadId);
  const pluginId = typeof tab.params?.pluginId === "string" ? tab.params.pluginId : "";
  const appId = typeof tab.params?.appId === "string" ? tab.params.appId : "";
  const surfaceId = typeof tab.params?.surfaceId === "string" ? tab.params.surfaceId : "";
  const server = typeof tab.params?.server === "string" ? tab.params.server : "";
  const title = typeof tab.params?.title === "string" ? tab.params.title : tab.title;
  const availability = tab.params?.availability === "always" ? "always" : "session";

  // An entry App legitimately omits the surface pair; a surface App that
  // lost either half cannot be launched at all.
  const surfaceLaunch = surfaceId.length > 0 || server.length > 0;
  if (!pluginId || !appId || (surfaceLaunch && (!surfaceId || !server))) {
    return <div className="plugin-app-host-error" role="alert">{t("apps.launchFailed")}</div>;
  }
  if (availability === "session" && !activeThreadId) {
    return <div className="plugin-app-host-error" role="status">{t("apps.selectChat")}</div>;
  }

  return (
    <PluginAppHost
      pluginId={pluginId}
      appId={appId}
      surfaceId={surfaceId || undefined}
      server={server || undefined}
      title={title}
      chatSessionId={activeThreadId ?? undefined}
    />
  );
}
