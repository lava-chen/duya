// useStreamSubscription.ts - React hook for stream subscription

import { useEffect, useState, useCallback, useRef } from 'react';
import type { SessionStreamSnapshot } from '@/types/message';
import { ensureSession, subscribe, getSnapshot } from './stream-session-manager';

/**
 * React hook for subscribing to stream events
 * Returns the current snapshot and automatically unsubscribes on unmount
 */
export function useStreamSubscription(sessionId: string): SessionStreamSnapshot | null {
  // Get initial snapshot immediately
  const [snapshot, setSnapshot] = useState<SessionStreamSnapshot | null>(() => {
    return getSnapshot(sessionId);
  });

  const sessionIdRef = useRef(sessionId);

  useEffect(() => {
    ensureSession(sessionId);

    // Update ref when sessionId changes
    sessionIdRef.current = sessionId;

    // Get initial snapshot
    const initialSnapshot = getSnapshot(sessionId);
    if (initialSnapshot) {
      setSnapshot(initialSnapshot);
    }

    // Subscribe to updates
    const unsubscribe = subscribe(sessionId, (newSnapshot) => {
      // Only update if this is still the current session
      if (sessionIdRef.current === sessionId) {
        setSnapshot(newSnapshot);
      }
    });

    // Cleanup on unmount or when sessionId changes
    return () => {
      unsubscribe();
    };
  }, [sessionId]);

  return snapshot;
}
