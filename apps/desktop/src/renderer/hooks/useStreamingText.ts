import { useEffect, useState } from 'react';
import { subscribeToText } from '@/lib/stream-session-manager';

export function useStreamingText(sessionId: string): string {
  const [text, setText] = useState('');

  useEffect(() => {
    const unsubscribe = subscribeToText(sessionId, (newText) => {
      setText(newText);
    });
    return unsubscribe;
  }, [sessionId]);

  return text;
}
