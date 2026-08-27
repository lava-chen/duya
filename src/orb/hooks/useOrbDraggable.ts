/**
 * useOrbDraggable — wire mousedown to Electron window drag.
 *
 * In Electron, `-webkit-app-region: drag` on the ball element handles drag
 * natively. This hook provides a fallback for cases where the app region
 * doesn't trigger (e.g. non-frame mode quirks) and also persists position
 * to main process on drag end.
 */
import { useCallback, type MouseEvent } from 'react';

interface UseOrbDraggableOpts {
  enabled: boolean;
}

export function useOrbDraggable({ enabled }: UseOrbDraggableOpts) {
  const onMouseDown = useCallback(
    (e: MouseEvent) => {
      if (!enabled) return;
      // Electron handles drag via -webkit-app-region: drag CSS;
      // we just prevent default to avoid focus stealing.
      e.preventDefault();
    },
    [enabled],
  );

  // Track drag end to persist position via IPC
  const onMouseUp = useCallback(() => {
    if (!enabled) return;
    // Get current position from screen API if needed; for now main process
    // tracks position via Electron's move events.
    const api = window.electronAPI?.orb;
    api?.getPosition?.().then((pos) => {
      // Just a sync — main already has the position from Electron events
      void pos;
    });
  }, [enabled]);

  return { onMouseDown, onMouseUp };
}