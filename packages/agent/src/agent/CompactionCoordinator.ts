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
 * ## The three gates, and why all three live here
 *
 * Plan 610 A3-2b6 moved the two recovery gates in from `DuyaAgent`'s inline
 * cycle body. They were ~55 lines of decision logic written straight into
 * `streamChat` (`DuyaAgent.ts:3360-3371` emergency, `:3009-3026` preflight), so
 * nothing outside `streamChat` could ask them anything -- and a
 * `CompactionPort` host that has to answer `decide` had no option but to
 * decline by name, which reads at the cutover as "the transcript is fine".
 * Lifting them here makes them reachable without duplicating them: the inline
 * sites and the port now ask the SAME method, so there is one authority for
 * each gate rather than a legacy copy next to a port copy.
 *
 * The three differ, and the difference is the point:
 *
 * | gate | line it compares | cooldown | evidence |
 * | --- | --- | --- | --- |
 * | `decidePreTurn` | `overTriggerLine` | yes | probe |
 * | `decidePreflightOverflow` | `overHardLimit` | no | probe |
 * | `decideEmergency` | n/a | no | provider text + probe |
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import type { CompactionManager, CompactionProbe } from '../compact/CompactionManager.js';
import { classifyContextLengthError, type ContextLengthErrorKind } from '../compact/compactErrors.js';
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
 * What the emergency / preflight gates decided, BEFORE anything ran.
 *
 * Same three members as `PreTurnVerdict` and deliberately not a distinct
 * shape: `CompactionPort.decide` returns ONE `CompactionDecision` for all
 * three triggers (`ports.ts:1911`), so a host that has to cache a verdict per
 * decision input (`run-engine-compaction.ts`) needs one type to hold. The
 * `imageTriggered` member is always `false` on these two paths -- it means
 * "bypassed the cooldown", and neither of these gates HAS a cooldown.
 *
 * `evidence` is DIAGNOSTIC and additive: it exists so the legacy's structured
 * context-length log (`DuyaAgent.ts:3744-3754`, kept because plan 577 review
 * round 2 made those lines the historical baseline the ContextLedger is
 * verified against) can read the classification and the measured context off
 * the SAME gate that decided, rather than re-probing next to it. Nothing reads
 * it to make the decision -- it is an output, not an input.
 */
export interface RecoveryVerdict extends PreTurnVerdict {
  /** `classifyContextLengthError`'s answer. `null` when it declined. */
  readonly classification?: ContextLengthErrorKind;
  /** The probe the gate took, or `null` when it took none / it threw. */
  readonly probe?: CompactionProbe | null;
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
   * The EMERGENCY gate, and it is a dual-evidence statement.
   *
   * ## Why this is not `decidePreTurn` with a wider input
   *
   * The proactive gate asks "is the transcript over the line, and is the
   * cooldown over?". The emergency gate asks "did the PROVIDER say it was too
   * long", and it is reached only after a model stream has already FAILED
   * (`DuyaAgent.ts:3306`, the `catch` around the stream). Two differences are
   * load-bearing and both are inherited, not invented here:
   *
   * 1. **No cooldown and no suppression.** An emergency compaction is the
   *    recovery path for a request the provider already rejected; gating it on
   *    "not too soon after the last compaction" would decline the one
   *    compaction that can fix the turn. The legacy has no such gate at
   *    `DuyaAgent.ts:3360` and neither does this.
   * 2. **The classification is the gate.** `classifyContextLengthError`
   *    (`compactErrors.ts:41`) is the plan-577 rule: an EXPLICIT provider claim
   *    compacts on its own, because the local budget may itself be misresolved
   *    and a probe is not more authoritative than the provider; WEAK wording
   *    (`"exceeds limit"`, which output/payload/quota errors also produce)
   *    compacts ONLY alongside a local probe that is over the trigger line; and
   *    a FAILED probe is no evidence at all, so weak wording with no probe
   *    declines. Fail-closed on the weak arm, deliberately.
   *
   * ## Why the coordinator owns it, rather than the host
   *
   * Because the rule is a property of how providers phrase errors and of the
   * session's own probe, and `CompactionPort` states that the engine forwards
   * the provider's text VERBATIM precisely so this side decides
   * (`ports.ts`, `CompactionObservation.providerError`). Re-deriving it in a
   * host would put two copies of the dual-evidence gate next to each other, and
   * a copy that lost the fail-closed arm would fire an emergency compaction for
   * a rate-limit message.
   *
   * ## The probe is best-effort and its failure is NOT an exception
   *
   * `projectInputMessages()` can throw, and the legacy swallows it into "no
   * local evidence" (`DuyaAgent.ts:3311-3319`). A throw here would abandon the
   * one pass that can still recover an explicit claim, so it is caught and
   * turns into a null probe.
   */
  decideEmergency(input: { turnCount: number; providerError: string | undefined }): RecoveryVerdict {
    const kind = classifyContextLengthError(input.providerError ?? '');

    // Probed for BOTH kinds, exactly as the legacy does: weak NEEDS it as
    // corroboration, and explicit takes it only so the caller's log can state
    // the measured context. Probing for explicit is therefore not what makes it
    // fire.
    let probe: CompactionProbe | null = null;
    if (kind !== null) {
      try {
        probe = this.deps.compactionManager.probeCompaction(
          this.deps.compactionController.projectInputMessages(),
        );
      } catch {
        probe = null;
      }
    }

    if (kind === 'explicit') {
      return { fire: true, imageTriggered: false, declinedBecause: null, classification: kind, probe };
    }
    if (kind === 'weak' && probe?.overTriggerLine === true) {
      return { fire: true, imageTriggered: false, declinedBecause: null, classification: kind, probe };
    }

    const declinedBecause =
      kind === null
        ? 'the provider error is not a context-length claim'
        : kind === 'weak' && probe === null
          ? 'weak context wording with no local corroboration (fail-closed)'
          : 'weak context wording, but the local projection is not over the trigger line';
    return {
      fire: false,
      imageTriggered: false,
      declinedBecause,
      classification: kind,
      probe,
    };
  }

