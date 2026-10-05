/**
 * Compile-time assertions about the `RunEngine` port contract.
 *
 * ## Why these live in `src/` and not in `test/`
 *
 * Every package's tsconfig excludes `test/`, so a type assertion in a test
 * directory is checked by nothing -- `src/index.ts:322-323` records the same
 * observation for the transport guards. A negative type assertion that nobody
 * compiles is not an assertion, it is a comment with worse ergonomics, so the
 * negative cases are here, where `npm run typecheck:runtime` sees them, and
 * `test/engine-ports.test.ts` asserts only what is observable at run time.
 *
 * ## Why `@ts-expect-error` is the right tool here
 *
 * It is self-policing: TypeScript reports an error when a directive stops
 * suppressing one. So each negative case below is a MUTATION PROOF, not a
 * snapshot. Widening `RunEventStorePort` with a `seq` parameter, making
 * `RunExecutionRequest.signal` optional, or letting an approval verdict carry a
 * `recorded` field all turn this file red on the next `npm run typecheck:runtime`
 * -- which is the property plan 600 `04` section 6 says the gates have been
 * missing ("the completed mutation proofs only cover the half where breaking the
 * detector makes the test red").
 *
 * Each case is also phrased to fail for the RIGHT reason: the annotation is
 * attached to the exact expression that must not compile, and the positive
 * cases below it prove the ports are still constructible, so a red build means
 * "the contract closed" rather than "the contract is unusable".
 */

import type { RunEvent } from '@duya/agent-protocol';
import type {
  ApprovalVerdict,
  AssistantMessageRecord,
  CompactionOutcome,
  CompactionPort,
  CompactionProgress,
  ModelFrame,
  ModelMessage,
  ModelRequest,
  OneShotTextPort,
  OneShotTextRequest,
  OneShotTextResult,
  RunEngine,
  RunEnginePorts,
  RunEventStorePort,
  RunExecutionRequest,
  SubtaskTerminationReason,
  ToolDrainItem,
  ToolOutcome,
  ToolResultRecord,
  TurnOutputPort,
  TurnOutputSummary,
} from './ports.js';

// ---------------------------------------------------------------------------
// Positive: the port is CONSTRUCTIBLE.
//
// If any of these stopped compiling, the contract would be unimplementable, and
// the negative cases below would be passing for the wrong reason.
// ---------------------------------------------------------------------------

/** The five mandatory sub-ports, built with the smallest legal members. */
const MINIMAL_PORTS: RunEnginePorts = {
  model: {
    stream(_request, _signal) {
      return (async function* (): AsyncIterable<ModelFrame> {
        // one frame, then the stop the loop branches on
        yield { type: 'turn_stopped', reason: 'end_turn' };
      })();
    },
  },
  tools: {
    dispatch() {},
    drain() {
      return (async function* (): AsyncIterable<ToolDrainItem> {
        // an empty drain is a legal turn
      })();
    },
    discard() {},
    describe: () => [],
  },
  context: {
    assemble: () =>
      Promise.resolve({
        systemPrompt: '',
        messages: [],
        tools: [],
        catalogRevision: 'rev-0',
        revision: 'rev-0',
      }),
    defer() {},
  },
  approval: {
    authorize: () => Promise.resolve({ allowed: true, scope: 'once' } as const),
  },
  events: {
    publish() {},
    proposeTerminal() {},
  },
};

/** An engine is one method returning one handle. */
const MINIMAL_ENGINE: RunEngine = {
  execute(_request: RunExecutionRequest) {
    throw new Error('not run; this file asserts types, not behaviour');
  },
};

// Referenced so a `noUnusedLocals` tightening cannot silently drop them.
export const PORT_IS_CONSTRUCTIBLE = [MINIMAL_PORTS, MINIMAL_ENGINE] as const;

/**
 * The optional ports are OPTIONAL, and the required five are the only required
 * ones. Positive half of the split, so the negative half below can be read as
 * "and nothing else became mandatory".
 */
const FULL_PORTS: RunEnginePorts = {
  ...MINIMAL_PORTS,
  budget: {
    budget: { maxTurns: 10 },
    spend: () => ({ turns: 0, toolCalls: 0, tokens: 0 }),
    evaluate: () => ({ exhausted: false, breaches: [] }),
  },
  attempt: {
    acquire: () => Promise.resolve({ runId: 'r', runEpoch: 1, token: 1 }),
    release: () => Promise.resolve(),
    current: () => Promise.resolve(null),
  },
  subtasks: {
    register: () => ({
      terminate: () =>
        Promise.resolve({ subtaskId: 's', reason: 'parent_cancel' as const, outcome: 'killed' as const }),
    }),
    terminateAll: () => Promise.resolve([]),
    list: () => [],
  },
  extensions: {
    list: () => [],
    unload: () => Promise.resolve(),
  },
  checkpoints: {
    commit: () => Promise.resolve({ applied: true }),
    latest: () => Promise.resolve(null),
    attempts: () => Promise.resolve([]),
  },
  sideEffects: {
    begin: (call) =>
      Promise.resolve({
        attemptKey: `k:${call.callId}`,
        runId: 'r',
        runEpoch: 1,
        fence: { runId: 'r', runEpoch: 1, token: 1 },
      }),
    settle: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
    read: () => Promise.resolve([]),
  },
  turnOutput: {
    recordToolResult: () => Promise.resolve(),
    recordAssistantMessage: () => Promise.resolve(),
    finishTurn: () => Promise.resolve(),
  },
};

