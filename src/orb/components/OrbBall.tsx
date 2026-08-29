/**
 * OrbBall \u2014 DORMANT / LOADING shared ball component.
 *
 * Owns the gaze controller and the expression-transition hook.
 * Re-renders 60fps during state transitions (eye + mouth morph);
 * idle in steady state.
 *
 * The orb's "state" (DORMANT/INPUT/LOADING/RESULT) is owned by
 * the parent. This component only sees `loading` (DORMANT vs.
 * LOADING) and picks the corresponding target expression. We
 * don't yet morph between the input's FOCUSED expression and
 * the loading's THINKING expression \u2014 INPUT uses its own
 * component (OrbInput) so the cross-fade there would need a
 * shared ball, deferred to a follow-up.
 */
import { type MouseEvent } from 'react';

import { DuyaMascot } from '../DuyaMascot';
import { EXPRESSION_NEUTRAL, EXPRESSION_THINKING } from '../expressions/duya-expressions';
import { useExpressionTransition } from '../hooks/useExpressionTransition';
import { useOrbGaze } from '../hooks/useOrbGaze';

interface OrbBallProps {
  onMouseDown?: (e: MouseEvent) => void;
  /** When true, render the LOADING variant (closed eye, small
   *  inward-gazing pupil). */
  loading?: boolean;
}

export function OrbBall({ onMouseDown, loading = false }: OrbBallProps) {
  const handleMouseDown = (e: MouseEvent) => {
    onMouseDown?.(e);
  };

  const handleClick = () => {
    if (loading) return; // LOADING variant doesn't respond to click
    window.electronAPI?.orb?.showInput();
  };

  // One gaze controller per OrbBall instance, mode-keyed off the
  // `loading` flag. The hook owns its own rAF loop, so re-renders
  // are cheap; we just hand the controller to DuyaMascot which
  // subscribes inside its own effect.
  const gaze = useOrbGaze(loading ? 'inward' : 'drift');

  // Expression transition: when `loading` flips, we morph from
  // the current visual state to the new target over ~260ms.
  // The hook returns the live interpolated expression every
  // frame; once settled it idles.
  const target = loading ? EXPRESSION_THINKING : EXPRESSION_NEUTRAL;
  const sample = useExpressionTransition(target, 260);

  return (
    <div
      className="orb-ball orb-drag"
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      role="button"
      aria-label="Duya Orb \u2014 click or double-tap Shift+="
    >
      <div className="orb-ball-mascot" aria-hidden="true">
        <DuyaMascot
          expression={sample.expression}
          gaze={gaze}
          mouthTween={sample.mouthTween}
        />
      </div>
    </div>
  );
}
