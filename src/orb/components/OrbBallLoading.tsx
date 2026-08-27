/**
 * OrbBallLoading — LOADING state.
 *
 * 球回归 + 右上小气泡。气泡显示"思考中 / 正在用 xxx 工具",
 * 通过 `automation:orb:update-progress` IPC 由 main 进程推送。
 *
 * 球自身继续 pulse 动画,提示"在工作"。
 */
import type { MouseEvent } from 'react';
import type { ProgressInfo } from '../types';

interface OrbBallLoadingProps {
  progress: ProgressInfo;
  onMouseDown?: (e: MouseEvent) => void;
}

export function OrbBallLoading({ progress, onMouseDown }: OrbBallLoadingProps) {
  const bubbleText =
    progress.toolName
      ? `用 ${progress.toolName}`
      : progress.label ?? null;

  return (
    <div className="orb-ball-loading">
      <div className="orb-ball orb-drag" onMouseDown={onMouseDown}>
        <div className="orb-ball-logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="100%" height="100%">
            <circle cx="8.5" cy="10" r="1.5" fill="currentColor" />
            <circle cx="15.5" cy="10" r="1.5" fill="currentColor" />
            <path
              d="M8 14.5 Q12 17 16 14.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        </div>
      </div>

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
          aria-label="思考中"
        />
      )}
    </div>
  );
}