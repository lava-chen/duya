// StartupLanding — branded full-screen overlay shown during the first-launch
// loading window. Visually matches the anti-FOUC splash in `index.html` so
// the transition from "raw HTML" → "React tree" is seamless.
//
// Only shown on the first launch (not on session switches). Fades out via CSS
// 200ms when `phase` transitions to `'fading'` and unmounts when `'hidden'`.
//
// Props:
//   phase:   'visible' | 'fading' | 'hidden'
//            - 'visible' full opacity, spinner + status text
//            - 'fading'  200ms opacity transition in progress
//            - 'hidden'  component should be unmounted by parent
//   status:  optional human-readable status line ("Loading workspace…")

import { useEffect, useState } from 'react';

export type StartupLandingPhase = 'visible' | 'fading' | 'hidden';

interface StartupLandingProps {
  phase: StartupLandingPhase;
  status?: string;
}

export function StartupLanding({ phase, status }: StartupLandingProps) {
  // Track the visible opacity so we can apply a 200ms fade-out on the
  // 'visible' → 'fading' transition. We use a separate state instead of
  // deriving from `phase` so the CSS transition has a starting value to
  // animate from.
  const [visible, setVisible] = useState(phase !== 'hidden');

  useEffect(() => {
    if (phase === 'hidden') {
      setVisible(false);
      return;
    }
    setVisible(true);
  }, [phase]);

  if (phase === 'hidden') return null;

  return (
    <div
      className="duya-startup-landing"
      data-phase={phase}
      data-visible={visible ? 'true' : 'false'}
      aria-hidden={phase === 'fading'}
      role="status"
    >
      <div className="duya-startup-stack">
        <div className="duya-startup-logo">
          <img src="/icon.png" alt="" draggable={false} />
        </div>
        <div className="duya-startup-name">duya</div>
        <div className="duya-startup-spinner" aria-hidden="true" />
        {status && <div className="duya-startup-status">{status}</div>}
      </div>
    </div>
  );
}
