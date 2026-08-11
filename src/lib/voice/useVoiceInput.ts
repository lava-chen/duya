// src/lib/voice/useVoiceInput.ts — hook that drives the push-to-talk flow:
//   started → mic capture → stream chunks to Main STT → interim/final text
//   injected via onText callbacks. Handles permission, model-not-ready, and
//   no-speech cancellation gracefully.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceStatus, VoiceErrorCode } from './types';

export interface UseVoiceInputOptions {
  /** Called with interim text (and later the final result). */
  onText: (text: string, kind: 'interim' | 'final') => void;
  /** Called when the utterance is cancelled (no speech / user cancel). */
  onCancelled?: (reason: string) => void;
}

export interface UseVoiceInputResult {
  status: VoiceStatus;
  supported: boolean;
  errorCode: VoiceErrorCode | null;
  errorMessage: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
}

export function useVoiceInput({ onText, onCancelled }: UseVoiceInputOptions): UseVoiceInputResult {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [errorCode, setErrorCode] = useState<VoiceErrorCode | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const onTextRef = useRef(onText);
  const onCancelledRef = useRef(onCancelled);
  onTextRef.current = onText;
  onCancelledRef.current = onCancelled;

  const captureRef = useRef<import('./voice-capture').VoiceCapture | null>(null);
  const statusRef = useRef<VoiceStatus>('idle');
  statusRef.current = status;

  const apiSupported = typeof window !== 'undefined' && !!window.electronAPI?.voice;

  const setStatusSafe = useCallback((s: VoiceStatus) => setStatus(s), []);

  // Subscribe to Main-driven STT events once.
  useEffect(() => {
    if (!apiSupported) return;
    const api = window.electronAPI.voice;
    const unsubInterim = api.onInterim((d) => onTextRef.current(d.text, 'interim'));
    const unsubFinal = api.onFinal((d) => onTextRef.current(d.text, 'final'));
    const unsubError = api.onError((d) => {
      setErrorCode(d.code as VoiceErrorCode);
      setErrorMessage(d.message);
      setStatusSafe('error');
    });
    const unsubCancelled = api.onCancelled((d) => {
      onCancelledRef.current?.(d.reason);
      setStatusSafe('idle');
    });
    const unsubAutoStop = api.onAutoStop((d) => {
      if (d.reason === 'finalize') {
        // Main already finalized the utterance; final text arrives via onFinal.
        captureRef.current?.stop();
        captureRef.current = null;
        if (statusRef.current === 'recording') setStatusSafe('idle');
      } else {
        captureRef.current?.stop();
        captureRef.current = null;
        onCancelledRef.current?.('no_speech');
        setStatusSafe('idle');
      }
    });
    return () => {
      unsubInterim();
      unsubFinal();
      unsubError();
      unsubCancelled();
      unsubAutoStop();
    };
  }, [apiSupported, setStatusSafe]);

  const start = useCallback(async () => {
    if (!apiSupported || statusRef.current === 'recording') return;

    // Ensure the model/binary is ready before grabbing the mic.
    const cfg = await window.electronAPI.voice.getConfig();
    if (!cfg.modelReady) {
      setErrorCode('model_not_ready');
      setErrorMessage(`STT model not ready: ${cfg.model}`);
      setStatusSafe('error');
      return;
    }

    const { AudioWorkletVoiceCapture } = await import('./voice-capture');
    const capture = new AudioWorkletVoiceCapture();
    captureRef.current = capture;

    setErrorCode(null);
    setErrorMessage(null);
    setStatusSafe('permission-pending');

    const ok = await capture.start();
    if (!ok) {
      setErrorCode('permission_denied');
      setErrorMessage('Microphone permission denied or unavailable');
      setStatusSafe('error');
      return;
    }

    capture.setCallbacks({
      onChunk: (chunk) => {
        void window.electronAPI.voice.transcribeChunk(chunk);
      },
      onError: (message) => {
        setStatusSafe('error');
        setErrorMessage(message);
      },
    });

    const started = await window.electronAPI.voice.start();
    if (!started.ok) {
      setErrorCode((started.error as VoiceErrorCode) ?? 'internal');
      setErrorMessage(started.message ?? started.error ?? 'failed to start STT');
      setStatusSafe('error');
      capture.stop();
      captureRef.current = null;
      return;
    }

    setStatusSafe('recording');
  }, [apiSupported, setStatusSafe]);

  const stop = useCallback(async () => {
    if (statusRef.current !== 'recording') return;
    setStatusSafe('transcribing');
    await window.electronAPI.voice.stop();
    captureRef.current?.stop();
    captureRef.current = null;
    setStatusSafe('idle');
  }, [setStatusSafe]);

  const cancel = useCallback(async () => {
    if (statusRef.current !== 'recording' && statusRef.current !== 'transcribing') return;
    await window.electronAPI.voice.cancel();
    captureRef.current?.stop();
    captureRef.current = null;
    onCancelledRef.current?.('user_cancelled');
    setStatusSafe('idle');
  }, [setStatusSafe]);

  return { status, supported: apiSupported, errorCode, errorMessage, start, stop, cancel };
}