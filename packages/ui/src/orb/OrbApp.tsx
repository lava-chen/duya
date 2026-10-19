/**
 * OrbApp — root component, owns the 4-state machine.
 *
 * State transitions are driven by IPC events from main process:
 *   - DORMANT → INPUT    : main calls `orb.showInput()` (Ctrl+Shift+Space)
 *   - INPUT   → LOADING  : user submits, main calls `orb.showLoading()`
 *   - LOADING → RESULT   : stream completes, main calls `orb.showResult()`
 *   - *       → DORMANT  : Esc / close / cancel
 *
 * Phase B (Plan session-floater): INPUT/LOADING/RESULT now render the
 * same chat-style `OrbSessionCard` (header + message stream + input
 * row) inside the 360x520 window. DORMANT still uses `OrbBall` (the
 * 50x50 floating anchor). The legacy `OrbInput`/`OrbResult` pair was
 * deleted — all their input-row behaviour moved into OrbSessionCard.
 *
 * Plan 453 Task F + Plan session-floater Phase B.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import type { OrbMoment } from './bot/BloubOrb';
import type { StateId } from './bot/states';
import { OrbBall } from './components/OrbBall';
import { OrbSessionCard } from './components/OrbSessionCard';
import { useOrbState } from './hooks/useOrbState';
import { useOrbDraggable } from './hooks/useOrbDraggable';
import { useAutoCollapse } from './hooks/useAutoCollapse';

/** LOADING 超过这个时长，RESULT 到达时播一次 burst 庆祝。 */
const LONG_TASK_MS = 10_000;
/**
 * OrbApp 端 moment 的保留时长。必须大于所有 moment 状态的目录时长
 * （最长 burst 2.6s）：引擎先自行回落 base，这里随后清空 prop。
 */
const MOMENT_TTL_MS = 4000;

export function OrbApp() {
  const {
    state,
    progress,
    notified,
    cardSeq,
    messages,
    pendingText,
    setPendingText,
    pendingAttachments,
    setPendingAttachments,
    autoInjectBanner,
    setAutoInjectBanner,
    submit,
    openResult,
    insertTab,
    hide,
    resetConversation,
  } = useOrbState();

  const [isCollapsed, setIsCollapsed] = useState(false);

  // Moment 层：业务事件 → 一次性动画。仲裁器在 BloubOrb 内。
  const [moment, setMoment] = useState<OrbMoment | null>(null);
  const momentKey = useRef(0);
  const momentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const playMoment = useCallback((momentState: StateId) => {
    momentKey.current += 1;
    setMoment({ state: momentState, key: momentKey.current });
    if (momentTimer.current) clearTimeout(momentTimer.current);
    momentTimer.current = setTimeout(() => setMoment(null), MOMENT_TTL_MS);
  }, []);
  useEffect(
    () => () => {
      if (momentTimer.current) clearTimeout(momentTimer.current);
    },
    [],
  );

  // LOADING → RESULT：长任务完成才庆祝，短问答安静交付。
  const loadingSince = useRef(0);
  useEffect(() => {
    if (state === 'LOADING') {
      if (loadingSince.current === 0) loadingSince.current = Date.now();
      return;
    }
    if (
      state === 'RESULT' &&
      loadingSince.current !== 0 &&
      Date.now() - loadingSince.current >= LONG_TASK_MS
    ) {
      playMoment('burst');
    }
    loadingSince.current = 0;
  }, [state, playMoment]);

  // 结果在 DORMANT 时到达：不弹卡片，球上闪一下 notify 徽标。
  useEffect(() => {
    if (notified) playMoment('notify');
  }, [notified, playMoment]);

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

  // The wake hotkey focuses the window without any in-window activity, so a
  // folded card must unfold here or the hotkey would bring back only a ball.
  useEffect(() => {
    const onWindowFocus = () => setIsCollapsed(false);
    window.addEventListener('focus', onWindowFocus);
    return () => window.removeEventListener('focus', onWindowFocus);
  }, []);

  // Unfold whenever main opens a card. This is the reliable path: Windows'
  // foreground lock often makes win.focus() a no-op for a background app,
  // so the focus event above can never fire in the hotkey scenario.
  useEffect(() => {
    if (cardSeq > 0) setIsCollapsed(false);
  }, [cardSeq]);

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
    async (text: string, attachments?: string[]) => {
      resetAutoCollapse();
      playMoment('wink');
      const accepted = await submit(text, attachments);
      if (!accepted) playMoment('exclaim');
    },
    [submit, resetAutoCollapse, playMoment],
  );

  // Ball click: a badged (notified) ball opens the stored result; otherwise
  // it opens the input box.
  const handleBallActivate = useCallback(() => {
    if (notified) {
      void openResult();
      return;
    }
    void window.electronAPI?.orb?.showInput();
  }, [notified, openResult]);

  // Phase B header actions.
  const handleNewChat = useCallback(async () => {
    await resetConversation();
  }, [resetConversation]);

  const handleCopyLast = useCallback(async () => {
    // The actual clipboard write happens inside OrbSessionCard so the
    // nav button can pick the latest assistant text; here we just need
    // a hook the session card can invoke after writing.
  }, []);

  const handleClose = useCallback(async () => {
    await hide();
  }, [hide]);

  const renderCurrent = () => {
    if (isCollapsed && state !== 'DORMANT') {
      // Force the ball visually while preserving the underlying state
      // (so resuming activity restores the right element).
      return (
        <OrbBall
          onMouseDown={onDragMouseDown}
          onActivate={handleBallActivate}
          moment={moment}
        />
      );
    }
    if (state === 'DORMANT') {
      return (
        <OrbBall
          onMouseDown={onDragMouseDown}
          onActivate={handleBallActivate}
          moment={moment}
        />
      );
    }
    return (
      <OrbSessionCard
        messages={messages}
        state={state}
        progress={progress}
        pendingText={pendingText}
        setPendingText={setPendingText}
        pendingAttachments={pendingAttachments}
        setPendingAttachments={setPendingAttachments}
        autoInjectBanner={autoInjectBanner}
        setAutoInjectBanner={setAutoInjectBanner}
        onSubmit={handleSubmit}
        onNewChat={handleNewChat}
        onCopyLast={handleCopyLast}
        onClose={handleClose}
        onInsertTab={insertTab}
      />
    );
  };

  return (
    <div className="orb-window" data-state={state}>
      {/* data-moment: test/debug observability for the moment arbiter */}
      <div className="orb-element-enter" key={state} data-moment={moment?.state}>
        {renderCurrent()}
      </div>
    </div>
  );
}