export const OPTIONAL_PORTS_ARE_OPTIONAL = FULL_PORTS;

// ---------------------------------------------------------------------------
// Distributive key probes.
//
// `keyof (A | B)` yields only the keys A and B SHARE, so a plain `keyof` over a
// union would report `never` even if ONE member had the forbidden field. The
// conditional type below distributes over the union instead, which is what
// makes these assertions mutation-sensitive rather than accidentally-true.
// ---------------------------------------------------------------------------

type KeysOfEveryMember<T> = T extends unknown ? keyof T : never;

/** `'seq'` if ANY member of `T` carries a `seq`; `never` if none does. */
type SeqOn<T> = Extract<KeysOfEveryMember<T>, 'seq'>;

/** `'recorded'` if ANY member of `T` carries one; `never` if none does. */
type RecordedOn<T> = Extract<KeysOfEveryMember<T>, 'recorded'>;

// --- Contract 1e / 04 section 2.2: the engine cannot mint a `seq` ------------

/**
 * Assigning `'seq'` only compiles if some `RunEvent` member grew a `seq`, in
 * which case this directive goes UNUSED and the build fails. That is the
 * assertion: not "there is no seq today" but "adding one is red".
 */
// @ts-expect-error - no member of the `RunEvent` union carries `seq`
const RUN_EVENT_CARRIES_NO_SEQ: SeqOn<RunEvent> = 'seq';

/** Same rule for the tool outcome the engine feeds back to the model. */
// @ts-expect-error - a `ToolOutcome` is a model input, never an ordered event
const TOOL_OUTCOME_CARRIES_NO_SEQ: SeqOn<ToolOutcome> = 'seq';

// ---------------------------------------------------------------------------
// Contract 1b / the drain: the union is CLOSED, and only one member is a result
// ---------------------------------------------------------------------------

/**
 * The drained kinds are exactly these three.
 *
 * Phrased so that a FOURTH kind is red, not "there are three today". `#drainOutcomes`
 * switches on `item.kind` with no `default`, so a new member turns the engine's
 * own typecheck red at the drain -- which is the whole reason the union is
 * discriminated instead of being three optional fields on one interface.
 *
 * The polarity matches the `SeqOn` guards above and is worth stating, because
 * getting it backwards produces a guard that is green in BOTH states: the
 * conditional yields `never` while the set is closed, so the assignment is an
 * error and the directive is used; add a kind and the conditional yields
 * `'unexpected-kind'`, the assignment becomes legal, the directive goes unused
 * and the build fails.
 */
type DrainKindGuard = ToolDrainItem['kind'] extends
  | 'tool_result'
  | 'deferred_context'
  | 'subagent_progress'
  ? never
  : 'unexpected-kind';
// @ts-expect-error - a fourth drained kind must break the engine's switch
const DRAIN_KIND_SET_IS_CLOSED: DrainKindGuard = 'unexpected-kind';

/**
 * A progress frame carries no `content`, so it cannot become model input.
 *
 * This is the leak guard at the type level rather than the behavioural one in
 * `test/tool-drain-contract.test.ts`. `content` is what `#drainOutcomes` turns
 * into a message for the model, so a member that lacked it could not be fed
 * back even by an adapter that ignored `kind` -- and an adapter that ignored
 * `kind` would already have no `content` to forward.
 */
type ProgressCarriesContent = Extract<ToolDrainItem, { kind: 'subagent_progress' }> extends {
  content: unknown;
}
  ? true
  : false;
// @ts-expect-error - a `subagent_progress` item has no `content` to feed the model
const SUBAGENT_PROGRESS_HAS_NO_CONTENT: ProgressCarriesContent = true;

/**
 * A deferred context cannot be handed over already resolved.
 *
 * The rule is not stylistic. `TransientContextFragment` has both a `text` and a
 * `pending` arm precisely so that a caller states which one it has; an adapter
 * that filled in `text` from an `await` would have moved the wait into the
 * drain loop, and the guard makes that a build error rather than a stalled turn
 * found in production.
 */
type DeferredIsResolved = Extract<ToolDrainItem, { kind: 'deferred_context' }> extends {
  pending: Promise<unknown>;
}
  ? true
  : false;
