/**
 * Bridge from the legacy `CompactionManager` (which replaces a `Message[]` in
 * place) to the append-only `MessageTimeline` domain.
 *
 * The existing `CompactionManager` and its strategies are left untouched. This
 * controller sits between the timeline and the manager:
 *
 * 1. Input  — projects the timeline's latest checkpoint to a provider
 *              `Message[]` via `buildAgentContext` + `projectModelMessages`.
 * 2. Run    — delegates to `CompactionManager.compact` / `reactiveCompact`.
 * 3. Output — converts the returned `Message[]` (which contains a compaction
 *              marker plus retained messages) into a `CompactionEntry` and
 *              appends it to the timeline. The original `MessageEntry`s are
 *              never deleted or overwritten.
 *
 * The compaction summary lives exclusively inside the `CompactionEntry`.
 * `buildAgentContext` synthesises a transient `CompactionSummaryAgentMessage`
 * from the latest entry, so the summary never appears both in the system prompt
 * and as a regular history message.
 */

import type { Message } from '../types.js';
import type { EnhancedCompactionResult } from '../compact/CompactionManager.js';
import { estimateMessagesTokens } from '../compact/tokenBudget.js';
import {
  findSafeCompactionBoundary,
  MessageTimeline,
  type AgentMessage,
  type CompactionEntry,
  type MessageTimelineEntry,
} from './message-framework.js';
import { projectModelMessages } from './message-projectors.js';

/**
 * Structural subset of the real `CompactionManager` that the controller relies on.
 * Tests can pass any object satisfying this shape; production wires the real
 * `CompactionManager` instance.
 */
export interface CompactionManagerLike {
  compact(
    messages: Message[],
    options?: Record<string, unknown>,
  ): Promise<EnhancedCompactionResult>;
  reactiveCompact(
    messages: Message[],
    triggerError?: 'prompt_too_long' | 'context_length_exceeded' | 'manual_trigger',
  ): Promise<EnhancedCompactionResult>;
  updateContextTokens(messages: Message[]): void;
  shouldCompact(): boolean;
}

export interface MessageCompactionControllerOptions {
  readonly timeline: MessageTimeline;
  readonly compactionManager: CompactionManagerLike;
  /** Id generator for new `CompactionEntry` ids. Defaults to `crypto.randomUUID`. */
  readonly idGenerator?: () => string;
  /** Clock for `CompactionEntry.createdAt`. Defaults to `Date.now`. */
  readonly clock?: () => number;
  /**
   * Invoked after a compaction entry has been appended to the timeline,
   * with the ids of the messages that were compacted. Used by the host
   * (e.g. DuyaAgent) to mark the original DB rows as `superseded` so a
   * reload does not resurrect them as ghost rows.
   */
  readonly onCompacted?: (compactedMessageIds: readonly string[]) => void;
}

/**
 * Options for proactive compaction. Forwarded to `CompactionManager.compact`
 * after the controller supplies the projected `Message[]`.
 */
export interface CompactProactiveOptions {
  readonly strategy?: string;
  readonly maxMessagesToKeep?: number;
  readonly customInstructions?: string;
  readonly workingDirectory?: string;
  readonly customReinjectContext?: string;
  readonly recentChanges?: readonly unknown[];
}

export type CompactReactiveTrigger =
  | 'prompt_too_long'
  | 'context_length_exceeded'
  | 'manual_trigger';

function defaultIdGenerator(): string {
  return crypto.randomUUID();
}

function defaultClock(): number {
  return Date.now();
}

/**
 * A compaction marker is any message the strategy injected to stand in for the
 * compacted history. The projection used as CompactionManager input never
 * contains `role: 'system'` messages (system content is kept separate by
 * `projectModelMessages`), so any system-role message in the result is a
 * strategy-produced marker. `isCompactSummary` / `isCompactBoundary` flags are
 * also honoured for strategies that set them on non-system roles.
 */
function isCompactionMarker(message: Message): boolean {
  return (
    message.isCompactSummary === true ||
    message.isCompactBoundary === true ||
    message.role === 'system'
  );
}

function extractSummaryText(message: Message): string {
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter(
      (block): block is { type: 'text'; text: string } => block.type === 'text',
    )
    .map((block) => block.text)
    .join('\n');
}

/**
 * Bridges the legacy `CompactionManager` to the append-only `MessageTimeline`.
 *
 * The controller never mutates existing timeline entries. Each compaction
 * appends one `CompactionEntry` that records the compacted message ids, the
 * first retained message id (safe boundary), the summary, the strategy, token
 * counts, and a pointer to the previous compaction entry for full
 * traceability across repeated compactions.
 */
