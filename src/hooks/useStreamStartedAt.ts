import { useEffect, useState } from 'react';
import { subscribe } from '@/lib/stream-session-manager';

export function useStreamStartedAt(sessionId: string): number | null {
  const [startedAt, setStartedAt] = useState<number | null>(null);

  useEffect(() => {
    const unsubscribe = subscribe(sessionId, (snapshot) => {
      setStartedAt(snapshot.startedAt);
    });
    return unsubscribe;
  }, [sessionId]);

  return startedAt;
}
