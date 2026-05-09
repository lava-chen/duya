import { useEffect, useState } from 'react';
import { subscribeToError } from '@/lib/stream-session-manager';

export function useStreamingError(sessionId: string): string | null {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToError(sessionId, (newError) => {
      setError(newError);
    });
    return unsubscribe;
  }, [sessionId]);

  return error;
}
