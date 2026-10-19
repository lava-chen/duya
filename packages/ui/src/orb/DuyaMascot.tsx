/**
 * DuyaMascot — the duya brand creature, drawn as a single SVG.
 *
 * Rendered into the orb ball (DORMANT) and the loading variant
 * (LOADING). Used by OrbBall / OrbBallLoading. Future task: a
 * full-face hero for the result card header.
 *
 * Visual construction (back to front):
 *
 *   1. Body fill (purple gradient) through a mask that cuts an
 *      eye-shaped hole. The hole is the "eye" — it reveals the
 *      warm cream "back wall" below. Auto-clips at the body
 *      silhouette so the eye can never escape the body.
 *   2. Specular highlight, also clipped to the body, for the 3D
 *      glass-bead feel from assets/icon.png.
 *   3. Secondary glint (the small white teardrop in the original
 *      icon). Hidden in `thinking` so the face reads as downcast.
 *   4. Beak (a tiny triangle) — a "bird" detail. Always visible
 *      except when hidden by the expression.
 *   5. The eye's back wall (warm cream), drawn through the mask
 *      hole. This is the visible part of the eye.
 *   6. Pupil + glint, drawn over the back wall. Pupil position
 *      is gaze-driven (see useOrbGaze.ts).
 *   7. Mouth, drawn on top of everything else. The `d` is taken
 *      from the active Expression.
 *
 * The viewBox is 0 0 100 100 so a 50x50 CSS render = 2x scale.
 * All coordinates in the data model (Expression) are in this
 * viewBox space.
 *
 * Plan 453: Task F (foundation). State-to-state animation lands
 * in a follow-up commit via useExpressionTransition; this file
 * renders one Expression per frame.
 */

import { useEffect, useRef, useState } from 'react';

import type { Expression } from './expressions/types';
import { MOUTH_PATHS } from './expressions/duya-expressions';
import type { GazeController, GazeSample } from './hooks/useOrbGaze';
import type { TweenedPath } from './expressions/pathTween';

interface DuyaMascotProps {
  /** Live expression. The renderer re-draws every frame during
   *  state transitions (driven by useExpressionTransition). */
  expression: Expression;
  /**
   * Optional gaze controller. When provided, the pupil follows the
   * controller's current sample. Without a controller, the pupil
   * uses the static `expression.pupilDx/pupilDy`.
   */
  gaze?: GazeController;
  /**
   * Override the pupil sample directly (advanced). Used by tests
   * and by the expression-transition hook when it needs to pin
   * the gaze mid-transition.
   */
  gazeOverride?: GazeSample | null;
  /**
   * Tweened mouth path. When supplied (typically by
   * `useExpressionTransition`), the renderer uses this in place
   * of the static `expression.mouth` path. The tween handles
   * both linear interpolation (same mouth kind) and cross-fade
   * (different mouth kinds) by setting `d: null` and pairing
   * `opacityA` / `opacityB`.
   */
  mouthTween?: TweenedPath;
  /** Render at a different size; default 50 (CSS px). */
  size?: number;
  /**
   * Override the body fill. Default uses the duya-purple gradient.
   * Useful for the result-card hero where we want a softer pink.
   */
  accent?: string;
}

