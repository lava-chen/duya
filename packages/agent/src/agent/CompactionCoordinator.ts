/**
 * CompactionCoordinator — Plan 550 step 2c.
 *
 * `duyaAgent.streamChat` historically inlined ~150 lines of proactive
 * compaction logic: prefire kick, turn-based + token-based cooldown gate
 * (plan 517), event subscription, compactProactive execution,
 * post-compaction baseline pinning, and the `compact:*` SSE event
 * sequence. Pulling this into a dedicated module lets:
 *
 *   - tests pin the cooldown / image-trigger / event-buffer contract
 *     without driving a full `streamChat`
 *   - the future `ToolExecutionPipeline` (2b) call `runPreTurn` once and
 *     treat compaction as a black box
 *   - the renderer-facing `compact:*` event shape moves next to its
 *     single source of truth
 *
 * The coordinator owns the per-turn state that previously lived on
 * `duyaAgent` (`lastCompactionTurn`, `lastCompactionObservedTokens`).
 * It also owns the `compaction_over_threshold` / `compaction_step` event
 * subscription for the duration of one `compactProactive` call. The
 * caller (`streamChat`) forwards the returned SSE events to the wire.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import {
  IMAGE_COMPACTION_TRIGGER_COUNT,
  countImagePartsInMessages,
} from '../compact/imageParts.js';
import type { CompactionManager } from '../compact/CompactionManager.js';
import type { MessageCompactionController } from '../message/message-compaction-controller.js';
import type { Message, SSEEvent } from '../types.js';
import { logger } from '../utils/logger.js';

/**
 * Session-scope dependencies the coordinator needs. Fields are getters
 * when their underlying value can change mid-session (`getMessages()` is
 * a timeline-derived getter, `lastCompactionTurn` / `lastCompactionObservedTokens`
 * are mutated by the coordinator itself between runs).
 */
export interface CompactionCoordinatorDeps {
  /** Bridge to the legacy CompactionManager; owns the actual compaction engine. */
  compactionController: MessageCompactionController;
  /** The compaction manager; some metrics live here (getObservedPromptTokens). */
  compactionManager: CompactionManager;
  /**
   * Re-project model messages after a successful compaction. The system
   * prompt is owned by the caller (`streamChat`); the coordinator only
   * updates `messages` and returns the projected pair.
   */
  projectModelMessages: (
    systemPrompt: string,
    options: { injectHookContexts: boolean },
  ) => { systemPromptContent: string; messages: Message[] };
  /** Fires after a successful compaction so the host can persist the new timeline. */
  onMessagesCompacted?: (newMessageCount: number) => void;
  /** Live timeline-derived message list — the persisted-message baseline. */
  getMessages(): readonly Message[];
  /** Per-session baseline reads / writes for the cooldown gate. */
  getLastCompactionTurn(): number;
  setLastCompactionTurn(turn: number): void;
  getLastCompactionObservedTokens(): number | undefined;
  setLastCompactionObservedTokens(tokens: number | undefined): void;
  /** Static thresholds used by the cooldown gate (plan 517). */
  getMinTurnsSinceCompact(): number;
  getMinTokensGrowthSinceCompact(): number;
}

/**
 * Result of one pre-turn compaction run. The caller forwards `events`
 * to the SSE wire and replaces `systemPromptContent` / `messages` with
 * the projected versions if a compaction fired.
 */
export interface CompactionRunResult {
  /** True when an actual compaction completed and the timeline was updated. */
  didCompact: boolean;
  /** True when the image-volume trigger bypassed the cooldown gate. */
  imageTriggered: boolean;
  /** Projected system prompt — unchanged unless compaction fired. */
  systemPromptContent: string;
  /** Projected model messages — replaced from the timeline after a successful compaction. */
  messages: Message[];
  /** SSE events the caller must yield in order to surface the lifecycle. */
  events: SSEEvent[];
}

/**
 * Buffers `compaction_step` / `compaction_over_threshold` /
 * `compaction_summary_outcome` events emitted during a `compactProactive`
 * run so the caller can drain them between `compact:start` and
 * `compact:done`. Order is preserved by emit order.
 *
 * `CompactionManager.addEventHandler` returns `void` (the engine manages
 * subscription lifetime internally for the lifetime of the manager), so
 * the buffer takes no `unsubscribe` parameter. The handler stays
 * registered after the buffer array is drained — the next
 * `compactProactive` call simply reuses the same handler.
 */
function attachCompactionEventBuffer(
  compactionManager: CompactionManager,
): SSEEvent[] {
  const events: SSEEvent[] = [];
  compactionManager.addEventHandler((event) => {
    if (event.type === 'compaction_step') {
      events.push({
        type: 'compact:step',
        data: {
          step: event.step,
          phase: event.phase,
          messageCount: event.messageCount,
          tokensBefore: event.tokensBefore,
          tokensEstimated: event.tokensEstimated,
          filesCached: event.filesCached,
        },
      } as unknown as SSEEvent);
    } else if (event.type === 'compaction_over_threshold') {
      events.push({
        type: 'compact:over_threshold',
        data: {
          tokensRetained: event.tokensRetained,
          available: event.available,
        },
      } as unknown as SSEEvent);
    } else if (event.type === 'compaction_summary_outcome') {
      events.push({
        type: 'compact:summary_outcome',
        data: {
          attempt: event.attempt,
          outcome: event.outcome,
          errorKind: event.errorKind,
          chars: event.chars,
        },
      } as unknown as SSEEvent);
    }
  });
  return events;
}

export class CompactionCoordinator {
  constructor(private readonly deps: CompactionCoordinatorDeps) {}

