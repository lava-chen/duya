/**
 * The host's `CompactionSources`, bound to the legacy `CompactionCoordinator`.
 *
 * ## Why this file exists rather than a line in a composition
 *
 * `buildCompactionPort` (`run-engine-ports.ts`) turns a SOURCE into the
 * runtime's `CompactionPort`, and A3-2a built it. What A3-2a could not build is
 * the other half: nothing in the tree supplied a `CompactionSources`, so the
 * port was required and universally faked. This file is that half -- the
 * adapter that reaches the legacy's own compaction rather than reimplementing
 * it.
 *
 * ## What it wraps, and why that is a WRAPPER
 *
 * `CompactionManager.compact` has ZERO production call sites in
 * `DuyaAgent.streamChat`. That is measured, and it is the reason this file does
 * not wrap it: the loop delegates the proactive pass to
 * `compactionCoordinator.runPreTurn` (`DuyaAgent.ts:2594`), and that single
 * call owns the prefire kick, the probe, the cooldown gate, the rearm
 * hysteresis, the suppression ring, the compaction itself, the cooldown
 * re-pinning, the timeline append and the post-compaction re-projection. The
 * coordinator IS the legacy's compaction decision, and wrapping anything
 * narrower would leave the gates behind.
 *
 * So the wrapper is the coordinator, split at the point the port needs:
 * `decide` is `decidePreTurn` and `compact` is `executePreTurn`. That split
 * was made ON THE COORDINATOR rather than here because the gate has to stay a
 * single authority -- `CompactionPort` splits decide from run (`ports.ts:2086`,
 * `:2102`), and a host that re-derived the cooldown arithmetic next to the
 * coordinator's would be two copies of one rule.
 *
 * ## Progress is forwarded LIVE, and that is structural rather than careful
 *
 * The legacy's progress events reach a caller through `onEvent`
 * (`CompactionCoordinator.ts:250-253`), which the coordinator calls
 * SYNCHRONOUSLY at the moment each event is produced -- including from the
 * manager's own event handler, mid-summarization (`:100`). This adapter's
 * `onEvent` calls `reporter` inline and returns. There is no queue, no array
 * and no flush, so a buffering bug is not something this code can express: it
 * would have to be written deliberately.
 *
 * The property that makes it matter is the legacy's own reason for the pump
 * (`DuyaAgent.ts:2583-2590`): the summarizer takes MINUTES, so a reporter
 * that flushed at the end would put `compaction.step` after
 * `compaction.completed`. The engine binds its reporter straight to
 * `events.publish` (`compaction.ts:150-152`), so a buffered adapter would
 * publish the terminal frame first and then the progress that belonged before
 * it.
 *
 * ## What is NOT carried, stated plainly
 *
 * Four things, each named here rather than discovered later:
 *
 * 1. **The re-projected system prompt.** `executePreTurn` returns
 *    `{ systemPromptContent, messages }` and the legacy assigns BOTH
 *    (`DuyaAgent.ts:2630-2631`). `CompactionOutcome` has a `replacement` and no
 *    system-prompt field, and `#modelRequest` takes `assembled.systemPrompt`
 *    verbatim (`run-engine.ts:2011`). So the post-compaction system prompt --
 *    the one that gains the entry's `reinjectedSystemMessages` -- does not
 *    reach the next request through this port. The transcript does; the system
 *    prompt does not. This is a property of the PORT SHAPE, not of this
 *    adapter, and it belongs to whoever changes `CompactionOutcome`.
 *
 * 2. **Two of the three decision points.** `runPreTurn` is the proactive
 *    (`auto`) pass, and A3-2b5 declined the other two BY NAME because the
 *    logic sat inline in the legacy's cycle body and nothing outside
 *    `streamChat` could reach it. It is now lifted onto the coordinator
 *    (`decideEmergency` / `decidePreflightOverflow`) and dispatched per trigger
 *    below, so all three reach this port. See `SERVED_TRIGGERS` and
 *    `UNCOVERED_TRIGGERS` for what is served and what is still not.
 *
 * 3. **`compact:summary_outcome`.** The coordinator forwards it
 *    (`CompactionCoordinator.ts:121-131`) and the inbound translator has an arm
 *    for it, but `CompactionProgress` has exactly two members -- `step` and
 *    `over_threshold` (`ports.ts:1998-2012`) -- and there is no arm for a
 *    summarizer retry report. It is dropped here, not buffered and not
 *    smuggled into a step.
 *
 * 4. **`compact:start` / `compact:done`.** Deliberately not forwarded: the
 *    engine mints `compaction.started` before it calls `run` and
 *    `compaction.completed` after (`compaction.ts:145`, `:157`), so forwarding
 *    the legacy's pair would publish each of them twice. The coordinator still
 *    EMITS them, because the legacy loop is still the thing driving production
 *    and reads them off the buffer.
 *
 * ## Why `noteUsage` is threaded rather than invented
 *
 * The port's `noteUsage` is optional and its absence is checkable
 * (`run-engine-ports.ts:518-526`). The legacy already has the exact statement
 * (`DuyaAgent.ts:3565`) and it is epoch-tagged for a reason the port restates
 * (`ports.ts:1979-1994`), so this adapter forwards the caller's anchor rather
 * than dropping it and letting the trigger fall back to the pre-plan-577
 * estimate. The caller supplies it; this file never mints an anchor.
 */

