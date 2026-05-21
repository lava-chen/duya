// @ts-nocheck
/**
 * Feishu Media Batcher
 *
 * Debounces rapidly sent media messages from the same user/chat.
 * Similar to TextBatcher but optimized for media attachments.
 */

import type { NormalizedMessage } from '../../types.js';

interface MediaBatch {
  message: NormalizedMessage;
  mediaCount: number;
}

interface MediaBatchOptions {
  /** Delay after last message before flushing (default: 800ms) */
  delayMs?: number;
}

/** Default media batch delay */
const DEFAULT_DELAY_MS = 800;

export class MediaBatcher {
  private pendingBatches = new Map<string, MediaBatch>();
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private options: Required<MediaBatchOptions>;

  private onFlush: (msg: NormalizedMessage) => void;

  constructor(onFlush: (msg: NormalizedMessage) => void, options: MediaBatchOptions = {}) {
    this.onFlush = onFlush;
    this.options = {
      delayMs: options.delayMs ?? DEFAULT_DELAY_MS,
    };
  }

  enqueue(message: NormalizedMessage): void {
    const key = this.batchKey(message);

    // Check compatibility
    const existing = this.pendingBatches.get(key);
    if (existing && !this.isCompatible(existing.message, message)) {
      this.flushNow(key);
    }

    const newOrExisting = this.pendingBatches.get(key);

    if (!newOrExisting) {
      // Create new batch
      const batch: MediaBatch = {
        message: { ...message },
        mediaCount: this.countMedia(message),
      };
      this.pendingBatches.set(key, batch);
      this.scheduleFlush(key);
      return;
    }

    // Merge with existing batch
    const batch = newOrExisting;

    // Merge media
    if (message.images?.length) {
      batch.message.images = [...(batch.message.images ?? []), ...message.images];
    }
    if (message.imagePaths?.length) {
      batch.message.imagePaths = [...(batch.message.imagePaths ?? []), ...message.imagePaths];
    }
    if (message.files?.length) {
      batch.message.files = [...(batch.message.files ?? []), ...message.files];
    }
    if (message.filePaths?.length) {
      batch.message.filePaths = [...(batch.message.filePaths ?? []), ...message.filePaths];
    }
    if (message.voicePaths?.length) {
      batch.message.voicePaths = [...(batch.message.voicePaths ?? []), ...message.voicePaths];
    }
    if (message.videoPaths?.length) {
      batch.message.videoPaths = [...(batch.message.videoPaths ?? []), ...message.videoPaths];
    }

    // Merge text (caption)
    if (message.text && batch.message.text) {
      batch.message.text = `${batch.message.text}\n${message.text}`;
    } else if (message.text) {
      batch.message.text = message.text;
    }

    batch.mediaCount += this.countMedia(message);

    this.scheduleFlush(key);
  }

  private batchKey(msg: NormalizedMessage): string {
    const threadId = msg.threadId ?? '';
    const replyTo = msg.replyToMsgId ?? '';
    const msgType = this.getPrimaryMediaType(msg);
    return `${msg.platformChatId}:${msg.platformUserId}:${threadId}:${replyTo}:${msgType}`;
  }

  private getPrimaryMediaType(msg: NormalizedMessage): string {
    if (msg.images?.length || msg.imagePaths?.length) return 'image';
    if (msg.videoPaths?.length) return 'video';
    if (msg.files?.length || msg.filePaths?.length) return 'file';
    if (msg.voicePaths?.length) return 'voice';
    return 'unknown';
  }

  private isCompatible(a: NormalizedMessage, b: NormalizedMessage): boolean {
    return (
      a.platformChatId === b.platformChatId &&
      a.platformUserId === b.platformUserId &&
      a.threadId === b.threadId &&
      a.replyToMsgId === b.replyToMsgId &&
      this.getPrimaryMediaType(a) === this.getPrimaryMediaType(b)
    );
  }

  private countMedia(msg: NormalizedMessage): number {
    return (
      (msg.images?.length ?? 0) +
      (msg.imagePaths?.length ?? 0) +
      (msg.files?.length ?? 0) +
      (msg.filePaths?.length ?? 0) +
      (msg.voicePaths?.length ?? 0) +
      (msg.videoPaths?.length ?? 0)
    );
  }

  private scheduleFlush(key: string): void {
    const existingTimer = this.flushTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.flushNow(key);
    }, this.options.delayMs);

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