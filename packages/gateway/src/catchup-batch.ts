/**
 * catchup-batch.ts - Realtime message catchup batch processing
 *
 * Handles batch processing of platform messages that arrived during
 * adapter disconnection. Called when a gateway adapter reconnects
 * after a network outage or polling restart.
 *
 * Edge cases handled:
 * - Empty messages: skipped with warning log
 * - Very long messages (>64KB text): truncated to safe limit
 * - Concurrent catchup: per-chat serialization via lock map
 */

import type { NormalizedMessage } from './types.js';

const MAX_TEXT_LENGTH = 64 * 1024; // 64KB safe limit
const CATCHUP_LOCK_TTL_MS = 60000; // Auto-release stale locks after 60s
const MAX_BATCH_SIZE = 100; // Safety cap on batch size

interface CatchupBatchResult {
  processed: number;
  skipped: number;
  truncated: number;
  errors: string[];
}

interface ChatLock {
  sessionId: string;
  acquiredAt: number;
}

export class CatchupBatchProcessor {
  private locks = new Map<string, ChatLock>();
  private lockCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startLockCleanup();
  }

  /**
   * Process a batch of caught-up messages from a platform adapter.
   *
   * @param chatKey - Unique identifier for the chat (e.g., "telegram:12345")
   * @param messages - Array of normalized messages to process
   * @param handler - Async handler for each message (injects into gateway flow)
   * @returns Result summary with counts
   */
  async runBatch(
    chatKey: string,
    messages: NormalizedMessage[],
    handler: (msg: NormalizedMessage) => Promise<void>,
  ): Promise<CatchupBatchResult> {
    // Guard: concurrent catchup for the same chat
    const existingLock = this.locks.get(chatKey);
    if (existingLock) {
      const elapsed = Date.now() - existingLock.acquiredAt;
      if (elapsed < CATCHUP_LOCK_TTL_MS) {
        console.warn(`[CatchupBatch] Skipping concurrent catchup for ${chatKey}, lock held by ${existingLock.sessionId} (${elapsed}ms ago)`);
        return { processed: 0, skipped: messages.length, truncated: 0, errors: ['Concurrent catchup in progress'] };
      }
      // Stale lock, release it
      console.warn(`[CatchupBatch] Releasing stale lock for ${chatKey}`);
      this.locks.delete(chatKey);
    }

    const sessionId = `catchup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.locks.set(chatKey, { sessionId, acquiredAt: Date.now() });

    const result: CatchupBatchResult = { processed: 0, skipped: 0, truncated: 0, errors: [] };

    // Safety cap
    if (messages.length > MAX_BATCH_SIZE) {
      console.warn(`[CatchupBatch] Batch size ${messages.length} exceeds limit ${MAX_BATCH_SIZE}, truncating`);
      messages = messages.slice(0, MAX_BATCH_SIZE);
    }

    try {
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        try {
          // Guard: empty message
          if (!msg.text || msg.text.trim().length === 0) {
            console.warn(`[CatchupBatch] Skipping empty message at index ${i} for ${chatKey}`);
            result.skipped++;
            continue;
          }

          // Guard: very long message
          if (msg.text.length > MAX_TEXT_LENGTH) {
            console.warn(`[CatchupBatch] Truncating message at index ${i} for ${chatKey}: ${msg.text.length} chars`);
            msg.text = msg.text.slice(0, MAX_TEXT_LENGTH) + '\n\n[Message truncated due to length]';
            result.truncated++;
          }

          await handler(msg);
          result.processed++;
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.error(`[CatchupBatch] Error processing message at index ${i} for ${chatKey}:`, errorMsg);
          result.errors.push(`msg[${i}]: ${errorMsg}`);
        }
      }
    } finally {
      this.locks.delete(chatKey);
    }

    return result;
  }

  /**
   * Check if a chat is currently being caught up
   */
  isLocked(chatKey: string): boolean {
    return this.locks.has(chatKey);
  }

  /**
   * Force release a lock (emergency use)
   */
  forceUnlock(chatKey: string): void {
    this.locks.delete(chatKey);
  }

  /**
   * Clean up all locks and timers
   */
  shutdown(): void {
    if (this.lockCleanupTimer) {
      clearInterval(this.lockCleanupTimer);
      this.lockCleanupTimer = null;
    }
    this.locks.clear();
  }

  private startLockCleanup(): void {
    this.lockCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, lock] of this.locks) {
        if (now - lock.acquiredAt > CATCHUP_LOCK_TTL_MS) {
          console.warn(`[CatchupBatch] Cleaning up stale lock for ${key}`);
          this.locks.delete(key);
        }
      }
    }, 30000);
  }
}

/**
 * Singleton instance for use across gateway adapters
 */
let defaultProcessor: CatchupBatchProcessor | null = null;

export function getCatchupBatchProcessor(): CatchupBatchProcessor {
  if (!defaultProcessor) {
    defaultProcessor = new CatchupBatchProcessor();
  }
  return defaultProcessor;
}

/**
 * Convenience function for one-shot batch processing.
 * Uses the singleton processor.
 */
export async function runRealtimeCatchupBatch(
  chatKey: string,
  messages: NormalizedMessage[],
  handler: (msg: NormalizedMessage) => Promise<void>,
): Promise<CatchupBatchResult> {
  const processor = getCatchupBatchProcessor();
  return processor.runBatch(chatKey, messages, handler);
}