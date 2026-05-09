import { useEffect, useState } from 'react';
import { subscribeToToolProgress } from '@/lib/stream-session-manager';

export function useStreamingToolProgress(sessionId: string): { toolName: string; elapsedSeconds: number } | null {
  const [toolProgressInfo, setToolProgressInfo] = useState<{ toolName: string; elapsedSeconds: number } | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToToolProgress(sessionId, (newInfo) => {
      setToolProgressInfo(newInfo);
    });
    return unsubscribe;
  }, [sessionId]);

  return toolProgressInfo;
}
