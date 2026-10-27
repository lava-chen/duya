/**
 * useSessionUnreadBadge — decides whether a session row carries the blue
 * "finished, not looked at yet" dot (Claude parity, 2026-10-27).
 *
 * ## The two halves of the question
 *
 * "Has the user seen this session's output?" is answered by
 * `useSessionSeenStore` — a persisted `unreadAt` stamp, cleared when the user
 * opens the session.
 *
 * "Has the session stopped working?" is NOT answered by the store, because
 * unread output also exists for a session that is still running. The
 * renderer's own stream phase covers the sessions this renderer started or
 * attached to; a session that ran entirely in the background (cron, a
 * sub-agent, a turn started by another window) leaves the renderer with no
 * stream state at all, and its phase reads as idle.
 *
 * So for a candidate row the hook asks the agent server whether the session
 * is STREAMING and suppresses the dot while it is. The probe is cached for a
 * few seconds and only runs for rows that would otherwise show a dot, so the
 * request volume stays proportional to the number of pending badges rather
 * than to the size of the sidebar.
 */

import { useEffect, useState } from "react";
import { getAgentServerClient } from "@/lib/agent-http-client";
import { useSessionSeenStore } from "@/stores/session-seen-store";

/** How long a streaming answer stays usable before it is re-read. */
const STREAMING_CACHE_TTL_MS = 4000;
/** How often a still-unknown candidate is re-checked. */
const RECHECK_INTERVAL_MS = 8000;

interface StreamingAnswer {
  at: number;
  streaming: boolean;
}

const streamingCache = new Map<string, StreamingAnswer>();

async function isSessionStreaming(sessionId: string): Promise<boolean> {
  const cached = streamingCache.get(sessionId);
  if (cached && Date.now() - cached.at < STREAMING_CACHE_TTL_MS) return cached.streaming;
  try {
    const status = await getAgentServerClient().getSessionStatus(sessionId);
    const streaming = status?.status === "STREAMING";
    streamingCache.set(sessionId, { at: Date.now(), streaming });
    return streaming;
  } catch {
    // The agent server may be gone; an unknown state must not hide a badge
    // that is otherwise true, so report "not streaming".
    return false;
  }
}

/**
 * @param sessionId  the session the row represents
 * @param busy       true when the renderer already knows the session is
 *                   running or waiting on the user — no probe needed then
 */
export function useSessionUnreadBadge(sessionId: string, busy: boolean): boolean {
  const unreadAt = useSessionSeenStore((s) => s.unreadAt[sessionId]);
  const [streaming, setStreaming] = useState(false);

  useEffect(() => {
    if (unreadAt == null || busy) {
      setStreaming(false);
      return;
    }
    let cancelled = false;
    const check = () => {
      void isSessionStreaming(sessionId).then((running) => {
        if (!cancelled) setStreaming(running);
      });
    };
    check();
    const timer = setInterval(check, RECHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, unreadAt, busy]);

  if (unreadAt == null) return false;
  return !streaming;
}
