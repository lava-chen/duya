import { useEffect, useState } from 'react';
import { subscribeToStatusText } from '@/lib/stream-session-manager';

export function useStreamingStatusText(sessionId: string): string | undefined {
  const [statusText, setStatusText] = useState<string | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = subscribeToStatusText(sessionId, (newStatusText) => {
      setStatusText(newStatusText);
    });
    return unsubscribe;
  }, [sessionId]);

  return statusText;
}
