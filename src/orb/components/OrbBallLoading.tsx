/**
 * OrbBallLoading — LOADING state.
 *
 * 球回归 + 右上小气泡。气泡显示"思考中 / 正在用 xxx 工具",
 * 通过 `automation:orb:update-progress` IPC 由 main 进程推送。
 *
 * 球自身继续 pulse 动画,提示"在工作"。眼睛用 OrbBall 的
 * `loading` 变体(闭眼弧线)以增加"在处理"的语义。
 */
import type { MouseEvent } from 'react';
import type { ProgressInfo } from '../types';
import { OrbBall } from './OrbBall';

interface OrbBallLoadingProps {
  progress: ProgressInfo;
  onMouseDown?: (e: MouseEvent) => void;
}

export function OrbBallLoading({ progress, onMouseDown }: OrbBallLoadingProps) {
  const bubbleText = progress.toolName
    ? `\u7528 ${progress.toolName}`
    : progress.label ?? null;

  return (
    <div className="orb-ball-loading">
      <OrbBall onMouseDown={onMouseDown} loading />

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