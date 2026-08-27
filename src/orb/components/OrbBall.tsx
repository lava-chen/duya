/**
 * OrbBall — DORMANT state.
 *
 * The persistent 50x50 anchor that lives on the user's desktop.
 * - Drag handle: mousedown → main process initiates window drag
 * - Hover: subtle scale up
 * - Click (single): triggers showInput via main process IPC
 */
import type { MouseEvent } from 'react';

interface OrbBallProps {
  onMouseDown?: (e: MouseEvent) => void;
}

export function OrbBall({ onMouseDown }: OrbBallProps) {
  const handleMouseDown = (e: MouseEvent) => {
    onMouseDown?.(e);
  };

  const handleClick = () => {
    // Single click → request INPUT state
    window.electronAPI?.orb?.showInput();
  };

  return (
    <div
      className="orb-ball orb-drag"
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      role="button"
      aria-label="Duya Orb — click or press Ctrl+Shift+Space"
    >
      <div className="orb-ball-logo" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          width="100%"
          height="100%"
        >
          {/* duya robot face — placeholder, replace with actual logo */}
          <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.15" />
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
  );
}