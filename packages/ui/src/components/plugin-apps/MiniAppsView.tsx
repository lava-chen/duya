"use client";

import { PageFrame, PageHeader } from "@/components/ui/page";
import { PluginAppLauncher } from "./PluginAppLauncher";
import { useTranslation } from "@/hooks/useTranslation";
import { useConversationStore } from "@/stores/conversation-store";
import { useOptionalPanel } from "@/hooks/usePanel";
import { Button } from "@/components/ui/Button";
import { getPluginUiSurfaceIcon } from "./plugin-ui-surface-icons";
import { useMiniAppCatalog } from "./useMiniAppCatalog";

/** Desktop launcher for Mini Apps declared by installed plugins. */
export function MiniAppsView() {
  const { t, locale } = useTranslation();
  const { plugins, surfaces, loading, error } = useMiniAppCatalog();
  const panel = useOptionalPanel();
  const activeThreadId = useConversationStore((state) => state.activeThreadId);

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