import type { CompactionDecision, CompactionProgress } from '@duya/agent-runtime';
import type { Message, SSEEvent } from '../types.js';
import type {
  CompactionCoordinator,
  CompactionRunResult,
  PreTurnVerdict,
  RecoveryVerdict,
} from '../agent/CompactionCoordinator.js';
import type { CompactionSources } from './run-engine-ports.js';
import { toRuntimeMessage } from './run-engine-ports.js';

/**
 * The triggers this source still does not serve, and the reason each reports.
 *
 * DOWN FROM FOUR TO TWO. `emergency` and `preflight_overflow` were here until
 * A3-2b6 and are served now, over their own coordinator gates
 * (`CompactionCoordinator.decideEmergency` / `.decidePreflightOverflow`).
 *
 * They are the two that MATTERED, and the reason is worth keeping in the file:
 * `emergency` is the recovery path for a provider that answered
 * `context_length_exceeded` (`ports.ts:2059-2073`). A silent decline there
 * reads as "the transcript is fine" for a run the provider had already
 * rejected. Leaving the reason string in place while the path is served would
 * have been the worst outcome -- a decline that names a gap which no longer
 * exists -- so it is deleted rather than kept as decoration.
 *
 * `model_switch` and `manual` remain. `model_switch` fires at the TOP of
 * `streamChat`, before the turn loop exists (`DuyaAgent.ts:1971-2026`), so the
 * engine has no spine point that could host it and it is not a
 * `CompactionPort` trigger at all; `manual` is a slash command handled outside
 * the loop entirely. Neither is a lost recovery path -- declining them is the
 * correct answer, and a named reason keeps that honest.
 */
const UNCOVERED_TRIGGERS: Readonly<Record<string, string>> = {
  model_switch: 'model-switch compaction is not served by the pre-turn coordinator',
  manual: 'manual compaction is not served by the pre-turn coordinator',
};

/**
 * The three triggers this source serves, each over its OWN coordinator gate.
 *
 * A set rather than three `===` comparisons because `decide` answers "is this
 * trigger mine?" for FIVE possible values, and a source that served three by
 * enumeration would silently decline a sixth trigger it had never heard of --
 * which is the exact silent-decline failure `UNCOVERED_TRIGGERS` exists to
 * prevent. A name the adapter does not claim gets the NAMED reason, never a
 * fallthrough to the proactive gate.
 *
 * Membership is `Set.has` and NOT `in`: `in` walks an object's own property
 * keys, so `'emergency' in new Set([...])` is `false` for every value and
 * EVERY trigger declines -- which is precisely the failure this slice exists
 * to remove, reintroduced by the membership test itself. Measured, not
 * asserted: the first run of the recovery suite failed all 24 of its
 * behavioural cases with the pre-A3-2b6 reason string.
 */
const SERVED_TRIGGERS: ReadonlySet<string> = new Set(['auto', 'emergency', 'preflight_overflow']);

