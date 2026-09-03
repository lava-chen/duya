"use client";

/**
 * use-bot-contacts — renderer data source for the sidebar Bots section
 * (plan 483 Phase 1 / P1.2).
 *
 * Contacts come from the merged read side (`config:bots:list` IPC):
 * config.toml `[agents.<id>]` declaration layer + `agents/<id>/profile.json`
 * identity layer (plan 485 §2.4 — profile wins for name/title/description/
 * avatar). The plan's full data source also includes the per-bot
 * persistent session binding (plan 477) and `~/.duya/groups.toml` rooms
 * (plan 478); both merge into `buildBotContacts` / a future
 * `buildRoomContacts` once those backends land.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConversationStore } from "@/stores/conversation-store";
import { listBots } from "@/lib/agent-profile-ipc";
import { buildBotContacts, type BotContact } from "./bot-contacts";

export function useBotContacts() {
  const threads = useConversationStore((s) => s.threads);
  const [bots, setBots] = useState<Awaited<ReturnType<typeof listBots>>>([]);
  const [loading, setLoading] = useState(true);

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
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const contacts = useMemo(
    () => buildBotContacts(bots, threads),
    [bots, threads],
  );

  return { contacts, loading, reload };
}
