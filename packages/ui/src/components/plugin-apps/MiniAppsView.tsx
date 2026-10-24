"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageFrame, PageHeader } from "@/components/ui/page";
import { PluginAppLauncher } from "./PluginAppLauncher";
import { useTranslation } from "@/hooks/useTranslation";
import { getPluginAPI } from "@/lib/plugin-ipc";
import { getPluginAppAPI } from "@/lib/plugin-app-ipc";
import { useConversationStore } from "@/stores/conversation-store";
import { useOptionalPanel } from "@/hooks/usePanel";
import { Button } from "@/components/ui/Button";
import { getPluginUiSurfaceIcon } from "./plugin-ui-surface-icons";
import type { PluginRegistryEntry, PluginUiSurfaceDirectoryResponse } from "@/lib/plugin-types";

/** Desktop launcher for Mini Apps declared by installed plugins. */
export function MiniAppsView() {
  const { t, locale } = useTranslation();
  const [plugins, setPlugins] = useState<PluginRegistryEntry[]>([]);
  const [surfaces, setSurfaces] = useState<PluginUiSurfaceDirectoryResponse["data"]["surfaces"]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pluginAPI = useMemo(() => getPluginAPI(), []);
  const panel = useOptionalPanel();
  const activeThreadId = useConversationStore((state) => state.activeThreadId);

  const reload = useCallback(async () => {
    if (!pluginAPI) {
      setPlugins([]);
      setSurfaces([]);
      setError(t("apps.unavailable"));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const registryResponse = await pluginAPI.registry.list();
      if (!registryResponse.success) throw new Error(registryResponse.error || t("apps.loadError"));
      setPlugins(registryResponse.data);
      try {
        const surfaceResponse = await pluginAPI.uiSurfaces.list();
        if (!surfaceResponse.success) throw new Error(surfaceResponse.error || t("apps.loadError"));
        setSurfaces(surfaceResponse.data.surfaces);
      } catch (cause) {
        // A renderer paired with an older preload can still launch static
        // entry Apps when the newer surface directory API is unavailable.
        setSurfaces([]);
        setError(cause instanceof Error ? cause.message : t("apps.loadError"));
      }
    } catch (cause) {
      setPlugins([]);
      setSurfaces([]);
      setError(cause instanceof Error ? cause.message : t("apps.loadError"));
    } finally {
      setLoading(false);
    }
  }, [pluginAPI, t]);

  useEffect(() => {
    void reload();
    return getPluginAppAPI()?.onChanged(() => void reload());
  }, [reload]);

  const visibleSurfaces = surfaces.filter((surface) =>
    surface.availability !== "session" || Boolean(activeThreadId));
  const appPlugins = plugins.filter((plugin) => plugin.enabled && (
    (plugin.apps?.length ?? 0) > 0 || visibleSurfaces.some((surface) => surface.pluginId === plugin.id)
  ));

  return (
    <PageFrame>
      <PageHeader title={t("apps.title")} subtitle={t("apps.description")} />
      {error && plugins.length > 0 ? <p className="plugin-app-host-error" role="alert">{error}</p> : null}
      {loading && plugins.length === 0 ? (
        <p className="text-sm text-muted-foreground" role="status">{t("apps.loading")}</p>
      ) : error && plugins.length === 0 ? (
        <p className="plugin-app-host-error" role="alert">{error}</p>
      ) : appPlugins.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
          <h2 className="text-base font-medium text-foreground">{t("apps.emptyTitle")}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t("apps.emptyDescription")}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {appPlugins.map((plugin) => {
            const pluginSurfaces = visibleSurfaces.filter((surface) => surface.pluginId === plugin.id);
            return (
              <section key={plugin.id} className="rounded-xl border border-border bg-[var(--surface)] p-4">
                <h2 className="text-base font-semibold text-foreground">{plugin.name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{plugin.description}</p>
                <div className="mt-3">
                  <PluginAppLauncher
                    pluginId={plugin.id}
                    apps={plugin.apps ?? []}
                    emptyHint={t("apps.selectChat")}
                  />
                  {pluginSurfaces.length > 0 ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2" aria-label={t("apps.description")}>
                      {pluginSurfaces.map((surface) => {
                        const Icon = getPluginUiSurfaceIcon(surface.icon);
                        return (
                          <Button
                            key={`${surface.pluginId}:${surface.id}`}
                            variant="secondary"
                            size="sm"
                            onClick={() => panel?.openOrActivatePage("plugin-app", {
                              pluginId: surface.pluginId,
                              appId: surface.appId,
                              surfaceId: surface.id,
                              server: surface.server,
                              title: surface.title[locale],
                              icon: surface.icon,
                              availability: surface.availability,
                            })}
                          >
                            <Icon size={14} stroke={1.5} />
                            {surface.title[locale]}
                          </Button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </PageFrame>
  );
}
