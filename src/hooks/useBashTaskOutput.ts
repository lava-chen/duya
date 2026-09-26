// src/hooks/useBashTaskOutput.ts
// Poll the tail of a background bash task's output file, mirroring ZCode's
// useBackgroundBashOutput semantics: 1s cadence while the task is running,
// one final read once it ends, "follow" auto-scroll that pauses when the
// reader scrolls up and resumes when they return to the bottom.
//
// Data path: the task snapshot (bash_task:update) carries `outputFile`; the
// main process reads its tail via `bash-task:read-output`, so no worker
// round-trip is involved.

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BashBackgroundTaskSnapshot } from '@/types';

export interface UseBashTaskOutputResult {
  /** Tail of the output file, '' before the first successful read. */
  output: string;
  /** Recoverable failure description ('not found' | 'read failed' | ...). */
  error: string | null;
  /** True while the view auto-follows the tail; false when paused by scroll-up. */
  following: boolean;
  /** True until the first read settles (drives the loading state). */
  loading: boolean;
  pause: () => void;
  resume: () => void;
  /** Force an immediate re-read (retry after error). */
  refresh: () => void;
}

const POLL_INTERVAL_MS = 1000;

export function useBashTaskOutput(task: BashBackgroundTaskSnapshot | null): UseBashTaskOutputResult {
  const outputFile = task?.outputFile ?? null;
  const isRunning = task?.status === 'running';

  const [output, setOutput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // `frozen` holds the last output while following is paused, so the view
  // keeps showing a stable snapshot instead of jumping under the reader.
  const [frozen, setFrozen] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  const inFlightRef = useRef(false);
  const disposedRef = useRef(false);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  // Reset state when the target file changes (task switch). The ref skips
  // the mount pass so the poll effect below doesn't run twice on mount.
  const prevFileRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevFileRef.current === outputFile) return;
    prevFileRef.current = outputFile;
    setOutput('');
    setError(null);
    setLoading(outputFile !== null);
    setFrozen(null);
    setRevision((r) => r + 1);
  }, [outputFile]);

  const read = useCallback(async () => {
    if (!outputFile || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const result = await window.electronAPI?.bashTasks?.readOutput(outputFile);
      if (disposedRef.current) return;
      if (!result || !result.ok) {
        setError(result?.error ?? 'read failed');
        return;
      }
      setError(null);
      setOutput(result.output ?? '');
    } catch {
      if (!disposedRef.current) setError('read failed');
    } finally {
      inFlightRef.current = false;
      if (!disposedRef.current) setLoading(false);
    }
  }, [outputFile]);

  // Poll while running; a single read otherwise (and whenever the caller
  // bumps `revision` via refresh/resume).
  useEffect(() => {
    if (!outputFile) return;
    void read();
    if (!isRunning) return;

    const timer = window.setInterval(() => void read(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [outputFile, isRunning, read, revision]);

  const pause = useCallback(() => {
    setFrozen((current) => current ?? output);
  }, [output]);

  const resume = useCallback(() => {
    setFrozen(null);
    setRevision((r) => r + 1);
  }, []);

  return {
    output: frozen ?? output,
    error,
    following: frozen === null,
    loading,
    pause,
    resume,
    refresh: useCallback(() => setRevision((r) => r + 1), []),
  };
}
