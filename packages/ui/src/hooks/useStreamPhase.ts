import { useEffect, useState } from 'react';
import type { StreamPhase } from '@/types';
import { subscribeToPhase } from '@/lib/stream-session-manager';

export function useStreamPhase(sessionId: string): StreamPhase {
  const [phase, setPhase] = useState<StreamPhase>('idle');

  useEffect(() => {
    const unsubscribe = subscribeToPhase(sessionId, (newPhase) => {
      setPhase(newPhase);
    });
    return unsubscribe;
  }, [sessionId]);

  return phase;
}
