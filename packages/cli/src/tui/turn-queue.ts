/** Serial admission of local drafts into Host turns. This does not execute runs. */
export type TurnOutcome = 'completed' | 'cancelled' | 'failed';

export interface TurnQueueSnapshot {
  readonly busy: boolean;
  readonly paused: boolean;
  readonly pending: readonly string[];
}

export interface TurnQueueOptions {
  readonly execute: (text: string) => Promise<TurnOutcome>;
  readonly onChange: (snapshot: TurnQueueSnapshot) => void;
  readonly onError: (error: unknown) => void;
}

export class TurnQueue {
  private readonly pending: string[] = [];
  private busy = false;
  private paused = false;
  private closed = false;
  private draining: Promise<void> = Promise.resolve();

  constructor(private readonly options: TurnQueueOptions) {}

  get snapshot(): TurnQueueSnapshot {
    return { busy: this.busy, paused: this.paused, pending: [...this.pending] };
  }

  submit(text: string): void {
    if (this.closed || text.trim() === '') return;
    // A fresh input after interruption is an explicit new intent. Older queued
    // drafts still require the user's resume decision before automatic drain.
    if (this.paused && this.pending.length === 0 && !this.busy) this.paused = false;
    this.pending.push(text);
    this.changed();
    this.drain();
  }

  /** Explicit cancellation never silently starts queued work afterwards. */
  pause(): void {
    this.paused = true;
    this.changed();
  }

  resume(): void {
    if (this.closed) return;
    this.paused = false;
    this.changed();
    this.drain();
  }

  takeLast(): string | null {
    const text = this.pending.pop() ?? null;
    this.changed();
    return text;
  }

  clear(): void {
    this.pending.length = 0;
    this.paused = false;
    this.changed();
  }

  close(): void {
    this.closed = true;
    this.pending.length = 0;
    this.changed();
  }

  whenIdle(): Promise<void> {
    return this.draining;
  }

  private changed(): void {
    this.options.onChange(this.snapshot);
  }

  private drain(): void {
    if (this.closed || this.busy || this.paused || this.pending.length === 0) return;
    // Acquire admission synchronously, before any API call can yield.
    this.busy = true;
    this.draining = this.run();
  }

  private async run(): Promise<void> {
    try {
      while (!this.closed && !this.paused) {
        const text = this.pending.shift();
        if (text === undefined) break;
        this.changed();
        const outcome = await this.options.execute(text);
        if (outcome !== 'completed') this.paused = true;
      }
    } catch (error) {
      this.paused = true;
      this.options.onError(error);
    } finally {
      this.busy = false;
      this.changed();
    }
  }
}