/**
 * The per-run values the coordinator needs and the port cannot supply.
 *
 * Both are the LEGACY LOOP'S OWN locals (`DuyaAgent.ts:2597-2598` passes
 * `systemPromptContent` and `messages` straight into `runPreTurn`), and both
 * are read AT CALL TIME rather than captured: a compaction re-projects them, so
 * a captured copy would hand the second request of a run the first request's
 * transcript.
 *
 * They are accessors for that reason and not fields. `CompactionSources` is
 * built once per run and used for every compaction in it
 * (`LegacyEngineSources.compaction`, `run-engine-ports.ts:304`), so a snapshot
 * taken at construction would be stale by the second turn.
 */
export interface CoordinatorCompactionOptions {
  /** The per-session coordinator the legacy loop itself drives. */
  readonly coordinator: CompactionCoordinator;
  /** The run's current system prompt, read when a compaction runs. */
  readonly systemPromptContent: () => string;
  /** The run's current projected messages, read when a compaction runs. */
  readonly messages: () => readonly Message[];
  /**
   * Mints the id four of the five frames share.
   *
   * The HOST's to mint (`ports.ts:2107-2117`). Defaults to a uuid, which is the
   * same shape `MessageCompactionController` uses for a `CompactionEntry` id
   * and is deliberately a DIFFERENT value from it: the entry id and the frame
   * id are separate identities, and a host that drove both from one generator
   * would make `compactionId` and `boundaryId` collide on every compaction.
   */
  readonly nextCompactionId?: () => string;
  /**
   * Files the provider's real token usage against the compaction ledger.
   *
   * OPTIONAL, and its absence is meaningful rather than neutral: a source
   * without it gets a port WITHOUT the method
   * (`run-engine-ports.ts:589-596`), so the engine can tell a degraded
   * (estimated) trigger from an anchored one.
   */
  readonly noteUsage?: CompactionSources['noteUsage'];
}

/** The decision object both `decide` and `compact` are handed. */
type DecisionInput = Parameters<CompactionSources['decide']>[0];

/** The anchor `noteUsage` is handed. */
type UsageAnchor = Parameters<NonNullable<CompactionSources['noteUsage']>>[0];

/**
 * One legacy `compact:*` frame, in the shape the coordinator emits it.
 *
 * Declared here rather than imported because the coordinator casts these into
 * `SSEEvent` with `as unknown as SSEEvent` -- they are not members of that
 * union, so reading them through it would type every field as absent.
 */
interface CompactionWireEvent {
  readonly type: string;
  readonly data?: unknown;
}

/** `compact:step` -- the only frame that carries the summarizer's own progress. */
interface StepPayload {
  readonly step: number;
  readonly phase: string;
  readonly messageCount?: number;
  readonly tokensBefore?: number;
  readonly tokensEstimated?: number;
  readonly filesCached?: number;
}

/**
 * One `CompactionProgress`, or `null` for a frame that has no arm.
 *
 * The two members are the runtime's own (`ports.ts:1998-2012`), and they are
 * read off the wire shape rather than invented: `compaction.step` and
 * `compaction.over_threshold` are forwarded VERBATIM
 * (`compaction.ts:220-248`), so every optional member has to survive the hop
 * or the frame under-reports a summarization that actually happened.
 */
function toProgress(event: CompactionWireEvent): CompactionProgress | null {
  if (event.type === 'compact:step') {
    const data = (event.data ?? {}) as StepPayload;
    return {
      kind: 'step',
      step: data.step,
      phase: data.phase,
      // OMITTED rather than set to undefined: `exactOptionalPropertyTypes` is
      // on, and `progressFrame` spreads the same idiom (`compaction.ts:243`).
      ...(data.messageCount === undefined ? {} : { messageCount: data.messageCount }),
      ...(data.tokensBefore === undefined ? {} : { tokensBefore: data.tokensBefore }),
      ...(data.tokensEstimated === undefined ? {} : { tokensEstimated: data.tokensEstimated }),
      ...(data.filesCached === undefined ? {} : { filesCached: data.filesCached }),
    };
  }
  if (event.type === 'compact:over_threshold') {
    const data = (event.data ?? {}) as { tokensRetained: number; available: number };
    return {
      kind: 'over_threshold',
      tokensRetained: data.tokensRetained,
      available: data.available,
    };
  }
  return null;
}

