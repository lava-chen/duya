/**
 * OrbBallLoading — LOADING state.
 *
 * Ball returns + right-top progress bubble. Bubble content
 * ("thinking" / "using tool X") is pushed by main via the
 * `automation:orb:update-progress` IPC.
 *
 * The ball itself reuses OrbBall with `loading=true`, which picks
 * the THINKING expression and points the gaze controller at
 * `inward` mode (pupil eases to center while the agent works).
 */
import type { MouseEvent } from 'react';
import type { OrbMoment } from '../bot/BloubOrb';
import type { ProgressInfo } from '../types';
import { OrbBall } from './OrbBall';

interface OrbBallLoadingProps {
  progress: ProgressInfo;
  onMouseDown?: (e: MouseEvent) => void;
  moment?: OrbMoment | null;
}

export function OrbBallLoading({
  progress,
  onMouseDown,
  moment = null,
}: OrbBallLoadingProps) {
  const bubbleText = progress.toolName
    ? `\u7528 ${progress.toolName}`
    : progress.label ?? null;

  return (
    <div className="orb-ball-loading">
      <OrbBall
        onMouseDown={onMouseDown}
        loading
        toolStage={progress.stage === 'tool'}
        moment={moment}
      />

      {bubbleText ? (
        <div
          className="orb-progress-bubble"
          role="status"
          aria-live="polite"
          title={bubbleText}
        >
          {bubbleText}
        </div>
      ) : (
        <div
          className="orb-progress-bubble orb-progress-bubble--spinner"
          role="status"
          aria-label="\u601d\u8003\u4e2d"
        />
      )}
    </div>
  );
}
