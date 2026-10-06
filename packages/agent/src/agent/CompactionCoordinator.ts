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
 * subscription for the duration of one `compactProactive` call. The caller
 * (`streamChat`) receives events either via the `onEvent` callback (live,
 * while the compaction is still running) or via the returned `events`
 * buffer (legacy contract, no `onEvent` provided).
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import type { CompactionManager, CompactionProbe } from '../compact/CompactionManager.js';
import type { MessageCompactionController } from '../message/message-compaction-controller.js';
import type { CompactionEntry } from '../message/message-framework.js';
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
  /**
   * The timeline entry a successful compaction appended, or `null`.
   *
   * ADDITIVE (plan 610 A3-2b5). The legacy loop never reads it -- it watches
   * `didCompact` and the `compact:done` event, and that is enough for it. But
   * `compact:done` carries `strategy` / `tokensRemoved` / `tokensRetained` and
   * NOTHING about the boundary, while `compaction.completed` REQUIRES a
   * `boundaryId` and a `compactedMessageIds` list
   * (`events/required.ts:184-185`). Those two facts exist only here, so a host
   * that has to answer the protocol has to reach them without re-deriving them
   * from the timeline it cannot see.
   */
  entry: CompactionEntry | null;
}

/**
 * What the pre-turn gate decided, BEFORE anything ran.
 *
 * Split out so a host that must DECIDE and then RUN separately can ask this
 * coordinator for the first half and commit to the second (`executePreTurn`).
 * `CompactionPort` has exactly that shape (`ports.ts:2086`, `:2102`), and the
 * gate is one authority: re-deriving it here would put two copies of the
 * cooldown arithmetic next to each other, which is the failure `ports.ts:2059`
 * is written against.
 */
export interface PreTurnVerdict {
  /** True when the gates opened and the compaction should run. */
  readonly fire: boolean;
  /** True when the image-volume trigger bypassed the cooldown gate. */
  readonly imageTriggered: boolean;
  /** Why it declined, when it declined. `null` when `fire`. */
  readonly declinedBecause: string | null;
}

/**
 * Forwards `compaction_step` / `compaction_over_threshold` /
 * `compaction_summary_outcome` events emitted during a `compactProactive`
 * run to `emit` in engine order.
 *
 * `CompactionManager.addEventHandler` returns `void` (the engine manages
 * subscription lifetime internally for the lifetime of the manager), so
 * the wiring takes no `unsubscribe` parameter. The handler stays
 * registered after the run — the next `compactProactive` call simply
 * reuses the same handler.
 */