export class MessageCompactionController {
  private readonly timeline: MessageTimeline;
  private readonly compactionManager: CompactionManagerLike;
  private readonly idGenerator: () => string;
  private readonly clock: () => number;
  private readonly onCompacted?: (compactedMessageIds: readonly string[]) => void;

  constructor(options: MessageCompactionControllerOptions) {
    this.timeline = options.timeline;
    this.compactionManager = options.compactionManager;
    this.idGenerator = options.idGenerator ?? defaultIdGenerator;
    this.clock = options.clock ?? defaultClock;
    this.onCompacted = options.onCompacted;
  }

  /** Readonly handle to the timeline being bridged. */
  getTimeline(): MessageTimeline {
    return this.timeline;
  }

  /**
   * Projects the timeline's latest checkpoint to a provider `Message[]`
   * suitable as input for the legacy `CompactionManager`.
   *
   * This reads the latest compaction checkpoint via `buildAgentContext` and
   * converts the resulting `AgentMessage[]` through the model-boundary
   * projector, so the manager only sees the post-checkpoint view (previous
   * summary + retained messages), never the full raw history.
   */
  projectInputMessages(): Message[] {
    const projection = this.timeline.buildContext();
    const modelProjection = projectModelMessages(projection.messages);
    return [...modelProjection.messages];
  }

  /**
   * Convenience: updates the manager's token count from the current timeline
   * projection and reports whether proactive compaction should fire.
   */
  shouldCompact(): boolean {
    const messages = this.projectInputMessages();
    this.compactionManager.updateContextTokens(messages);
    return this.compactionManager.shouldCompact();
  }

  /**
   * Proactive compaction. Projects the timeline, runs the manager, and appends
   * a `CompactionEntry` to the timeline. Returns the new entry, or `null` when
   * the strategy decided no compaction was needed (returned input unchanged
   * with no marker message).
   */
  async compactProactive(
    options?: CompactProactiveOptions,
  ): Promise<CompactionEntry | null> {
    const inputMessages = this.projectInputMessages();
    this.compactionManager.updateContextTokens(inputMessages);
    const result = await this.compactionManager.compact(
      inputMessages,
      options as Record<string, unknown> | undefined,
    );
    return this.applyCompactionResult(result, inputMessages);
  }

