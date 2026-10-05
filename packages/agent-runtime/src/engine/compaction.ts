/**
 * The compaction seam: the ONE producer of the five `compaction.*` frames, and
 * the ONE place a compaction result becomes the transcript the next request is
 * built from.
 *
 * ## Why this file exists rather than a method on the engine
 *
 * `packages/agent-runtime/src/engine/ports.ts` declares `CompactionPort`; this
 * file is what an engine (or a host driving the port directly) calls to get a
 * transcript replacement and the frames that describe it. It is deliberately a
 * standalone module with no dependency on `RunEngineImpl`, because the loop
 * call site that will consume it is not in this slice -- see "The engine call
 * site this slice does NOT make" below, which names the exact file and method.
 *
 * Keeping it separate is also what makes the two properties this slice must
 * prove testable without a run at all: that a REPLACEMENT reaches the next
 * request, and that each of the five frames has a producer.
 *
 * ## The five frames, and where each one comes from
 *
 * | frame | produced by | source |
 * | --- | --- | --- |
 * | `compaction.started` | `#startedFrame` | the id from `nextCompactionId()`, the trigger from the decision |
 * | `compaction.step` | `#stepFrame` | `onProgress({ kind: 'step' })`, forwarded verbatim |
 * | `compaction.over_threshold` | `#overThresholdFrame` | `onProgress({ kind: 'over_threshold' })`, forwarded verbatim |
 * | `compaction.completed` | `#completedFrame` | `CompactionOutcome` `{ kind: 'replaced' }` |
 * | `compaction.failed` | `#failedFrame` | `CompactionOutcome` `{ kind: 'failed' \| 'cancelled' }` |
 *
 * Every one of those five is a member of the protocol registry
 * (`packages/agent-protocol/src/events/registry.ts:222-226`) and every one has
 * an arm in the projector (`src/project/legacy-sse-projector.ts:201-231`) and in
 * the inbound translator (`src/translate/chat-event-translator.ts:694-744`).
 * Before this file existed they had all three and NO PRODUCER -- the legacy
 * loop emits them as raw `compact:*` SSE frames, which is why the translator
 * exists; the engine emitted none, and the projector was unreachable.
 *
 * ## The step is WHEREVER THE PORT SAYS, and that is stated, not assumed
 *
 * `compaction.step` and `compaction.over_threshold` are VOLATILE
 * (`registry.ts:223`, `:226`) and arrive DURING the summarizer call, which
 * takes minutes. They are published from the `onProgress` callback the port is
 * handed, so they are produced while the compaction is still running -- which
 * is the property the legacy's real-time pump was written to preserve
 * (`DuyaAgent.ts:2144-2151`: buffering them made the renderer see nothing for
 * minutes and then every row at once).
 *
 * The three terminal frames are reported AFTER the port answers, because that
 * is the only moment the answer exists. That is a deliberate consequence and
 * not a compromise: `compaction.completed` needs a `boundaryId` and a
 * `compactedMessageIds` list (`events/required.ts:181-185`) that only a
 * finished compaction can supply.
 *
 * ## What absence costs, stated exactly (and measured, not asserted)
 *
 * With no port bound, `runCompactionPass` cannot be given a replacement and
 * returns `{ kind: 'unbound' }`. That is a DISTINCT outcome rather than a
 * `declined`, because declining is a decision made by a bound port that
 * examined the transcript and chose not to compact, while `unbound` means
 * nobody was asked. Collapsing them would make "nothing was configured" and
 * "the configured thing said no" indistinguishable at every call site -- and
 * the first is a wiring bug while the second is normal operation.
 *
 * Classification against the b3a/b3b precedent: **a forgotten binding loses
 * data.** Nothing shrinks the transcript, so it grows past the window, the
 * provider answers `context_length_exceeded`, and the emergency compaction that
 * exists to recover from precisely that error (`DuyaAgent.ts:3360`) has no port
 * to call. A forgotten GUARDRAIL, by contrast, would be a bound-but-ignored
 * port, which loses nothing today because the legacy loop still drives every
 * turn and still compacts on its own.
 *
 * ## G1: this file imports nothing from `packages/agent` or `packages/ai`
 *
 * The summarization is a `OneShotTextPort` call made by the HOST's
 * implementation of `CompactionPort.run`, not by this seam. `OneShotTextPort`
 * is the runtime-side port b1 built for exactly that call
 * (`ports.ts`, and `DuyaAgent.ts:783` where the summarizer is already wired
 * through it), and it is TOOL-FREE by construction -- `toolChoice: 'none'
 * unconditionally, the plan-523 P4.1 fix, guarded in `port-guards.ts`. A
 * compaction port that carried its own model call would duplicate that surface
 * and risk reintroducing the tool-calling summarizer.
 */

