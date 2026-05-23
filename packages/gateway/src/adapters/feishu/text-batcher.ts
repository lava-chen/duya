/**
 * Feishu Text Batcher
 *
 * Debounces rapidly sent text messages from the same user/chat.
 * Feishu clients often split messages at ~4000 character boundaries.
 * This batcher aggregates them into a single message event.
 */

import type { FeishuBatchText } from './types.js';

interface BatchedMessage {
  batch: FeishuBatchText;
  lastChunkLen: number;
}

interface TextBatchOptions {
  /** Delay after last message before flushing (default: 600ms) */
  delayMs?: number;
  /** Delay when chunk is near split threshold (default: 2000ms) */
  splitDelayMs?: number;
  /** Maximum messages per batch (default: 8) */
  maxMessages?: number;
  /** Maximum characters per batch (default: 4000) */
  maxChars?: number;
  /** Character threshold for split detection (Feishu splits at ~4096) */
  splitThreshold?: number;
}

/** Default Feishu split threshold */
const SPLIT_THRESHOLD = 4000;

export class TextBatcher {
  private pendingBatches = new Map<string, BatchedMessage>();
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private options: Required<TextBatchOptions>;

  private onFlush: (batches: FeishuBatchText[]) => Promise<void>;

  constructor(onFlush: (batches: FeishuBatchText[]) => Promise<void>, options: TextBatchOptions = {}) {
    this.onFlush = onFlush;
    this.options = {
      delayMs: options.delayMs ?? 600,
      splitDelayMs: options.splitDelayMs ?? 2000,
      maxMessages: options.maxMessages ?? 8,
      maxChars: options.maxChars ?? 4000,
      splitThreshold: options.splitThreshold ?? SPLIT_THRESHOLD,
    };
  }

  enqueue(batch: FeishuBatchText): void {
    const key = this.batchKey(batch);

    const newOrExisting = this.pendingBatches.get(key);

    if (!newOrExisting) {
      const batched: BatchedMessage = {
        batch: { ...batch },
        lastChunkLen: batch.content?.length ?? 0,
      };
      this.pendingBatches.set(key, batched);
      this.scheduleFlush(key);
      return;
    }

    // Merge with existing batch
    const existing = newOrExisting;
    if (batch.content && existing.batch.content) {
      existing.batch.content = `${existing.batch.content}\n${batch.content}`;
    }

    // Merge replyTo (use first one)
    if (!existing.batch.replyTo && batch.replyTo) {
      existing.batch.replyTo = batch.replyTo;
    }

    existing.lastChunkLen = batch.content?.length ?? 0;

    // Check if we should flush immediately
    const textLen = existing.batch.content?.length ?? 0;
    if (textLen >= this.options.maxChars || this.getMessageCount(key) >= this.options.maxMessages) {
      this.flushNow(key);
      return;
    }

    this.scheduleFlush(key);
  }

  private batchKey(batch: FeishuBatchText): string {
    return batch.chatId;
  }

  private getMessageCount(key: string): number {
    const existing = this.pendingBatches.get(key);
    if (!existing) return 0;
    return Math.ceil((existing.batch.content?.length ?? 0) / this.options.splitThreshold);
  }

  private scheduleFlush(key: string): void {
    const existingTimer = this.flushTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const batch = this.pendingBatches.get(key);
    const delay =
      batch && batch.lastChunkLen >= this.options.splitThreshold
        ? this.options.splitDelayMs
        : this.options.delayMs;

    const timer = setTimeout(() => {
      this.flushNow(key);
    }, delay);

    this.flushTimers.set(key, timer);
  }

  private flushNow(key: string): void {
    const timer = this.flushTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(key);
    }

    const batch = this.pendingBatches.get(key);
    if (!batch) return;

    this.pendingBatches.delete(key);
    this.onFlush([batch.batch]);
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