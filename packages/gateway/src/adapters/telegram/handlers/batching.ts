/**
 * Batching handlers for message aggregation
 */

import type { NormalizedMessage } from '../../../types.js';
import { getBatchKey, mergeCaption } from '../message-utils.js';

const TEXT_BATCH_DELAY_MS = 600;
const TEXT_BATCH_SPLIT_DELAY_MS = 2000;
const SPLIT_THRESHOLD = 4000;
const MEDIA_GROUP_WAIT_SECONDS = 0.8;
const PHOTO_BURST_WAIT_SECONDS = 0.8;

interface BatchState<T extends NormalizedMessage> {
  message: T;
  lastChunkLen: number;
}

export class TextBatcher {
  private pending = new Map<string, NormalizedMessage>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private flushCallback: (msg: NormalizedMessage) => void;

  constructor(flushCallback: (msg: NormalizedMessage) => void) {
    this.flushCallback = flushCallback;
  }

  enqueue(msg: NormalizedMessage): void {
    const key = getBatchKey(
      msg.platformChatId,
      msg.platformUserId,
      msg.threadId
    );
    const existing = this.pending.get(key);

    if (existing) {
      if (msg.text) {
        existing.text = existing.text ? `${existing.text}\n${msg.text}` : msg.text;
      }
      if (msg.imagePaths) {
        existing.imagePaths = [...(existing.imagePaths ?? []), ...msg.imagePaths];
      }
      if (msg.filePaths) {
        existing.filePaths = [...(existing.filePaths ?? []), ...msg.filePaths];
      }
      if (msg.voicePaths) {
        existing.voicePaths = [...(existing.voicePaths ?? []), ...msg.voicePaths];
      }
      if (msg.videoPaths) {
        existing.videoPaths = [...(existing.videoPaths ?? []), ...msg.videoPaths];
      }
      if (!existing.replyToText && msg.replyToText) {
        existing.replyToText = msg.replyToText;
      }
      (existing as unknown as BatchState<NormalizedMessage>).lastChunkLen = msg.text?.length ?? 0;
    } else {
      (this.pending as unknown as Map<string, BatchState<NormalizedMessage>>).set(key, {
        message: msg,
        lastChunkLen: msg.text?.length ?? 0,
      });
    }

    const priorTimer = this.timers.get(key);
    if (priorTimer) clearTimeout(priorTimer);

    const state = (this.pending as unknown as Map<string, BatchState<NormalizedMessage>>).get(key)!;
    const delay = state.lastChunkLen >= SPLIT_THRESHOLD
      ? TEXT_BATCH_SPLIT_DELAY_MS
      : TEXT_BATCH_DELAY_MS;

    const timer = setTimeout(() => this.flush(key), delay);
    this.timers.set(key, timer);
  }

  private flush(key: string): void {
    const msg = this.pending.get(key);
    if (!msg) return;

    this.pending.delete(key);
    this.timers.delete(key);

    console.log(`[Telegram] Flushing text batch ${key} (${msg.text?.length ?? 0} chars)`);
    this.flushCallback(msg);
  }

  clear(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.pending.clear();
  }
}

export class MediaGroupBatcher {
  private pending = new Map<string, NormalizedMessage>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private flushCallback: (msg: NormalizedMessage) => void;

  constructor(flushCallback: (msg: NormalizedMessage) => void) {
    this.flushCallback = flushCallback;
  }

  enqueue(groupId: string, msg: NormalizedMessage): void {
    const existing = this.pending.get(groupId);

    if (existing) {
      if (msg.imagePaths) {
        existing.imagePaths = [...(existing.imagePaths ?? []), ...msg.imagePaths];
      }
      if (msg.videoPaths) {
        existing.videoPaths = [...(existing.videoPaths ?? []), ...msg.videoPaths];
      }
      if (msg.filePaths) {
        existing.filePaths = [...(existing.filePaths ?? []), ...msg.filePaths];
      }
      if (msg.text) {
        existing.text = mergeCaption(existing.text, msg.text);
      }
    } else {
      this.pending.set(groupId, msg);
    }

    const priorTimer = this.timers.get(groupId);
    if (priorTimer) clearTimeout(priorTimer);

    const timer = setTimeout(() => this.flush(groupId), MEDIA_GROUP_WAIT_SECONDS * 1000);
    this.timers.set(groupId, timer);
  }

  private flush(groupId: string): void {
    const msg = this.pending.get(groupId);
    if (!msg) return;

    this.pending.delete(groupId);
    this.timers.delete(groupId);

    console.log(
      `[Telegram] Flushing media group ${groupId} ` +
      `(${msg.imagePaths?.length ?? 0} images, ${msg.videoPaths?.length ?? 0} videos)`
    );
    this.flushCallback(msg);
  }

  clear(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.pending.clear();
  }
}

export class PhotoBurstBatcher {
  private pending = new Map<string, NormalizedMessage>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private flushCallback: (msg: NormalizedMessage) => void;

  constructor(flushCallback: (msg: NormalizedMessage) => void) {
    this.flushCallback = flushCallback;
  }

  enqueue(key: string, msg: NormalizedMessage): void {
    const existing = this.pending.get(key);

    if (existing) {
      if (msg.imagePaths) {
        existing.imagePaths = [...(existing.imagePaths ?? []), ...msg.imagePaths];
      }
      if (msg.text) {
        existing.text = mergeCaption(existing.text, msg.text);
      }
    } else {
      this.pending.set(key, msg);
    }

    const priorTimer = this.timers.get(key);
    if (priorTimer) clearTimeout(priorTimer);

    const timer = setTimeout(() => this.flush(key), PHOTO_BURST_WAIT_SECONDS * 1000);
    this.timers.set(key, timer);
  }

  private flush(key: string): void {
    const msg = this.pending.get(key);
    if (!msg) return;

    this.pending.delete(key);
    this.timers.delete(key);

    console.log(`[Telegram] Flushing photo burst ${key} (${msg.imagePaths?.length ?? 0} images)`);
    this.flushCallback(msg);
  }

  clear(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.pending.clear();
  }
}