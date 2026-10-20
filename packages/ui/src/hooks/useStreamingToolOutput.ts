import { useEffect, useState } from 'react';
import { subscribeToToolOutput } from '@/lib/stream-session-manager';

export function useStreamingToolOutput(sessionId: string): string {
  const [toolOutput, setToolOutput] = useState('');

  useEffect(() => {
    const unsubscribe = subscribeToToolOutput(sessionId, (newToolOutput) => {
      setToolOutput(newToolOutput);
    });
    return unsubscribe;
  }, [sessionId]);

  return toolOutput;
}
