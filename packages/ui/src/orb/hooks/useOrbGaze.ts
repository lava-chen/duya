/**
 * useOrbGaze — drives the mascot's eye gaze vector.
 *
 * Returns a `gaze` ref-like object (plain object, refreshed via
 * `requestAnimationFrame`) the DuyaMascot renderer applies to
 * pupilDx/pupilDy. The ref is intentionally *not* a React state:
 * re-rendering the orb 60 times/sec to track a moving cursor
 * would burn the whole tree.
 *
 * Three gaze modes, picked by the active orb state:
 *
 *   DORMANT  — "drift": slow Lissajous figure around the rest
 *              position. Looks alive, doesn't make the user feel
 *              watched.
 *   INPUT    — "follow": pupil tracks the cursor position,
 *              clamped to a max deviation.
 *   LOADING  — "inward": pupil slowly drifts to center and stays
 *              there. The mascot "thinks".
 *   RESULT   — "celebrate": brief upward gaze on appear, then
 *              drift back to neutral.
 *
 * The mode is decided by the caller; the hook itself just returns
 * the latest gaze sample. Switching modes is the caller's
 * responsibility (cleaner than having the hook know about orb
 * state).
 *
 * The hook is intentionally pure DOM — no React context, no
 * store, no event bus. The orb window is small and isolated; the
 * 5-line mousemove handler lives here.
 */

import { useEffect, useRef } from 'react';

export type GazeMode = 'drift' | 'follow' | 'inward' | 'celebrate';

export interface GazeSample {
  /** Pupil offset in viewBox units, normalized to roughly [-3, 3]. */
  dx: number;
  dy: number;
}

export interface GazeController {
  /** Current gaze sample. Read inside rAF, never as React state. */
  getCurrent: () => GazeSample;
  /** Subscribe to gaze changes; returns unsubscribe. */
  subscribe: (fn: (s: GazeSample) => void) => () => void;
  /** Switch mode. Triggers a one-shot transition (e.g. celebrate). */
  setMode: (mode: GazeMode) => void;
  /** Update the cursor position used by `follow` mode. */
  setPointer: (x: number, y: number, el: HTMLElement | null) => void;
}

const DRIFT_AMP_X = 2.2;
const DRIFT_AMP_Y = 1.4;
const FOLLOW_GAIN = 9; // viewBox units per CSS pixel
const FOLLOW_CLAMP = 3.4;
const INWARD_EASE_MS = 600;

export function useOrbGaze(initialMode: GazeMode = 'drift'): GazeController {
  const modeRef = useRef<GazeMode>(initialMode);
  const pointerRef = useRef<{ x: number; y: number; el: HTMLElement | null }>({
    x: 0,
    y: 0,
    el: null,
  });
  const sampleRef = useRef<GazeSample>({ dx: 0, dy: 0 });
  const targetRef = useRef<GazeSample>({ dx: 0, dy: 0 });
  const startRef = useRef<number>(performance.now());
  const modeStartRef = useRef<number>(performance.now());
  const prevDxRef = useRef<number>(0);
  const prevDyRef = useRef<number>(0);
  const subscribersRef = useRef<Set<(s: GazeSample) => void>>(new Set());

  // Set up the rAF loop. The loop:
  //   1. Computes the target gaze for the current mode.
  //   2. Lerps the live sample toward the target (ease-out).
  //   3. Notifies subscribers.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const t = (now - startRef.current) / 1000;
      const mode = modeRef.current;
      const modeAge = now - modeStartRef.current;

      // Step 1: target.
      if (mode === 'drift') {
        // Lissajous: independent sin/cos with different periods so
        // the path never repeats inside a useful window.
        targetRef.current = {
          dx: DRIFT_AMP_X * Math.sin(t * 0.55),
          dy: DRIFT_AMP_Y * Math.cos(t * 0.41),
        };
      } else if (mode === 'follow') {
        const p = pointerRef.current;
        if (p.el) {
          const rect = p.el.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const dxPx = p.x - cx;
          const dyPx = p.y - cy;
          let dx = dxPx / FOLLOW_GAIN;
          let dy = dyPx / FOLLOW_GAIN;
          const len = Math.hypot(dx, dy);
          if (len > FOLLOW_CLAMP) {
            dx = (dx / len) * FOLLOW_CLAMP;
            dy = (dy / len) * FOLLOW_CLAMP;
          }
          targetRef.current = { dx, dy };
        } else {
          targetRef.current = { dx: 0, dy: 0 };
        }
      } else if (mode === 'inward') {
        // Ease into (0, 0) over INWARD_EASE_MS, then stay there.
        const t01 = Math.min(1, modeAge / INWARD_EASE_MS);
        const ease = 1 - Math.pow(1 - t01, 3);
        targetRef.current = {
          dx: prevDxRef.current * (1 - ease),
          dy: prevDyRef.current * (1 - ease),
        };
      } else {
        // celebrate: brief upward arc.
        const t01 = Math.min(1, modeAge / 800);
        const arc = Math.sin(t01 * Math.PI) * 2.4;
        targetRef.current = { dx: arc * 0.4, dy: -arc };
      }

      // Step 2: lerp the live sample toward the target. Lower
      // alpha = snappier (looks responsive in follow); higher
      // alpha = smoother (looks alive in drift).
      const alpha = mode === 'follow' ? 0.35 : 0.12;
      sampleRef.current.dx +=
        (targetRef.current.dx - sampleRef.current.dx) * alpha;
      sampleRef.current.dy +=
        (targetRef.current.dy - sampleRef.current.dy) * alpha;

      // Step 3: notify.
      for (const sub of subscribersRef.current) {
        try {
          sub(sampleRef.current);
        } catch {
          // listener errors are non-fatal
        }
      }

      // Track previous for the inward mode continuity.
      prevDxRef.current = sampleRef.current.dx;
      prevDyRef.current = sampleRef.current.dy;

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, []);

  return {
    getCurrent: () => sampleRef.current,
    subscribe: (fn) => {
      subscribersRef.current.add(fn);
      return () => {
        subscribersRef.current.delete(fn);
      };
    },
    setMode: (mode) => {
      if (modeRef.current === mode) return;
      modeRef.current = mode;
      modeStartRef.current = performance.now();
    },
    setPointer: (x, y, el) => {
      pointerRef.current = { x, y, el };
    },
  };
}
