/**
 * compaction.ts - CompactionStore
 *
 * Encapsulates the compaction surface of the agent runtime (Plan 334 Phase 4+5).
 * It owns the {@link MessageCompactionController} (the bridge to the append-only
 * timeline) and the configured {@link CompactionManager}, exposing the same
 * operations `DuyaAgent` previously invoked directly on those two objects.
 *
 * Contract:
 * - `shouldCompact` / `compactProactive` / `compactReactive` delegate to the
 *   controller, which projects the timeline to provider messages and appends a
 *   `CompactionEntry` (never mutating existing entries).
 * - `updateContextTokens` / `getStats` delegate to the manager.
 * - `setOnMessagesCompacted` wires the controller's `onCompacted` hook, which
 *   fires with the ids of newly compacted messages so the host can mark the
 *   original DB rows `superseded`.
 */

import type { Message } from '../../types.js';
import type { MessageTimeline } from '../../message/index.js';
import type { CompactionEntry } from '../../message/index.js';
import {
  MessageCompactionController,
  type CompactProactiveOptions,
  type CompactReactiveTrigger,
} from '../../message/message-compaction-controller.js';
import type { CompactionManager } from '../../compact/CompactionManager.js';
import type { CompactionStats } from '../../compact/types.js';

/**
 * Options for constructing a {@link CompactionStore}.
 */
export interface CompactionStoreOptions {
  /** The shared message timeline (must be the same instance the history store uses). */
  readonly timeline: MessageTimeline;
  /** The configured compaction manager (summarizer already wired by the host). */
  readonly compactionManager: CompactionManager;
}

/**
 * Compaction store backed by a {@link MessageCompactionController} and a
 * {@link CompactionManager}.
 */
export class CompactionStore {
  private readonly controller: MessageCompactionController;
  private readonly compactionManager: CompactionManager;
  private onMessagesCompacted?: (compactedMessageIds: readonly string[]) => void;

  constructor(options: CompactionStoreOptions) {
    this.compactionManager = options.compactionManager;
    this.controller = new MessageCompactionController({
      timeline: options.timeline,
      compactionManager: options.compactionManager,
      onCompacted: (ids: readonly string[]) => this.onMessagesCompacted?.(ids),
    });
  }

  /** Readonly handle to the underlying timeline. */
  getTimeline(): MessageTimeline {
    return this.controller.getTimeline();
  }

  /** The underlying compaction manager. */
  getManager(): CompactionManager {
    return this.compactionManager;
  }

  /**
   * Whether proactive compaction should fire, based on the token budget for
   * the current timeline projection.
   */
  shouldCompact(): boolean {
    return this.controller.shouldCompact();
  }

  /**
   * Run proactive compaction. Projects the timeline, runs the manager, and
   * appends a `CompactionEntry` to the timeline. Returns the new entry, or
   * `null` when the strategy decided no compaction was needed.
   */
  compactProactive(options?: CompactProactiveOptions): Promise<CompactionEntry | null> {
    return this.controller.compactProactive(options);
  }

  /**
   * Run reactive compaction for emergency situations (`prompt_too_long`,
   * `context_length_exceeded`, manual). Same bridging as proactive but
   * delegates to `CompactionManager.reactiveCompact`.
   */
  compactReactive(triggerError?: CompactReactiveTrigger): Promise<CompactionEntry | null> {
    return this.controller.compactReactive(triggerError);
  }

  /**
   * Update the manager's context token count from the supplied messages.
   * The host passes the current persistence projection of the timeline.
   */
  updateContextTokens(messages: Message[]): void {
    this.compactionManager.updateContextTokens(messages);
  }

  /** Current compaction stats from the manager. */
  getStats(): CompactionStats {
    return this.compactionManager.getStats();
  }

  /**
   * Set the hook invoked after a compaction entry has been appended to the
   * timeline, with the ids of the messages that were compacted. Used by the
   * host to mark the original DB rows as `superseded`.
   */
  setOnMessagesCompacted(handler: (compactedMessageIds: readonly string[]) => void): void {
    this.onMessagesCompacted = handler;
  }
}