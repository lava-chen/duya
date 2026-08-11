// src/components/chat/VoiceButton.tsx — push-to-talk mic button.
//
// Press-and-hold to record: on pointer down it starts the mic + STT chain,
// on release it finalizes. Interim/final text is handed back via
// `onTranscription` (MessageInput wires it to setInputValue). Degrades to a
// no-op dimension when voice is unsupported or the model is not ready.
import React, { useCallback, useRef } from 'react';
import { useVoiceInput } from '@/lib/voice/useVoiceInput';
import { IconButton } from '@/components/ui/IconButton';

export interface VoiceButtonProps {
  onTranscription: (text: string, kind: 'interim' | 'final') => void;
  disabled?: boolean;
  /** Called when the STT environment is not ready (model_not_ready). */
  onNeedsSetup?: () => void;
}

export function VoiceButton({ onTranscription, disabled, onNeedsSetup }: VoiceButtonProps) {
  const { status, supported, errorCode, errorMessage, start, stop, cancel } = useVoiceInput({
    onText: onTranscription,
    onNeedsSetup,
  });

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
    if (recording) await stop();
  }, [disabled, supported, recording, stop]);

  const handlePointerLeave = useCallback(async () => {
    if (activeRef.current) {
      activeRef.current = false;
      if (recording) await cancel();
    }
  }, [recording, cancel]);

  const title = errorCode === 'model_not_ready'
    ? `Voice: STT model not ready (${errorMessage ?? 'run voice setup'})`
    : errorCode === 'permission_denied'
      ? `Voice: microphone permission required`
      : recording
        ? 'Release to finish dictation'
        : 'Press and hold to dictate';

  return (
    <IconButton
      variant="ghost"
      shape="round"
      size="md"
      aria-label="Voice input"
      title={title}
      disabled={disabled || !supported}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onPointerCancel={handlePointerLeave}
      className={recording
        ? 'text-red-400 bg-red-500/20 hover:bg-red-500/30'
        : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'}
    >
      <MicIcon active={recording} />
    </IconButton>
  );
}

function MicIcon({ active }: { active: boolean }) {
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
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
      {active && <circle cx="12" cy="12" r="9" className="animate-ping" opacity="0.3" />}
    </svg>
  );
}