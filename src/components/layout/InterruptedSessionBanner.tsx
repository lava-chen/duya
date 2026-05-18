"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getInterruptedSessions } from "@/lib/agent-sse-client";
import { useConversationStore } from "@/stores/conversation-store";

interface InterruptedSession {
  id: string;
  title?: string;
  updated_at?: number;
  working_directory?: string;
}

interface DismissedMap {
  [sessionId: string]: number;
}

const DISMISSED_KEY = "duya-interrupted-dismissed";

function loadDismissed(): DismissedMap {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveDismissed(map: DismissedMap): void {
  localStorage.setItem(DISMISSED_KEY, JSON.stringify(map));
}

export function InterruptedSessionBanner() {
  const [sessions, setSessions] = useState<InterruptedSession[]>([]);
  const [visible, setVisible] = useState(true);
  const { setActiveThread, isHydrated } = useConversationStore();
  const dismissedRef = useRef<DismissedMap>(loadDismissed());

  useEffect(() => {
    if (!isHydrated) return;

    getInterruptedSessions().then((result) => {
      const list = (result as InterruptedSession[]) || [];
      const dismissed = dismissedRef.current;
      const now = Date.now();

      const filtered = list.filter((s) => {
        const dismissedAt = dismissed[s.id];
        if (!dismissedAt) return true;
        return now - dismissedAt > 24 * 60 * 60 * 1000;
      });

      if (filtered.length > 0) {
        setSessions(filtered);
      }
    }).catch(() => {
      // silently ignore errors
    });
  }, [isHydrated]);

  const handleContinue = useCallback((sessionId: string) => {
    setActiveThread(sessionId);
    setVisible(false);
  }, [setActiveThread]);

  const handleViewHistory = useCallback((sessionId: string) => {
    setActiveThread(sessionId);
    setVisible(false);
  }, [setActiveThread]);

  const handleDismiss = useCallback((sessionId: string) => {
    const map = dismissedRef.current;
    map[sessionId] = Date.now();
    saveDismissed(map);
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
  }, []);

  const handleDismissAll = useCallback(() => {
    const map = dismissedRef.current;
    const now = Date.now();
    for (const s of sessions) {
      map[s.id] = now;
    }
    saveDismissed(map);
    setVisible(false);
  }, [sessions]);

  if (!visible || sessions.length === 0) return null;

  return (
    <div className="interrupted-banner">
      <div className="interrupted-banner-content">
        <div className="interrupted-banner-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <div className="interrupted-banner-text">
          {sessions.length === 1 ? (
            <span>
              Previous session "{sessions[0].title || sessions[0].id}" was interrupted.
            </span>
          ) : (
            <span>
              {sessions.length} sessions were interrupted during your last session.
            </span>
          )}
        </div>
        <div className="interrupted-banner-actions">
          {sessions.map((s) => (
            <div key={s.id} className="interrupted-banner-session">
              <span className="interrupted-banner-session-title" title={s.working_directory}>
                {s.title || s.id}
              </span>
              <button
                className="interrupted-banner-btn interrupted-banner-btn-primary"
                onClick={() => handleContinue(s.id)}
              >
                Continue
              </button>
              <button
                className="interrupted-banner-btn"
                onClick={() => handleViewHistory(s.id)}
              >
                View History
              </button>
              <button
                className="interrupted-banner-btn"
                onClick={() => handleDismiss(s.id)}
              >
                Dismiss
              </button>
            </div>
          ))}
          {sessions.length > 1 && (
            <button
              className="interrupted-banner-btn interrupted-banner-dismiss-all"
              onClick={handleDismissAll}
            >
              Dismiss All
            </button>
          )}
        </div>
      </div>
    </div>
  );
}