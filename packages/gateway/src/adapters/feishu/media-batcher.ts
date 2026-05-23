/**
 * Feishu Media Batcher
 *
 * Debounces rapidly sent media messages from the same user/chat.
 * Similar to TextBatcher but optimized for media attachments.
 */

import type { FeishuBatchMedia } from './types.js';

interface MediaBatchOptions {
  /** Delay after last message before flushing (default: 800ms) */
  delayMs?: number;
}

/** Default media batch delay */
const DEFAULT_DELAY_MS = 800;

export class MediaBatcher {
  private pendingBatches = new Map<string, FeishuBatchMedia>();
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private onFlush: (batches: FeishuBatchMedia[]) => Promise<void>;

  constructor(onFlush: (batches: FeishuBatchMedia[]) => Promise<void>, options: MediaBatchOptions = {}) {
    this.onFlush = onFlush;
  }

  enqueue(batch: FeishuBatchMedia): void {
    const key = batch.chatId;
    this.pendingBatches.set(key, batch);

    const existingTimer = this.flushTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      const pendingBatch = this.pendingBatches.get(key);
      if (pendingBatch) {
        this.pendingBatches.delete(key);
        this.flushTimers.delete(key);
        this.onFlush([pendingBatch]);
      }
    }, DEFAULT_DELAY_MS);

    this.flushTimers.set(key, timer);
  }

  clear(): void {
    for (const timer of this.flushTimers.values()) {
      clearTimeout(timer);
    }
    this.flushTimers.clear();
    this.pendingBatches.clear();
  }

  get pendingCount(): number {
    return this.pendingBatches.size;
  }

  stop(): void {
    this.clear();
  }
}