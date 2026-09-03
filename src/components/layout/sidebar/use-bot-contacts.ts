"use client";

/**
 * use-bot-contacts — renderer data source for the sidebar Bots section
 * (plan 483 Phase 1 / P1.2 + P2).
 *
 * Contacts come from the merged read side (`config:bots:list` IPC):
 * config.toml `[agents.<id>]` declaration layer + `agents/<id>/profile.json`
 * identity layer (plan 485 §2.4 — profile wins for name/title/description/
 * avatar). The plan's full data source also includes the per-bot
 * persistent session binding (plan 477) and `~/.duya/groups.toml` rooms
 * (plan 478); both merge into `buildBotContacts` / a future
 * `buildRoomContacts` once those backends land.
 *
 * Plan 483 P2 adds the sidebar management layer: pin / hide / reorder.
 * Both are pure renderer concerns (no config mutation), persisted through
 * the `settingsDb` key-value store so they survive restarts without
 * touching config.toml:
 *   - `sidebar.botPinnedIds` — ordered pinned ids (doubles as the
 *     drag-to-reorder order).
 *   - `sidebar.botHiddenIds` — ids hidden from the sidebar (restorable).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConversationStore } from "@/stores/conversation-store";
import { listBots } from "@/lib/agent-profile-ipc";
import {
  buildBotContacts,
  partitionBotContacts,
  type BotPartition,
} from "./bot-contacts";

const PINNED_IDS_KEY = "sidebar.botPinnedIds";
const HIDDEN_IDS_KEY = "sidebar.botHiddenIds";

async function readIds(key: string): Promise<string[]> {
  try {
    const value = await window.electronAPI?.settingsDb?.getJson<string[]>(
      key,
      [],
    );
    return Array.isArray(value) ? value : [];
  } catch {
    // Dev browser without the Electron preload — no persisted state.
    return [];
  }
}

function writeIds(key: string, ids: string[]): void {
  void (async () => {
    try {
      await window.electronAPI?.settingsDb?.setJson(key, ids);
    } catch {
      // Dev browser without the Electron preload — ignore.
    }
  })();
}

export function useBotContacts() {
  const threads = useConversationStore((s) => s.threads);
  const [bots, setBots] = useState<Awaited<ReturnType<typeof listBots>>>([]);
  const [loading, setLoading] = useState(true);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);

  const reload = useCallback(async () => {
    try {
      setBots(await listBots());
    } catch {
      // Dev browser without the Electron preload — no contacts, the
      // Bots section shows its empty state instead.
      setBots([]);
    } finally {
      setLoading(false);
    }
    setPinnedIds(await readIds(PINNED_IDS_KEY));
    setHiddenIds(await readIds(HIDDEN_IDS_KEY));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Pin / hide toggles persist immediately; the contacts list re-derives
  // from the updated ids on the next render.
  const togglePin = useCallback((agentId: string, isPinned: boolean) => {
    setPinnedIds((prev) => {
      const next = isPinned
        ? [...prev, agentId]
        : prev.filter((id) => id !== agentId);
      writeIds(PINNED_IDS_KEY, next);
      return next;
    });
  }, []);

  /** Plan 483 P2: drag-to-reorder inside the pinned rail. */
  const movePinned = useCallback(
    (movedId: string, targetId: string, position: "before" | "after") => {
      if (movedId === targetId) return;
      setPinnedIds((prev) => {
        const without = prev.filter((id) => id !== movedId);
        const targetIndex = without.indexOf(targetId);
        if (targetIndex < 0) return prev;
        const insertAt = position === "before" ? targetIndex : targetIndex + 1;
        const next = [
          ...without.slice(0, insertAt),
          movedId,
          ...without.slice(insertAt),
        ];
        writeIds(PINNED_IDS_KEY, next);
        return next;
      });
    },
    [],
  );

  const hide = useCallback((agentId: string) => {
    setHiddenIds((prev) => {
      const next = [...prev, agentId];
      writeIds(HIDDEN_IDS_KEY, next);
      return next;
    });
  }, []);

  const unhide = useCallback((agentId: string) => {
    setHiddenIds((prev) => {
      const next = prev.filter((id) => id !== agentId);
      writeIds(HIDDEN_IDS_KEY, next);
      return next;
    });
  }, []);

  const allContacts = useMemo(
    () => buildBotContacts(bots, threads),
    [bots, threads],
  );

  const partition: BotPartition = useMemo(
    () => partitionBotContacts(allContacts, pinnedIds, hiddenIds),
    [allContacts, pinnedIds, hiddenIds],
  );

  return {
    ...partition,
    allContacts,
    loading,
    reload,
    togglePin,
    movePinned,
    hide,
    unhide,
  };
}
