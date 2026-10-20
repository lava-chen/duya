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
 *   - `sidebar.botSections` — user-defined group definitions (array order
 *     is the display order, rakazo-style folders).
 *   - `sidebar.botSectionMembers` — ordered agent ids per section (the
 *     group-internal drag-to-reorder order).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConversationStore } from "@/stores/conversation-store";
import { listBots } from "@/lib/agent-profile-ipc";
import { canSend } from "@/lib/stream-session-manager";
import { pendingTurnCountForSession } from "@/components/chat/bot/send/scheduled-turns";
import {
  buildBotContacts,
  buildRoomContacts,
  createBotSection,
  deleteBotSection,
  moveBotToSection as moveBotToSectionPure,
  partitionBotContacts,
  renameBotSection,
  reorderSectionBots as reorderSectionBotsPure,
  reorderSections as reorderSectionsPure,
  type BotPartition,
  type BotSectionDef,
  type BotSessionStatus,
  type RoomContact,
  type RoomSource,
} from "./bot-contacts";

const PINNED_IDS_KEY = "sidebar.botPinnedIds";
const HIDDEN_IDS_KEY = "sidebar.botHiddenIds";
const SECTIONS_KEY = "sidebar.botSections";
const SECTION_MEMBERS_KEY = "sidebar.botSectionMembers";

async function readJson<T>(key: string, defaultValue: T): Promise<T> {
  try {
    const value = await window.electronAPI?.settingsDb?.getJson<T>(
      key,
      defaultValue,
    );
    return value ?? defaultValue;
  } catch {
    // Dev browser without the Electron preload — no persisted state.
    return defaultValue;
  }
}

function writeJson(key: string, value: unknown): void {
  void (async () => {
    try {
      await window.electronAPI?.settingsDb?.setJson(key, value);
    } catch {
      // Dev browser without the Electron preload — ignore.
    }
  })();
}