  /**
   * Reactive compaction for emergency situations (`prompt_too_long`,
   * `context_length_exceeded`, manual). Same bridging as proactive but
   * delegates to `CompactionManager.reactiveCompact`.
   */
  async compactReactive(
    triggerError?: CompactReactiveTrigger,
  ): Promise<CompactionEntry | null> {
    const inputMessages = this.projectInputMessages();
    this.compactionManager.updateContextTokens(inputMessages);
    const result = await this.compactionManager.reactiveCompact(
      inputMessages,
      triggerError,
    );
    return this.applyCompactionResult(result, inputMessages);
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  /**
   * Converts a `CompactionManager` result into a `CompactionEntry` and appends
   * it to the timeline. Returns `null` when the result carries no compaction
   * marker (strategy returned early without compacting).
   */
  private applyCompactionResult(
    result: EnhancedCompactionResult,
    inputMessages: Message[],
  ): CompactionEntry | null {
    const markerIndex = result.messages.findIndex(isCompactionMarker);

    // No marker → strategy returned the input unchanged (e.g. conversation
    // shorter than `maxMessagesToKeep`). Nothing to record.
    if (markerIndex < 0) {
      return null;
    }

    const marker = result.messages[markerIndex]!;
    const retainedResultMessages = result.messages.slice(markerIndex + 1);

    // Collect ids of real MessageEntry messages currently in the timeline.
    const realMessageIds = this.collectRealMessageIds();
    if (realMessageIds.size === 0) {
      return null;
    }

    // Latest checkpoint projection (previous summary + retained messages).
    const projection = this.timeline.buildContext();
    const realInputAgentMessages: readonly AgentMessage[] =
      projection.messages.filter(
        (m) =>
          m.role !== 'compaction_summary' &&
          typeof m.id === 'string' &&
          realMessageIds.has(m.id),
      );

    if (realInputAgentMessages.length === 0) {
      return null;
    }

    // Find the first retained result message that maps back to a real timeline
    // entry. Strategy-reinjected messages (file/skill context) do not have
    // timeline ids and are skipped for boundary computation.
    const firstRealRetainedId = retainedResultMessages.find(
      (m) => m.id && realMessageIds.has(m.id),
    )?.id;

    // The legacy manager reinjects file/skill/tool/working-directory context
    // immediately after its summary marker. Keep that system context on the
    // checkpoint so it survives both the current projection and a restart.
    // It must not be appended as a user history turn.
    const firstRealRetainedIndex = retainedResultMessages.findIndex(
      (m) => m.id && realMessageIds.has(m.id),
    );
    const reinjectedSystemMessages = retainedResultMessages
      .slice(0, firstRealRetainedIndex < 0 ? retainedResultMessages.length : firstRealRetainedIndex)
      .filter((message) => message.role === 'system')
      .map((message) => message.content);

    const { firstKeptIndex, firstKeptMessageId } = this.resolveSafeBoundary(
      realInputAgentMessages,
      firstRealRetainedId,
    );

    if (!firstKeptMessageId) {
      return null;
    }

    // Compacted ids = real input messages strictly before the safe boundary.
    // Messages from earlier compactions are not re-listed here; they remain
    // traceable via the `previousCompactionId` chain.
    const compactedMessageIds = realInputAgentMessages
      .slice(0, firstKeptIndex)
      .flatMap((m) => (typeof m.id === 'string' ? [m.id] : []));

    const tokensBefore = estimateMessagesTokens(inputMessages);
    const previousCompaction = this.findLatestCompaction();

    const entry: CompactionEntry = {
      type: 'compaction',
      id: this.idGenerator(),
      parentId: null,
      createdAt: this.clock(),
      summary: extractSummaryText(marker),
      firstKeptMessageId,
      compactedMessageIds,
      tokensBefore,
      tokensAfter: result.tokensRetained,
      strategy: result.strategy,
    };
    if (previousCompaction) {
      entry.previousCompactionId = previousCompaction.id;
    }
    if (reinjectedSystemMessages.length > 0) {
      entry.reinjectedSystemMessages = reinjectedSystemMessages;
    }

    this.timeline.appendCompaction(entry);

    // Notify the host so it can mark the original DB rows as `superseded`.
    // Without this, a reload reads the compacted messages as ghost rows
    // because the append-only timeline never deletes them.
    if (entry.compactedMessageIds.length > 0) {
      this.onCompacted?.(entry.compactedMessageIds);
    }

    return entry;
  }

  /**
   * Resolves a safe `firstKeptMessageId` from the strategy's first retained
   * message id.
   *
   * The strategies already call `adjustSliceBoundary` to avoid orphaned
   * `tool_result` blocks. This method applies the framework-level
   * {@link findSafeCompactionBoundary} as an additional guarantee: if the
   * strategy's boundary lands on a non-user turn, the boundary walks backwards
   * to the nearest user message so the model never receives a dangling
   * `tool_result` / `tool_use` half-pair.
   *
   * If the walk would collapse all the way back to index 0 for a non-trivial
   * proposed boundary (meaning there is no user turn to anchor on), the
   * strategy's original boundary is trusted instead of retaining the entire
   * history.
   */
  private resolveSafeBoundary(
    realInputAgentMessages: readonly AgentMessage[],
    firstRealRetainedId: string | undefined,
  ): { firstKeptIndex: number; firstKeptMessageId: string | undefined } {
    const fallback = {
      firstKeptIndex: realInputAgentMessages.length - 1,
      firstKeptMessageId:
        realInputAgentMessages[realInputAgentMessages.length - 1]?.id,
    };

    if (!firstRealRetainedId) {
      return fallback;
    }

    const proposedIndex = realInputAgentMessages.findIndex(
      (m) => m.id === firstRealRetainedId,
    );
    if (proposedIndex < 0) {
      return fallback;
    }

    const boundary = findSafeCompactionBoundary(
      realInputAgentMessages,
      proposedIndex,
    );

    // Trust the strategy boundary when the safe walk would retain the entire
    // history (collapsed to index 0 without an explicit user anchor at 0).
    if (
      boundary.firstKeptIndex === 0 &&
      proposedIndex > 0 &&
      realInputAgentMessages[0]?.role !== 'user'
    ) {
      return {
        firstKeptIndex: proposedIndex,
        firstKeptMessageId: realInputAgentMessages[proposedIndex]!.id,
      };
    }

    return {
      firstKeptIndex: boundary.firstKeptIndex,
      firstKeptMessageId: boundary.firstKeptMessageId,
    };
  }

  private collectRealMessageIds(): Set<string> {
    const ids = new Set<string>();
    for (const entry of this.timeline.snapshot()) {
      if (entry.type === 'message' && typeof entry.message.id === 'string') {
        ids.add(entry.message.id);
      }
    }
    return ids;
  }

  private findLatestCompaction(): CompactionEntry | undefined {
    const entries: readonly MessageTimelineEntry[] =
      this.timeline.snapshot();
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i]!;
      if (entry.type === 'compaction') {
        return entry;
      }
    }
    return undefined;
  }
}
