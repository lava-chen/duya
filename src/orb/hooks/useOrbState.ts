/**
 * useOrbState — central state machine for Orb.
 *
 * Owns the 4-state transition logic and bridges to main process via
 * `window.electronAPI.orb.*`. IPC events from main → orb are received
 * via `onChunk` / `onShowInput` / `onShowLoading` / `onUpdateProgress`
 * / `onShowResult` / `onHide` / `onShowInputWithContext`.
 *
 * Phase A (Plan session-floater): introduces a `messages: Turn[]` array
 * alongside the legacy `result` field. The renderer still renders the
 * single-card UI; Phase B replaces that with `OrbSessionCard` and
 * consumes `messages`. `result` stays in sync for back-compat until B
 * lands.
 *
 * Plan 453 Task F.
 */
import { useState, useCallback, useEffect } from 'react';
import type {
  OrbState,
  ProgressInfo,
  ResultContent,
  Turn,
  WakeAutoContext,
} from '../types';

export interface UseOrbStateReturn {
  state: OrbState;
  progress: ProgressInfo;
  result: ResultContent | null;
  /** DORMANT 时收到结果（notify 徽标在先）；用户点球后经 openResult 清除。 */
  notified: boolean;
  /**
   * 主进程每次"开卡"事件（show-input / show-result）自增。事件驱动的
   * 解折叠信号：Windows 前台锁常使 win.focus() 抢不到焦点，靠 focus
   * 事件解折叠不可靠，卡片必须随事件本身展开。
   */
  cardSeq: number;
  /** 会话式消息流；Phase B 启用 UI 消费。 */
  messages: Turn[];
  /** Wake 自动注入的预填文本；Phase B/D 由 OrbSessionCard 消费。 */
  pendingText: string;
  setPendingText: (text: string) => void;
  /** Wake 自动注入的预填附件 data-URL 列表。 */
  pendingAttachments: string[];
  setPendingAttachments: (attachments: string[]) => void;
  /** redaction 时显示的 banner 文案；null 表示无需提示。 */
  autoInjectBanner: string | null;
  setAutoInjectBanner: (banner: string | null) => void;
  transition: (next: OrbState) => void;
  submit: (text: string, attachments?: string[]) => Promise<boolean>;
  openResult: () => Promise<void>;
  insertTab: (text: string) => Promise<void>;
  hide: () => Promise<void>;
  /** 清空 messages,orb 窗口与当前 state 不动；Phase F 触发主进程持久化。 */
  resetConversation: () => Promise<void>;
}

const DEFAULT_PROGRESS: ProgressInfo = { label: null, stage: 'thinking' };

/**
 * Generate a turn id. `crypto.randomUUID()` is the preferred path; fall back
 * to a Date+random string for environments where the WebCrypto surface is
 * missing (older jsdom, exotic test envs).
 */
