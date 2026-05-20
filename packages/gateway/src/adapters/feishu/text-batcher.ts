/**
 * Feishu Text Batcher
 *
 * Debounces rapidly sent text messages from the same user/chat.
 * Feishu clients often split messages at ~4000 character boundaries.
 * This batcher aggregates them into a single message event.
 */

import type { NormalizedMessage } from '../../types.js';

interface BatchedMessage {
  message: NormalizedMessage;
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

  private onFlush: (msg: NormalizedMessage) => void;

  constructor(onFlush: (msg: NormalizedMessage) => void, options: TextBatchOptions = {}) {
    this.onFlush = onFlush;
    this.options = {
      delayMs: options.delayMs ?? 600,
      splitDelayMs: options.splitDelayMs ?? 2000,
      maxMessages: options.maxMessages ?? 8,
      maxChars: options.maxChars ?? 4000,
      splitThreshold: options.splitThreshold ?? SPLIT_THRESHOLD,
    };
  }

  enqueue(message: NormalizedMessage): void {
    const key = this.batchKey(message);

    // Check if we need to flush existing batch first
    const existing = this.pendingBatches.get(key);
    if (existing && !this.isCompatible(existing.message, message)) {
      this.flushNow(key);
    }

    const newOrExisting = this.pendingBatches.get(key);

    if (!newOrExisting) {
      // Create new batch
      const batch: BatchedMessage = {
        message: { ...message },
        lastChunkLen: message.text?.length ?? 0,
      };
      this.pendingBatches.set(key, batch);
      this.scheduleFlush(key);
      return;
    }

    // Merge with existing batch
    const batch = newOrExisting;
    if (message.text && batch.message.text) {
      batch.message.text = `${batch.message.text}\n${message.text}`;
    }

    // Merge attachments
    if (message.imagePaths?.length) {
      batch.message.imagePaths = [...(batch.message.imagePaths ?? []), ...message.imagePaths];
    }
    if (message.filePaths?.length) {
      batch.message.filePaths = [...(batch.message.filePaths ?? []), ...message.filePaths];
    }
    if (message.images?.length) {
      batch.message.images = [...(batch.message.images ?? []), ...message.images];
    }
    if (message.files?.length) {
      batch.message.files = [...(batch.message.files ?? []), ...message.files];
    }

    batch.lastChunkLen = message.text?.length ?? 0;

    // Check if we should flush immediately
    const textLen = batch.message.text?.length ?? 0;
    if (textLen >= this.options.maxChars || this.getMessageCount(key) >= this.options.maxMessages) {
      this.flushNow(key);
      return;
    }

    this.scheduleFlush(key);
  }

  private batchKey(msg: NormalizedMessage): string {
    const threadId = msg.threadId ?? '';
    const userId = msg.platformUserId ?? '';
    return `${msg.platformChatId}:${userId}:${threadId}`;
  }

  private isCompatible(a: NormalizedMessage, b: NormalizedMessage): boolean {
    // Same chat, user, and thread
    return (
      a.platformChatId === b.platformChatId &&
      a.platformUserId === b.platformUserId &&
      a.threadId === b.threadId &&
      a.replyToMsgId === b.replyToMsgId
    );
  }

  private getMessageCount(key: string): number {
    // Track message count per batch
    const existing = this.pendingBatches.get(key);
    if (!existing) return 0;
    // Simple heuristic: message count based on text length and threshold
    return Math.ceil((existing.message.text?.length ?? 0) / this.options.splitThreshold);
  }

  private scheduleFlush(key: string): void {
    // Clear existing timer
    const existingTimer = this.flushTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Use longer delay if last chunk was near split threshold
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
    this.onFlush(batch.message);
  }

  clear(): void {
    for (const timer of this.flushTimers.values()) {
      clearTimeout(timer);
    }
    this.flushTimers.clear();
    this.pendingBatches.clear();
  }

  /** Get pending batch count */
  get pendingCount(): number {
    return this.pendingBatches.size;
  }
}