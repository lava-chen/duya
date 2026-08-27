/**
 * useOrbState — central state machine for Orb.
 *
 * Owns the 4-state transition logic and bridges to main process via
 * `window.electronAPI.orb.*`. IPC events from main → orb are received
 * via `onChunk` / `onShowInput` / `onShowLoading` / `onUpdateProgress`
 * / `onShowResult` / `onHide`.
 *
 * Plan 453 Task F.
 */
import { useState, useCallback, useEffect } from 'react';
import type { OrbState, ProgressInfo, ResultContent } from '../types';

export interface UseOrbStateReturn {
  state: OrbState;
  progress: ProgressInfo;
  result: ResultContent | null;
  transition: (next: OrbState) => void;
  submit: (text: string, attachments?: string[]) => Promise<void>;
  insertTab: (text: string) => Promise<void>;
  hide: () => Promise<void>;
}

const DEFAULT_PROGRESS: ProgressInfo = { label: null, stage: 'thinking' };

export function useOrbState(): UseOrbStateReturn {
  const [state, setState] = useState<OrbState>('DORMANT');
  const [progress, setProgress] = useState<ProgressInfo>(DEFAULT_PROGRESS);
  const [result, setResult] = useState<ResultContent | null>(null);

  const transition = useCallback((next: OrbState) => {
    setState(next);
    if (next === 'DORMANT') {
      setProgress(DEFAULT_PROGRESS);
    }
  }, []);

  const submit = useCallback(
    async (text: string, _attachments?: string[]) => {
      transition('LOADING');
      setProgress({ label: '思考中', stage: 'thinking' });
      setResult(null);
      try {
        // attachments ignored for now; Task F wires attachment IPC if needed
        const res = await window.electronAPI?.orb?.submit(text);
        if (!res?.accepted) {
          transition('DORMANT');
        }
      } catch {
        transition('DORMANT');
      }
    },
    [transition],
  );

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

  // Subscribe to main-driven events.
  useEffect(() => {
    const api = window.electronAPI?.orb;
    if (!api) {
      // Dev / SSR — orb is unavailable.
      return;
    }

    // Stream chunks: accumulate rawText (current chunk delta = text body).
    let currentRaw = '';
    const unsubChunk = api.onChunk((chunk) => {
      currentRaw += chunk.delta;
      setResult((prev) =>
        prev
          ? { ...prev, rawText: currentRaw }
          : { rawText: currentRaw, turnId: chunk.turnId },
      );
    });

    const unsubShowInput = api.onShowInput(() => {
      transition('INPUT');
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
      setResult({
        rawText: payload.text,
        turnId: payload.turnId,
      });
      currentRaw = payload.text;
      transition('RESULT');
    });

    const unsubHide = api.onHide(() => {
      transition('DORMANT');
    });

    return () => {
      unsubChunk();
      unsubShowInput();
      unsubShowLoading();
      unsubUpdateProgress();
      unsubShowResult();
      unsubHide();
    };
  }, [transition]);

  return { state, progress, result, transition, submit, insertTab, hide };
}