function newTurnId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useOrbState(): UseOrbStateReturn {
  const [state, setState] = useState<OrbState>('DORMANT');
  const [progress, setProgress] = useState<ProgressInfo>(DEFAULT_PROGRESS);
  const [result, setResult] = useState<ResultContent | null>(null);
  const [notified, setNotified] = useState(false);
  const [cardSeq, setCardSeq] = useState(0);
  const [messages, setMessages] = useState<Turn[]>([]);
  const [pendingText, setPendingText] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<string[]>([]);
  const [autoInjectBanner, setAutoInjectBanner] = useState<string | null>(null);

  const transition = useCallback((next: OrbState) => {
    setState(next);
    if (next === 'DORMANT') {
      setProgress(DEFAULT_PROGRESS);
      setNotified(false);
    }
  }, []);

  const submit = useCallback(
    async (text: string, attachments?: string[]) => {
      // Arm the in-flight guard on the main process BEFORE the local transition
      // unmounts the focused textarea (which can fire a spurious OS blur). This
      // closes the race where a blur delivered during INPUT→LOADING would
      // otherwise collapse the box and interrupt the worker we're about to start.
      try {
        window.electronAPI?.orb?.markSubmitting?.();
      } catch {
        // main unavailable — the submit IPC handler also arms the guard
      }
      // Phase A: append user + empty assistant turns *before* IPC. The first
      // streaming chunk must find an assistant row to land in. On rejection
      // we drop both rows; on success they live until the next submit.
      const userTurn: Turn = {
        id: newTurnId(),
        role: 'user',
        text,
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
        createdAt: Date.now(),
      };
      const assistantTurn: Turn = {
        id: newTurnId(),
        role: 'assistant',
        text: '',
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, userTurn, assistantTurn]);
      transition('LOADING');
      setProgress({ label: '思考中', stage: 'thinking' });
      setResult(null);
      // Submit consumed any pre-filled context — keep the stream clean.
      setPendingText('');
      setPendingAttachments([]);
      setAutoInjectBanner(null);
      try {
        const res = await window.electronAPI?.orb?.submit(text, attachments);
        if (!res?.accepted) {
          // Drop the two optimistic turns we just appended.
          setMessages((prev) => prev.slice(0, -2));
          transition('DORMANT');
          return false;
        }
        return true;
      } catch {
        setMessages((prev) => prev.slice(0, -2));
        transition('DORMANT');
        return false;
      }
    },
    [transition],
  );

  const openResult = useCallback(async () => {
    setNotified(false);
    try {
      await window.electronAPI?.orb?.openResult?.();
    } catch {
      // main unavailable — still show the card locally
    }
    transition('RESULT');
  }, [transition]);

  const insertTab = useCallback(async (text: string) => {
    const res = await window.electronAPI?.orb?.insertTab(text);
    if (!res?.ok) {
      throw new Error(res?.reason ?? 'Insert Tab 失败');
    }
  }, []);

  const hide = useCallback(async () => {
    transition('DORMANT');
    await window.electronAPI?.orb?.collapse?.();
  }, [transition]);

  const resetConversation = useCallback(async () => {
    try {
      await window.electronAPI?.orb?.resetConversation?.();
    } catch {
      // best-effort — local clear is what the UI cares about
    }
    setMessages([]);
    setResult(null);
    setPendingText('');
    setPendingAttachments([]);
    setAutoInjectBanner(null);
  }, []);

  // Subscribe to main-driven events.
  useEffect(() => {
    const api = window.electronAPI?.orb;
    if (!api) {
      // Dev / SSR — orb is unavailable.
      return;
    }

    // Rescue sync: main may already be in INPUT/LOADING/RESULT by the time
    // this renderer mounts (first wake, or a reload mid-session). Any IPC
    // sent before these listeners existed is gone, so ask instead — but only
    // move off DORMANT, never yank the user out of a state they just entered.
    void api
      .state?.()
      .then((res) => {
        const next = res?.state as OrbState | undefined;
        if (!next) return;
        setState((current) => (current === 'DORMANT' ? next : current));
      })
      .catch(() => {
        // main unavailable — stay DORMANT
      });

    // Stream chunks: accumulate into the last assistant turn.
    let currentRaw = '';
    const unsubChunk = api.onChunk((chunk) => {
      currentRaw += chunk.delta;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (!last || last.role !== 'assistant') return prev;
        return [...prev.slice(0, -1), { ...last, text: currentRaw }];
      });
      setResult((prev) =>
        prev
          ? { ...prev, rawText: currentRaw }
          : { rawText: currentRaw, turnId: chunk.turnId },
      );
    });

    const unsubShowInput = api.onShowInput(() => {
      transition('INPUT');
      setCardSeq((n) => n + 1);
    });

    // Hotkey wake auto-injection. Phase A only seeds the bridge state;
    // Phase B/D wires the input row to consume it.
    const unsubShowInputWithContext = api.onShowInputWithContext?.((payload) => {
      transition('INPUT');
      setCardSeq((n) => n + 1);
      if (payload.redacted) {
        setAutoInjectBanner('当前焦点被遮蔽，未注入上下文');
        setPendingText('');
        setPendingAttachments([]);
      } else {
        setAutoInjectBanner(null);
        setPendingText(payload.contextText ?? '');
        setPendingAttachments(
          payload.screenshotBase64
            ? [`data:image/png;base64,${payload.screenshotBase64}`]
            : [],
        );
      }
    });

    const unsubShowLoading = api.onShowLoading((payload) => {
      transition('LOADING');
      setProgress({
        label: '思考中',
        stage: payload.stage as ProgressInfo['stage'],
      });
    });

    const unsubUpdateProgress = api.onUpdateProgress((payload) => {
      setProgress({
        label: payload.label,
        stage: payload.stage as ProgressInfo['stage'],
      });
    });

    const unsubShowResult = api.onShowResult((payload) => {
      currentRaw = payload.text;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (!last || last.role !== 'assistant') return prev;
        return [
          ...prev.slice(0, -1),
          { ...last, text: payload.text, finishedAt: Date.now() },
        ];
      });
      setResult({
        rawText: payload.text,
        turnId: payload.turnId,
      });
      transition('RESULT');
      setCardSeq((n) => n + 1);
    });

    const unsubNotifyResult = api.onNotifyResult?.((payload) => {
      // Result arrived while parked in DORMANT: store it, badge the ball.
      // The card opens when the user clicks (openResult).
      currentRaw = payload.text;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'assistant' && !last.finishedAt) {
          return [
            ...prev.slice(0, -1),
            { ...last, text: payload.text, finishedAt: Date.now() },
          ];
        }
        return [
          ...prev,
          {
            id: newTurnId(),
            role: 'assistant',
            text: payload.text,
            createdAt: Date.now(),
            finishedAt: Date.now(),
          },
        ];
      });
      setResult({
        rawText: payload.text,
        turnId: payload.turnId,
      });
      setNotified(true);
    });

    const unsubHide = api.onHide(() => {
      transition('DORMANT');
    });

    // Focus resync: the wake hotkey shows/focuses the window without any
    // in-window event, and messages sent while this renderer was reloading
    // are gone. Re-ask main for the authoritative state — same rescue
    // semantics as the mount sync (never yank the user out of a live state).
    const onWindowFocus = () => {
      void api
        .state?.()
        .then((res) => {
          const next = res?.state as OrbState | undefined;
          if (!next) return;
          setState((current) => (current === 'DORMANT' ? next : current));
        })
        .catch(() => {
          // main unavailable — keep current state
        });
    };
    window.addEventListener('focus', onWindowFocus);

    return () => {
      unsubChunk();
      unsubShowInput();
      unsubShowInputWithContext?.();
      unsubShowLoading();
      unsubUpdateProgress();
      unsubShowResult();
      unsubNotifyResult?.();
      unsubHide();
      window.removeEventListener('focus', onWindowFocus);
    };
  }, [transition]);

  // Event-loss convergence: messages sent while the orb renderer was
  // reloading are gone, and Windows' foreground lock makes focus-based
  // rescue unreliable. While DORMANT, poll main's state (150ms — same
  // order as the 40ms pointer poll) so a wake is never missed.
  useEffect(() => {
    if (state !== 'DORMANT') return;
    const timer = window.setInterval(() => {
      void window.electronAPI?.orb
        ?.state?.()
        .then((res) => {
          const next = res?.state as OrbState | undefined;
          if (next && next !== 'DORMANT') {
            setState((current) => (current === 'DORMANT' ? next : current));
          }
        })
        .catch(() => {
          // main unavailable — stay DORMANT
        });
    }, 150);
    return () => window.clearInterval(timer);
  }, [state]);

  return {
    state,
    progress,
    result,
    notified,
    cardSeq,
    messages,
    pendingText,
    setPendingText,
    pendingAttachments,
    setPendingAttachments,
    autoInjectBanner,
    setAutoInjectBanner,
    transition,
    submit,
    openResult,
    insertTab,
    hide,
    resetConversation,
  };
}