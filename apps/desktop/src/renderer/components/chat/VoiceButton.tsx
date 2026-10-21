// apps/desktop/src/renderer/components/chat/VoiceButton.tsx — push-to-talk mic button.
//
// Press-and-hold to record: on pointer down it starts the mic + STT chain,
// on release it finalizes. Interim/final text is handed back via
// `onTranscription`; `onSessionStart` fires when recording actually begins so
// the host can snapshot the base text for append-style dictation. Degrades
// to a no-op dimension when voice is unsupported.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useVoiceInput } from '@/lib/voice/useVoiceInput';
import { IconButton } from '@/components/ui/IconButton';

export interface VoiceButtonProps {
  onTranscription: (text: string, kind: 'interim' | 'final') => void;
  disabled?: boolean;
  /** Called when the STT environment is not ready (model_not_ready). */
  onNeedsSetup?: () => void;
  /** Called once per dictation session when recording actually starts. */
  onSessionStart?: () => void;
  /** Called when a dictation session fully ends (recording released and
   *  the final transcript committed) so the host can restore its layout. */
  onSessionEnd?: () => void;
}

/**
 * Whether the STT module is configured AND ready (`enabled` + model
 * downloaded). Drives the composer's voice/send button swap: the mic only
 * earns the send-button slot when dictation is actually usable — the
 * `window.electronAPI.voice` bridge existing (what `useVoiceInput` calls
 * "supported") is not enough. Re-checks on window focus so enabling voice
 * in Settings is picked up without a composer remount.
 */
export function useVoiceConfigured(): boolean {
  const [configured, setConfigured] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const api =
        typeof window !== 'undefined' ? window.electronAPI?.voice : undefined;
      if (!api?.getConfig) {
        setConfigured(false);
        return;
      }
      try {
        const cfg = await api.getConfig();
        if (!cancelled) setConfigured(Boolean(cfg?.enabled && cfg?.modelReady));
      } catch {
        if (!cancelled) setConfigured(false);
      }
    };
    void check();
    window.addEventListener('focus', check);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', check);
    };
  }, []);
  return configured;
}

export function VoiceButton({
  onTranscription,
  disabled,
  onNeedsSetup,
  onSessionStart,
  onSessionEnd,
}: VoiceButtonProps) {
  const { status, supported, errorCode, errorMessage, start, stop, cancel } = useVoiceInput({
    onText: onTranscription,
    onNeedsSetup,
  });

  const onSessionStartRef = useRef(onSessionStart);
  onSessionStartRef.current = onSessionStart;

  useEffect(() => {
    if (status === 'recording') onSessionStartRef.current?.();
  }, [status]);

  // Session end: the status leaving the active set means the utterance is
  // fully done (final text committed) or aborted — either way the host
  // should stop treating the composer as "dictating".
  const sessionEndRef = useRef(onSessionEnd);
  sessionEndRef.current = onSessionEnd;
  const sessionActiveRef = useRef(false);
  useEffect(() => {
    const active =
      status === 'recording' ||
      status === 'permission-pending' ||
      status === 'transcribing';
    if (sessionActiveRef.current && !active) sessionEndRef.current?.();
    sessionActiveRef.current = active;
  }, [status]);

  const recording = status === 'recording' || status === 'permission-pending';
  const activeRef = useRef(false);

  const handlePointerDown = useCallback(async (e: React.PointerEvent) => {
    if (disabled || !supported) return;
    e.preventDefault();
    activeRef.current = true;
    await start();
    // If start failed (e.g. permission), don't keep waiting for pointer-up.
    if (!activeRef.current) return;
  }, [disabled, supported, start]);

  const handlePointerUp = useCallback(async (e: React.PointerEvent) => {
    if (disabled || !supported) return;
    e.preventDefault();
    activeRef.current = false;
    if (status === 'recording') await stop();
  }, [disabled, supported, status, stop]);

  const handlePointerLeave = useCallback(async () => {
    if (activeRef.current) {
      activeRef.current = false;
      if (status === 'recording') await cancel();
    }
  }, [status, cancel]);

  const title = status === 'error'
    ? `语音输入：${errorMessage ?? '发生错误'}`
    : status === 'permission-pending'
      ? '正在请求麦克风权限…'
      : status === 'transcribing'
        ? '正在转写…'
        : status === 'recording'
          ? '松开结束听写'
          : '按住说话，松开转文字';

  // Same solid-disc treatment as the Send button this slot replaces
  // (round/md, `ml-1` spacing included): swapping mic ↔ send must read as
  // "only the icon changed", so idle matches the send fill and the active
  // states tint the same disc.
  const stateClass =
    'ml-1 ' +
    (status === 'error'
      ? 'bg-destructive/15 text-destructive hover:bg-destructive/25'
      : status === 'transcribing'
        ? 'bg-[var(--accent)]/25 text-[var(--accent)] animate-pulse'
        : recording
          ? 'bg-red-500 text-white hover:bg-red-500/90'
          : 'bg-[var(--send-btn)] text-white hover:bg-[var(--send-btn-hover)]');

  return (
    <IconButton
      variant="primary"
      shape="round"
      size="md"
      aria-label="语音输入"
      title={title}
      disabled={disabled || !supported}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onPointerCancel={handlePointerLeave}
      className={stateClass}
    >
      <MicIcon active={recording} error={status === 'error'} />
    </IconButton>
  );
}

function MicIcon({ active, error }: { active: boolean; error?: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {error && <line x1="3" y1="3" x2="21" y2="21" />}
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
      {active && <circle cx="12" cy="12" r="9" className="animate-ping" opacity="0.3" />}
    </svg>
  );
}
