/**
 * Bridge from the legacy `CompactionManager` (which replaces a `Message[]` in
 * place) to the append-only `MessageTimeline` domain.
 *
 * The existing `CompactionManager` and its strategies are left untouched. This
 * controller sits between the timeline and the manager:
 *
 * 1. Input  — projects the timeline's latest checkpoint to a provider
 *              `Message[]` via `buildAgentContext` + `projectModelMessages`.
 * 2. Run    — delegates to `CompactionManager.compact`.
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
import type { MessageContent } from '../types.js';
import type { EnhancedCompactionResult } from '../compact/CompactionManager.js';
import { estimateMessagesTokens } from '../compact/tokenBudget.js';
import { logger } from '../utils/logger.js';
import {
  findSafeCompactionBoundary,
  MessageTimeline,
  type AgentMessage,
  type CompactionEntry,
  type MessageTimelineEntry,
} from './message-framework.js';
import { projectModelMessages } from './message-projectors.js';
import { isBranchedMessage } from './threads.js';

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
  shouldCompact(messages: readonly Message[]): boolean;
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
  /**
   * Plan 475 P2.1: injects bot-scoped system sections into the compaction
   * entry's `reinjectedSystemMessages` so history-level bot state that lived
   * in the compacted range (pending wake/DM summaries, automation reminders)
   * survives into the post-compaction system prompt segments. Called only
   * when a compaction entry is actually created. Sections that duplicate the
   * per-turn system prompt (identity/roster, Plan 474 §7.6 tail wiring) must
   * NOT be returned here — those are rebuilt every turn and would duplicate.
   * Returning an empty array is a no-op. A thrown error is logged and the
   * compaction proceeds without the extra sections.
   */
  readonly postSummarySections?: () => string[] | Promise<string[]>;
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
  /** Initiation source — forwarded to CompactionManager loop guards. */
  readonly trigger?: 'auto' | 'manual' | 'emergency' | 'preflight_overflow' | 'model_switch';
}

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
  private timeline: MessageTimeline;
  private readonly compactionManager: CompactionManagerLike;
  private readonly idGenerator: () => string;
  private readonly clock: () => number;
  private readonly onCompacted?: (compactedMessageIds: readonly string[]) => void;
  private readonly postSummarySections?: () => string[] | Promise<string[]>;

  constructor(options: MessageCompactionControllerOptions) {
    this.timeline = options.timeline;
    this.compactionManager = options.compactionManager;
    this.idGenerator = options.idGenerator ?? defaultIdGenerator;
    this.clock = options.clock ?? defaultClock;
    this.onCompacted = options.onCompacted;
    this.postSummarySections = options.postSummarySections;
  }

  /**
   * Replace the bridged timeline reference.
   *
   * `DuyaAgent.setMessages` rebuilds the timeline in place by assigning a
   * fresh `MessageTimeline` to its private field. The controller captured the
   * *original* reference at construction, so without this hookup it would
   * keep reading from the empty pre-rebuild instance — `compactProactive`
   * would then call `CompactionManager.compact([])` and trip the
   * `conversation is empty` preflight on every load-from-DB path (chat:start
   * cold resume, the new `case 'compact'` lazy-load, etc.).
   *
   * Plan 422 follow-up: synchronize the controller with the agent's current
   * timeline reference after every `setMessages` / `clearMessages` call.
   */
  setTimeline(timeline: MessageTimeline): void {
    this.timeline = timeline;
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
    return this.compactionManager.shouldCompact(messages);
  }

  /**
   * Proactive compaction. Projects the timeline, runs the manager, and appends
   * a `CompactionEntry` to the timeline. Returns the new entry, or `null` when
   * the strategy decided no compaction was needed (returned input unchanged
   * with no marker message).
   *
   * Plan 495 G1: when a background prefire pass1 summary is completed and its
   * message prefix is still valid, it is consumed as the `previousSummary`
   * seed — the main summarization becomes an iterative update of pass1
   * (grok two-pass semantics) instead of a cold full re-summarization.
   */
  async compactProactive(
    options?: CompactProactiveOptions,
  ): Promise<CompactionEntry | null> {
    const inputMessages = this.projectInputMessages()
    let effectiveOptions: Record<string, unknown> | undefined = options as Record<string, unknown> | undefined
    const prefireSource = (this.compactionManager as {
      takePrefireSummary?: (messages: readonly Message[]) => Promise<string | undefined>
    }).takePrefireSummary?.bind(this.compactionManager)
    if (prefireSource && !effectiveOptions?.previousSummary) {
      try {
        const seed = await prefireSource(inputMessages)
        if (seed) {
          effectiveOptions = {
            ...(options ?? {}),
            previousSummary: seed,
          }
        }
      } catch {
        // Prefire is best-effort; compact without the seed.
      }
    }
    const result = await this.compactionManager.compact(
      inputMessages,
      effectiveOptions,
    )
    return this.applyCompactionResult(result, inputMessages)
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  /**
   * Converts a `CompactionManager` result into a `CompactionEntry` and appends
   * it to the timeline. Returns `null` when the result carries no compaction
   * marker (strategy returned early without compacting).
   */
  private async applyCompactionResult(
    result: EnhancedCompactionResult,
    inputMessages: Message[],
  ): Promise<CompactionEntry | null> {
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
    // Plan 486 §2.4: branched (thread) messages are excluded from the real
    // compaction input. They never enter the model projection the strategy
    // sees, so they must also never be listed as compacted — otherwise
    // `onCompacted` would supersede their durable rows and `getThread` would
    // lose them after a compaction.
    const realInputAgentMessages: readonly AgentMessage[] =
      projection.messages.filter(
        (m) =>
          !isBranchedMessage(m) &&
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
    // Plan 422 + grok alignment: legacy_system messages (AGENTS.md, project
    // instructions, etc.) are extracted into the system prompt via
    // extractLegacySystemSegments BEFORE compaction, but
    // buildAgentContext excludes them from `context.messages` once they fall
    // inside a compaction boundary. Without re-injection, project
    // instructions vanish from the next turn. grok solves this with
    // reinjectedSystemMessages; we do the same — find legacy_system entries
    // in the timeline whose message.id is in compactedMessageIds and capture
    // their content so extractLegacySystemSegments can rebuild the segments.
    const timelineEntries = this.timeline.snapshot()
    const compactedIdsSet = new Set(compactedMessageIds)
    const legacySystemReinjected: (string | readonly MessageContent[])[] = []
    const seenLegacyIds = new Set<string>()
    for (const entry of timelineEntries) {
      if (entry.type !== 'message') continue
      const msg = entry.message
      if (
        msg.role === 'legacy_system' &&
        typeof msg.id === 'string' &&
        compactedIdsSet.has(msg.id) &&
        !seenLegacyIds.has(msg.id) &&
        msg.payload?.content
      ) {
        seenLegacyIds.add(msg.id)
        legacySystemReinjected.push(msg.payload.content)
      }
    }
    const combinedReinjected = [
      ...legacySystemReinjected,
      ...reinjectedSystemMessages,
    ]
    // Plan 475 P2.1: bot-scoped post-summary sections (history-level state
    // lost with the compacted range — pending wake/DM summaries, automation
    // reminders). Failure-isolated: a broken hook must never fail the
    // compaction, matching the Plan 474 tail-wiring error posture.
    if (this.postSummarySections) {
      try {
        const botSections = await this.postSummarySections();
        combinedReinjected.push(...botSections.filter((s) => typeof s === 'string' && s.length > 0));
      } catch (err) {
        logger.warn(
          `[Compaction] postSummarySections skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (combinedReinjected.length > 0) {
      entry.reinjectedSystemMessages = combinedReinjected
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