export function useBotContacts() {
  const threads = useConversationStore((s) => s.threads);
  const [bots, setBots] = useState<Awaited<ReturnType<typeof listBots>>>([]);
  /** Plan 478: raw groups.toml declaration rows (activity joins via threads). */
  const [roomSources, setRoomSources] = useState<RoomSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [sections, setSections] = useState<BotSectionDef[]>([]);
  const [sectionMembers, setSectionMembers] = useState<Record<string, string[]>>({});
  // Refs mirror the section state so synchronous reads (createSection
  // must return the minted id immediately) and multi-key writes
  // (deleteSection touches both keys) never depend on the async
  // React 18 updater timing.
  const sectionsRef = useRef<BotSectionDef[]>([]);
  const sectionMembersRef = useRef<Record<string, string[]>>({});
  const commitSections = useCallback((next: BotSectionDef[]) => {
    sectionsRef.current = next;
    setSections(next);
    writeJson(SECTIONS_KEY, next);
  }, []);
  const commitSectionMembers = useCallback((next: Record<string, string[]>) => {
    sectionMembersRef.current = next;
    setSectionMembers(next);
    writeJson(SECTION_MEMBERS_KEY, next);
  }, []);

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
    // Plan 478: shared rooms from groups.toml (via config:groups:list).
    try {
      const declared = await window.electronAPI?.groups?.list?.();
      setRoomSources(
        Object.entries(declared ?? {}).map(([id, group]) => ({
          id,
          name: group?.name ?? id,
          memberIds: group?.memberIds ?? [],
          memberNames: [],
        })),
      );
    } catch {
      setRoomSources([]);
    }
    setPinnedIds(await readJson<string[]>(PINNED_IDS_KEY, []));
    setHiddenIds(await readJson<string[]>(HIDDEN_IDS_KEY, []));
    const nextSections = await readJson<BotSectionDef[]>(SECTIONS_KEY, []);
    const nextMembers = await readJson<Record<string, string[]>>(SECTION_MEMBERS_KEY, {});
    sectionsRef.current = nextSections;
    sectionMembersRef.current = nextMembers;
    setSections(nextSections);
    setSectionMembers(nextMembers);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Live refresh: main broadcasts `config:bots:changed` after any bot
  // mutation — UI dialogs (create/edit/delete/avatar) AND a bot's own
  // update_state identity writes (profile.set / avatar.*). Without this
  // the sidebar only shows the mount-time snapshot until a manual reload.
  useEffect(() => {
    const unsubscribe = window.electronAPI?.configAgents?.onBotsChanged?.(() => {
      void reload();
    });
    return () => unsubscribe?.();
  }, [reload]);

  // Pin / hide toggles persist immediately; the contacts list re-derives
  // from the updated ids on the next render.
  const togglePin = useCallback((agentId: string, isPinned: boolean) => {
    setPinnedIds((prev) => {
      const next = isPinned
        ? [...prev, agentId]
        : prev.filter((id) => id !== agentId);
      writeJson(PINNED_IDS_KEY, next);
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
        writeJson(PINNED_IDS_KEY, next);
        return next;
      });
    },
    [],
  );

  const hide = useCallback((agentId: string) => {
    setHiddenIds((prev) => {
      const next = [...prev, agentId];
      writeJson(HIDDEN_IDS_KEY, next);
      return next;
    });
  }, []);

  const unhide = useCallback((agentId: string) => {
    setHiddenIds((prev) => {
      const next = prev.filter((id) => id !== agentId);
      writeJson(HIDDEN_IDS_KEY, next);
      return next;
    });
  }, []);

  // Sidebar group (section) management — same optimistic pattern: compute
  // the next value from the refs, persist immediately, let the partition
  // re-derive. Reads are synchronous so callers get the minted id back.
  const createSection = useCallback(
    (name: string): BotSectionDef | null => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const result = createBotSection(sectionsRef.current, trimmed);
      commitSections(result.sections);
      return result.section;
    },
    [commitSections],
  );

  const renameSection = useCallback(
    (sectionId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      commitSections(renameBotSection(sectionsRef.current, sectionId, trimmed));
    },
    [commitSections],
  );

  const deleteSection = useCallback(
    (sectionId: string) => {
      const result = deleteBotSection(
        sectionsRef.current,
        sectionMembersRef.current,
        sectionId,
      );
      commitSections(result.sections);
      commitSectionMembers(result.sectionMembers);
    },
    [commitSections, commitSectionMembers],
  );

  const moveBotToSection = useCallback(
    (agentId: string, toSectionId: string | null) => {
      commitSectionMembers(
        moveBotToSectionPure(sectionMembersRef.current, agentId, toSectionId),
      );
    },
    [commitSectionMembers],
  );

  const reorderSectionBots = useCallback(
    (sectionId: string, orderedIds: string[]) => {
      commitSectionMembers(
        reorderSectionBotsPure(sectionMembersRef.current, sectionId, orderedIds),
      );
    },
    [commitSectionMembers],
  );

  const reorderSections = useCallback(
    (orderedIds: string[]) => {
      commitSections(reorderSectionsPure(sectionsRef.current, orderedIds));
    },
    [commitSections],
  );

  // Plan 500 P2.4: coarse per-bot activity status. The renderer signal is
  // the stream phase (`canSend` false = running) plus this window's queued
  // turns (messageDelivery 'queued' + main-queue pending records). A short
  // poll keeps it honest between store updates — stream phases mutate
  // outside React.
  const messageDelivery = useConversationStore((s) => s.messageDelivery);
  const [statusTick, setStatusTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setStatusTick((n) => n + 1), 2_000);
    return () => clearInterval(timer);
  }, []);

  const statusForThread = useCallback(
    (threadId: string | null): BotSessionStatus | undefined => {
      if (!threadId) return undefined;
      void statusTick;
      const deliveryRows = Object.values(messageDelivery[threadId] ?? {});
      const queued =
        pendingTurnCountForSession(threadId) > 0 ||
        deliveryRows.some((d) => d === 'queued');
      const running = !canSend(threadId);
      if (running) return 'running';
      if (queued) return 'queued';
      return 'idle';
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messageDelivery, statusTick],
  );

  const allContacts = useMemo(
    () => buildBotContacts(bots, threads, statusForThread),
    [bots, threads, statusForThread],
  );

  /** Plan 478: room contacts, activity-joined against the thread list. */
  const roomContacts: RoomContact[] = useMemo(
    () => buildRoomContacts(roomSources, threads),
    [roomSources, threads],
  );

  const partition: BotPartition = useMemo(
    () => partitionBotContacts(allContacts, pinnedIds, hiddenIds, sections, sectionMembers),
    [allContacts, pinnedIds, hiddenIds, sections, sectionMembers],
  );

  return {
    ...partition,
    allContacts,
    roomContacts,
    loading,
    reload,
    togglePin,
    movePinned,
    hide,
    unhide,
    /** Raw section definitions (for the "Move to" submenu). */
    botSections: sections,
    sectionMembers,
    createSection,
    renameSection,
    deleteSection,
    moveBotToSection,
    reorderSectionBots,
    reorderSections,
  };
}
