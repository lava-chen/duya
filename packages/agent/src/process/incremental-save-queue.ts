/**
 * incremental-save-queue.ts - Serialized incremental save queue
 *
 * Replaces fire-and-forget saves with a serialized queue to prevent:
 * 1. Concurrent writes causing race conditions
 * 2. Request piling up when DB is slow
 * 3. "unknown request" responses from out-of-order responses
 *
 * Queue policy:
 * - Only 1 pending request at a time (replaces older pending if exists)
 * - executing request is never interrupted
 * - After flush(), new requests are rejected
 * - New conversation turn = new queue instance
 */

import { appendMessages } from '../session/db.js';
import type { Message } from '../types.js';

interface AppendMessagesResult {
  success: boolean;
  count: number;
}

interface SaveRequest {
  messages: readonly Message[];
  resolve: (result: AppendMessagesResult) => void;
  reject: (error: Error) => void;
}

export class IncrementalSaveQueue {
  private pending: SaveRequest | null = null;
  private executing: SaveRequest | null = null;
  private _isFlushed = false;
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  get isFlushed(): boolean {
    return this._isFlushed;
  }

  /**
   * Trigger a save. If already flushing, reject immediately.
   * If executing, replace pending (max 1).
   * If not executing, execute immediately.
   */
  trigger(messages: readonly Message[]): Promise<AppendMessagesResult> {
    if (this._isFlushed) {
      return Promise.resolve({ success: false, count: 0 });
    }

    return new Promise<AppendMessagesResult>((resolve, reject) => {
      const request: SaveRequest = { messages, resolve, reject };

      if (this.executing !== null) {
        if (this.pending !== null) {
          const oldPending = this.pending;
          this.pending = request;
          request.resolve = (result: AppendMessagesResult) => {
            oldPending.resolve(result);
            resolve(result);
          };
        } else {
          this.pending = request;
        }
      } else if (this.pending !== null) {
        const oldPending = this.pending;
        this.pending = request;
        request.resolve = (result: AppendMessagesResult) => {
          oldPending.resolve(result);
          resolve(result);
        };
      } else {
        this.execute(request);
      }
    });
  }

  private execute(request: SaveRequest): void {
    this.executing = request;
    this.pending = null;

    appendMessages(this.sessionId, request.messages)
      .then(result => {
        request.resolve(result);
        this.executing = null;
        if (this.pending !== null) {
          const next = this.pending;
          this.pending = null;
          this.execute(next);
        }
      })
      .catch(err => {
        request.reject(err instanceof Error ? err : new Error(String(err)));
        this.executing = null;
        if (this.pending !== null) {
          const next = this.pending;
          this.pending = null;
          this.execute(next);
        }
      });
  }

  markFlushed(): void {
    this._isFlushed = true;
  }

  async flush(): Promise<void> {
    while (this.executing !== null || this.pending !== null) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}