// @ts-expect-error - a deferred context must stay pending until the next assembly
const DEFERRED_CONTEXT_IS_PENDING: DeferredIsResolved = false;

/**
 * The store's surface has no seq allocator, so an executor cannot even name one.
 *
 * Checked through the method set rather than the event shape, because a
 * `mintSeq(): number` on the port would be reachable even with a seq-free event.
 */
// @ts-expect-error - the port exposes no `seq`/`mintSeq`/`nextSeq` allocator
const STORE_EXPOSES_NO_SEQ_ALLOCATOR: Extract<
  keyof RunEventStorePort,
  'seq' | 'mintSeq' | 'nextSeq' | 'allocateSeq' | 'reserveSeq'
> = 'mintSeq';

/**
 * The request an engine is given cannot smuggle a `seq` in either.
 *
 * `Pick<..., 'seq'>` is the object-literal form of the excess-property check:
 * the error is "no `seq` in `RunExecutionRequest`", stated once, rather than a
 * deep assignability failure somewhere else in the object.
 */
// @ts-expect-error - `RunExecutionRequest` has no `seq`; the emitter mints it
const NO_SEQ_IS_HANDED_IN: Pick<RunExecutionRequest, 'seq'> = { seq: 1 };

/**
 * The store's surface is EXACTLY these two calls.
 *
 * Positive rather than negative, because "the port offers no settle" is a claim
 * about the absence of a method, and the allocator probe above only covers
 * seq-shaped names. A new `settle` / `complete` / `finalize` would make this
 * `never` and the assignment below would fail.
 */
type SettleIsAbsent = keyof RunEventStorePort extends 'settle' | 'complete' | 'finalize' ? never : true;

export const STORE_SURFACE_IS_EXACT: SettleIsAbsent = true;

// --- Contract 1d: the engine asks for approval and does not record it -------

/**
 * The verdict carries no `recorded` flag, which is the type-level form of "the
 * durable write is the Control Plane's". If an adapter ever grew one, the engine
 * could start reading an audit fact it has no business holding.
 */
// @ts-expect-error - an approval verdict is a decision, never an audit receipt
const APPROVAL_VERDICT_CARRIES_NO_RECORD: RecordedOn<ApprovalVerdict> = 'recorded';

// --- Contract 1 / the cancellation fix: the signal is REQUIRED -------------

/**
 * `RunExecutionRequest.signal` is caller-owned and mandatory, which is what
 * makes pre-model work cancellable. `DuyaAgent.streamChat` builds its own
 * `AbortController` at its first line (`DuyaAgent.ts:963`), so a port that
 * created its own would leave context assembly outside cancellation. Making
 * this optional would silently reintroduce that gap.
 */
// @ts-expect-error - `signal` is required: an engine may not own cancellation
const SIGNAL_IS_REQUIRED: Pick<RunExecutionRequest, 'signal'> = {};

// --- Contract 3: the fence is ACQUIRED, never handed in ---------------------

/**
 * `RunExecutionRequest` carries no fence, because the STORE mints it
 * (`checkpoint-store.ts:258-263`) and a fence supplied from outside would be a
 * second authority. A host that could pass one could pin a stale attempt.
 */
// @ts-expect-error - there is no `fence` field; the engine acquires one
const NO_FENCE_IS_HANDED_IN: Pick<RunExecutionRequest, 'fence'> = { fence: { runId: 'r', runEpoch: 1, token: 1 } };

// --- Contract 5: the widened reason union, and no old vocabulary in it -----

/**
 * The four reasons that have no home in today's three-value union. If any is
 * dropped, a budget kill becomes indistinguishable from a user cancel in the
 * durable record (`BackgroundAgentLifecycle.ts:199` writes `killed: ${reason}`).
 */
export const SUBTASK_REASONS_COVER_PARENT_FAILURE: Extract<
  SubtaskTerminationReason,
  'parent_cancel' | 'parent_failure' | 'budget_exhausted' | 'app_exit'
> = 'budget_exhausted';

/**
 * And the old vocabulary did not leak in: `user_kill` is the sub-agent panel's
 * button, not a parent-initiated termination, and keeping it would give one
 * meaning two spellings.
 */
// @ts-expect-error - `user_kill` is a UI action, not a `SubtaskTerminationReason`
const NO_USER_KILL_REASON: Extract<SubtaskTerminationReason, 'user_kill'> = 'user_kill';

// --- Contract 1f: the turn output is a PROJECTION, never a ledger entry -----

/**
 * Positive half first, for the same reason `MINIMAL_PORTS` exists: a negative
 * assertion over a type that cannot be built would pass for the wrong reason.
 *
 * Every member here is a promise the engine makes to the host. `recordToolResult`
 * is AWAITED by `#drainOutcomes`, so the `Promise<void>` is load-bearing rather
 * than an erased async marker -- a host that returned `void` where the engine
 * awaits would typecheck only if the method were declared differently, which is
 * the change this case is here to catch. `recordAssistantMessage` is awaited the
 * same way and for the same reason.
 */
