'use client';

import { useState, useEffect } from 'react';
import { streamSessionManager, type AgentProgressEvent } from '@/lib/stream-session-manager';

export interface AgentProgressEventWithMeta extends AgentProgressEvent {
  receivedAt: number;
  seq: number;
}

export function useStreamingAgentProgress(sessionId: string): AgentProgressEventWithMeta[] {
  const [events, setEvents] = useState<AgentProgressEventWithMeta[]>([]);

  useEffect(() => {
    const manager = streamSessionManager;

    setEvents([]);

    const unsubscribe = manager.subscribeToAgentProgress(sessionId, (event: AgentProgressEvent) => {
      setEvents((prev) => [
        ...prev,
        {
          ...event,
          receivedAt: event.receivedAt ?? Date.now(),
          seq: prev.length + 1,
        },
      ]);
    });

    return () => {
      unsubscribe();
    };
  }, [sessionId]);

  return events;
}