/** The `compact:error` payload, read without widening the wire type. */
function toErrorMessage(event: CompactionWireEvent): string | null {
  if (event.type !== 'compact:error') return null;
  const data = (event.data ?? {}) as { message?: unknown };
  return typeof data.message === 'string' && data.message.length > 0
    ? data.message
    : 'compaction failed';
}

/**
 * Build the host's compaction source over the legacy coordinator.
 *
 * The verdict cache is a `WeakMap` keyed by the DECISION OBJECT, and that key
 * is the whole design. `runCompactionPass` passes one object to `decide` and
 * the same one to `run` (`compaction.ts:141`, `:154`) -- which is what lets
 * this adapter ask the gate ONCE and then run under the answer it acted on,
 * rather than probing a second time and possibly acting on a different answer
 * than the caller published `compaction.started` for.
 *
 * A `Map` keyed by turn number would be wrong in a way that is hard to see:
 * the engine calls `#compact` at three sites per turn (`run-engine.ts:579`,
 * `:677`, `:749`), and a turn-keyed cache would hand a later pass an earlier
 * pass's verdict.
 *
 * The `?? recompute` fallback is the same gate, so it is not a second
 * authority -- but it IS reported, because reaching it means `run` was called
 * on a decision this adapter never saw, and that is a wiring bug rather than
 * a normal path.
 */
