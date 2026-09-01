/**
 * CompactionStore
 *
 * Encapsulates the compaction surface of the agent runtime.
 * Owns the MessageCompactionController and CompactionManager.
 */
import type { MessageTimeline } from '../../message/index.js';
import type { CompactionEntry } from '../../message/index.js';
import {
  MessageCompactionController,
  type CompactProactiveOptions,
} from '../../message/message-compaction-controller.js';
import type { CompactionManager } from '../../compact/CompactionManager.js';
import type { CompactionStats } from '../../compact/types.js';

export interface CompactionStoreOptions {
  readonly timeline: MessageTimeline;
  readonly compactionManager: CompactionManager;
}

export class CompactionStore {
  private readonly controller: MessageCompactionController;
  readonly compactionManager: CompactionManager;
  private onMessagesCompacted?: (ids: readonly string[]) => void;

  constructor(options: CompactionStoreOptions) {
    this.compactionManager = options.compactionManager;
    this.controller = new MessageCompactionController({
      timeline: options.timeline,
      compactionManager: options.compactionManager,
      onCompacted: (ids) => this.onMessagesCompacted?.(ids),
    });
  }

  getTimeline(): MessageTimeline {
    return this.controller.getTimeline();
  }

  shouldCompact(): boolean {
    return this.controller.shouldCompact();
  }

  compactProactive(options?: CompactProactiveOptions): Promise<CompactionEntry | null> {
    return this.controller.compactProactive(options);
  }

  getStats(): CompactionStats {
    return this.compactionManager.getStats();
  }

  setOnMessagesCompacted(handler: (ids: readonly string[]) => void): void {
    this.onMessagesCompacted = handler;
  }
}