  /**
   * The PREFLIGHT-OVERFLOW gate: after tool results land, is the projected
   * context past the point where one more request would be rejected?
   *
   * ## The line is the HARD limit, not the trigger line
   *
   * This is the one thing that makes it a different decision from the proactive
   * gate rather than a second copy of it. `decidePreTurn` compares against
   * `overTriggerLine` (max minus reserve, 78%); this compares against
   * `overHardLimit` (the full window). The legacy is explicit about why
   * (`DuyaAgent.ts:3001-3008`): a single tool call can blow past the 78% line
   * by itself, and waiting for the next turn's proactive check "risks a
   * `context_length_exceeded` round-trip" -- compacting here is cheaper than
   * retrying the turn. Checking the trigger line instead would decline in
   * exactly the window this path exists to catch.
   *
   * ## No cooldown here either, and no suppression
   *
   * Same reasoning as the emergency gate, and the same as the legacy: the
   * image arm below is what bypasses suppression on the PROACTIVE path, and
   * this path has no suppression ring at all. Nothing is re-pinned after a
   * compaction either -- `executeRecovery` deliberately does not write the
   * cooldown baseline, because the legacy's two inline paths do not, and adding
   * a pin would silently move the proactive gate's arithmetic for the NEXT
   * turn of the same run.
   */
  decidePreflightOverflow(input: { turnCount: number }): RecoveryVerdict {
    let probe: CompactionProbe | null = null;
    try {
      probe = this.deps.compactionManager.probeCompaction(
        this.deps.compactionController.projectInputMessages(),
      );
    } catch {
      probe = null;
    }

    // Fail-closed, and the same reason as the emergency gate's weak arm: no
    // probe means no evidence, and the legacy's `catch` here also falls
    // through to the next iteration rather than compacting blind.
    if (probe === null) {
      return {
        fire: false,
        imageTriggered: false,
        declinedBecause: 'the local projection could not be probed',
      };
    }
    if (probe.imageTriggered || probe.overHardLimit) {
      return {
        fire: true,
        // Carried so `executePreflightOverflow` can pass `force` through
        // exactly as the legacy does for the image arm (`DuyaAgent.ts:3423`).
        imageTriggered: probe.imageTriggered,
        declinedBecause: null,
      };
    }
    return {
      fire: false,
      imageTriggered: false,
      declinedBecause: 'under the hard limit',
    };
  }

