/** Serial admission of local drafts into Host turns. This does not execute runs. */
import type { FileAttachment } from '@duya/agent-protocol';

export type TurnOutcome = 'completed' | 'cancelled' | 'failed';

/** One queued draft: the prompt text plus the attachments submitted with it. */
interface QueuedDraft {
  readonly text: string;
  readonly attachments: readonly FileAttachment[];
}

export interface TurnQueueSnapshot {
  readonly busy: boolean;
  readonly paused: boolean;
  /** The queued prompt TEXTS. Attachments are not surfaced here. */
  readonly pending: readonly string[];
}

export interface TurnQueueOptions {
  readonly runTurn: (text: string, attachments: readonly FileAttachment[]) => Promise<TurnOutcome>;
  readonly onChange: (snapshot: TurnQueueSnapshot) => void;
  readonly onError: (error: unknown) => void;
}

export class TurnQueue {
  private readonly pending: QueuedDraft[] = [];
  private busy = false;
  private paused = false;
  private closed = false;
  private resumeAfterActive = false;
  private draining: Promise<void> = Promise.resolve();

  constructor(private readonly options: TurnQueueOptions) {}

  get snapshot(): TurnQueueSnapshot {
    return { busy: this.busy, paused: this.paused, pending: this.pending.map((draft) => draft.text) };
  }

  submit(text: string, attachments: readonly FileAttachment[] = []): void {
    if (this.closed || text.trim() === '') return;
    // A fresh input after interruption is an explicit new intent. Older queued
    // drafts still require the user's resume decision before automatic drain.
    if (this.paused && this.pending.length === 0) {
      if (this.busy) this.resumeAfterActive = true;
      else this.paused = false;
    }
    this.pending.push({ text, attachments });
    this.changed();
    this.drain();
  }

  /** Explicit cancellation never silently starts queued work afterwards. */
  pause(): void {
    this.resumeAfterActive = false;
    this.paused = true;
    this.changed();
  }

  resume(): void {
    if (this.closed) return;
    if (this.busy && this.paused) this.resumeAfterActive = true;
    this.paused = false;
    this.changed();
    this.drain();
  }

  /**
   * Recall the newest queued draft's TEXT for editing.
   *
   * The attachments are dropped, not re-queued: the recalled text still
   * carries the chip labels, and resubmitting filters against an empty draft
   * list — the user re-attaches by pasting again rather than the queue
   * silently re-attaching files the editor no longer shows as queued chips.
   */
  takeLast(): string | null {
    const draft = this.pending.pop() ?? null;
    this.changed();
    return draft?.text ?? null;
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
        const draft = this.pending.shift();
        if (draft === undefined) break;
        this.changed();
        const outcome = await this.options.runTurn(draft.text, draft.attachments);
        if (outcome !== 'completed') this.paused = outcome !== 'cancelled' || !this.resumeAfterActive;
        this.resumeAfterActive = false;
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
