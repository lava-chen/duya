/**
 * Plan 491 P1.1: Bot send phase hook.
 *
 * Tracks the send phase for a bot session.
 * Used by BotDirectChatView to show send state (sending/sent/failed/queued).
 */

import { useState, useCallback } from 'react';
import type { MessageDelivery } from '@/types/message';
import { useConversationStore } from '@/stores/conversation-store';

export interface BotSendPhaseState {
  /** The current delivery phase of the last sent message */
  phase: MessageDelivery | null;
  /** Message ID of the last sent message */
  lastMessageId: string | null;
}

/**
 * useBotSendPhase — React hook for tracking bot send phase.
 *
 * Manages the send phase state for a bot session and provides
 * methods to update the phase.
 */
export function useBotSendPhase(sessionId: string) {
  const [phase, setPhase] = useState<MessageDelivery | null>(null);
  const [lastMessageId, setLastMessageId] = useState<string | null>(null);
  const setMessageDelivery = useConversationStore((s) => s.setMessageDelivery);
  const getMessageDelivery = useConversationStore((s) => s.getMessageDelivery);

  /**
   * Start sending a message - set phase to 'sending'.
   */
  const startSending = useCallback(
    (messageId: string) => {
      setPhase('sending');
      setLastMessageId(messageId);
      setMessageDelivery(sessionId, messageId, 'sending');
    },
    [sessionId, setMessageDelivery],
  );

  /**
   * Mark message as queued.
   */
  const markQueued = useCallback(
    (messageId: string) => {
      setPhase('queued');
      setLastMessageId(messageId);
      setMessageDelivery(sessionId, messageId, 'queued');
    },
    [sessionId, setMessageDelivery],
  );

  /**
   * Mark message as sent (received db_persisted ack).
   */
  const markSent = useCallback(
    (messageId: string) => {
      setPhase('sent');
      setLastMessageId(messageId);
      setMessageDelivery(sessionId, messageId, 'sent');
    },
    [sessionId, setMessageDelivery],
  );

  /**
   * Mark message as failed.
   */
  const markFailed = useCallback(
    (messageId: string) => {
      setPhase('failed');
      setLastMessageId(messageId);
      setMessageDelivery(sessionId, messageId, 'failed');
    },
    [sessionId, setMessageDelivery],
  );

  /**
   * Reset to idle.
   */
  const reset = useCallback(() => {
    setPhase(null);
    setLastMessageId(null);
  }, []);

  return {
    phase,
    lastMessageId,
    startSending,
    markQueued,
    markSent,
    markFailed,
    reset,
  };
}