export const TURN_OUTPUT_PORT_IS_CONSTRUCTIBLE: TurnOutputPort = {
  recordToolResult: () => Promise.resolve(),
  recordAssistantMessage: () => Promise.resolve(),
  finishTurn: () => Promise.resolve(),
};

/**
 * No `seq` on either payload.
 *
 * The legacy assigns `result.message.seq_index = seqIndex`
 * (`DuyaAgent.ts:2723`), and reproducing that field here would make the runtime
 * a second authority for "where does this message sit" -- the same reason
 * `RunEvent` carries no `seq` (`ports.ts:47-50`). Ordering is the host's, derived
 * from `turn`.
 */
type SeqOnToolResultRecord = Extract<KeysOfEveryMember<ToolResultRecord>, 'seq'>;

// @ts-expect-error - a landed result is not an ordered ledger event
const TOOL_RESULT_RECORD_CARRIES_NO_SEQ: SeqOnToolResultRecord = 'seq';
// @ts-expect-error - the turn summary is not an ordered ledger event either
const TURN_OUTPUT_SUMMARY_CARRIES_NO_SEQ: Extract<KeysOfEveryMember<TurnOutputSummary>, 'seq'> =
  'seq';

/**
 * No `runId`: the PORT is bound to one run, exactly as `events` is.
 *
 * `RunExecutionRequest.ports` is documented as "supplied per run, not per
 * process", so the binding already carries the identity. A `runId` parameter
 * would be a second, independently-passable copy of it -- and the one a caller
 * could get wrong.
 */
// @ts-expect-error - the port binding names the run; the payload need not repeat it
const TOOL_RESULT_RECORD_CARRIES_NO_RUN_ID: Extract<
  KeysOfEveryMember<ToolResultRecord>,
  'runId'
> = 'runId';
// @ts-expect-error - nor does the summary
const TURN_OUTPUT_SUMMARY_CARRIES_NO_RUN_ID: Extract<KeysOfEveryMember<TurnOutputSummary>, 'runId'> =
  'runId';

/**
 * No `id`, so durable identity stays with the writer that stores it.
 *
 * The legacy mints `crypto.randomUUID()` when a result has no id
 * (`DuyaAgent.ts:2724-2726`) and then hands the message to `_pushDurable`
 * (`:3515`), which is the thing that journals it. An engine that minted the id
 * would put the identity's authority in a layer that cannot see whether the
 * write landed.
 */
// @ts-expect-error - a durable message id belongs to the durable writer
const TOOL_RESULT_RECORD_CARRIES_NO_ID: Extract<KeysOfEveryMember<ToolResultRecord>, 'id'> = 'id';

/**
 * The same three absences hold for the ASSISTANT MESSAGE record, and the
 * third one is the one that is easy to get wrong.
 *
 * `messageId` is not `id`. It is a run-scoped CORRELATION id -- the value the
 * event stream keys its block map and its finalized map by
 * (`replay/transcript-snapshot.ts:195-200`) -- while the durable row's id is
 * `?? crypto.randomUUID()` (`DuyaAgent.ts:2678`) and belongs to whoever stores
 * the row. Asserting on the exact member name rather than "no id-ish field" is
 * what keeps the two from drifting into one another: a rename of the
 * correlation field to plain `id` is what these probes are here to catch.
 */
// @ts-expect-error - the assembled message is not an ordered ledger event
const ASSISTANT_MESSAGE_RECORD_CARRIES_NO_SEQ: Extract<
  KeysOfEveryMember<AssistantMessageRecord>,
  'seq'
> = 'seq';
// @ts-expect-error - nor does the record repeat the port binding's run id
const ASSISTANT_MESSAGE_RECORD_CARRIES_NO_RUN_ID: Extract<
  KeysOfEveryMember<AssistantMessageRecord>,
  'runId'
> = 'runId';
// @ts-expect-error - `messageId` correlates events; the row id is the writer's
const ASSISTANT_MESSAGE_RECORD_CARRIES_NO_ID: Extract<
  KeysOfEveryMember<AssistantMessageRecord>,
  'id'
> = 'id';

/**
 * The surface cannot express a terminal decision.
 *
 * Positive rather than negative, for the reason `STORE_SURFACE_IS_EXACT` gives:
 * "the port offers no settle" is a claim about an ABSENCE, and a conditional
 * type is what turns that absence into a build failure the day a method named
 * `settle`/`proposeTerminal`/`finalize` appears.
 */
type TurnOutputCannotSettle =
  keyof TurnOutputPort extends 'settle' | 'proposeTerminal' | 'finalize' | 'complete' ? never : true;

// @ts-expect-error - only a projection host; the terminal stays with `RunSession.settle`
export const TURN_OUTPUT_SURFACE_CANNOT_SETTLE: TurnOutputCannotSettle = false;

