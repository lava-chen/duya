import { useEffect, useState } from 'react';
import type { ContextUsage } from '@/types';
import { subscribeToContextUsage } from '@/lib/stream-session-manager';

export function useStreamingContextUsage(sessionId: string): ContextUsage | null {
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToContextUsage(sessionId, (newContextUsage) => {
      setContextUsage(newContextUsage);
    });
    return unsubscribe;
  }, [sessionId]);

  return contextUsage;
}