function attachCompactionEventBuffer(
  compactionManager: CompactionManager,
  emit: (event: SSEEvent) => void,
): void {
  compactionManager.addEventHandler((event) => {
    if (event.type === 'compaction_step') {
      emit({
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
      emit({
        type: 'compact:over_threshold',
        data: {
          tokensRetained: event.tokensRetained,
          available: event.available,
        },
      } as unknown as SSEEvent);
    } else if (event.type === 'compaction_summary_outcome') {
      emit({
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
}

export class CompactionCoordinator {
  constructor(private readonly deps: CompactionCoordinatorDeps) {}

  /**
   * The gate ALONE: probe, prefire kick, cooldown, rearm, suppression.
   *
   * Synchronous, and that is a fact about the legacy rather than a
   * simplification: everything `runPreTurn` did before `executeCompaction` was
   * synchronous already. Nothing is awaited here, so nothing needs to be.
   *
   * `runPreTurn` is now `decidePreTurn` + `executePreTurn`, so this code is the
   * ONE gate implementation and the legacy loop's behaviour is unchanged. See
   * `PreTurnVerdict` for why a host needs the two halves separately.
   */
  decidePreTurn(input: { turnCount: number }): PreTurnVerdict {
    const { turnCount } = input;

    // Plan 495 G1: kick the background pass1 prefire when approaching the
    // threshold — best-effort, never blocks or fails this turn. The seed
    // is harvested inside compactProactive when a real compaction fires.
    // Plan 495 G2: image-volume trigger (grok
    // IMAGE_SUMMARIZATION_TRIGGER_COUNT) — force compaction even when the
    // token budget has not been crossed yet.
    // Plan 552: one probe measures both triggers against the manager's
    // budget instead of separate threshold checks here and mid-loop.
    let imageTriggered = false;
    let probe: CompactionProbe | null = null;
    try {
      const checkpointProjection = this.deps.compactionController.projectInputMessages();
      this.deps.compactionManager.maybeStartPrefire(checkpointProjection);
      probe = this.deps.compactionManager.probeCompaction(checkpointProjection);
      imageTriggered = probe.imageTriggered;
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

    // Plan 552: the token path keeps shouldCompact's suppression semantics
    // (gate + threshold); the image trigger keeps bypassing both cooldown
    // and suppression, exactly as before the probe consolidation. The
    // fallback stays lazy so the cooldown gate still short-circuits before
    // the compaction engine is consulted when no probe is available.
    // Plan 577 §4: the rearm half of the double-watermark hysteresis runs
    // here too — a 'size' suppression lifts as soon as the measured
    // projection falls below the rearm low-watermark, even if no compaction
    // fired this turn (prune-driven shrink counts).
    if (probe) {
      this.deps.compactionManager.maybeRearm(probe.tokens)
    }
    const suppressed = this.deps.compactionManager.isSuppressed();
    const overLine = probe ? probe.overTriggerLine : this.deps.compactionController.shouldCompact();
    const fire = !cooldownActive && (imageTriggered || (!suppressed && overLine));

    // Why it said no, when it said no. ADDITIVE: the legacy loop never reads
    // this (it only ever learns "it did not compact"), but a host driving the
    // two halves separately has to report a decline with a reason, and
    // `CompactionDecision`'s skip arm is `reason: string`
    // (`ports.ts:1913`). The three arms are the three gates above, in the
    // order they are consulted.
    const declinedBecause = fire
      ? null
      : cooldownActive
        ? `cooldown: ${turnsSinceLastCompact} turns / ${Number.isFinite(tokensGrowthSinceCompact) ? tokensGrowthSinceCompact : 'unknown'} tokens since the last compaction`
        : suppressed && !imageTriggered
          ? 'suppression active'
          : 'under the trigger line';

    return { fire, imageTriggered, declinedBecause };
  }

  /**
   * Decide whether to fire a proactive compaction before the next LLM
   * call, execute it when the cooldown / image gates say so, and emit
   * the renderer-facing SSE events in lifecycle order.
   *
   * `onEvent` (optional): invoked the moment each event is produced so a
   * live caller can stream `compact:*` to the wire DURING the compaction
   * (the summarizer LLM call takes minutes). When provided, events are
   * NOT duplicated into the returned `events` buffer. When omitted, the
   * historical buffered semantics are preserved.
   *
   * ## This is `decidePreTurn` + `executePreTurn`, and stays one gate
   *
   * The two halves became public for a host that has to decide and run
   * separately (`CompactionPort`). Expressing this method as their
   * composition is what keeps that a SPLIT rather than a FORK: there is one
   * gate implementation and one place the cooldown arithmetic lives, and a
   * host cannot get a second opinion by asking a different method.
   */
  async runPreTurn(input: {
    turnCount: number;
    systemPromptContent: string;
    messages: Message[];
    onEvent?: (event: SSEEvent) => void;
  }): Promise<CompactionRunResult> {
    const verdict = this.decidePreTurn({ turnCount: input.turnCount });
    if (!verdict.fire) {
      return {
        didCompact: false,
        imageTriggered: verdict.imageTriggered,
        systemPromptContent: input.systemPromptContent,
        messages: input.messages,
        events: [],
        entry: null,
      };
    }
    return await this.executePreTurn(
      {
        turnCount: input.turnCount,
        systemPromptContent: input.systemPromptContent,
        messages: input.messages,
        verdict,
      },
      input.onEvent,
    );
  }

  /**
   * Run the compaction a `decidePreTurn` verdict already authorised.
   *
   * `verdict` is REQUIRED and is not re-derived. Re-deriving it here would
   * probe a second time and leave the decision the caller acted on possibly
   * different from the one the run acts on -- and the caller is the engine,
   * which has already published `compaction.started` off the back of it
   * (`compaction.ts:145`). A host that reaches this without a verdict has to
   * say so; `verdict` cannot be defaulted to a permissive one.
   */
  async executePreTurn(
    input: {
      turnCount: number;
      systemPromptContent: string;
      messages: Message[];
      verdict: PreTurnVerdict;
    },
    onEvent?: (event: SSEEvent) => void,
  ): Promise<CompactionRunResult> {
    const { turnCount, verdict } = input;
    let { systemPromptContent, messages } = input;
    const { imageTriggered } = verdict;
    const events: SSEEvent[] = [];
    // Real-time path: with `onEvent`, events go straight to the caller's
    // queue as they are produced (live SSE pump in streamChat) and the
    // returned `events` buffer stays empty to avoid double delivery.
    // Without `onEvent`, the historical buffer contract is kept.
    const emit = (event: SSEEvent) => {
      if (onEvent) onEvent(event);
      else events.push(event);
    };
    if (imageTriggered) {
      logger.info(`[Agent] Turn ${turnCount}: Image-count compaction trigger fired`);
    }
    logger.info(`[Agent] Turn ${turnCount}: Proactive compaction triggered`);
    emit({ type: 'compact:start' } as unknown as SSEEvent);

    attachCompactionEventBuffer(this.deps.compactionManager, emit);
    try {
      const compactEntry = await this.deps.compactionController.compactProactive({
        trigger: 'auto',
        ...(imageTriggered ? { force: true } : {}),
      });
      if (!compactEntry) {
        return { didCompact: false, imageTriggered, systemPromptContent, messages, events, entry: null };
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

      emit({
        type: 'compact:done',
        data: {
          strategy: compactEntry.strategy,
          tokensRemoved: compactEntry.tokensBefore,
          tokensRetained: compactEntry.tokensAfter ?? 0,
        },
      } as unknown as SSEEvent);

      return { didCompact: true, imageTriggered, systemPromptContent, messages, events, entry: compactEntry };
    } catch (compactError) {
      const compactErrorMsg =
        compactError instanceof Error ? compactError.message : String(compactError);
      logger.error(
        `[Agent] Turn ${turnCount}: Proactive compaction failed: ${compactErrorMsg}`,
      );
      emit({
        type: 'compact:error',
        data: { message: compactErrorMsg },
      } as unknown as SSEEvent);
      return { didCompact: false, imageTriggered, systemPromptContent, messages, events, entry: null };
    }
  }
}