/**
 * The two counts are separate FIELDS, not one aliased number.
 *
 * `results` is the legacy `toolResultMessageCount` (`DuyaAgent.ts:2722`) and
 * `dispatched` is `TurnWork.dispatched` (`run-engine.ts:805`); they diverge the
 * moment a turn dispatches two calls and one answers. Collapsing them into one
 * field would make the host's gate a dispatch count with no way to tell.
 */
type SummaryCountsResults = 'results' extends keyof TurnOutputSummary ? true : false;

// @ts-expect-error - `results` is a RESULT count; `dispatched` is not a substitute
export const TURN_SUMMARY_COUNTS_RESULTS: SummaryCountsResults = false;

/**
 * And the metadata the two host consumers read is reachable.
 *
 * `recordToolCatalogSchemaRead(catalogView, metadata)` (`:2728`) and the
 * renderer's preview path (`:2763`) read keys this layer cannot enumerate, so
 * `outcome.metadata` is the channel. If a rewrite of `ToolOutcome` dropped it,
 * both consumers would receive `undefined` and neither would fail.
 */
type OutcomeCarriesMetadata = 'metadata' extends keyof ToolOutcome ? true : false;

export const RESULT_METADATA_REACHES_THE_HOST: OutcomeCarriesMetadata = true;

// ---------------------------------------------------------------------------
// The one-shot port: TOOL-FREE, cancellable, and never a silent empty string
// ---------------------------------------------------------------------------

/**
 * `OneShotTextRequest` has no tool surface, and adding one turns this file red.
 *
 * This is the load-bearing assertion of the whole port. The summarizer needs
 * `toolChoice: 'none'` because plan 523 P4.1 found it emitting tool-call tokens
 * instead of a summary, and `ModelRequest` cannot express that flag
 * (`ports.ts:398-417`) -- so a `tools` field here is the only way a caller
 * could ask for tools, and its absence is what makes "this port generates text
 * and nothing else" a build-time fact instead of a convention.
 *
 * Probed through `keyof` rather than through a value, so a field added to the
 * interface is what goes red, and the three spellings are listed because the
 * provider spells it `toolChoice` (`packages/ai/src/types.ts:502`) and a
 * hand-written `tool_choice` would be the quiet way to smuggle it back.
 */
type OneShotToolSurface = Extract<
  keyof OneShotTextRequest,
  'tools' | 'toolChoice' | 'tool_choice'
>;

// @ts-expect-error - a one-shot generation is tool-free; the field is the bug
const ONE_SHOT_REQUEST_CARRIES_NO_TOOLS: OneShotToolSurface = 'tools';

// @ts-expect-error - nor under the wire spelling
const ONE_SHOT_REQUEST_CARRIES_NO_TOOL_CHOICE: OneShotToolSurface = 'tool_choice';

/**
 * The signal is REQUIRED, so an implementor cannot own cancellation.
 *
 * Same rule and same reason as `SIGNAL_IS_REQUIRED` above, reached from the
 * other side: that one proves the engine is HANDED a signal, this one proves an
 * implementation cannot decide to make its own. A port that built its own
 * controller would abort nobody, because everything worth cancelling here
 * happens before the provider request is opened.
 */
type OneShotSignalIsSecond = Parameters<OneShotTextPort['complete']>;
// @ts-expect-error - `complete` takes (request, signal); a one-argument call is not the port
const ONE_SHOT_TAKES_A_SIGNAL: OneShotSignalIsSecond = [{ systemPrompt: '', messages: [] }];

/**
 * The outcome union is CLOSED, so a consumer's `switch` stays exhaustive.
 *
 * Same polarity as `DRAIN_KIND_SET_IS_CLOSED`, and for the same reason: "there
 * are three outcomes" is a claim about today, whereas this turns a FOURTH one
 * into a build error at the consumer.
 */
type OneShotResultKindGuard = OneShotTextResult['kind'] extends
  | 'completed'
  | 'failed'
  | 'cancelled'
  ? never
  : 'unexpected-kind';
// @ts-expect-error - a fourth outcome must break the consumer's switch
export const ONE_SHOT_OUTCOMES_ARE_CLOSED: OneShotResultKindGuard = 'unexpected-kind';

/**
 * An empty answer is REPRESENTABLE, and it is not a failure.
 *
 * Positive first, for the reason `MINIMAL_PORTS` exists: the negative half of
 * this section is only meaningful if the value the pre-b2 summarizer silently
 * produced -- `''` after a provider died on the first token -- can still be
 * produced as a SUCCESS. A port that could not express `completed` with empty
 * text would push every empty answer into the error path, which is a different
 * lie in the other direction.
 */
export const ONE_SHOT_EMPTY_ANSWER_IS_A_COMPLETION: OneShotTextResult = {
  kind: 'completed',
  text: '',
};

