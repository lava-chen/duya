import { useEffect, useState } from 'react';
import type { ToolUseInfo, ToolResultInfo } from '@/types';
import { subscribeToTools } from '@/lib/stream-session-manager';

export function useStreamingTools(sessionId: string): { uses: ToolUseInfo[]; results: ToolResultInfo[] } {
  const [tools, setTools] = useState<{ uses: ToolUseInfo[]; results: ToolResultInfo[] }>({ uses: [], results: [] });

  useEffect(() => {
    const unsubscribe = subscribeToTools(sessionId, (newTools) => {
      setTools(newTools);
    });
    return unsubscribe;
  }, [sessionId]);

  return tools;
}
