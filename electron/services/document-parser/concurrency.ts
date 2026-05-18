import type { ParseResult } from './types';
import { MAX_CONCURRENT, PARSE_TIMEOUT } from './types';

export interface PendingRequest {
  id: number;
  filePath: string;
  sessionId: string;
  resolve: (result: ParseResult) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: number) => void;
}

interface DispatchHandler {
  execute: (request: PendingRequest) => void;
}

export class RequestQueue {
  private activeCount = 0;
  private pending = new Map<number, PendingRequest>();
  private queue: PendingRequest[] = [];
  private nextId = 1;
  private handler: DispatchHandler;

  constructor(handler: DispatchHandler) {
    this.handler = handler;
  }

  enqueue(request: Omit<PendingRequest, 'id'>): number {
    const id = this.nextId++;
    const req: PendingRequest = { id, ...request };

    if (this.activeCount < MAX_CONCURRENT) {
      this.activeCount++;
      this.handler.execute(req);
    } else {
      this.queue.push(req);
    }

    this.pending.set(id, req);
    return id;
  }

  onComplete(id: number): void {
    this.pending.delete(id);
    this.activeCount--;
    this.processQueue();
  }

  rejectPendingFiles(reason: Error): void {
    for (const [id, req] of this.pending) {
      this.pending.delete(id);
      this.queue.unshift(req);
      // restore for crash recovery
      this.activeCount = Math.max(0, this.activeCount - 1);
    }

    for (const req of this.queue) {
      req.reject(reason);
    }
    this.queue = [];
    this.activeCount = 0;
  }

  rejectAll(reason: Error): void {
    for (const [, req] of this.pending) {
      req.reject(reason);
    }
    this.pending.clear();
    for (const req of this.queue) {
      req.reject(reason);
    }
    this.queue = [];
    this.activeCount = 0;
  }

  requeueAll(): PendingRequest[] {
    const requests = Array.from(this.pending.values());
    for (const [id] of this.pending) {
      this.pending.delete(id);
    }
    for (const req of requests) {
      this.queue.unshift(req);
    }
    this.activeCount = 0;
    return requests;
  }

  getPending(): Map<number, PendingRequest> {
    return this.pending;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get active(): number {
    return this.activeCount;
  }

  get concurrencyLimit(): number {
    return MAX_CONCURRENT;
  }

  get timeoutMs(): number {
    return PARSE_TIMEOUT;
  }

  private processQueue(): void {
    while (this.activeCount < MAX_CONCURRENT && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        this.activeCount++;
        this.handler.execute(next);
      }
    }
  }
}
