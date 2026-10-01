/**
 * useAutoCollapse — fold INPUT/RESULT to DORMANT after 60s inactivity.
 *
 * The ball itself NEVER collapses (it's the persistent anchor).
 * Only INPUT and RESULT are folded after `timeoutMs` of no keyboard/mouse input.
 *
 * On activity, the fold is reversed — but state in main stays INPUT/RESULT,
 * so the next render shows the right element.
 */
import { useEffect, useRef } from 'react';
import type { OrbState } from '../types';

interface UseAutoCollapseOpts {
  state: OrbState;
  timeoutMs: number;
  onCollapse: () => void;
  onActivity: () => void;
}

export function useAutoCollapse(opts: UseAutoCollapseOpts): () => void {
  const { state, timeoutMs, onCollapse, onActivity } = opts;
  const lastActivityRef = useRef<number>(Date.now());

  useEffect(() => {
    if (state === 'DORMANT' || state === 'LOADING') {
      // No fold for these states (LOADING shows ball already)
      onActivity();
      return;
    }

    const recordActivity = () => {
      lastActivityRef.current = Date.now();
      onActivity();
    };

    window.addEventListener('mousemove', recordActivity);
    window.addEventListener('keydown', recordActivity);
    window.addEventListener('mousedown', recordActivity);

    const interval = window.setInterval(() => {
      if (Date.now() - lastActivityRef.current >= timeoutMs) {
        onCollapse();
      }
    }, 1000);

    return () => {
      window.removeEventListener('mousemove', recordActivity);
      window.removeEventListener('keydown', recordActivity);
      window.removeEventListener('mousedown', recordActivity);
      window.clearInterval(interval);
    };
  }, [state, timeoutMs, onCollapse, onActivity]);

  return () => {
    lastActivityRef.current = Date.now();
    onActivity();
  };
}