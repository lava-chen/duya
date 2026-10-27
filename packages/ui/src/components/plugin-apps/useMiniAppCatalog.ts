"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getPluginAPI } from "@/lib/plugin-ipc";
import { getPluginAppAPI } from "@/lib/plugin-app-ipc";
import { useTranslation } from "@/hooks/useTranslation";
import type { PluginRegistryEntry, PluginUiSurfaceDirectoryResponse } from "@/lib/plugin-types";

/** The surfaces a plugin App can open, as the host publishes them. */
export type MiniAppSurfaces = PluginUiSurfaceDirectoryResponse["data"]["surfaces"];

export interface MiniAppCatalog {
  /** Installed plugins, enabled or not. */
  plugins: PluginRegistryEntry[];
  /** UI surfaces of every installed plugin App. */
  surfaces: MiniAppSurfaces;
  loading: boolean;
  error: string | null;
  /** Re-read the catalogue (plugin lifecycle changes call this). */
  reload: () => Promise<void>;
}

/**
 * The catalogue of installed Mini Apps.
 *
 * One source of truth for "which apps exist": the Mini Apps page lists them
 * per plugin, and the launcher row's "more" menu opens one of them. Both read
 * the same registry + surface directory, so they can never disagree.
 *
 * The load is lazy: `enabled` gates the first read, so a launcher row that
 * only renders the menu does not hit the plugin registry on every chat.
 * Plugin lifecycle events keep the catalogue fresh afterwards.
 */
export function useMiniAppCatalog({ enabled = true }: { enabled?: boolean } = {}): MiniAppCatalog {
  const { t } = useTranslation();
  const pluginAPI = useMemo(() => getPluginAPI(), []);
  const [plugins, setPlugins] = useState<PluginRegistryEntry[]>([]);
  const [surfaces, setSurfaces] = useState<MiniAppSurfaces>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

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

  // First read, gated on the caller actually needing the catalogue.
  useEffect(() => {
    if (!enabled || loadedRef.current) return;
    loadedRef.current = true;
    void reload();
  }, [enabled, reload]);

  // Plugin install / enable / disable / remove invalidates the catalogue.
  useEffect(() => {
    return getPluginAppAPI()?.onChanged(() => void reload());
  }, [reload]);

  return { plugins, surfaces, loading, error, reload };
}
