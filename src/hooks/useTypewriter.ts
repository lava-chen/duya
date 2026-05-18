import { useState, useEffect, useRef } from 'react';

const DEFAULT_CHARS_PER_SECOND = 120;
const TICK_INTERVAL_MS = 30;

export function useTypewriter(
  rawText: string,
  isStreaming: boolean,
  charsPerSecond: number = DEFAULT_CHARS_PER_SECOND,
): string {
  const [displayText, setDisplayText] = useState('');
  const rawTextRef = useRef(rawText);
  rawTextRef.current = rawText;
  const displayIndexRef = useRef(0);

  useEffect(() => {
    if (!rawText && !isStreaming) {
      displayIndexRef.current = 0;
      setDisplayText('');
    }
  }, [rawText, isStreaming]);

  useEffect(() => {
    if (!isStreaming) {
      if (rawText && displayIndexRef.current < rawText.length) {
        displayIndexRef.current = rawText.length;
        setDisplayText(rawText);
      }
      return;
    }

    const charsPerTick = Math.max(1, Math.ceil(charsPerSecond * TICK_INTERVAL_MS / 1000));

    const interval = setInterval(() => {
      const currentText = rawTextRef.current;
      if (!currentText) return;

      const nextIndex = Math.min(displayIndexRef.current + charsPerTick, currentText.length);
      if (nextIndex > displayIndexRef.current) {
        displayIndexRef.current = nextIndex;
        setDisplayText(currentText.slice(0, nextIndex));
      }
    }, TICK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [isStreaming, charsPerSecond]);

  return displayText;
}