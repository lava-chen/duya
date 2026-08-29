/**
 * OrbApp — root component, owns the 4-state machine.
 *
 * State transitions are driven by IPC events from main process:
 *   - DORMANT → INPUT    : main calls `orb.showInput()` (Ctrl+Shift+Space)
 *   - INPUT   → LOADING  : user submits, main calls `orb.showLoading()`
 *   - LOADING → RESULT   : stream completes, main calls `orb.showResult()`
 *   - *       → DORMANT  : Esc / close / cancel
 *
 * Window bounds change on state transition (50x50 / 280x100 / 50x50 / 350x350).
 * Window positioning is handled by main process via setBounds().
 *
 * Plan 453 Task F.
 */
import { useEffect, useState, useCallback } from 'react';
import { OrbBall } from './components/OrbBall';
import { OrbBallLoading } from './components/OrbBallLoading';
import { OrbInput } from './components/OrbInput';
import { OrbResult } from './components/OrbResult';
import { useOrbState } from './hooks/useOrbState';
import { useOrbDraggable } from './hooks/useOrbDraggable';
import { useAutoCollapse } from './hooks/useAutoCollapse';
import type { OrbState } from './types';

export function OrbApp() {
  const { state, progress, result, submit, insertTab, hide } = useOrbState();

  const [isCollapsed, setIsCollapsed] = useState(false);

  // Drag handler — only meaningful in DORMANT/LOADING states.
  const { onMouseDown: onDragMouseDown } = useOrbDraggable({
    enabled: state === 'DORMANT' || state === 'LOADING',
  });

  // Auto-collapse: 60s no input → fold INPUT/RESULT visually to a ball.
  // The window itself stays open; this is purely a visual fold so the
  // desktop doesn't accumulate dangling cards.
  const resetAutoCollapse = useAutoCollapse({
    state,
    timeoutMs: 60_000,
    onCollapse: () => setIsCollapsed(true),
    onActivity: () => setIsCollapsed(false),
  });

  // Esc handler: any state → DORMANT.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void hide();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hide]);

  const handleSubmit = useCallback(
    async (text: string) => {
      resetAutoCollapse();
      await submit(text);
    },
    [submit, resetAutoCollapse],
  );

  const handleInsertTab = useCallback(async () => {
    if (!result) return;
    await insertTab(result.rawText);
    void hide();
  }, [insertTab, hide, result]);

  const renderCurrent = (): JSX.Element => {
    if (isCollapsed && state !== 'DORMANT') {
      // Force the ball visually while preserving the underlying state
      // (so resuming activity restores the right element).
      return <OrbBall onMouseDown={onDragMouseDown} />;
    }
    return renderByState(state, {
      progress,
      result,
      onDragMouseDown,
      onSubmit: handleSubmit,
      onInsertTab: handleInsertTab,
    });
  };

  return (
    <div className="orb-window" data-state={state}>
      <div className="orb-element-enter" key={state}>
        {renderCurrent()}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RenderArgs {
  progress: import('./types').ProgressInfo;
  result: import('./types').ResultContent | null;
  onDragMouseDown: (e: React.MouseEvent) => void;
  onSubmit: (text: string) => Promise<void>;
  onInsertTab: () => Promise<void>;
}

function renderByState(state: OrbState, args: RenderArgs): JSX.Element {
  switch (state) {
    case 'DORMANT':
      return <OrbBall onMouseDown={args.onDragMouseDown} />;
    case 'INPUT':
      return <OrbInput onSubmit={args.onSubmit} />;
    case 'LOADING':
      return <OrbBallLoading progress={args.progress} onMouseDown={args.onDragMouseDown} />;
    case 'RESULT':
      return <OrbResult result={args.result} onInsertTab={args.onInsertTab} />;
  }
}