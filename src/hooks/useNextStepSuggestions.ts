/**
 * useNextStepSuggestions - end-of-turn follow-up suggestions.
 *
 * When the agent turn finishes (isStreaming transitions true → false),
 * ask the main process to predict 3 plausible follow-up prompts for the
 * session. The result renders as cards at the end of the message list;
 * clicking one prefills the input box via `dispatchPrefillChatInput`.
 *
 * Lifecycle rules:
 * - A new streaming turn (false → true) clears current suggestions.
 * - Switching sessions clears immediately and invalidates in-flight
 *   requests so a slow response can never land on the wrong session.
 * - `dismiss()` is called after a card click or whenever the host view
 *   wants the cards gone.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseNextStepSuggestionsResult {
  suggestions: string[];
  isLoading: boolean;
  dismiss: () => void;
}

export function useNextStepSuggestions(options: {
  sessionId?: string;
  isStreaming: boolean;
}): UseNextStepSuggestionsResult {
  const { sessionId, isStreaming } = options;
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const prevStreamingRef = useRef(false);
  // Monotonic sequence — bumping it invalidates any in-flight request.
  const requestSeqRef = useRef(0);

  // Session switch: drop stale state at once.
  useEffect(() => {
    requestSeqRef.current += 1;
    setSuggestions([]);
    setIsLoading(false);
    prevStreamingRef.current = false;
  }, [sessionId]);

  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;

    // A new turn started (or we are mid-stream) — clear previous cards.
    if (isStreaming) {
      requestSeqRef.current += 1;
      setSuggestions([]);
      setIsLoading(false);
      return;
    }

    // Only fire on the active → idle transition, not on initial mount.
    if (!wasStreaming || !sessionId) return;

    // Guard the API lookup separately: optional chaining alone would leave
    // `.then()` called on undefined in browser-only (non-Electron) runs.
    const api = window.electronAPI?.nextSteps;
    if (!api) return;

    const seq = ++requestSeqRef.current;
    setIsLoading(true);
    api
      .request(sessionId)
      .then((res) => {
        if (seq !== requestSeqRef.current) return;
        const list = res?.success ? (res.suggestions ?? []) : [];
        setSuggestions(list.filter(Boolean).slice(0, 3));
      })
      .catch(() => {
        if (seq === requestSeqRef.current) setSuggestions([]);
      })
      .finally(() => {
        if (seq === requestSeqRef.current) setIsLoading(false);
      });
  }, [isStreaming, sessionId]);

  const dismiss = useCallback(() => {
    requestSeqRef.current += 1;
    setSuggestions([]);
    setIsLoading(false);
  }, []);

  return { suggestions, isLoading, dismiss };
}
