/**
 * worker-pool - bound concurrency for parser execution
 *
 * A simple async-mutex-style pool with a configurable limit. Parsers
 * themselves are pure async functions, so we don't need real
 * worker_threads — just a promise chain that caps how many run in
 * parallel.
 *
 * Why not real worker_threads?
 *   - jszip/pdf-parse/fast-xml-parser all run fine on the main thread
 *     for typical document sizes
 *   - Real threads add IPC serialization cost and complicate error
 *     propagation
 *   - We only need to prevent "5 large PDFs in flight" from OOM'ing
 *
 * TextParser and ImageParser can be marked as "fast" and bypass the
 * pool entirely (no queuing overhead for trivial work).
 */

import { MAX_CONCURRENT } from './types.js';

interface QueuedTask<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

export interface WorkerPoolOptions {
  maxConcurrent?: number;
}

export class WorkerPool {
  private active = 0;
  private queue: Array<QueuedTask<unknown>> = [];
  private max: number;
  private disposed = false;

  constructor(options: WorkerPoolOptions = {}) {
    this.max = options.maxConcurrent ?? MAX_CONCURRENT;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.disposed) {
      throw new Error('WorkerPool is disposed');
    }
    if (this.active < this.max) {
      this.active++;
      try {
        return await fn();
      } finally {
        this.active--;
        this.drain();
      }
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve: resolve as (v: unknown) => void, reject });
    });
  }

  get activeCount(): number {
    return this.active;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get concurrencyLimit(): number {
    return this.max;
  }

  private drain(): void {
    if (this.disposed || this.active >= this.max) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active++;
    next
      .fn()
      .then((v) => {
        this.active--;
        next.resolve(v);
        this.drain();
      })
      .catch((e) => {
        this.active--;
        next.reject(e);
        this.drain();
      });
  }

  dispose(): void {
    this.disposed = true;
    for (const task of this.queue) {
      task.reject(new Error('WorkerPool disposed'));
    }
    this.queue = [];
  }
}