  /**
   * Decide whether to fire a proactive compaction before the next LLM
   * call, execute it when the cooldown / image gates say so, and emit
   * the renderer-facing SSE events in lifecycle order.
   */
  async runPreTurn(input: {
    turnCount: number;
    systemPromptContent: string;
    messages: Message[];
  }): Promise<CompactionRunResult> {
    const { turnCount } = input;
    let { systemPromptContent, messages } = input;

    // Plan 495 G1: kick the background pass1 prefire when approaching the
    // threshold — best-effort, never blocks or fails this turn. The seed
    // is harvested inside compactProactive when a real compaction fires.
    // Plan 495 G2: image-volume trigger (grok
    // IMAGE_SUMMARIZATION_TRIGGER_COUNT) — force compaction even when the
    // token budget has not been crossed yet.
    let imageTriggered = false;
    try {
      const checkpointProjection = this.deps.compactionController.projectInputMessages();
      this.deps.compactionManager.maybeStartPrefire(checkpointProjection);
      imageTriggered =
        countImagePartsInMessages(checkpointProjection) >= IMAGE_COMPACTION_TRIGGER_COUNT;
    } catch {
      // Checkpoint projection is best-effort; shouldCompact() below still
      // runs its own projection.
    }

    // Plan 517 P2.1 + P2.3: turn-based + token-based cooldown to break
    // the compaction-loop bug.
    const lastTurn = this.deps.getLastCompactionTurn();
    const lastObserved = this.deps.getLastCompactionObservedTokens();
    const turnsSinceLastCompact = turnCount - lastTurn;
    const currentObservedTokens = this.deps.compactionManager.getObservedPromptTokens?.();
    const tokensGrowthSinceCompact =
      currentObservedTokens !== undefined && lastObserved !== undefined
        ? currentObservedTokens - lastObserved
        : Number.POSITIVE_INFINITY;
    const cooldownActive =
      !imageTriggered &&
      (turnsSinceLastCompact < this.deps.getMinTurnsSinceCompact() ||
        tokensGrowthSinceCompact < this.deps.getMinTokensGrowthSinceCompact());
    if (cooldownActive) {
      logger.debug(
        `[Agent] Turn ${turnCount}: Skipping proactive compaction (cooldown: ` +
          `turnsSinceLast=${turnsSinceLastCompact}/${this.deps.getMinTurnsSinceCompact()}, ` +
          `tokensGrowth=${Number.isFinite(tokensGrowthSinceCompact) ? tokensGrowthSinceCompact : 'unknown'}` +
          `/${this.deps.getMinTokensGrowthSinceCompact()})`,
      );
    }

    if (!cooldownActive && (imageTriggered || this.deps.compactionController.shouldCompact())) {
      return await this.executeCompaction(
        turnCount,
        systemPromptContent,
        messages,
        imageTriggered,
      );
    }

    return {
      didCompact: false,
      imageTriggered,
      systemPromptContent,
      messages,
      events: [],
    };
  }

  private async executeCompaction(
    turnCount: number,
    systemPromptContent: string,
    messages: Message[],
    imageTriggered: boolean,
  ): Promise<CompactionRunResult> {
    const events: SSEEvent[] = [];
    if (imageTriggered) {
      logger.info(`[Agent] Turn ${turnCount}: Image-count compaction trigger fired`);
    }
    logger.info(`[Agent] Turn ${turnCount}: Proactive compaction triggered`);
    events.push({ type: 'compact:start' } as unknown as SSEEvent);

    const buffer = attachCompactionEventBuffer(this.deps.compactionManager);
    try {
      const compactEntry = await this.deps.compactionController.compactProactive({
        trigger: 'auto',
        ...(imageTriggered ? { force: true } : {}),
      });
      // Drain buffered step / over-threshold events before compact:done so
      // the renderer sees the lifecycle in order.
      events.push(...buffer);
      if (!compactEntry) {
        return { didCompact: false, imageTriggered, systemPromptContent, messages, events };
      }

      // Pin the cooldown baseline.
      this.deps.setLastCompactionTurn(turnCount);
      const postCompactObserved = this.deps.compactionManager.getObservedPromptTokens?.();
      if (typeof postCompactObserved === 'number' && postCompactObserved > 0) {
        this.deps.setLastCompactionObservedTokens(postCompactObserved);
      } else {
        this.deps.setLastCompactionObservedTokens(undefined);
      }

      logger.info(
        `[Agent] Turn ${turnCount}: Compacted with strategy=${compactEntry.strategy}, ` +
          `removed=${compactEntry.tokensBefore} tokens, retained=${compactEntry.tokensAfter ?? 0} tokens`,
      );

      // The controller appended a checkpoint entry to the timeline
      // instead of mutating history in place; `this.messages` is a
      // timeline-derived getter, so it already reflects the compaction.
      this.deps.onMessagesCompacted?.(this.deps.getMessages().length);

      const reProjected = this.deps.projectModelMessages(systemPromptContent, {
        injectHookContexts: true,
      });
      systemPromptContent = reProjected.systemPromptContent;
      messages = reProjected.messages;

      events.push({
        type: 'compact:done',
        data: {
          strategy: compactEntry.strategy,
          tokensRemoved: compactEntry.tokensBefore,
          tokensRetained: compactEntry.tokensAfter ?? 0,
        },
      } as unknown as SSEEvent);

      return { didCompact: true, imageTriggered, systemPromptContent, messages, events };
    } catch (compactError) {
      const compactErrorMsg =
        compactError instanceof Error ? compactError.message : String(compactError);
      logger.error(
        `[Agent] Turn ${turnCount}: Proactive compaction failed: ${compactErrorMsg}`,
      );
      events.push(...buffer);
      return { didCompact: false, imageTriggered, systemPromptContent, messages, events };
    }
  }
}