export function buildCoordinatorCompactionSources(
  options: CoordinatorCompactionOptions,
): CompactionSources {
  const { coordinator, systemPromptContent, messages } = options;
  const nextCompactionId = options.nextCompactionId ?? (() => crypto.randomUUID());
  const noteUsage = options.noteUsage;
  const verdicts = new WeakMap<DecisionInput, PreTurnVerdict>();

  /**
   * Ask the coordinator the gate that OWNS this trigger.
   *
   * A per-trigger dispatch rather than one wide gate, because the three gates
   * are genuinely different statements -- `decidePreTurn` is over the trigger
   * line and behind a cooldown, `decidePreflightOverflow` is over the HARD
   * limit with no cooldown, `decideEmergency` is a classification of the
   * provider's own words (`CompactionCoordinator.ts`). Collapsing them into one
   * input would mean either widening the proactive gate until it fires on
   * conditions it was never written for, or re-deriving the emergency
   * classification here, which is the two-copies failure the coordinator's
   * existence is meant to prevent.
   *
   * The provider's text is forwarded VERBATIM and uninspected: the engine
   * copied it off the `error` frame and the classification is the HOST's rule
   * about how providers phrase errors (`ports.ts`, `CompactionObservation`).
   */
  const gate = (input: DecisionInput): RecoveryVerdict => {
    if (input.trigger === 'emergency') {
      return coordinator.decideEmergency({
        turnCount: input.turn,
        providerError: input.observation?.providerError,
      });
    }
    if (input.trigger === 'preflight_overflow') {
      return coordinator.decidePreflightOverflow({ turnCount: input.turn });
    }
    return coordinator.decidePreTurn({ turnCount: input.turn });
  };

  /**
   * Run the compaction, through the coordinator half that owns the trigger.
   *
   * `onEvent` is passed STRAIGHT through to the coordinator, which calls it
   * synchronously at the moment each event is produced -- including from the
   * manager's own handler, mid-summarization. Nothing here collects events or
   * defers a call, so a buffering bug is not something this file can express.
   *
   * `force` is read off the verdict rather than hardcoded, because the preflight
   * image arm is the one case that bypasses the strategy's own guards
   * (`DuyaAgent.ts:3423-3425`) and the emergency path never forces. Passing the
   * flag from the verdict keeps the bypass the GATE's decision instead of this
   * adapter's.
   */
  const execute = (
    input: DecisionInput,
    verdict: RecoveryVerdict,
    onEvent: (event: SSEEvent) => void,
  ): Promise<CompactionRunResult> => {
    const shared = {
      turnCount: input.turn,
      systemPromptContent: systemPromptContent(),
      messages: [...messages()],
    };
    if (input.trigger === 'emergency') {
      return coordinator.executeRecovery(
        { ...shared, trigger: 'emergency', force: false },
        onEvent,
      );
    }
    if (input.trigger === 'preflight_overflow') {
      return coordinator.executeRecovery(
        { ...shared, trigger: 'preflight_overflow', force: verdict.imageTriggered },
        onEvent,
      );
    }
    return coordinator.executePreTurn({ ...shared, verdict }, onEvent);
  };

  return {
    async decide(input): Promise<CompactionDecision> {
      if (!SERVED_TRIGGERS.has(input.trigger)) {
        // Named, not silent. See `UNCOVERED_TRIGGERS`.
        const reason =
          UNCOVERED_TRIGGERS[input.trigger] ??
          `compaction trigger ${input.trigger} is not served by the pre-turn coordinator`;
        return { kind: 'skip', reason };
      }
      const verdict = gate(input);
      verdicts.set(input, verdict);
      if (!verdict.fire) {
        return { kind: 'skip', reason: verdict.declinedBecause ?? 'the gate declined' };
      }
      return { kind: 'compact', trigger: input.trigger };
    },

    async compact(input, reporter, signal) {
      // Checked BEFORE the coordinator is touched. The summarizer runs behind
      // its own child abort controller (`DuyaAgent.ts:776-780`) and the port
      // cannot reach it, so an abort observed after the run started is not
      // something this adapter could act on -- and discarding a replacement
      // that DID happen would be worse than reporting it late.
      if (signal.aborted) return { kind: 'cancelled' };

      const verdict = verdicts.get(input) ?? gate(input);
      if (!verdict.fire) {
        return { kind: 'declined', reason: verdict.declinedBecause ?? 'the gate declined' };
      }

      // Live by construction: `onEvent` calls `reporter` inline and returns.
      // See this file's header -- there is no queue here to buffer into.
      let failure: string | null = null;
      const onEvent = (event: SSEEvent): void => {
        const wire = event as unknown as CompactionWireEvent;
        const progress = toProgress(wire);
        if (progress !== null) {
          reporter(progress);
          return;
        }
        // `compact:error` is how the legacy reports a failed compaction
        // (`CompactionCoordinator.ts:311-314`). It becomes the port's
        // `failed` arm rather than a decline, because a decline means
        // "chose not to compact" and this one DID try and could not -- and
        // because `failed` is the arm that publishes the terminal frame, so
        // a `compaction.started` can never be left without an ending.
        const message = toErrorMessage(wire);
        if (message !== null) failure = message;
      };

      const run: CompactionRunResult = await execute(input, verdict, onEvent);

      if (failure !== null) {
        return { kind: 'failed', error: { code: 'compaction_failed', message: failure } };
      }
      if (!run.didCompact || run.entry === null) {
        // The strategy returned its input unchanged (`compactProactive`
        // resolving `null`), so the transcript was not replaced. Reporting
        // `replaced` here would publish `compaction.completed` for work that
        // did not happen.
        return { kind: 'declined', reason: 'the strategy returned the transcript unchanged' };
      }

      return {
        kind: 'replaced',
        replacement: run.messages.map(toRuntimeMessage),
        // The boundary is the first message the timeline KEPT, which is what
        // `compaction.completed` means by it (`events/required.ts:184`). The
        // legacy's own `compact:done` carries no boundary at all, so the
        // inbound translator falls back to reusing `compactionId`
        // (`chat-event-translator.ts:734`); this is the real one.
        boundaryId: run.entry.firstKeptMessageId,
        compactedMessageIds: [...run.entry.compactedMessageIds],
        strategy: run.entry.strategy,
        tokensRemoved: run.entry.tokensBefore,
        ...(run.entry.tokensAfter === undefined ? {} : { tokensRetained: run.entry.tokensAfter }),
      };
    },

    nextCompactionId: () => nextCompactionId(),
    ...(noteUsage === undefined
      ? {}
      : {
          noteUsage: (anchor: UsageAnchor) => {
            noteUsage(anchor);
          },
        }),
  };
}