/**
 * And the port is constructible, so the negative cases above are not passing
 * because the contract is unimplementable.
 */
export const ONE_SHOT_PORT_IS_CONSTRUCTIBLE: OneShotTextPort = {
  complete: () => Promise.resolve({ kind: 'completed', text: '' }),
};

/**
 * The request carries no run identity, because a one-shot call is not a run.
 *
 * A `runId` here would be a second, independently-passable copy of an identity
 * the caller already has, and the one a caller could get wrong -- the same
 * reason `TOOL_RESULT_RECORD_CARRIES_NO_RUN_ID` gives. There is no ledger to
 * write to and no `seq` to mint: the summarizer's output is stored by
 * `CompactionManager` under its own key (the summarizer is installed at
 * `DuyaAgent.ts:764`).
 */
type OneShotCarriesNoRunIdentity = Extract<keyof OneShotTextRequest, 'runId' | 'runEpoch' | 'seq'>;
// @ts-expect-error - a one-shot generation is not a run and cannot claim to be one
const ONE_SHOT_REQUEST_CARRIES_NO_RUN_IDENTITY: OneShotCarriesNoRunIdentity = 'runId';

// ---------------------------------------------------------------------------
// The per-request cap: CONFIGURATION on the request, never a port, never a
// payload field the model port could enforce on its own.
// ---------------------------------------------------------------------------

/**
 * The cap is constructible where it is declared, and a number.
 *
 * Positive first, for the reason `MINIMAL_PORTS` exists: a negative half over a
 * field that cannot be set would pass for the wrong reason. This case is also
 * the one that carries the TYPE -- `number`, not `unknown` and not `string` --
 * because the whole argument for putting it here rather than in
 * `RunInputSnapshot.options` (`ports.ts`, the `options` bag is
 * `Readonly<Record<string, unknown>>`) is that the runtime can read it without
 * coercing, and a widened type here would delete that argument silently.
 */
export const REQUEST_CAP_IS_A_TYPED_FIELD: Pick<RunExecutionRequest, 'modelRequestTimeoutMs'> = {
  modelRequestTimeoutMs: 5_000,
};

/**
 * And it is OPTIONAL, because "absent = no per-request cap" is the legacy rule
 * (`DuyaAgent.ts:2255` arms the timer only when the option is set and positive)
 * and the state every run is in today. Making it required would force every
 * composition to state a policy none of them has.
 *
 * POSITIVE, and the polarity matters: an earlier draft of this case was written
 * as `@ts-expect-error` over the empty literal, and it is green in BOTH states
 * -- omitting an optional property is legal, so there was no error to suppress
 * and the directive went unused (`tsc` TS2578). That is the "guard that is green
 * in both states" this file's own header warns about, and it is why the absence
 * is asserted by construction instead: if the field ever becomes required, the
 * empty literal stops satisfying this `Pick` and the build fails.
 */
export const A_RUN_MAY_NAME_NO_CAP: Pick<RunExecutionRequest, 'modelRequestTimeoutMs'> = {};

/**
 * The cap is NOT on `ModelRequest`, so the model port cannot own the timer.
 *
 * This is the "one enforcer" rule `BudgetPort` argues at length
 * (`ports.ts:961-983`): two sides enforcing one ceiling is the failure both
 * contracts are written to prevent. A cap on `ModelRequest` would invite a
 * bound port to arm its own deadline from the request, at which point the
 * engine's timer and the port's would both be live and the request would be
 * killed at whichever fired first -- with no way to tell from outside which.
 *
 * The signal is the enforcement point, not the payload: `ModelPort.stream`
 * already receives one (`ports.ts:394`) and the engine already owns the only
 * controller that can abort it.
 */
type CapOnModelRequest = Extract<keyof ModelRequest, 'modelRequestTimeoutMs'>;
// @ts-expect-error - the cap lives on the execution request; a payload field would allow a second enforcer
const MODEL_REQUEST_CARRIES_NO_CAP: CapOnModelRequest = 'modelRequestTimeoutMs';

/**
 * And the port set did not grow a cancellation port to carry it.
 *
 * Polarity matches `DRAIN_KIND_SET_IS_CLOSED` for the reason given there: this
 * yields `'no-port'` while the port set is unchanged, so the assignment below is
 * an error and the directive is used; add a member and the conditional yields
 * `'unexpected-port'`, the assignment becomes legal, the directive goes unused
 * and `npm run typecheck:runtime` fails.
 *
 * This is the b3a lesson made structural. b3a made `recordAssistantMessage` a
 * METHOD of `TurnOutputPort` rather than a sibling port because a second optional
 * binding is a second way for a host to lose the answer silently. The cap does
 * not carry that risk -- an absent cap costs a guardrail, not data -- so it is a
 * field. This probe is what keeps that reasoning from being re-litigated by a
 * well-meaning later change that reaches for the port shape first.
 */
