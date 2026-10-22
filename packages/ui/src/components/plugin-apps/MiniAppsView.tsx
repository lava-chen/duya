"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageFrame, PageHeader } from "@/components/ui/page";
import { PluginAppLauncher } from "./PluginAppLauncher";
import { useTranslation } from "@/hooks/useTranslation";
import { getPluginAPI } from "@/lib/plugin-ipc";
import { getPluginAppAPI } from "@/lib/plugin-app-ipc";
import type { PluginRegistryEntry } from "@/lib/plugin-types";

/** Desktop launcher for Mini Apps declared by installed plugins. */
export function MiniAppsView() {
  const { t } = useTranslation();
  const [plugins, setPlugins] = useState<PluginRegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pluginAPI = useMemo(() => getPluginAPI(), []);

  const reload = useCallback(async () => {
    if (!pluginAPI) {
      setPlugins([]);
      setError(t("apps.unavailable"));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await pluginAPI.registry.list();
      if (!response.success) throw new Error(response.error || t("apps.loadError"));
      setPlugins(response.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("apps.loadError"));
    } finally {
      setLoading(false);
    }
  }, [pluginAPI, t]);

  useEffect(() => {
    void reload();
    return getPluginAppAPI()?.onChanged(() => void reload());
  }, [reload]);

  const appPlugins = plugins.filter((plugin) => plugin.enabled && (plugin.apps?.length ?? 0) > 0);

  return (
    <PageFrame>
      <PageHeader title={t("apps.title")} subtitle={t("apps.description")} />
      {loading ? (
        <p className="text-sm text-muted-foreground" role="status">{t("apps.loading")}</p>
      ) : error ? (
        <p className="plugin-app-host-error" role="alert">{error}</p>
      ) : appPlugins.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
          <h2 className="text-base font-medium text-foreground">{t("apps.emptyTitle")}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t("apps.emptyDescription")}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {appPlugins.map((plugin) => (
            <section key={plugin.id} className="rounded-xl border border-border bg-[var(--surface)] p-4">
              <h2 className="text-base font-semibold text-foreground">{plugin.name}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{plugin.description}</p>
              <div className="mt-3">
                <PluginAppLauncher
                  pluginId={plugin.id}
                  apps={plugin.apps ?? []}
                  emptyHint={t("apps.selectChat")}
                />
              </div>
            </section>
          ))}
        </div>
      )}
    </PageFrame>
  );
}
