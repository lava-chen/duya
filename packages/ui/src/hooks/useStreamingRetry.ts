import { useEffect, useState } from 'react';
import { subscribeToRetry } from '@/lib/stream-session-manager';

export interface RetryInfo {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  message: string;
}

export function useStreamingRetry(sessionId: string): RetryInfo | null {
  const [retryInfo, setRetryInfo] = useState<RetryInfo | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToRetry(sessionId, (info) => {
      setRetryInfo(info);
    });
    return unsubscribe;
  }, [sessionId]);

  return retryInfo;
}
