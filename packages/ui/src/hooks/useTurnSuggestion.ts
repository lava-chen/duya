/**
 * useTurnSuggestion - the next prompt the worker predicted for the last turn.
 *
 * When a turn finishes (the streaming flag falls), the surface reads the
 * suggestion the worker wrote for that turn. The write lands AFTER the turn
 * ended (the worker predicts it with one extra model call), so the read is a
 * short poll rather than a single fetch: the row is accepted only once it is
 * fresh enough to belong to the turn that just ended.
 *
 * Lifecycle rules:
 * - A new turn clears the suggestion and stops the poll.
 * - Switching sessions clears it at once and invalidates the in-flight read.
 * - `dismiss()` hides it without sending anything.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { readLatestTurnSuggestion } from '@/lib/turn-suggestion-client';

/** How often the surface looks for the row the worker is still writing. */
const POLL_INTERVAL_MS = 1_500;
/** How long the surface keeps looking before it gives up on this turn. */
const POLL_TIMEOUT_MS = 15_000;
/**
 * How much clock difference is tolerated when deciding whether a row belongs
 * to the turn that just ended. The row is written after the turn ends, so the
 * tolerance only has to absorb the worker's write latency.
 */
const FRESHNESS_TOLERANCE_MS = 1_500;

export interface UseTurnSuggestionResult {
  /** The suggested next prompt, or null when there is none. */
  suggestion: string | null;
  isLoading: boolean;
  dismiss: () => void;
}

export function useTurnSuggestion(options: {
  sessionId?: string;
  isStreaming: boolean;
}): UseTurnSuggestionResult {
  const { sessionId, isStreaming } = options;
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const prevStreamingRef = useRef(false);
  // Monotonic sequence — bumping it invalidates any in-flight read.
  const requestSeqRef = useRef(0);

  // Session switch: drop stale state at once.
  useEffect(() => {
    requestSeqRef.current += 1;
    setSuggestion(null);
    setIsLoading(false);
    prevStreamingRef.current = false;
  }, [sessionId]);

  // Unmount: stop the poll. A read that lands after the surface is gone must
  // not keep the loop alive for the rest of its window.
  useEffect(() => () => {
    requestSeqRef.current += 1;
  }, []);

  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;

    // A new turn started (or we are mid-stream) — the previous suggestion is
    // about a turn that is over.
    if (isStreaming) {
      requestSeqRef.current += 1;
      setSuggestion(null);
      setIsLoading(false);
      return;
    }

    // Only fire on the active → idle transition, not on initial mount.
    if (!wasStreaming || !sessionId) return;

    const seq = ++requestSeqRef.current;
    const turnEndedAt = Date.now();
    setIsLoading(true);

    const poll = async (): Promise<void> => {
      const deadline = turnEndedAt + POLL_TIMEOUT_MS;
      while (seq === requestSeqRef.current && Date.now() < deadline) {
        try {
          const record = await readLatestTurnSuggestion(sessionId);
          if (seq !== requestSeqRef.current) return;
          if (record && record.createdAt >= turnEndedAt - FRESHNESS_TOLERANCE_MS) {
            // The row belongs to this turn: an empty suggestion means the
            // worker had nothing to offer, which is a final answer.
            setSuggestion(record.suggestion.trim().length > 0 ? record.suggestion : null);
            setIsLoading(false);
            return;
          }
        } catch {
          // A failed read is not a failed feature: the next attempt may work.
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      if (seq === requestSeqRef.current) setIsLoading(false);
    };

    void poll();
  }, [isStreaming, sessionId]);

  const dismiss = useCallback(() => {
    requestSeqRef.current += 1;
    setSuggestion(null);
    setIsLoading(false);
  }, []);

  return { suggestion, isLoading, dismiss };
}
