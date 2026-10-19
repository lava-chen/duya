/**
 * Plan 491 P1.1: botDirectSend — self-contained send pipeline for bot-direct messages.
 *
 * Features:
 * - Phase machine integration (P0.1 delivery states)
 * - Nonce deduplication (content hash + time window)
 * - Busy-time strategy (queue vs preempt)
 *
 * The actual send is delegated to the provided sendFn callback.
 */

import { nonceDedup } from './nonce';
import { preemptionManager } from './preemption';

export interface BotDirectSendOptions {
  /** Session ID for the bot conversation */
  sessionId: string;
  /** Message content */
  content: string;
  /** Callback to actually send the message */
  sendFn: (messageId: string, content: string) => void | Promise<void>;
  /** Callback when phase changes to 'queued' */
  onQueued?: (messageId: string) => void;
  /** Callback when phase changes to 'sent' */
  onSent?: (messageId: string) => void;
  /** Callback when phase changes to 'failed' */
  onFailed?: (messageId: string, error?: Error) => void;
  /** Preemption strategy: 'queue' (default) or 'preempt' */
  strategy?: 'queue' | 'preempt';
}

export interface BotDirectSendResult {
  messageId: string;
  phase: 'sending' | 'queued' | 'sent' | 'failed';
}

/**
 * botDirectSend — Send a message through the bot-direct pipeline.
 *
 * Manages:
 * 1. Nonce deduplication
 * 2. Preemption strategy (queue vs preempt)
 * 3. Phase machine (sending -> sent/failed/queued)
 *
 * Returns immediately with the message ID and initial phase.
 * Phase transitions are reported via callbacks.
 */
export async function botDirectSend(
  options: BotDirectSendOptions,
): Promise<BotDirectSendResult> {
  const {
    sessionId,
    content,
    sendFn,
    onQueued,
    onSent,
    onFailed,
    strategy = 'queue',
  } = options;

  // Generate nonce for deduplication
  const nonce = nonceDedup.generateNonce(content);

  // Check for duplicate message
  const existingMessageId = nonceDedup.check(nonce);
  if (existingMessageId) {
    // Duplicate detected - return existing message info
    return {
      messageId: existingMessageId,
      phase: 'sent', // Assume already sent if we have a matching nonce
    };
  }

  // Generate message ID
  const messageId = crypto.randomUUID();

  // Register nonce
  nonceDedup.register(nonce, messageId);

  // Get preemption tracker for this session
  const tracker = preemptionManager.getTracker(sessionId);
  tracker.setStrategy(strategy);

  // Check if session is busy and apply strategy
  if (tracker.isBusy() && strategy === 'queue') {
    // Queue the message
    tracker.setBusy(true); // Keep busy true since we're queuing
    onQueued?.(messageId);
    return { messageId, phase: 'queued' };
  }

  // Send immediately (either session not busy or strategy is preempt)
  tracker.setBusy(true);

  // Start sending
  const phase: BotDirectSendResult['phase'] = 'sending';

  try {
    // Actually send the message
    const result = sendFn(messageId, content);

    // If sendFn returns a promise, wait for it
    if (result instanceof Promise) {
      await result;
    }

    // Mark as sent (db_persisted ack would come through SSE)
    onSent?.(messageId);

    return { messageId, phase: 'sent' };
  } catch (error) {
    // Mark as failed
    onFailed?.(messageId, error instanceof Error ? error : undefined);
    return { messageId, phase: 'failed' };
  }
}

/**
 * Mark a bot session as no longer busy.
 * Called when streaming ends.
 */
export function botDirectSendComplete(sessionId: string): void {
  const tracker = preemptionManager.getTracker(sessionId);
  tracker.setBusy(false);
}