export function DuyaMascot({
  expression,
  gaze,
  gazeOverride,
  mouthTween,
  size = 50,
  accent,
}: DuyaMascotProps) {
  // Live pupil offset, driven by the gaze controller's rAF loop.
  // Local state, but only re-renders when the value actually
  // changes (we use a small deadband below).
  const [pupilOffset, setPupilOffset] = useState<GazeSample>({ dx: 0, dy: 0 });
  const pupilRef = useRef<GazeSample>({ dx: 0, dy: 0 });

  useEffect(() => {
    if (!gaze) return;
    const unsub = gaze.subscribe((s) => {
      // Deadband: only update React state when the offset moved
      // more than 0.1 viewBox unit. Saves a render for tiny jitter.
      const dx = s.dx;
      const dy = s.dy;
      if (
        Math.abs(dx - pupilRef.current.dx) < 0.1 &&
        Math.abs(dy - pupilRef.current.dy) < 0.1
      ) {
        return;
      }
      pupilRef.current = { dx, dy };
      setPupilOffset({ dx, dy });
    });
    return unsub;
  }, [gaze]);

  const eyeCx = 60;
  const eyeCy = 42;
  const eyeRx = expression.eyeRx;
  // eyeRy collapses to ~0 when eyeOpenness is 0; we keep a small
  // floor so the eye still reads as a hole in the body.
  const eyeRy = Math.max(0.6, expression.eyeRy * expression.eyeOpenness);

  const pupilCenterX = eyeCx + (gazeOverride?.dx ?? pupilOffset.dx ?? 0) +
    expression.pupilDx;
  const pupilCenterY = eyeCy + (gazeOverride?.dy ?? pupilOffset.dy ?? 0) +
    expression.pupilDy;
  const pupilR = expression.pupilR * expression.eyeOpenness;

  // Mouth: respect the tween (from useExpressionTransition) when
  // supplied, otherwise fall back to the static expression mouth.
  // The tween decides whether to linear-interp the path or
  // cross-fade two paths (the latter sets d: null and pairs
  // opacityA / opacityB).
  const staticD =
    expression.mouth === 'hidden' ? '' : MOUTH_PATHS[expression.mouth] || '';
  const mouthD = mouthTween
    ? mouthTween.d ?? staticD
    : staticD;
  const mouthOpacityA = mouthTween ? mouthTween.opacityA : 1;
  const mouthOpacityB = mouthTween ? mouthTween.opacityB : 0;
  // When the tween cross-fades, render the second path (target
  // expression's static mouth) alongside the first.
  const isCrossFade = mouthTween?.d === null;

  // Body geometry. Slight asymmetric blob — wider on the left
  // (where the body bulges in the original duya icon), with a
  // subtle "wing" curve on the right where the beak attaches.
  const bodyScale = expression.bodyScale;
  const bodyFill = accent ?? 'url(#duya-body-gradient)';

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className="duya-mascot"
      role="img"
      aria-label={`Duya mascot \u2014 ${expression.label}`}
    >
      <defs>
        <linearGradient id="duya-body-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#c79bff" />
          <stop offset="0.55" stopColor="#7c3aed" />
          <stop offset="1" stopColor="#160921" />
        </linearGradient>
        <radialGradient id="duya-shine" cx="0.32" cy="0.22" r="0.5">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="0.6" stopColor="#ffffff" stopOpacity="0.05" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <clipPath id="duya-body-clip">
          <path d="M 22 14 C 56 8, 84 22, 86 50 C 88 78, 66 90, 50 90 C 30 90, 14 76, 14 50 C 14 32, 18 18, 22 14 Z" />
        </clipPath>
        <mask id="duya-eye-mask" maskUnits="userSpaceOnUse">
          {/* Everything visible by default. */}
          <rect x="0" y="0" width="100" height="100" fill="#fff" />
          {/* Eye hole — black cuts the body fill. */}
          <ellipse
            cx={eyeCx}
            cy={eyeCy}
            rx={eyeRx}
            ry={eyeRy}
            fill="#000"
          />
        </mask>
      </defs>

      <g
        style={{
          transformOrigin: '50% 55%',
          transform: `scale(${bodyScale})`,
          transition: 'transform var(--orb-transition-base) var(--orb-easing)',
        }}
      >
        {/* Body fill, masked to cut the eye hole. */}
        <path
          d="M 22 14 C 56 8, 84 22, 86 50 C 88 78, 66 90, 50 90 C 30 90, 14 76, 14 50 C 14 32, 18 18, 22 14 Z"
          fill={bodyFill}
          mask="url(#duya-eye-mask)"
        />
        {/* Specular highlight, also masked. */}
        <rect
          x="0"
          y="0"
          width="100"
          height="100"
          fill="url(#duya-shine)"
          mask="url(#duya-eye-mask)"
        />
        {/* Subtle wing curve — a soft inner highlight on the right
            side that suggests a folded wing without being too
            literal. */}
        <path
          d="M 70 40 Q 80 55 72 76"
          stroke="#ffffff"
          strokeOpacity="0.18"
          strokeWidth="1.4"
          fill="none"
          strokeLinecap="round"
        />
        {/* Secondary glint (the small white teardrop from
            icon.png). Hidden in `thinking`. */}
        {expression.glintVisible && (
          <ellipse
            cx="78"
            cy="22"
            rx="3.4"
            ry="5"
            fill="#ffffff"
            opacity="0.85"
            transform="rotate(-18 78 22)"
          />
        )}

        {/* Beak — a small triangle pointing right. The mascot is
            duya's "bird" detail. */}
        <path
          d="M 78 56 L 92 60 L 78 64 Z"
          fill="#f59e0b"
          stroke="#92400e"
          strokeWidth="0.6"
          strokeLinejoin="round"
        />
      </g>

      {/* Eye rendering: the back wall is clipped to the body, so
          the warm cream only shows through the mask hole. */}
      <g clipPath="url(#duya-body-clip)">
        <ellipse
          cx={eyeCx}
          cy={eyeCy}
          rx={eyeRx}
          ry={Math.max(eyeRy, 1.2)}
          fill="#fef3c7"
        />
        {/* Pupil — small dark disc at the gaze-driven offset. When
            eyeOpenness collapses toward 0 (thinking), the pupil
            shrinks to nothing. */}
        {pupilR > 0.5 && (
          <>
            <circle
              cx={pupilCenterX}
              cy={pupilCenterY}
              r={pupilR}
              fill="#160921"
            />
            {/* Glint. */}
            <circle
              cx={pupilCenterX + pupilR * 0.3}
              cy={pupilCenterY - pupilR * 0.3}
              r={pupilR * 0.28}
              fill="#ffffff"
              opacity="0.9"
            />
          </>
        )}
      </g>

      {/* Mouth — always on top of the body. The tween-driven
          override renders two layered paths when the source
          shapes differ. */}
      {mouthD && mouthOpacityA > 0 && (
        <path
          d={mouthD}
          fill="none"
          stroke="#160921"
          strokeWidth={1.6}
          strokeLinecap="round"
          opacity={mouthOpacityA * 0.7}
        />
      )}
      {isCrossFade && mouthTween && staticD && mouthOpacityB > 0 && (
        <path
          d={staticD}
          fill="none"
          stroke="#160921"
          strokeWidth={1.6}
          strokeLinecap="round"
          opacity={mouthOpacityB * 0.7}
        />
      )}
    </svg>
  );
}
