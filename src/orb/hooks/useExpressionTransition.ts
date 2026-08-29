/**
 * useExpressionTransition \u2014 morph between two Expressions over time.
 *
 * Plan 453 Task F (foundation follow-up).
 *
 * The orb's expression is normally set by the state (DORMANT \u2192
 * NEUTRAL, LOADING \u2192 THINKING, etc.). When the expression
 * changes we don't want a 1-frame snap \u2014 we want the eye to
 * soften, the mouth to morph, the body to squash, all over
 * ~260ms.
 *
 * How it works:
 *
 *   1. The hook owns a single rAF loop that lives for the full
 *      component lifetime. Each tick we compute elapsed time
 *      since the latest target change, derive a progress t in
 *      [0, 1] with cubic ease-out, and lerp every numeric
 *      parameter of the expression.
 *
 *   2. For the mouth we use a tweened `d` path string. When the
 *      source and target have different mouth kinds (e.g.
 *      `smile` \u2192 `flat`) the tween falls back to cross-fade \u2014
 *      the renderer layers both paths with the computed opacities.
 *
 *   3. The hook is *not* itself a React state holder. Internally
 *      it stores the interpolated expression in a ref and forces
 *      a render via a useReducer. The component just reads
 *      `current.expression` once per frame and re-renders the
 *      <DuyaMascot>. 60fps renders are fine because DuyaMascot
 *      is a pure SVG (no DOM mutation cost).
 *
 *   4. When the target changes mid-animation we *don't* restart;
 *      we snapshot the current interpolated value as the new
 *      "from" and continue toward the new target. The animation
 *      thus stays smooth even under rapid state changes.
 *
 *   5. The rAF loop is *always alive* (even at t=1) so a target
 *      change on the very next frame is picked up without a
 *      useEffect re-run. The cleanup cancels in-flight rAFs
 *      when the hook unmounts.
 *
 * Public API:
 *
 *   const sample = useExpressionTransition(target, durationMs?)
 *
 * Returns `{ expression, mouthTween }`. The component re-renders
 * on every frame the animation is running; after settle the
 * hook idles at 1 rAF per frame cost (negligible).
 */

import { useEffect, useReducer, useRef } from 'react';

import type { Expression, MouthKind } from '../expressions/types';
import { MOUTH_PATHS } from '../expressions/duya-expressions';
import { tweenPath, type TweenedPath } from '../expressions/pathTween';

export interface ExpressionTransitionSample {
  expression: Expression;
  mouthTween: TweenedPath;
}

const DEFAULT_DURATION_MS = 260;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Cubic ease-out. Mirrors the orb's --orb-easing style. */
function ease(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function useExpressionTransition(
  target: Expression,
  durationMs: number = DEFAULT_DURATION_MS,
): ExpressionTransitionSample {
  const fromRef = useRef<Expression>(target);
  const startMsRef = useRef<number | null>(null);
  const lastTargetIdRef = useRef<string>(target.id);
  const targetRef = useRef<Expression>(target);
  const sampleRef = useRef<ExpressionTransitionSample>({
    expression: target,
    mouthTween: { d: MOUTH_PATHS[target.mouth] || '', opacityA: 1, opacityB: 0 },
  });
  const [, force] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    // On every effect run, sync the target into the ref. The
    // effect runs after commit, so this captures the latest
    // target the parent rendered with.
    targetRef.current = target;
    // If the target id changed since the last effect run, restart
    // the animation from the current interpolated value.
    if (target.id !== lastTargetIdRef.current) {
      fromRef.current = sampleRef.current.expression;
      lastTargetIdRef.current = target.id;
      startMsRef.current = null;
    }

    let raf = 0;
    let running = true;
    const tick = () => {
      if (!running) return;
      const now = performance.now();
      if (startMsRef.current === null) {
        startMsRef.current = now;
      }
      const elapsed = now - startMsRef.current;
      const tRaw = Math.min(1, elapsed / durationMs);
      const t = ease(tRaw);

      const from = fromRef.current;
      const to = targetRef.current;
      const tween: TweenedPath = tweenPath(
        MOUTH_PATHS[from.mouth as MouthKind] ?? '',
        MOUTH_PATHS[to.mouth as MouthKind] ?? '',
        t,
      );

      const glintVisible = t < 0.5 ? from.glintVisible : to.glintVisible;

      const openLerp = lerp(from.eyeOpenness, to.eyeOpenness, t);
      const pupilRScale = Math.max(0, Math.min(1, openLerp * 1.2 - 0.1));
      const pupilR = lerp(from.pupilR, to.pupilR, t) * pupilRScale;

      const next: Expression = {
        id: to.id,
        label: to.label,
        eyeOpenness: openLerp,
        eyeRx: lerp(from.eyeRx, to.eyeRx, t),
        eyeRy: lerp(from.eyeRy, to.eyeRy, t),
        pupilDx: lerp(from.pupilDx, to.pupilDx, t),
        pupilDy: lerp(from.pupilDy, to.pupilDy, t),
        pupilR,
        mouth: to.mouth,
        mouthOpenness: lerp(from.mouthOpenness, to.mouthOpenness, t),
        bodyScale: lerp(from.bodyScale, to.bodyScale, t),
        glintVisible,
      };

      sampleRef.current = { expression: next, mouthTween: tween };
      force();

      // Always keep the rAF loop alive so a target change on the
      // very next frame is picked up without a useEffect re-run.
      if (tRaw < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        fromRef.current = next;
        startMsRef.current = null;
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [target, durationMs]);

  return sampleRef.current;
}
