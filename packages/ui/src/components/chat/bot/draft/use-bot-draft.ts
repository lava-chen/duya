/**
 * Plan 491 P2.1: Bot draft hook.
 *
 * Provides draft state for a given botId, persisted to localStorage.
 * Restores draft when switching back to a bot.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  loadBotDraft,
  saveBotDraft,
  clearBotDraft,
  type BotDraft,
} from './draft-state';

export interface UseBotDraftResult {
  /** Current draft text */
  draft: string;
  /** Set draft text (saves to localStorage) */
  setDraft: (text: string) => void;
  /** Clear draft (removes from localStorage) */
  clearDraft: () => void;
  /** Last updated timestamp */
  updatedAt: number | null;
}

/**
 * useBotDraft — hook for managing bot composer draft persistence.
 *
 * Loads draft from localStorage on mount, saves on every change,
 * clears on explicit clear or send.
 */
export function useBotDraft(botId: string | null): UseBotDraftResult {
  const [draft, setDraftState] = useState<string>('');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  // Load draft from localStorage when botId changes
  useEffect(() => {
    if (!botId) {
      setDraftState('');
      setUpdatedAt(null);
      return;
    }

    const saved = loadBotDraft(botId);
    if (saved) {
      setDraftState(saved.text);
      setUpdatedAt(saved.updatedAt);
    } else {
      setDraftState('');
      setUpdatedAt(null);
    }
  }, [botId]);

  // Save draft to localStorage whenever it changes
  const setDraft = useCallback(
    (text: string) => {
      setDraftState(text);
      if (botId) {
        saveBotDraft(botId, text);
        setUpdatedAt(Date.now());
      }
    },
    [botId],
  );

  // Clear draft from localStorage
  const clearDraft = useCallback(() => {
    setDraftState('');
    setUpdatedAt(null);
    if (botId) {
      clearBotDraft(botId);
    }
  }, [botId]);

  return { draft, setDraft, clearDraft, updatedAt };
}
