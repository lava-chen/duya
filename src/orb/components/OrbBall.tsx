/**
 * OrbBall — DORMANT state.
 *
 * The persistent 50x50 anchor that lives on the user's desktop.
 * - Drag handle: mousedown → main process initiates window drag
 * - Hover: subtle scale up
 * - Click (single): triggers showInput via main process IPC
 *
 * Visual: a simplified duya mascot (purple gradient blob + large eye
 * + small smile) drawn as inline SVG so it scales crisply at 50x50
 * and matches the brand identity in `assets/icon.png`. The SVG
 * uses currentColor where it makes sense so :root[data-theme="dark"]
 * can shift the body tint if we want to add that later.
 */
import type { MouseEvent } from 'react';

interface OrbBallProps {
  onMouseDown?: (e: MouseEvent) => void;
  /** When true, the mascot draws a tiny ⌛/eyes-closed look. Used by
   *  the LOADING variant; not in DORMANT. */
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

  return (
    <div
      className="orb-ball orb-drag"
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      role="button"
      aria-label="Duya Orb \u2014 click or double-tap Shift+="
    >
      <div className="orb-ball-logo" aria-hidden="true">
        <svg
          viewBox="0 0 32 32"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          width="100%"
          height="100%"
        >
          <defs>
            {/* Body gradient: matches the duya app icon's purple
                family (hero.svg: #b184e2 → #7c3aed → #160921). */}
            <linearGradient id="duyaBody" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#c79bff" />
              <stop offset="0.55" stopColor="#7c3aed" />
              <stop offset="1" stopColor="#160921" />
            </linearGradient>
            {/* Specular highlight on the body — gives the 3D "glass
                bead" feel that icon.png uses. */}
            <radialGradient id="duyaShine" cx="0.32" cy="0.22" r="0.5">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
              <stop offset="0.6" stopColor="#ffffff" stopOpacity="0.05" />
              <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
            </radialGradient>
            {/* Eye iris — warm amber contrasts with the cool purple
                body so the gaze reads even at 14px. */}
            <radialGradient id="duyaIris" cx="0.5" cy="0.5" r="0.5">
              <stop offset="0" stopColor="#fef3c7" />
              <stop offset="0.65" stopColor="#f59e0b" />
              <stop offset="1" stopColor="#92400e" />
            </radialGradient>
            <clipPath id="duyaBodyClip">
              {/* Asymmetric blob — slightly wider on the left where
                  the mascot's body bulges in the original icon. */}
              <path d="M9 3 C 19 2, 28 6, 28.5 16 C 29 26, 22 30, 16 30 C 9 30, 3 25, 3 16 C 3 9, 5 4, 9 3 Z" />
            </clipPath>
          </defs>

          {/* Body */}
          <path
            d="M9 3 C 19 2, 28 6, 28.5 16 C 29 26, 22 30, 16 30 C 9 30, 3 25, 3 16 C 3 9, 5 4, 9 3 Z"
            fill="url(#duyaBody)"
          />
          {/* Highlight layer, clipped to the body so the gradient
              never bleeds outside the silhouette. */}
          <rect
            x="0"
            y="0"
            width="32"
            height="32"
            fill="url(#duyaShine)"
            clipPath="url(#duyaBodyClip)"
          />
          {/* Big eye (the mascot's signature feature). Centered slightly
              to the right to match icon.png. */}
          <circle cx="20" cy="14" r="5.5" fill="#ffffff" />
          <circle cx="20" cy="14" r="3" fill="url(#duyaIris)" />
          {/* Pupil + glint. Closed eyes variant swaps the glint for
              a curved line. */}
          {loading ? (
            <path
              d="M16.5 14 Q 20 11.5 23.5 14"
              stroke="#160921"
              strokeWidth="0.9"
              fill="none"
              strokeLinecap="round"
            />
          ) : (
            <>
              <circle cx="20.4" cy="14.3" r="1.4" fill="#160921" />
              <circle cx="21.2" cy="13.1" r="0.6" fill="#ffffff" />
            </>
          )}
          {/* Tiny secondary glint (smaller eye/highlight from the
              original icon) */}
          <ellipse
            cx="26.5"
            cy="10.5"
            rx="1.1"
            ry="1.6"
            fill="#ffffff"
            opacity="0.85"
            transform="rotate(-18 26.5 10.5)"
          />
          {/* Subtle smile. */}
          <path
            d="M22 22 Q 25 24 27 22"
            stroke="#160921"
            strokeWidth="0.9"
            fill="none"
            strokeLinecap="round"
            opacity="0.45"
          />
        </svg>
      </div>
    </div>
  );
}