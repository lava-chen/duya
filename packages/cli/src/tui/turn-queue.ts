/** Serial admission of local drafts into Host turns. This does not execute runs. */
import type { FileAttachment } from '@duya/agent-protocol';

export type TurnOutcome = 'completed' | 'cancelled' | 'failed' | 'skipped';

/**
 * How a draft is meant to reach the agent while a run is active.
 *
 * `steer` is injected into the running turn at its next model boundary (Host
 * mailbox `kind='followup'`); `queue` waits until the turn settles and starts
 * a fresh user turn.
 */
export type DraftMode = 'steer' | 'queue';

export interface PendingDraft {
  /** Stable local identity; the wiring keys per-item operations on it. */
  readonly key: string;
  /** Host mailbox row id, when the draft was written to the running turn. */
  readonly mailboxId: string | null;
  readonly text: string;
  readonly mode: DraftMode;
  /** The controller already printed this draft; the turn must not print it again. */
  readonly echoed: boolean;
  /**
   * The files submitted with this draft.
   *
   * They are part of the draft rather than a separate channel: a draft is one
   * thing the user sent, and the turn it starts carries the files with the
   * text. A draft that is recalled drops them (see `takeLast`).
   */
  readonly attachments: readonly FileAttachment[];
}

export interface SubmitDraftOptions {
  readonly mode?: DraftMode;
  readonly mailboxId?: string | null;
  readonly echoed?: boolean;
  /** Put the draft ahead of older ones (interrupt-and-send). */
  readonly front?: boolean;
  /** The files submitted with the draft; they ride along into the turn. */
  readonly attachments?: readonly FileAttachment[];
}

export interface ReclassifyPatch {
  readonly text?: string;
  readonly mode?: DraftMode;
  readonly mailboxId?: string | null;
  readonly echoed?: boolean;
}

export interface TurnQueueSnapshot {
  readonly busy: boolean;
  readonly paused: boolean;
  /** The queued prompt TEXTS. Attachments are not surfaced here. */
  readonly pending: readonly string[];
}

export interface TurnQueueOptions {
  readonly execute: (text: string, draft: PendingDraft) => Promise<TurnOutcome>;
  readonly onChange: (snapshot: TurnQueueSnapshot) => void;
  readonly onError: (error: unknown) => void;
}

export class TurnQueue {
  private readonly pending: PendingDraft[] = [];
  private busy = false;
  private paused = false;
  private closed = false;
  private resumeAfterActive = false;
  private draining: Promise<void> = Promise.resolve();
  private nextKey = 1;

  constructor(private readonly options: TurnQueueOptions) {}

  get snapshot(): TurnQueueSnapshot {
    return { busy: this.busy, paused: this.paused, pending: this.pending.map((draft) => draft.text) };
  }

  /** Full drafts, newest last. The snapshot above stays text-only for callers that only paint. */
  get drafts(): readonly PendingDraft[] {
    return [...this.pending];
  }

  submit(text: string, options: SubmitDraftOptions = {}): void {
    if (this.closed || text.trim() === '') return;
    // A fresh input after interruption is an explicit new intent. Older queued
    // drafts still require the user's resume decision before automatic drain.
    if (this.paused && this.pending.length === 0) {
      if (this.busy) this.resumeAfterActive = true;
      else this.paused = false;
    }
    const draft: PendingDraft = {
      key: `draft-${this.nextKey++}`,
      mailboxId: options.mailboxId ?? null,
      text,
      mode: options.mode ?? 'queue',
      echoed: options.echoed ?? false,
      attachments: options.attachments ?? [],
    };
    if (options.front === true) this.pending.unshift(draft);
    else this.pending.push(draft);
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
    return this.takeLastDraft()?.text ?? null;
  }

  takeLastDraft(): PendingDraft | null {
    const draft = this.pending.pop() ?? null;
    this.changed();
    return draft;
  }

  remove(key: string): PendingDraft | null {
    const index = this.pending.findIndex((draft) => draft.key === key);
    if (index < 0) return null;
    const [removed] = this.pending.splice(index, 1);
    this.changed();
    return removed ?? null;
  }

  /**
   * Rewrite a pending draft in place, keeping its key and position. A queued
   * draft sent into the running turn stays in line as a steer; an edited draft
   * keeps the order the user gave it.
   */
  reclassify(key: string, patch: ReclassifyPatch): PendingDraft | null {
    const index = this.pending.findIndex((draft) => draft.key === key);
    const current = index < 0 ? undefined : this.pending[index];
    if (current === undefined) return null;
    const next: PendingDraft = {
      ...current,
      ...(patch.text === undefined ? {} : { text: patch.text }),
      ...(patch.mode === undefined ? {} : { mode: patch.mode }),
      ...(patch.mailboxId === undefined ? {} : { mailboxId: patch.mailboxId }),
      ...(patch.echoed === undefined ? {} : { echoed: patch.echoed }),
    };
    this.pending[index] = next;
    this.changed();
    return next;
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
        const outcome = await this.options.execute(draft.text, draft);
        // `skipped` means the draft was already delivered elsewhere (a steer
        // the running turn claimed). It must not pause or resume anything.
        if (outcome === 'skipped') continue;
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
