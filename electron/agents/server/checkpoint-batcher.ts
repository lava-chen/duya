import { SessionManager } from './session-store';

interface QueuedCheckpoint {
  sessionId: string;
  data: unknown;
  timestamp: number;
}

const BATCH_INTERVAL_MS = 1500;
const MAX_BATCH_SIZE = 10;

export class CheckpointBatcher {
  private queue: QueuedCheckpoint[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private sessionManager: SessionManager;
  private onFlush: ((checkpoints: QueuedCheckpoint[]) => void) | null = null;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  setFlushHandler(handler: (checkpoints: QueuedCheckpoint[]) => void): void {
    this.onFlush = handler;
  }

  start(): void {
    this.timer = setInterval(() => {
      this.flush();
    }, BATCH_INTERVAL_MS);
  }

  enqueue(sessionId: string, data: unknown): void {
    this.sessionManager.setLastCheckpoint(sessionId, data);

    const entry: QueuedCheckpoint = {
      sessionId,
      data,
      timestamp: Date.now(),
    };

    this.queue.push(entry);

    if (this.queue.length >= MAX_BATCH_SIZE) {
      this.flush();
    }
  }

  flush(): void {
    if (this.queue.length === 0) return;

    const batch = this.queue;
    this.queue = [];

    if (this.onFlush) {
      try {
        this.onFlush(batch);
      } catch (err) {
        console.error('[CheckpointBatcher] Flush handler error:', err);
      }
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.flush();
  }
}