// plugin-mention-store.ts - Installed plugins, reduced to what an inline
// @-mention chip needs (id + display name + icon URL).
//
// One shared source for two surfaces that must agree:
//   - the composer's contentEditable chip (MessageInput → RichTextInput)
//   - the sent user bubble's chip (MessageItem → PluginMentionText)
//
// MessageInput refreshes it whenever it rebuilds the @-popover (session
// change / popover open), so a freshly installed plugin shows up in both
// places without a reload. Lazy `ensureLoaded` covers transcript-only views
// where the composer never mounts.

import { useEffect } from 'react';
import { create } from 'zustand';
import { getPluginAPI } from '@/lib/plugin-ipc';
import type { PluginMentionTarget } from '@/lib/message-input-logic';

interface PluginMentionState {
  /** Enabled installed plugins as chip targets. */
  targets: PluginMentionTarget[];
  /** True once a load attempt finished — never retried on every render. */
  loaded: boolean;
  setTargets: (targets: PluginMentionTarget[]) => void;
  ensureLoaded: () => void;
}

let inflight: Promise<void> | null = null;

export const usePluginMentionStore = create<PluginMentionState>()((set, get) => ({
  targets: [],
  loaded: false,

  setTargets: (targets) => set({ targets, loaded: true }),

  ensureLoaded: () => {
    if (get().loaded || inflight) return;

    const api = getPluginAPI();
    if (!api) {
      // Browser-only render (no preload bridge): nothing to resolve against.
      set({ loaded: true });
      return;
    }

    inflight = (async () => {
      try {
        const res = await api.registry.list();
        set({
          targets: (res.data ?? [])
            .filter((p) => p.enabled !== false)
            .map((p) => ({ pluginId: p.id, name: p.name || p.id, iconUrl: p.icon })),
          loaded: true,
        });
      } catch {
        // Plugin registry unavailable — mentions degrade to plain text.
        set({ loaded: true });
      } finally {
        inflight = null;
      }
    })();
  },
}));

/** Chip targets, kicking off a one-shot load on first use. */
export function usePluginMentionTargets(): PluginMentionTarget[] {
  const targets = usePluginMentionStore((s) => s.targets);
  const ensureLoaded = usePluginMentionStore((s) => s.ensureLoaded);
  useEffect(() => {
    ensureLoaded();
  }, [ensureLoaded]);
  return targets;
}
