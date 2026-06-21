'use client';

import { useState, useEffect, useRef } from 'react';
import { streamSessionManager, type AgentProgressEvent } from '@/lib/stream-session-manager';

export interface AgentProgressEventWithMeta extends AgentProgressEvent {
  receivedAt: number;
  seq: number;
}

export function useStreamingAgentProgress(sessionId: string): AgentProgressEventWithMeta[] {
  const [events, setEvents] = useState<AgentProgressEventWithMeta[]>([]);
  const callCountRef = useRef(0);

  useEffect(() => {
    const manager = streamSessionManager;
    const instanceId = Math.random().toString(36).slice(2, 8);
    callCountRef.current = 0;

    console.debug('[useStreamingAgentProgress] mount', { sessionId, instanceId });

    setEvents([]);

    const unsubscribe = manager.subscribeToAgentProgress(sessionId, (event: AgentProgressEvent) => {
      callCountRef.current += 1;
      console.debug('[useStreamingAgentProgress] listener fire', {
        sessionId,
        instanceId,
        callCount: callCountRef.current,
        agentId: event.agentId,
        type: event.type,
      });
      setEvents((prev) => {
        const next = [
          ...prev,
          {
            ...event,
            receivedAt: event.receivedAt ?? Date.now(),
            seq: prev.length + 1,
          },
        ];
        if (callCountRef.current === 1 || callCountRef.current % 5 === 0) {
          console.debug('[useStreamingAgentProgress] events state size', { sessionId, instanceId, n: next.length });
        }
        return next;
      });
    });

    return () => {
      console.debug('[useStreamingAgentProgress] cleanup', { sessionId, instanceId, callCount: callCountRef.current });
      unsubscribe();
    };
  }, [sessionId]);

  return events;
}
