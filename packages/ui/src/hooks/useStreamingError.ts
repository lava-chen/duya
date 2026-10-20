import { useEffect, useState } from 'react';
import { subscribeToError, type StreamingError } from '@/lib/stream-session-manager';

export type { StreamingError } from '@/lib/stream-session-manager';

export function useStreamingError(sessionId: string): StreamingError | null {
  const [error, setError] = useState<StreamingError | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToError(sessionId, (newError) => {
      setError(newError);
    });
    return unsubscribe;
  }, [sessionId]);

  return error;
}
