"use client";

import { useState, useEffect, useCallback } from "react";
import { useConversationStore } from "@/stores/conversation-store";

interface Task {
  status: "pending" | "in_progress" | "completed";
}

/**
 * Lightweight count of pending + in_progress tasks for the active thread.
 * Used by the TitleBar badge so we don't mount the full TaskDrawer just to
 * show a number. Polls at 1.5s — slower than the drawer's 1s because
 * badges are not latency-sensitive.
 */
export function useTaskCount(): { pending: number; active: number } {
  const activeThreadId = useConversationStore((s) => s.activeThreadId);
  const [counts, setCounts] = useState<{ pending: number; active: number }>({ pending: 0, active: 0 });

  const fetchCount = useCallback(async () => {
    if (!activeThreadId) {
      setCounts({ pending: 0, active: 0 });
      return;
    }
    try {
      const raw = await window.electronAPI?.thread?.getTasks?.(activeThreadId);
      if (!Array.isArray(raw)) {
        setCounts({ pending: 0, active: 0 });
        return;
      }
      let pending = 0;
      let active = 0;
      for (const t of raw as Task[]) {
        if (t.status === "pending") pending++;
        else if (t.status === "in_progress") active++;
      }
      setCounts({ pending, active });
    } catch {
      // ignore
    }
  }, [activeThreadId]);

  useEffect(() => {
    setCounts({ pending: 0, active: 0 });
    void fetchCount();
    const id = setInterval(fetchCount, 1500);
    return () => clearInterval(id);
  }, [activeThreadId, fetchCount]);

  return counts;
}