type CancellationPortAbsent = Extract<
  keyof RunEnginePorts,
  'requestCancellation' | 'requestScope' | 'cancellation'
> extends never
  ? 'no-port'
  : 'unexpected-port';

// @ts-expect-error - a cap is configuration the caller already has, not a capability it supplies
export const REQUEST_CAP_IS_NOT_A_PORT: CancellationPortAbsent = 'unexpected-port';

// ---------------------------------------------------------------------------
// Compaction: a port, because a VETO cannot replace a transcript -- and the
// transcript replacement is observable, not an assertion about intent.
// ---------------------------------------------------------------------------

/**
 * The port is CONSTRUCTIBLE with the smallest legal members.
 *
 * Positive first, for the reason `MINIMAL_PORTS` exists: the negative cases
 * below are only meaningful if a real implementation can satisfy the
 * contract. `replacement` is `readonly ModelMessage[]` here and NOT null,
 * because `replaced` is the one arm of `CompactionOutcome` that may carry a
 * replacement, and an arm that could be null would make the load-bearing field
 * optional in the very case it exists for.
 */
export const COMPACTION_PORT_IS_CONSTRUCTIBLE: CompactionPort = {
  decide: () => Promise.resolve({ kind: 'skip', reason: 'cooldown' } as const),
  run: () =>
    Promise.resolve({
      kind: 'replaced' as const,
      replacement: [],
      boundaryId: 'b-0',
      compactedMessageIds: [],
    }),
  nextCompactionId: () => 'cmp-0',
};

/**
 * THE load-bearing assertion of this slice: the port can RETURN A TRANSCRIPT,
 * and on the `replaced` arm it MUST.
 *
 * A `CompactionOutcome` whose `replaced` arm has no `replacement` would still
 * satisfy the five frames -- `compaction.completed` needs a `boundaryId` and
 * an id list, not the messages themselves -- so every frame would publish
 * correctly and the next request would still be built from the ORIGINAL
 * history. That is the exact failure the port exists to prevent, and it is
 * invisible to any test that only asserts on events.
 *
 * ## The polarity, and why the obvious version of this case is a no-op
 *
 * Written the other way round -- a POSITIVE literal that supplies
 * `replacement: []` -- this guard is green in BOTH states, which was measured
 * rather than assumed: an earlier draft asserted the arm by constructing it,
 * and making `replacement` optional left the build exit 0. It cannot fail,
 * because `exactOptionalPropertyTypes` still accepts a supplied value for an
 * optional property, so the literal satisfies the arm either way. That is the
 * "guard that is green in both states" this file's header warns about, and it
 * is the same mistake `A_RUN_MAY_NAME_NO_CAP` documents at length.
 *
 * So the absence is asserted instead, NEGATIVE: the literal below OMITS
 * `replacement`, which today is a compile error (the directive is used), and
 * becomes legal the moment the field goes optional -- at which point TypeScript
 * reports the directive as unused (TS2578) and `npm run typecheck:runtime`
 * fails. Self-policing in both directions.
 */
// @ts-expect-error - a `replaced` outcome MUST carry the transcript it produced
export const COMPACTION_REPLACEMENT_IS_REQUIRED: Extract<CompactionOutcome, { kind: 'replaced' }> = {
  kind: 'replaced',
  boundaryId: 'b-1',
  compactedMessageIds: [],
};

/**
 * And the replacement is REACHABLE and typed, positive half of the pair above.
 *
 * Needed because a negative case alone is only meaningful if the positive one
 * is constructible -- for the reason `MINIMAL_PORTS` exists. This also pins
 * the element type: `readonly ModelMessage[]`, so a port cannot hand back a
 * bare `string[]` and leave the engine to re-derive message shape.
 */
export const COMPACTION_RESULT_CARRIES_A_TRANSCRIPT: Extract<CompactionOutcome, { kind: 'replaced' }> = {
  kind: 'replaced',
  replacement: [],
  boundaryId: 'b-1',
  compactedMessageIds: [],
};

/**
 * And NO OTHER ARM may carry one, so "the transcript was replaced" stays a
 * fact about exactly one outcome rather than something a decline or a failure
 * can quietly also do.
 *
 * Polarity matches `SeqOn<ToolResultRecord>` above, for the same reason: a
 * fourth member carrying a `replacement` would make this conditional yield
 * `true`, the directive would go unused, and the build would fail.
 */
type ReplacementOnlyOnReplaced = Extract<CompactionOutcome, { replacement: readonly ModelMessage[] }> extends {
  readonly kind: 'replaced';
}
  ? true
  : false;
// @ts-expect-error - only a REPLACEMENT replaces the transcript; a decline cannot
export const REPLACEMENT_BELONGS_TO_REPLACED_ALONE: ReplacementOnlyOnReplaced = false;