import type { RunEvent } from '@duya/agent-protocol';
import type {
  CompactionDecisionInput,
  CompactionOutcome,
  CompactionPort,
  CompactionProgress,
  ModelMessage,
  RunEventStorePort,
} from './ports.js';

/** What a pass produced. `unbound` and `declined` are NOT the same answer. */
export type CompactionPassResult =
  | {
      readonly kind: 'replaced';
      /** The transcript the NEXT request must be built from. */
      readonly transcript: readonly ModelMessage[];
      readonly compactionId: string;
      readonly boundaryId: string;
      readonly compactedMessageIds: readonly string[];
    }
  | { readonly kind: 'declined'; readonly reason: string }
  | { readonly kind: 'failed'; readonly compactionId: string; readonly message: string }
  | { readonly kind: 'cancelled'; readonly compactionId: string }
  | { readonly kind: 'unbound' };

/** Everything one pass needs. `port` absent is the unbound case, not a throw. */
export interface CompactionPassInput {
  readonly port: CompactionPort | undefined;
  readonly events: RunEventStorePort;
  readonly decision: CompactionDecisionInput;
  readonly signal: AbortSignal;
}

/**
 * Run one compaction pass and publish its frames.
 *
 * Ordering is the legacy's own (`CompactionCoordinator.ts:258`, `:295`, `:311`
 * and the live pump at `DuyaAgent.ts:2171-2180`): `started` first, then the
 * progress frames as the port reports them, then exactly ONE terminal frame.
 * A pass that published two terminals, or none, would leave a consumer holding
 * a compaction that never finished.
 */
export async function runCompactionPass(input: CompactionPassInput): Promise<CompactionPassResult> {
  const { port, events, decision, signal } = input;

  if (port === undefined) return { kind: 'unbound' };

  // The DECISION is a separate await from the run, matching the legacy, where
  // the probe and the compact call are separate statements with a decision
  // between them (`DuyaAgent.ts:3018` then `:3022`). Publishing `started`
  // before the decision would announce a compaction that then declines.
  const verdict = await port.decide(decision);
  if (verdict.kind === 'skip') return { kind: 'declined', reason: verdict.reason };

  const compactionId = port.nextCompactionId();
  events.publish(startedFrame(compactionId, verdict.trigger));

  // Progress is forwarded through the SAME function that publishes the two
  // volatile frames, so a step and an over_threshold reading cannot take
  // different paths to the wire.
  const onProgress = (progress: CompactionProgress): void => {
    events.publish(progressFrame(compactionId, progress));
  };

  const outcome: CompactionOutcome = await port.run(decision, onProgress, signal);

  if (outcome.kind === 'replaced') {
    events.publish(
      completedFrame(compactionId, {
        boundaryId: outcome.boundaryId,
        compactedMessageIds: outcome.compactedMessageIds,
        ...(outcome.strategy === undefined ? {} : { strategy: outcome.strategy }),
        ...(outcome.tokensRemoved === undefined ? {} : { tokensRemoved: outcome.tokensRemoved }),
        ...(outcome.tokensRetained === undefined ? {} : { tokensRetained: outcome.tokensRetained }),
      }),
    );
    return {
      kind: 'replaced',
      // The transcript travels OUT, not in. This is the load-bearing line of
      // the whole slice: it is the only value a caller needs in order to build
      // the next request from the compacted history instead of the original.
      transcript: outcome.replacement,
      compactionId,
      boundaryId: outcome.boundaryId,
      compactedMessageIds: outcome.compactedMessageIds,
    };
  }

  if (outcome.kind === 'failed') {
    events.publish(failedFrame(compactionId, outcome.error.message, outcome.error.code));
    return { kind: 'failed', compactionId, message: outcome.error.message };
  }

  if (outcome.kind === 'cancelled') {
    // Reported through the SAME `compaction.failed` frame, and that is a
    // protocol fact rather than a local choice: the registry lists five
    // compaction members and none of them is a cancellation
    // (`registry.ts:222-226`). A cancel is still a compaction that did not
    // produce a boundary, and the frame's own description says so --
    // "Compaction failed; transcript unchanged" (`:225`) -- which is exactly
    // true here.
    events.publish(failedFrame(compactionId, 'compaction cancelled', 'compaction_cancelled'));
    return { kind: 'cancelled', compactionId };
  }

  return { kind: 'declined', reason: outcome.reason };
}

