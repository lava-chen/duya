"use client";

import { useEffect, useState } from "react";
import { getPluginAPI } from "@/lib/plugin-ipc";
import { getPluginAppAPI } from "@/lib/plugin-app-ipc";
import type { PluginAppPlacementSlot, PluginUiPlacementDirectoryEntry } from "@/lib/plugin-types";

export type MiniAppPlacement = PluginUiPlacementDirectoryEntry;

/**
 * The App entries a plugin asked the host to render in one slot.
 *
 * This is a placement feed, not a component feed: every entry opens the App in
 * its sandboxed frame. Nothing the plugin ships is ever mounted into the host's
 * React tree, which is what keeps the iframe boundary meaningful.
 *
 * The read is one directory call, refreshed on plugin lifecycle events. An
 * older preload without the directory API yields no entries rather than an
 * error: a host that cannot answer has nothing to place.
 */
export function useMiniAppPlacements(
  slot: PluginAppPlacementSlot,
  { enabled = true }: { enabled?: boolean } = {},
): MiniAppPlacement[] {
  const [placements, setPlacements] = useState<MiniAppPlacement[]>([]);

  useEffect(() => {
    if (!enabled) return;
    const api = getPluginAPI();
    if (!api) return;
    let cancelled = false;

    const load = async () => {
      try {
        const response = await api.uiSurfaces.list();
        if (cancelled || !response.success) return;
        const all = (response.data?.placements ?? []) as MiniAppPlacement[];
        setPlacements(all.filter((entry) => entry.slot === slot));
      } catch {
        // No directory API, or the host is mid-restart: no entries.
      }
    };

    void load();
    const unsubscribe = getPluginAppAPI()?.onChanged(() => void load());
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [enabled, slot]);

  return placements;
}