/**
 * Declining is a VALUE with a reason, not an error and not an absence.
 *
 * Positive, and the polarity is the point: the legacy declines without
 * throwing in three places (`probeCompaction` compares a probe,
 * `DuyaAgent.ts:3018`; `compactProactive` returns null, `:3022`;
 * `CompactOptions.force` documents the nothing-to-summarize early return,
 * `types.ts:66-71`). A port that could not express a declined outcome would
 * force every one of those to either throw or fabricate a compaction, and the
 * fabricate branch is the one that loses messages.
 */
export const COMPACTION_DECLINAL_IS_A_COMPLETION: CompactionOutcome = {
  kind: 'declined',
  reason: 'nothing to compact',
};

/**
 * The four outcomes are CLOSED, so a consumer's `switch` stays exhaustive and
 * a fifth becomes a build error there.
 *
 * Same polarity and same reason as `DRAIN_KIND_SET_IS_CLOSED`.
 */
type CompactionOutcomeKindGuard = CompactionOutcome['kind'] extends
  | 'replaced'
  | 'declined'
  | 'failed'
  | 'cancelled'
  ? never
  : 'unexpected-kind';
// @ts-expect-error - a fifth outcome must break the consumer's switch
export const COMPACTION_OUTCOMES_ARE_CLOSED: CompactionOutcomeKindGuard = 'unexpected-kind';

/**
 * The port carries NO model method, because the summarization already has one.
 *
 * `OneShotTextPort.complete` is the tool-free, cancellable one-shot request the
 * summarizer needs (`ports.ts`, and `DuyaAgent.ts:783` where it is already
 * installed). A second model-shaped method here would either duplicate that
 * surface or -- worse -- reintroduce the tool-calling summarizer that
 * plan 523 P4.1 had to forbid with `toolChoice: 'none'`, a flag `ModelRequest`
 * cannot express. So the probe is over the KEY SET, which covers
 * `complete`/`stream`/`summarize` rather than one spelling.
 */
type CompactionCarriesNoModelCall = Extract<
  keyof CompactionPort,
  'complete' | 'stream' | 'summarize' | 'summarise' | 'generate' | 'callModel'
>;
// @ts-expect-error - the summarization is `OneShotTextPort`'s, not this port's
export const COMPACTION_PORT_CARRIES_NO_MODEL_CALL: CompactionCarriesNoModelCall = 'complete';

/**
 * And it exposes no settle-shaped method, for the reason the store's surface
 * guard (`STORE_SURFACE_IS_EXACT`) gives: a compaction is not a terminal
 * decision, and a method named `settle`/`finalize`/`complete` on this port
 * would read as one. Probed POSITIVELY so the absence is what fails.
 */
type CompactionCannotSettle = keyof CompactionPort extends 'settle' | 'finalize' | 'complete' ? never : true;
export const COMPACTION_SURFACE_CANNOT_SETTLE: CompactionCannotSettle = true;

/**
 * The progress union is CLOSED, so a sixth progress reading is a build error at
 * the consumer rather than a silently ignored value.
 *
 * `over_threshold` is a MEMBER rather than a field on the step reading because
 * the two arrive on different cadences and carry disjoint required facts: a
 * step has `step` + `phase` (`events/required.ts:169-176`) while
 * `over_threshold` has `tokensRetained` + `available` and no `compactionId` at
 * all (`:188`). One object with optional fields would let a caller publish
 * `{ kind: 'step' }` with neither `step` nor `phase`.
 */
type CompactionProgressKindGuard = CompactionProgress['kind'] extends 'step' | 'over_threshold' ? never : 'unexpected-kind';
// @ts-expect-error - a third progress kind must break the consumer's switch
export const COMPACTION_PROGRESS_KINDS_ARE_CLOSED: CompactionProgressKindGuard = 'unexpected-kind';

/**
 * A step carries its `phase`, and it is REQUIRED.
 *
 * The wire requires it (`events/required.ts:171`), and the legacy always sends
 * one (`CompactionCoordinator.ts:106` forwards `event.phase`). If `phase`
 * became optional the projector would fall back to the step number
 * (`chat-event-translator.ts:711`) -- a `phase` of `"3"` -- which is a string
 * that looks like data and is not.
 */
export const COMPACTION_STEP_NAMED_ITS_PHASE: Extract<CompactionProgress, { kind: 'step' }> = {
  kind: 'step',
  step: 1,
  phase: 'summarize',
};

/**
 * The port set DID grow a compaction member, which is what makes the
 * `CancellationPortAbsent` probe above a statement about that probe rather than
 * a statement about the port set as a whole.
 *
 * Kept adjacent to that probe on purpose: one file asserting "no port grew"
 * and another asserting "one grew" is a contradiction a reader has to
 * reconcile, so both live here and the reader sees them together.
 */
type CompactionPortIsBound = Extract<keyof RunEnginePorts, 'compaction'>;
export const COMPACTION_IS_AN_OPTIONAL_PORT: CompactionPortIsBound = 'compaction';
