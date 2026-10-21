import { useCallback, useEffect, useMemo, useState } from "react";
import { getMessagesBySessionIPC, type Message as WireMessage } from "@/lib/ipc-client";
import {
  buildAgentDmPairMessages,
  getBotSessionId,
  type AgentDmPairEntry,
} from "./agent-dm-pair";

interface UseAgentDmPairOptions {
  selfAgentId: string;
  peerAgentId: string;
  /** Enabled while the overlay is open. */
  enabled: boolean;
}

/**
 * Plan 497 — data source for the read-only 1:1 pair overlay. Fetches both
 * bots' persistent sessions (`bot:<agentId>`) and merges their agent_dm
 * sent-markers into one chronological transcript. Refetches when a
 * `message:new` broadcast lands on either side, so a live wake reply
 * appears without reopening the overlay.
 */
export function useAgentDmPairMessages({
  selfAgentId,
  peerAgentId,
  enabled,
}: UseAgentDmPairOptions): {
  entries: AgentDmPairEntry[];
  isLoading: boolean;
  refresh: () => void;
} {
  const [selfRows, setSelfRows] = useState<WireMessage[]>([]);
  const [peerRows, setPeerRows] = useState<WireMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  // Bump to refetch; the effect below depends on it.
  const [version, setVersion] = useState(0);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!enabled || !selfAgentId || !peerAgentId) return;
    let cancelled = false;
    const fetchBoth = async () => {
      setIsLoading(true);
      try {
        const wired = typeof window !== "undefined" && !!window.electronAPI?.message?.getBySession;
        const [a, b] = wired
          ? await Promise.all([
              getMessagesBySessionIPC(getBotSessionId(selfAgentId)),
              getMessagesBySessionIPC(getBotSessionId(peerAgentId)),
            ])
          : [[], []];
        if (!cancelled) {
          setSelfRows(a);
          setPeerRows(b);
        }
      } catch {
        // The overlay is a read-only side view — a failed fetch leaves it
        // empty rather than crashing the chat behind it.
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void fetchBoth();
    return () => {
      cancelled = true;
    };
  }, [selfAgentId, peerAgentId, enabled, version]);

  const selfSessionId = getBotSessionId(selfAgentId);
  const peerSessionId = getBotSessionId(peerAgentId);

  useEffect(() => {
    if (!enabled) return;
    const onMessageNew = window.electronAPI?.onMessageNew;
    if (!onMessageNew) return;
    const unsubscribe = onMessageNew((payload: { sessionId: string }) => {
      if (payload.sessionId === selfSessionId || payload.sessionId === peerSessionId) {
        setVersion((v) => v + 1);
      }
    });
    return unsubscribe;
  }, [enabled, selfSessionId, peerSessionId]);

  const entries = useMemo(
    () => buildAgentDmPairMessages(selfAgentId, peerAgentId, selfRows, peerRows),
    [selfAgentId, peerAgentId, selfRows, peerRows],
  );

  return { entries, isLoading, refresh };
}