  /**
   * Run the compaction a `decideEmergency` / `decidePreflightOverflow` verdict
   * authorised, and emit the same lifecycle the proactive half does.
   *
   * ## Why this is ONE method for two triggers rather than two
   *
   * The two paths differ only in the `trigger` they forward and whether the
   * image arm forces. Everything else -- the event buffer, the entry, the
   * re-projection -- is one statement in both inline legacy sites, and two
   * copies of the re-projection is exactly the drift this coordinator exists to
   * prevent. `force` is threaded rather than hardcoded so the image arm's
   * bypass is the CALLER's decision, matching `DuyaAgent.ts:3422-3426`.
   *
   * ## `force` is threaded rather than hardcoded, and it CHANGES the trigger
   *
   * The image arm of the preflight gate is the one case that forces, and the
   * legacy pairs `force: true` with `trigger: 'auto'` -- not with
   * `preflight_overflow` (`DuyaAgent.ts:3422-3426`). That pairing is not
   * cosmetic: `CompactionManager` only folds a failure into the suppression
   * ring when the trigger is `auto` (`CompactionManager.ts:941`), so an
   * image-triggered overflow that reported as `preflight_overflow` would stop
   * arming the ring that the proactive gate consults. `executeRecovery`
   * therefore derives the manager's trigger the way the legacy chose it, from
   * `force`, rather than forwarding its own name.
   *
   * ## The cooldown baseline is deliberately NOT re-pinned
   *
   * `executePreTurn` writes `setLastCompactionTurn` and the observed-token
   * anchor; this does not. That is not an oversight -- the legacy's emergency
   * (`:3758`) and preflight (`:3422`) call sites call `compactProactive`
   * directly and pin nothing. Pinning here would let an emergency compaction
   * reset the proactive cooldown, so the turn after a recovery could not
   * compact again for three more turns, on a transcript the provider had just
   * rejected once. Preserved as measured rather than tidied.
   */
  async executeRecovery(
    input: {
      turnCount: number;
      systemPromptContent: string;
      messages: Message[];
      trigger: 'emergency' | 'preflight_overflow';
      force: boolean;
    },
    onEvent?: (event: SSEEvent) => void,
  ): Promise<CompactionRunResult> {
    const { turnCount, trigger, force } = input;
    let { systemPromptContent, messages } = input;
    const events: SSEEvent[] = [];
    // Identical dual-path emit to `executePreTurn`: live when `onEvent` is
    // given, buffered otherwise. The live half is what keeps `compaction.step`
    // between `started` and `completed` -- the summarizer takes MINUTES, so a
    // buffered reporter would publish the terminal frame first.
    const emit = (event: SSEEvent) => {
      if (onEvent) onEvent(event);
      else events.push(event);
    };

    logger.info(`[Agent] Turn ${turnCount}: ${trigger} compaction triggered`);
    emit({ type: 'compact:start' } as unknown as SSEEvent);

    attachCompactionEventBuffer(this.deps.compactionManager, emit);
    try {
      const compactEntry = await this.deps.compactionController.compactProactive({
        // See the header: the legacy pairs `force` with `auto`, and only an
        // `auto` failure arms the suppression ring (`CompactionManager.ts:941`).
        ...(force ? { trigger: 'auto' as const, force: true } : { trigger }),
      });
      if (!compactEntry) {
        return {
          didCompact: false,
          imageTriggered: false,
          systemPromptContent,
          messages,
          events,
          entry: null,
        };
      }

      logger.info(
        `[Agent] Turn ${turnCount}: ${trigger} compaction succeeded, strategy=${compactEntry.strategy}, retained=${compactEntry.tokensAfter ?? 0} tokens`,
      );

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

      return {
        didCompact: true,
        imageTriggered: false,
        systemPromptContent,
        messages,
        events,
        entry: compactEntry,
      };
    } catch (compactError) {
      const compactErrorMsg =
        compactError instanceof Error ? compactError.message : String(compactError);
      logger.error(
        `[Agent] Turn ${turnCount}: ${trigger} compaction failed: ${compactErrorMsg}`,
      );
      emit({
        type: 'compact:error',
        data: { message: compactErrorMsg },
      } as unknown as SSEEvent);
      return {
        didCompact: false,
        imageTriggered: false,
        systemPromptContent,
        messages,
        events,
        entry: null,
      };
    }
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