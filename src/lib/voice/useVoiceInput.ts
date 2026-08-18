// src/lib/voice/useVoiceInput.ts — hook that drives the push-to-talk flow:
//   started → mic capture → stream chunks to Main STT → interim/final text
//   injected via onText callbacks. Handles permission, device selection,
//   model-not-ready, and no-speech cancellation gracefully.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceStatus, VoiceErrorCode } from './types';
import { describeStartError } from './errors';

export interface UseVoiceInputOptions {
  /** Called with interim text (and later the final result). */
  onText: (text: string, kind: 'interim' | 'final') => void;
  /** Called when the utterance is cancelled (no speech / user cancel). */
  onCancelled?: (reason: string) => void;
  /**
   * Called when the STT environment is not ready (disabled / model_not_ready)
   * and the user taps the mic. Lets the UI auto-inject a setup-guide message
   * so the agent configures whisper via the `voice-setup` skill. Fired per
   * attempt; the caller is responsible for de-duplication.
   */
  onNeedsSetup?: () => void;
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

export function useVoiceInput({ onText, onCancelled, onNeedsSetup }: UseVoiceInputOptions): UseVoiceInputResult {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [errorCode, setErrorCode] = useState<VoiceErrorCode | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const onTextRef = useRef(onText);
  const onCancelledRef = useRef(onCancelled);
  const onNeedsSetupRef = useRef(onNeedsSetup);
  onTextRef.current = onText;
  onCancelledRef.current = onCancelled;
  onNeedsSetupRef.current = onNeedsSetup;

  const captureRef = useRef<import('./voice-capture').VoiceCapture | null>(null);
  const statusRef = useRef<VoiceStatus>('idle');
  statusRef.current = status;
  const startInFlightRef = useRef(false);
  const stopRequestedRef = useRef(false);

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
    const unsubCancelled = api.onCancelled(() => {
      onCancelledRef.current?.('user_cancelled');
      setStatusSafe('idle');
    });
    const unsubAutoStop = api.onAutoStop((d) => {
      captureRef.current?.stop();
      captureRef.current = null;
      if (d.reason === 'finalize') {
        // Main already finalized the utterance; final text arrives via onFinal.
        if (statusRef.current === 'recording') setStatusSafe('idle');
      } else {
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
    if (!apiSupported || statusRef.current === 'recording' || startInFlightRef.current) return;
    startInFlightRef.current = true;
    stopRequestedRef.current = false;
    try {
      // Ensure voice is enabled and the model/binary is ready before
      // grabbing the mic.
      const cfg = await window.electronAPI.voice.getConfig();
      if (!cfg.enabled || !cfg.modelReady) {
        setErrorCode(!cfg.enabled ? 'model_not_ready' : 'model_not_ready');
        setErrorMessage(
          !cfg.enabled
            ? '语音输入未启用：请在 设置 → 语音输入 中开启，或让 DUYA 自动配置'
            : `语音模型未就绪：${cfg.model}（可在设置中一键安装）`,
        );
        setStatusSafe('error');
        // Notify the UI that the environment needs setup so it can
        // auto-inject a guide message (Phase 3 of Plan 411).
        onNeedsSetupRef.current?.();
        return;
      }

      const { AudioWorkletVoiceCapture } = await import('./voice-capture');
      const capture = new AudioWorkletVoiceCapture();
      captureRef.current = capture;

      setErrorCode(null);
      setErrorMessage(null);
      setStatusSafe('permission-pending');

      // One bounded PCM block per chunkMs; keeps the IPC invoke rate at
      // ~5/s instead of one per render quantum.
      const blockSamples = Math.max(160, Math.round((16000 * cfg.chunkMs) / 1000));
      const started = await capture.start({
        deviceId: cfg.inputDevice || undefined,
        blockSamples,
      });
      if (!started.ok) {
        setErrorCode('permission_denied');
        setErrorMessage(started.message ?? '无法访问麦克风');
        setStatusSafe('error');
        capture.stop();
        captureRef.current = null;
        return;
      }

      // The button was released while permission/start was pending.
      if (stopRequestedRef.current) {
        capture.stop();
        captureRef.current = null;
        setStatusSafe('idle');
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

      const res = await window.electronAPI.voice.start();
      if (!res.ok) {
        const { code, message } = describeStartError(res.error, res.message);
        setErrorCode(code);
        setErrorMessage(message);
        setStatusSafe('error');
        capture.stop();
        captureRef.current = null;
        if (res.error === 'model_not_ready') onNeedsSetupRef.current?.();
        return;
      }

      // Released while the STT worker was starting.
      if (stopRequestedRef.current) {
        await window.electronAPI.voice.stop();
        capture.stop();
        captureRef.current = null;
        setStatusSafe('idle');
        return;
      }

      setStatusSafe('recording');
    } finally {
      startInFlightRef.current = false;
    }
  }, [apiSupported, setStatusSafe]);

  const stop = useCallback(async () => {
    if (statusRef.current === 'recording') {
      setStatusSafe('transcribing');
      await window.electronAPI.voice.stop();
      captureRef.current?.stop();
      captureRef.current = null;
      setStatusSafe('idle');
      return;
    }
    // Still starting (permission / worker spawn): remember the release and
    // let the in-flight start() unwind as soon as it is ready.
    if (startInFlightRef.current) {
      stopRequestedRef.current = true;
    }
  }, [apiSupported, setStatusSafe]);

  const cancel = useCallback(async () => {
    if (statusRef.current !== 'recording' && statusRef.current !== 'transcribing') {
      if (startInFlightRef.current) stopRequestedRef.current = true;
      return;
    }
    // Main emits `voice:cancelled` which resets the status via the event.
    await window.electronAPI.voice.cancel();
    captureRef.current?.stop();
    captureRef.current = null;
    setStatusSafe('idle');
  }, [apiSupported, setStatusSafe]);

  return { status, supported: apiSupported, errorCode, errorMessage, start, stop, cancel };
}
