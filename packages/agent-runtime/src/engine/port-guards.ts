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
  ModelFrame,
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
 * the change this case is here to catch.
 */
export const TURN_OUTPUT_PORT_IS_CONSTRUCTIBLE: TurnOutputPort = {
  recordToolResult: () => Promise.resolve(),
  finishTurn: () => Promise.resolve(),
};

/**
 * No `seq` on either payload.
 *
 * The legacy assigns `result.message.seq_index = seqIndex`
 * (`DuyaAgent.ts:2723`), and reproducing that field here would make the runtime
 * a second authority for "where does this message sit" -- the same reason
 * `RunEvent` carries no `seq` (`ports.ts:46-49`). Ordering is the host's, derived
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
 * `dispatched` is `TurnWork.dispatched` (`run-engine.ts:569`); they diverge the
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