/**
 * `compaction.started`. Required: `compactionId`, `trigger`
 * (`events/required.ts:168`).
 *
 * Exported separately from the pass so the frame can be built and asserted on
 * its own; each builder is the single producer of its frame, which is what
 * makes "drop this frame" a mutation a test can catch.
 */
export function startedFrame(compactionId: string, trigger: CompactionDecisionInput['trigger']): RunEvent {
  return {
    type: 'compaction.started',
    compactionId,
    // The protocol narrows `trigger` to `'auto' | 'manual' | 'threshold'`
    // (`payloads.ts:550`) while the port keeps the legacy's five
    // (`compact/types.ts:63`). Three of the five have no wire spelling, so the
    // narrowing happens HERE rather than in the port -- a host that saw a
    // squashed trigger could no longer tell `emergency` from `preflight_overflow`,
    // and those two are exactly the paths that must not be confused.
    trigger: trigger === 'manual' ? 'manual' : trigger === 'auto' ? 'auto' : 'threshold',
  };
}

/** `compaction.step` or `compaction.over_threshold`, forwarded verbatim. */
export function progressFrame(compactionId: string, progress: CompactionProgress): RunEvent {
  if (progress.kind === 'over_threshold') {
    // The one payload in the family with NO `compactionId`
    // (`events/required.ts:188`): it is a reading about the window, not about
    // one compaction. Adding the id would be an undeclared field, and the
    // translator's own output for `compact:over_threshold` omits it too
    // (`chat-event-translator.ts:717-722`).
    return {
      type: 'compaction.over_threshold',
      tokensRetained: progress.tokensRetained,
      available: progress.available,
    };
  }
  return {
    type: 'compaction.step',
    compactionId,
    step: progress.step,
    phase: progress.phase,
    // Optional members are OMITTED rather than set to undefined, because
    // `exactOptionalPropertyTypes` is on and an explicit `undefined` is not the
    // same as an absent key. The same idiom the engine uses for the per-request
    // cap (`run-engine.ts:382-384`).
    ...(progress.messageCount === undefined ? {} : { messageCount: progress.messageCount }),
    ...(progress.tokensBefore === undefined ? {} : { tokensBefore: progress.tokensBefore }),
    ...(progress.tokensEstimated === undefined ? {} : { tokensEstimated: progress.tokensEstimated }),
    ...(progress.filesCached === undefined ? {} : { filesCached: progress.filesCached }),
  };
}

/** What a `replaced` outcome contributes to `compaction.completed`. */
export interface CompletedFacts {
  readonly boundaryId: string;
  readonly compactedMessageIds: readonly string[];
  readonly strategy?: string;
  readonly tokensRemoved?: number;
  readonly tokensRetained?: number;
}

/**
 * `compaction.completed`. Required: `compactionId`, `boundaryId`,
 * `compactedMessageIds` (`events/required.ts:178-186`).
 *
 * `removedCount` is deliberately NOT derived here. The protocol accepts it
 * (`payloads.ts:568`) and the legacy can supply it, but deriving it as
 * `compactedMessageIds.length` would assert a count the engine never measured
 * -- it is handed a list, and how many MESSAGES that is versus how many the
 * compaction removed are different quantities, in the same way `results` and
 * `dispatched` are (`TurnOutputSummary`).
 */
export function completedFrame(compactionId: string, facts: CompletedFacts): RunEvent {
  return {
    type: 'compaction.completed',
    compactionId,
    boundaryId: facts.boundaryId,
    compactedMessageIds: facts.compactedMessageIds,
    ...(facts.strategy === undefined ? {} : { strategy: facts.strategy }),
    ...(facts.tokensRemoved === undefined ? {} : { tokensRemoved: facts.tokensRemoved }),
    ...(facts.tokensRetained === undefined ? {} : { tokensRetained: facts.tokensRetained }),
  };
}

/**
 * `compaction.failed`. Required: `compactionId`, `error`
 * (`events/required.ts:187`).
 *
 * `code` is a required member of the error OBJECT (`payloads.ts:575`), so it
 * is supplied even though the inbound path hardcodes one
 * (`chat-event-translator.ts:727`). A defaulted code is honest here: the port
 * is the authority on its own failure and this is the fallback when it named
 * no better one.
 */
export function failedFrame(compactionId: string, message: string, code = 'compaction_failed'): RunEvent {
  return { type: 'compaction.failed', compactionId, error: { code, message } };
}
