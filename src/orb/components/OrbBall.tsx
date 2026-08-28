/**
 * OrbBall — DORMANT state.
 *
 * The persistent 50x50 anchor that lives on the user's desktop.
 * - Drag handle: mousedown → main process initiates window drag
 * - Hover: subtle scale up
 * - Click (single): triggers showInput via main process IPC
 *
 * The visual is now a `DuyaMascot` with the DORMANT expression
 * (neutral / awake, idle). The mascot owns the eye + mouth +
 * body; this component is just the clickable wrapper.
 */
import { type MouseEvent } from 'react';

import { DuyaMascot } from '../DuyaMascot';
import { EXPRESSION_NEUTRAL, EXPRESSION_THINKING } from '../expressions/duya-expressions';
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
          expression={loading ? EXPRESSION_THINKING : EXPRESSION_NEUTRAL}
          gaze={gaze}
        />
      </div>
    </div>
  );
}
