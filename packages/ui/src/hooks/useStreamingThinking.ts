import { useEffect, useState } from 'react';
import { subscribeToThinking } from '@/lib/stream-session-manager';

export function useStreamingThinking(sessionId: string): string {
  const [thinking, setThinking] = useState('');

  useEffect(() => {
    const unsubscribe = subscribeToThinking(sessionId, (newThinking) => {
      setThinking(newThinking);
    });
    return unsubscribe;
  }, [sessionId]);

  return thinking;
}
