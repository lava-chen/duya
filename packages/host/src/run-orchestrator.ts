/**
 * run-orchestrator.ts — the Host-owned run adapter, currently composed by Agent Server.
 *
 * ## What this file is for
 *
 * The Agent Server is a fork with no access to `duya-core.db`, and it is the
 * only process that sees both the host's chat request and the worker's event
 * stream. So it hosts the `RunController`, and reaches the Control Plane over
 * the existing `db:request` channel — the same one `acquireChatLock` uses
 * (`chat-runtime-lock.ts:71`).
 *
 * ## ONE entry, not two (plan 587 R2.1)
 *
 * ```ts
 * const start = await orchestrator.openRun(sessionId, turn);   // opens AND dispatches
 * const legacy = orchestrator.observe(sessionId, frame);        // per frame
 * ```
 *
 * The dispatch is inside that single entry. `openRun` hands the channel the
 * manifest, the resolved prompt and the input revision, and the channel's
 * adapter puts the canonical `runId`, the manifest hash and the revision on the
 * one `chat:start` command that begins the work. Before this, the router sent
 * `chat:start` itself with a SECOND freshly minted id on it, and nothing
 * connected the two — so a run could exist with an executor that had never been
 * told it was executing anything.
 *
 * `openRun` still never blocks the chat: a Control Plane that refuses is a
 * degradation, and a product that refuses to answer because a bookkeeping row
 * could not be written is a worse regression. What changed is that "chat
 * proceeded" comes back as an explicit `{ accepted: false, stage }` rather than
 * a bare `null` the caller could only guess about — and, crucially, a run that
 * was not accepted has NO executor behind it, because the dispatch never
 * happened.
 *
 * `observe` is a tee, and it no longer PERSISTS. It returns the legacy frame
 * for the router to write and keeps the protocol envelope for the live run-event
 * arm; the durable `run_events` ledger is written by the native `run:event`
 * channel instead, under the identity the Runtime minted. The router never
 * learns the protocol, and the run layer never learns about
 * `http.ServerResponse`.
 *
 * ## Settling
 *
 * The worker emits `chat:done` or `chat:error`, which the router turns into a
 * `done` / `error` frame. The run therefore settles when that frame is
 * observed — not when the HTTP response closes.
 *
 * Note what this host does on a client disconnect: the router's own
 * `req.on('close')` handler removes the stdout listener and calls
 * `interruptWorker` (router.ts). A run is not a connection, but neither is it
 * a process that outlives its executor: the worker really does stop, and the
 * run settles as `cancelled` rather than as a crash. Recording silence as
 * `runtime_crash` there would mean accusing the runtime of a failure this very
 * host requested.
 */

import { randomUUID } from 'node:crypto';
import {
  manifestFingerprint,
  type CancelOutcome,
  type ErrorCode,
  type ProtocolErrorInfo,
  type RunEventEnvelope,
  type RunManifest,
  type RunResult,
  type RunTerminalState,
  type StopDisposition,
} from '@duya/agent-protocol';
import {
  ExecutionDispatchError,
  RunController,
  RunStartError,
  type ExecutionChannel,
  type ExecutionHandle,
  type FrameOutcome,
  type RunHandle,
  type RunStartAcceptance,
  type RunStartStage,
  type StopReceipt,
  type TranslateContext,
} from '@duya/agent-runtime';
// Imported from the factory module, NOT the `control-plane` barrel. The barrel
// re-exports `run-control-plane`, which pulls in `core-connection` and
// therefore better-sqlite3 and the Electron config layer — none of which
// belongs in a forked process that reaches storage over `db:request`. The type
// import is likewise a direct file import for the same reason.
import { buildRunManifest, type RunIntent } from './manifest-factory.js';
import {
  describeReceipt,
  isDurableWrite,
  readRunReceipt,
  reasonOf,
  type RunWriteReceipt,
} from './run-receipt.js';
import { eventSpecOf, runInputRevision } from '@duya/agent-protocol';
import type { DispatchReceipt, DispatchReserveOutcome } from '@duya/agent-protocol/bot-inbox-api';
import type { ControlPlaneRequest } from './control-plane-service.js';

export interface RunOrchestratorLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, error?: Error, data?: Record<string, unknown>): void;
}

const NOOP_RUN_ORCHESTRATOR_LOGGER: RunOrchestratorLogger = Object.freeze({
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});

/**
 * The one sentence a session with no live run is refused with.
 *
 * Two sites refuse it — the synchronous guard in `queueNativeRunEvent` and the
 * awaited body of `#appendNativeRunEvent` — because a late frame can be caught
 * by either depending on how far the session got before it ended. Two different
 * sentences for one incident would make a log search for this refusal depend on
 * which side of the boundary the frame landed.
 */
const noLiveRunReason = (sessionId: string): string =>
  `session ${sessionId} has no live run; the envelope is dropped rather than appended to an ended or unopened run`;

/** The `dbRequest` seam the router already threads through `RouterDeps`. */
type DbRequest = ControlPlaneRequest;

/**
 * Ended runs whose `RunResult` is still readable, plus every turn in flight.
 *
 * A host that wants a real `RunResult` — the non-SSE response, which has no
 * stream to read a terminal off — needs the handle the controller returned, and
 * that handle deliberately outlives the live run: `result()` is a READ that
 * never settles (contract §C). Discarding it at settle time would force the
 * host to rebuild the receipt from the terminal alone, which is a second
 * derivation of a value the runtime already decided once.
 *
 * Bounded for the same reason the controller's receipts are: remembering every
 * run forever is the leak this replaces, with more useful-looking data in it.
 */
const RETAINED_HANDLES = 64;

/**
 * What the durable store said about one native append.
 *
 * Receipt-shaped rather than a bare count, because the three ways an append can
 * fail mean opposite things and the caller must not collapse them: `fenced`
 * means "this attempt may no longer write" and the batch must be DROPPED, while
 * `conflict` means two different envelopes are claiming one `(run, seq)` and
 * must be refused LOUDLY. A single `written: 0` cannot say which.
 */
export type NativeAppendOutcome =
  | { readonly state: 'written'; readonly written: number }
  /** A duplicate delivery of an envelope already stored — a retry, not an error. */
  | { readonly state: 'duplicate' }
  /**
   * A superseded attempt. `current` is `null` only when the hop that refused
   * could not report which attempt now holds write authority; the refusal is
   * the fact either way, and the number is a diagnostic.
   */
  | { readonly state: 'fenced'; readonly presented: number; readonly current: number | null }
  | { readonly state: 'conflict'; readonly seq: number }
  | { readonly state: 'failed'; readonly reason: string };

/**
 * The ONE durable writer for envelopes the Runtime minted itself.
 *
 * Injected rather than reached for, so this module keeps its promise of holding
 * no store handle: the composing process owns the connection, and the
 * orchestrator only routes. It is also the seam that carries the ATTEMPT FENCE —
 * the store refuses a write from a superseded attempt, and only a seam that can
 * present an epoch can be fenced.
 */
export interface NativeRunEventWriter {
  /** The run's current attempt, or `null` when there is no run row yet. */
  currentEpoch(runId: string): number | null;
  /** Appends the envelopes VERBATIM, under the presented attempt. */
  append(
    runId: string,
    envelopes: readonly RunEventEnvelope[],
    epoch: number,
  ): NativeAppendOutcome | Promise<NativeAppendOutcome>;
}

/** What {@link RunOrchestrator.persistNativeRunEvent} decided about one message. */
export type NativeEventAcceptance =
  | { readonly accepted: true; readonly runId: string; readonly seq: number }
  | { readonly accepted: false; readonly runId: string | null; readonly reason: string };

/**
 * One run's attempt, with the two states the run layer can actually observe.
 *
 * ## What the run layer knows, and when
 *
 * It knows ONE thing about a run's attempt: the number it opened the run under,
 * read from {@link NativeRunEventWriter.currentEpoch} at `openRun`. It does not
 * watch that number afterwards, because the store owns it and this process may
 * not even be able to read it (the Desktop writer hardcodes `0`, since the fork
 * holds no connection). So the run layer learns a run has been ADVANCED only at
 * the moment a write presents the stale attempt and comes back `fenced` — that
 * refusal is the observation, and it is the earliest one available.
 *
 * `superseded` records that observation, so a caller can distinguish "this run's
 * attempt is the one it was opened under" from "this run's attempt moved on and
 * the move was observed at a write". `null` means no move was ever seen, which
 * is not the same claim as "no move happened".
 */
export interface RunAttemptBinding {
  /** The attempt this Host opened the run under. Never re-read from the store. */
  readonly epoch: number;
  /**
   * Set when the run's bindings were released. A retired attempt may no longer
   * establish itself for a new turn; it survives retirement only so the terminal
   * CAS it has a right to make can still present it.
   */
  retired: boolean;
  /**
   * The attempt the store reported as holding write authority, once one has been
   * observed on a `fenced` refusal. `null` until then, and `null` still after a
   * refusal that could not report the current holder.
   */
  superseded: number | null;
}

export interface RunOrchestratorOptions {
  readonly dbRequest: DbRequest;
  readonly logger?: RunOrchestratorLogger;
  /** Receives canonical events while they are still in the active process. */
  readonly onEvent?: (event: RunEventEnvelope) => void;
  /** Called after the terminal has crossed the durable settlement boundary. */
  readonly onRunSettled?: (runId: string) => void;
  /**
   * The durable writer for Runtime-minted envelopes.
   *
   * Optional because a host with no native channel still runs legacy frames,
   * and one absent seam must degrade rather than throw. Absent, a native event
   * is refused with a reason rather than silently discarded.
   */
  readonly nativeWriter?: NativeRunEventWriter;
  /**
   * The worker's command channel. Supplied by the router, which owns
   * `WorkerManager`; the runtime reaches the worker only through this seam, so
   * a replacement executor needs no change here.
   */
  readonly channel: ExecutionChannel;
}

/** Trusted Host admission; candidate identity is still minted by this owner. */
export interface RunDispatchAdmission {
  lookup(): DispatchReceipt | null;
  reserve(candidateRunId: string): DispatchReserveOutcome | null;
  /** Rechecked at the actual execution-channel boundary, after async writes. */
  isCurrent(): boolean;
}

/** What the router resolved for one turn, passed through `openRun`. */
export interface RunModelIdentity {
  readonly model: string;
  readonly providerId: string;
  readonly apiFormat: 'anthropic' | 'openai';
}

/**
 * Everything one chat turn needs to become a run.
 *
 * The prompt and the options are HERE rather than sent by the router alongside
 * the run, because they used to be a second parallel description of the same
 * turn — the double source of truth §R2.2 names. Passing them in means the
 * command that starts the work is DERIVED FROM the run, so the two cannot
 * drift apart.
 *
 * `sessionId` and `runId` are deliberately absent: the run id is minted here,
 * by the Control Plane's start entry, and the session id is the map key. A
 * caller that could supply its own run id would be a second run-identity
 * source, which is the thing R2.1 exists to remove.
 */
export type RunTurnIntent = Omit<RunIntent, 'sessionId' | 'runId'> & {
  readonly apiFormat?: 'anthropic' | 'openai';
  readonly prompt: string;
  readonly options: Readonly<Record<string, unknown>>;
};

/** Everything the router needs back from `observe`. */
export interface ObservedFrame {
  /** What to write to the SSE stream, or `null` to write nothing. */
  readonly legacy: FrameOutcome['legacy'];
  /** True when the frame had no protocol counterpart and is forward-only. */
  readonly forwardOnly: boolean;
  /**
   * True when this frame arrived for a run that has already ended.
   *
   * The router writes the frame regardless — that is the live path and it does
   * not change — so this is the only signal the host gets that the run layer
   * had already decided. A frame for a session that never opened a run is a
   * different fact and reports `false`.
   */
  readonly late: boolean;
}

export class RunOrchestrator {
  readonly #options: RunOrchestratorOptions;
  readonly #logger: RunOrchestratorLogger;
  readonly #controller: RunController;
  /**
   * One `db:request` durability call, with the failure reported where it is
   * seen. A reply this adapter cannot read and a channel that throws are both
   * diagnostics only the adapter can attach a run id to.
   */
  readonly #request: DbRequest;
  /** sessionId -> the run currently executing for it. One live run per
   *  session, which the router's own STREAMING 409 already guarantees. */
  readonly #bySession = new Map<string, string>();
  readonly #openingSessions = new Set<string>();
  readonly #dispatchAdmissions = new Map<string, RunDispatchAdmission>();
  /**
   * runId -> the model identity the router resolved for that turn.
   *
   * Per-run, not a field on the orchestrator: the model changes between turns
   * and between sessions, so a single slot would attribute one turn's events to
   * whichever model ran most recently. Read out when the run settles.
   */
  readonly #modelByRun = new Map<string, RunModelIdentity>();
  /**
   * sessionId -> the run that last ended for it.
   *
   * Only used to tell a late frame apart from a frame for a session that never
   * opened a run, which the router cannot see any other way once `#bySession`
   * has been released. One entry per SESSION, overwritten by the next run for
   * that session — so it is bounded by the conversation list rather than by
   * the number of turns, which is the distinction that matters.
   */
  readonly #endedBySession = new Map<string, string>();
  /**
   * sessionId -> the settlement currently in flight for it.
   *
   * Exists so the router's close-event backstop can WAIT for a run the `done`
   * frame already began closing, rather than returning while the terminal write
   * is still crossing the process boundary. One entry per live session, removed
   * when the settlement lands.
   */
  readonly #finishing = new Map<string, Promise<void>>();
  /**
   * runId -> the handle the controller handed back, kept so an ENDED run is
   * still answerable.
   *
   * `result()` is a read that never settles (contract §C), so the handle is the
   * only source of a real `RunResult`. The non-SSE response has no event stream
   * to read a terminal off and needs one. Bounded by `RETAINED_HANDLES`, and
   * inserted in run order so eviction drops the oldest.
   */
  readonly #handleByRun = new Map<string, RunHandle>();
  /**
   * runId -> the session that asked for it, for the window inside `openRun`.
   *
   * Exists only so `onDispatchReady` — which receives a run id, because that is
   * all the controller knows — can bind the right session before the dispatch.
   * Deleted as soon as the start resolves, so it can never hold a binding for a
   * run that ended.
   */
  readonly #pendingSessionByRun = new Map<string, string>();
  /**
   * runId -> native `run:event` envelopes this Host actually put in the ledger.
   *
   * Counted rather than kept, because the count's only job is the comparison in
   * {@link #reportNativeChannel}: "this run produced legacy frames and nothing
   * on the native channel" is a degradation nobody can see from either counter
   * alone.
   */
  readonly #nativeEventsByRun = new Map<string, number>();
  /**
   * runId -> envelopes REVERSE-TRANSLATED from legacy worker frames.
   *
   * These are the ones `persistenceFor.append` refused to persist, so a run with
   * a non-zero count and a zero native count is a run whose ledger has no
   * Runtime identity in it at all.
   */
  readonly #translatedEventsByRun = new Map<string, number>();
  /**
   * runId -> the terminal envelope held back until `run:complete` is durable.
   *
   * A terminal is the one event a client may read as "this succeeded", so it is
   * the one event that must not reach a consumer before the commit that records
   * it. Cleared in {@link #finish} on both the committed and the failed path.
   */
  readonly #terminalAwaitingCommit = new Map<string, RunEventEnvelope>();
  /**
   * runId -> the attempt this Host opened the run under, and its lifecycle.
   *
   * Captured ONCE, at open, and never re-read from the store at settle time.
   * The terminal CAS is fenced by the attempt that owns the run, so re-reading
   * the CURRENT epoch when settling would let a superseded attempt present the
   * newer attempt's number and land a terminal it had no right to land — the
   * fence would pass exactly the case it exists for.
   *
   * It is a LIFECYCLE and not a number, because "captured once" alone left two
   * holes this closes:
   *
   *  - **Retired, not deleted, at release.** `#release` runs BEFORE
   *    `controller.settle` inside `#finish` — deliberately, because it deletes
   *    the session binding every queued append checks, and the drain has already
   *    completed by then. A binding deleted at that instant is gone before
   *    `persistenceFor.complete` reads it, so the terminal CAS was sent with NO
   *    `epoch` at all and the fence never applied to it. Retiring keeps the
   *    number readable for the terminal write that still has a right to present
   *    it, and the entry is dropped once the run has actually ended.
   *  - **Dropped on a refused start.** `#forgetRun` released the model binding
   *    but not the attempt, so every start that threw left one permanent entry
   *    keyed by a run id that will never run.
   */
  readonly #attemptByRun = new Map<string, RunAttemptBinding>();
  /**
   * sessionId -> the tail of the serialized native-append chain for it.
   *
   * Exists because a Host whose frame intake is SYNCHRONOUS cannot await an
   * append: the Desktop router's stdout tee is an `onData` handler, and the
   * worker can still be writing `run:event` lines when the `done` frame settles
   * the run. A bare `void persistNativeRunEvent(...)` there races
   * {@link #release}, and the loser is the terminal envelope: every append that
   * had not reached the `#bySession` lookup before the binding was deleted comes
   * back `session ... has no live run` — a silent drop, which is the one
   * failure this channel exists to remove.
   *
   * Chaining rather than firing means the appends keep the worker's `seq` order,
   * and the drain in {@link #finish} turns "probably finished" into "finished":
   * the queue is awaited before the run's bindings are released and before the
   * terminal is recorded, so no `run.completed` row can be written before the
   * events it summarises.
   *
   * One entry per live session, removed when the run settles.
   */
  readonly #nativeQueues = new Map<string, Promise<unknown>>();
  /**
   * runId -> durable native batches this Host lost for the CURRENT attempt.
   *
   * A refusal the attempt fence explains (`fenced`) is NOT counted: those
   * envelopes belong to an attempt the Host has already moved on from, and the
   * run now belongs to a newer one. A refusal that leaves the CURRENT attempt's
   * ledger short is a hole in the transcript this run is going to report on.
   */
  readonly #nativeLostByRun = new Map<string, number>();
  /**
   * runId -> the terminal actually committed for it, when that terminal is not
   * the one the Runtime proposed.
   *
   * Exists so {@link #terminalFor} answers with what the LEDGER says. Bounded
   * like {@link #handleByRun} and pruned on the same schedule, so an ended run
   * stays answerable without becoming a second unbounded map.
   */
  readonly #committedTerminalByRun = new Map<string, RunTerminalState>();

  constructor(options: RunOrchestratorOptions) {
    this.#options = options;
    this.#logger = options.logger ?? NOOP_RUN_ORCHESTRATOR_LOGGER;
    this.#request = options.dbRequest;
    // A durable call whose CHANNEL throws is reported here and re-thrown, so a
    // failure that cannot produce a reply is as visible as one that can. The
    // runtime turns a rejected append into a `persistence_failed` terminal
    // rather than an exception, so the settle path is no longer a reliable
    // place to notice it.
    const request = async (action: string, runId: string, payload: Record<string, unknown>): Promise<unknown> => {
      try {
        return await this.#request(action, payload);
      } catch (error) {
        this.#logger.warn(`${action} channel failed — the durable transcript is degraded`, {
          runId,
          reason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
    this.#controller = new RunController({
      channel: {
        start: (manifest, input, context) => {
          const admission = this.#dispatchAdmissions.get(manifest.runId);
          if (admission && !admission.isCurrent()) {
            throw new Error('bot dispatch claim expired or was superseded before execution');
          }
          return options.channel.start(manifest, input, context);
        },
      },
      identity: { name: 'duya-agent-server', version: RUNTIME_VERSION },
      protocol: { major: 1, minor: 0 },
      contextFor: (manifest) => this.#contextFor(manifest.runId, manifest.permissionPolicy.defaultTimeoutMs),
      // Bind the session BEFORE the dispatch, which now happens inside
      // `controller.start` (plan 587 R2.1). The first frame the worker produces
      // comes back through the router's tee, which resolves a session to its run
      // through this very binding — so binding afterwards would make the first
      // frame of every turn race the map it is looked up in.
      //
      // It is NOT bound before `run.started` is durable: that was R1.2's fix for
      // a start that failed leaving the session pointing at a run with no record
      // and no place in the Control Plane. The hook is after that barrier, so
      // both properties hold.
      onDispatchReady: (runId) => {
        const sessionId = this.#pendingSessionByRun.get(runId);
        if (sessionId === undefined) return;
        this.#bySession.set(sessionId, runId);
        this.#endedBySession.delete(sessionId);
      },
      // The run id is read from the manifest INSIDE this closure, not from a
      // field on the orchestrator. A field would be a single slot shared by
      // every concurrent session, so two interleaved runs would append their
      // events to each other's rows — the exact failure a per-run closure
      // makes unrepresentable.
      persistenceFor: (manifest) => {
        const runId = manifest.runId;
        return {
          /**
           * ## This no longer writes anything, and that is the point
           *
           * Every envelope that reaches here was REVERSE-TRANSLATED from a
           * legacy worker frame, and a reverse translation has to re-`seq` it:
           * the Host's emitter numbers from its own ledger, not from the
           * Runtime's, so the row it would write carries the Host's identity
           * and can never be matched back to the envelope the engine emitted.
           *
           * The native channel (`run:event`) is the ledger writer now, and it
           * writes the envelope verbatim. Leaving this arm writing rows would
           * put two writers with two different `seq` spaces into one
           * `(run_id, seq)` identity — which the store can only answer with a
           * `RunEventConflictError` for whichever envelope lost, or with a
           * silently dropped batch.
           *
           * What is KEPT here is the SSE tee, and it is kept by NOT writing:
           * `observe` still forwards each translated envelope to `onEvent`, and
           * the router still writes the frame it was handed. This arm only
           * counts what it refused to persist, so a run that produced legacy
           * frames but no native events is visible at settle time instead of
           * reading as a quiet run.
           */
          append: async (envelopes) => {
            for (const envelope of envelopes) {
              this.#translatedEventsByRun.set(
                runId,
                (this.#translatedEventsByRun.get(runId) ?? 0) + 1,
              );
            }
            // ## A hole in the native ledger is a hole in THIS run's transcript
            //
            // The arm above writes nothing, and the native channel is the
            // ledger's only writer, so a batch the native writer refused is a
            // batch this run's durable transcript is missing. Refusing here is
            // how that reaches the Runtime's own settlement path: it re-offers
            // the batch its configured number of times, and when it finally
            // gives up it marks the run degraded, rewrites the row so no
            // `running` row is left behind, and announces the degraded terminal
            // instead of the success. Reporting `completed` over a transcript
            // with a hole in it is the failure this exists to prevent.
            //
            // `fenced` batches are excluded on purpose (see
            // {@link #nativeLostByRun}): a superseded attempt losing write
            // authority is not this run losing events.
            const lost = this.#nativeLostByRun.get(runId) ?? 0;
            if (lost > 0) {
              throw new RunLedgerIncompleteError(runId, lost);
            }
          },
          complete: async (terminal, metrics) => {
            // A run whose ledger lost a batch must not settle as a SUCCESS, and
            // the durable row must not keep saying one either. The terminal
            // committed here is therefore the DEGRADED one, while the Runtime's
            // own verdict stays untouched in the event stream — so the row and
            // the log of the run say different things on purpose, and the row
            // is the one a reconciler reads.
            const lost = this.#nativeLostByRun.get(runId) ?? 0;
            const committed = lost > 0 && terminal.status !== 'failed'
              ? {
                  status: 'failed' as const,
                  error: {
                    code: 'persistence_failed' as const,
                    message:
                      `run ${runId} lost ${lost} durable run ${lost === 1 ? 'event' : 'events'} before it settled; ` +
                      'the terminal recorded here is not the verdict the run reached',
                  },
                }
              : terminal;
            if (committed !== terminal) {
              this.#rememberCommittedTerminal(runId, committed);
              this.#logger.error('a run whose durable transcript lost events will not be recorded as a success', new Error(RunLedgerIncompleteError.describe(runId, lost)), {
                runId,
                lostEvents: lost,
                proposed: terminal.status,
                committed: committed.status,
              });
            }
            // Fenced by the attempt this run was OPENED under — see
            // `#attemptByRun` for why that value is captured and not re-read.
            //
            // It is presented even though the binding is already RETIRED by the
            // time this runs: retirement happens at `#release`, which is the
            // step before `controller.settle`, and dropping the number with the
            // binding is what previously sent this terminal CAS with no `epoch`
            // at all — an unfenced write on the one call the fence exists for.
            const presented = this.#attemptByRun.get(runId);
            const reply = await request('run:complete', runId, {
              runId,
              terminal: committed,
              metrics,
              ...(presented === undefined ? {} : { epoch: presented.epoch }),
            });
            // `reconciled` resolves. It is NOT an acknowledgement failure: it
            // means another writer committed the SAME terminal, so the run IS
            // durably settled as asked and the only thing that happened is that
            // two writers raced. Throwing here — which is what `applied: false`
            // used to do — made the runtime report `persistence_failed` for a run
            // that had in fact succeeded, and R1.2's degraded terminal then told
            // the host a completed run was a failed one.
            //
            // `conflict` and `absent` still throw, and must: a lost claim and a
            // write that matched nothing are the two cases where this caller
            // genuinely cannot say the run ended as it decided.
            const receipt = readRunReceipt(reply, 'run:complete', runId);
            if (receipt.state === 'fenced') {
              // Its own refusal, and deliberately NOT reported as a `conflict`:
              // no other writer decided this run's history, so there is no
              // rival to reconcile with and no committed terminal to inspect.
              // What happened is that this attempt lost the right to decide.
              reportAckLoss(receipt, this.#logger);
              throw new Error(
                `run:complete was refused by the attempt fence: attempt ${receipt.presented} may no longer land a terminal` +
                  (receipt.current === null ? '' : `; attempt ${receipt.current} holds it`),
              );
            }
            if (!isDurableWrite(receipt)) {
              reportAckLoss(receipt, this.#logger);
              throw new Error(`run:complete was not acknowledged: ${describeReceipt(receipt)}`);
            }
            if (receipt.state === 'reconciled') {
              this.#logger.info('run:complete lost the CAS to a writer that agreed — the run is settled as decided', {
                runId,
                committed: receipt.committed.status,
              });
            }
          },
        };
      },
    });
  }

  /**
   * Open a run for a chat turn AND dispatch it. One call, one dispatch.
   *
   * Never throws. The chat proceeds either way; the run layer is additive, and
   * a product that refuses to answer because a bookkeeping row could not be
   * written is worse than one that answers without the record.
   *
   * What it returns is the acknowledgement the contract asks for (§R2.1): an
   * explicit `accepted` flag plus, when false, WHICH of the three distinct
   * situations happened. Before this, the answer was `string | null` and the
   * caller could only learn "no run", which is precisely the ambiguity that let
   * a refused start and a started run look alike.
   *
   * One consequence is worth stating plainly: `accepted: false` now also means
   * **nothing was dispatched**. The `chat:start` command is issued from inside
   * the start, so there is no path where the executor was told to work while the
   * run layer reported that the run did not open.
   */
  async openRun(sessionId: string, intent: RunTurnIntent, admission?: RunDispatchAdmission): Promise<RunStartAcceptance> {
    try {
      const existing = admission?.lookup();
      if (existing) return {
        accepted: false, runId: existing.runId, stage: 'run_already_exists',
        reason: 'dispatch key already reserved; reconcile the canonical run without a second execution',
      };
      if (this.isSessionBusy(sessionId)) {
        const active = this.#bySession.get(sessionId);
        return { accepted: false, runId: null, stage: 'run_active',
          reason: active === undefined ? `session ${sessionId} already has an opening or settling run`
            : `session ${sessionId} already has live run ${active}` };
      }
      const candidate = randomUUID();
      const reserved = admission?.reserve(candidate);
      if (admission && reserved == null) {
        return { accepted: false, runId: null, stage: 'dispatch_refused', reason: 'bot dispatch claim is no longer current' };
      }
      if (reserved && reserved.state !== 'fresh') return {
        accepted: false, runId: reserved.runId, stage: 'run_already_exists',
        reason: 'dispatch key already reserved; no second execution was dispatched',
      };
      const runId = reserved?.runId ?? candidate;
      this.#openingSessions.add(sessionId);
      if (admission) this.#dispatchAdmissions.set(runId, admission);
      try {
        return await this.#openReservedRun(sessionId, intent, runId);
      } finally {
        this.#openingSessions.delete(sessionId);
        this.#dispatchAdmissions.delete(runId);
      }
    } catch (error) {
      return { accepted: false, runId: null, stage: 'unknown', reason: describeCause(error) };
    }
  }

  async #openReservedRun(sessionId: string, intent: RunTurnIntent, runId: string): Promise<RunStartAcceptance> {
    // An active binding is NEVER overwritten. The router's STREAMING 409 is what
    // normally guarantees one live run per session, and that guarantee lives in
    // a different process from this map — so two turns that pass it (a retry of
    // the HTTP request, a reconnect) would otherwise silently rebind the
    // session, and the first run's frames would then be teed into the second
    // run's ledger. Refusing here is the only thing that keeps the map's
    // invariant true, and it is checked at the one place the binding is taken.
    const active = this.#bySession.get(sessionId);
    if (active !== undefined) {
      this.#logger.warn('a second run was opened for a session that already has a live one', {
        sessionId,
        activeRunId: active,
        refusedRunId: runId,
      });
      return {
        accepted: false,
        runId: null,
        stage: 'run_active',
        reason: `session ${sessionId} already has live run ${active}`,
      };
    }
    // The pending-session entry lives only for the duration of this call, and a
    // `finally` is the only thing that guarantees that: there are three exits
    // from the body below (refused row, failed start, success) and the one that
    // returns EARLY is the `run_not_created` path, which a trailing cleanup
    // after the try block would never reach. One entry per refused run, for the
    // life of the agent-server process, is the leak this map could have become.
    this.#pendingSessionByRun.set(runId, sessionId);
    // The attempt is established HERE, before `run:create`, and not at the
    // dispatch below. Two paths out of this method close a run row that may
    // ALREADY exist — `#closeAbandonedRun` on a `run:create` whose REPLY was
    // unreadable, and the `run:complete` it sends — and both are fenced writes
    // now: a payload with no readable attempt is refused rather than made
    // unfenced, so an attempt captured only after a successful create leaves
    // exactly the abandoned run with no way to record its terminal.
    //
    // Reading it before the row exists is not a guess. `currentEpoch` answers
    // `null` for no row, which maps to `0`, and a row this Host creates is
    // created at attempt 0 — so the value is the same one the post-create read
    // would have produced, and it is now available to every exit.
    const attemptEpoch = this.#attemptEpochFor(runId);
    this.#beginAttempt(runId, attemptEpoch);
    // Whether this run survived to dispatch. Read in the `finally` so the
    // attempt is released on EVERY non-dispatch exit, not only on the ones that
    // happen to remember to.
    let dispatched = false;
    try {
      if (typeof intent.model === 'string' && intent.model !== '') {
        this.#modelByRun.set(runId, {
          model: intent.model,
          providerId: intent.providerId ?? 'env',
          apiFormat: intent.apiFormat ?? 'anthropic',
        });
      }
      // `prompt` and `options` are stripped before the manifest is built: they
      // are run INPUT, not configuration. Leaving them in would mean the
      // manifest fingerprint changes whenever the user rewords a message, which
      // is the opposite of what a manifest is for.
      const { prompt: turnPrompt, options: turnOptions, ...manifestIntent } = intent;
      const built = buildRunManifest({ ...manifestIntent, sessionId, runId });
      const effectiveTurnOptions = effectiveRunOptions(built.manifest, turnOptions);
      // The input revision is computed ONCE here, by the protocol's canonical
      // function, and the SAME string goes to the Control Plane and to the
      // controller. The Control Plane persists it into the run row so a reused
      // `runId` can be compared; the controller puts it on the executor's
      // command. Two derivations of one value in two places is the drift
      // `controller.ts:542-547` warns about, so the derivation happens at the
      // one call site that already holds all three inputs.
      const inputHash = runInputRevision({ sessionId, prompt: turnPrompt, options: effectiveTurnOptions });
      const created = await this.#options.dbRequest('run:create', {
        runId,
        sessionId,
        manifest: built.manifest,
        manifestHash: built.manifestHash,
        inputHash,
        ...(intent.parentRunId === undefined ? {} : { parentRunId: intent.parentRunId, origin: 'agent' }),
      });
      const createdReceipt = readRunReceipt(created, 'run:create', runId);

      // `reused` is refused on purpose. The run already exists with this exact
      // manifest and input, so the ROW is fine — but accepting it would dispatch
      // a SECOND executor onto a run that already has one, and the first
      // executor is still streaming into the same `(runId, seq)` space. The
      // honest answer is "this run exists, it was not started again", which is
      // what its own stage says.
      if (createdReceipt.state !== 'created') {
        this.#forgetRun(runId);
        if (createdReceipt.state === 'reused') {
          this.#logger.warn('Control Plane reports this runId was already opened — not dispatched again', {
            sessionId,
            runId,
          });
          return {
            accepted: false,
            runId,
            stage: 'run_already_exists',
            reason: `run ${runId} already exists with the same manifest and input, so no second execution was dispatched`,
          };
        }
        // The producer's own sentence, unprefixed: the state name belongs in the
        // log line below, and a host branching on this reason is reading what
        // the Control Plane actually said.
        const reason = reasonOf(createdReceipt);
        this.#logger.warn('Control Plane refused the run — the chat turn has no durable record', {
          sessionId,
          runId,
          reason: describeReceipt(createdReceipt),
        });
        // This is the one path where a row CAN be stranded, and it is the shape
        // the dropped desktop turns had: `run:create` wrote the row, and the
        // reply came back unreadable, so the caller learned "no run" while a
        // `running` row with `terminal=NULL` sat in the table with nothing that
        // would ever move it. The controller is never reached on this path, so
        // there is no `#failStart` to have closed it.
        //
        // Whether the row actually landed is not guessed here — `run:complete`
        // answers `absent` when it matched nothing, which is the truth for a
        // create that failed before its write. Both answers are logged, and
        // neither invents a run.
        await this.#closeAbandonedRun(runId, sessionId, 'run_not_created', reason, attemptEpoch);
        return { accepted: false, runId: null, stage: 'run_not_created', reason };
      }

      // Start the run so `run.started` is recorded with its manifest hash
      // BEFORE the worker produces anything. This is what makes a run that
      // crashes on its first frame still answerable.
      //
      // The ledger copy of that fact now comes from the RUNTIME, not from here:
      // the controller's emitter still mints a `run.started` (and still publishes
      // it to the live arm), but `persistenceFor.append` no longer writes it, so
      // the row carries the engine's own `seq` and the Runtime's envelope
      // verbatim. See `persistenceFor` for why one `run.started` has to win.
      //
      // The session is bound by `onDispatchReady`, after `run.started` is
      // durable and before the executor is told to begin. It used to be bound
      // FIRST, which meant a start that failed left the session pointing at a
      // run with no `run.started` and no place in the Control Plane — and the
      // worker's very next frame was then teed into it. Binding first is also
      // what R2.1 requires now, since the dispatch happens inside this call and
      // its first frame can arrive before `openRun` returns.
      // The attempt is already established above, before `run:create` — the same
      // value, read once.
      const handle = await this.#controller.start(built.manifest, {
        prompt: turnPrompt,
        sessionId,
        // `attemptEpoch` is read HERE, at open time, and injected AFTER
        // `inputHash` was computed above. It is a Host→worker directive about WHICH attempt
        // may write, not part of the user's turn input, so folding it into the
        // input revision would make the digest describe something the user never
        // said and would break the worker's own recomputation of it.
        //
        // It is also STORED, because this Host lands the terminal under the same
        // attempt. Re-reading the current epoch at settle time would hand a
        // superseded attempt the newer attempt's number and let its terminal
        // through the fence that exists to stop exactly that.
        options: { ...effectiveTurnOptions, attemptEpoch },
        // The revision computed above, verbatim. Passing it is what keeps the
        // digest on the executor's command identical to the one now in the run
        // row; letting the controller recompute it would be a second
        // derivation of the same value.
        revision: inputHash,
      });
      this.#retain(runId, handle);
      dispatched = true;
      return { accepted: true, runId };
    } catch (error) {
      this.#forgetRun(runId);
      // The binding is released here rather than left to survive a refused
      // start: a session pointing at a run that was never dispatched is exactly
      // what R1.2 fixed, and `dispatch_refused` reaches this path now that a
      // missing worker is a refusal instead of a silently dropped command.
      if (this.#bySession.get(sessionId) === runId) {
        this.#bySession.delete(sessionId);
      }
      if (error instanceof RunStartError) {
        // `start_failed` is the code, and it is not the same incident as a
        // refused row: the row exists, the run did not open, and the executor
        // was never dispatched. Saying so is the whole value of the code.
        //
        // NO terminal is synthesised here. The controller's own `#failStart`
        // already emitted the `run.failed` and settled the run before it threw
        // this, and contract C allows exactly one writer for a terminal — a
        // second one here would be refused as a `conflict` and would report a
        // settled run as a stranded one.
        this.#logger.warn(`${error.code}: the run was not dispatched — the run layer is degraded`, {
          sessionId,
          runId,
          stage: error.stage,
        });
        return {
          accepted: false,
          runId,
          stage: error.stage,
          reason: describeCause(error.cause) || error.message,
        };
      }
      const reason = describeCause(error);
      this.#logger.warn('openRun failed — chat proceeds without a durable record', {
        sessionId,
        error: reason,
      });
      await this.#closeAbandonedRun(runId, sessionId, 'unknown', reason, attemptEpoch);
      return { accepted: false, runId, stage: 'unknown', reason };
    } finally {
      // The one cleanup that has to cover every exit, including the early
      // `run_not_created` return above. See the note at the top of this method.
      this.#pendingSessionByRun.delete(runId);
      // A run that never dispatched owns nothing worth keeping — not a model
      // binding, and not an attempt. Read from the `dispatched` flag rather than
      // from the return value because two of the three failure exits call
      // `#closeAbandonedRun` FIRST, which needs the attempt still present.
      if (!dispatched) this.#forgetRun(runId);
    }
  }

  /**
   * Give a run that was created and then abandoned a real terminal.
   *
   * ## Why this is not optional
   *
   * On the `run_not_created` path `run:create` has already been sent, and a
   * refusal or an unreadable reply does not tell us whether its row landed. If
   * it did, nothing will ever execute that run — the controller is never
   * reached, so its `#failStart` never runs — and the row stays
   * `status='running'` with `terminal=NULL` and `finished_at=NULL` and no
   * process that will ever move it. Contract C requires exactly this case
   * ("dispatch failure must synthesise an explicit terminal event"), because a
   * stranded row is a run the Control Plane can never answer for, and a
   * reconciler reading `running` forever is told a story that is not what
   * happened.
   *
   * ## `run:complete` is asked to be the authority, not a guess
   *
   * This does not decide whether the row exists. It asks, and `completeRun`
   * answers `absent` when the write matched nothing, so a `run:create` that
   * failed before its row landed reports "there was nothing to close" instead
   * of inventing a terminal for a run that does not exist. The two answers are
   * different incidents and are logged differently. A `conflict` is the third:
   * somebody else already decided a terminal, so this run is NOT stranded and
   * this call has nothing to add.
   *
   * ## Not called for a `RunStartError`
   *
   * The controller's `#failStart` emits the `run.failed` and settles the run
   * before it throws, and contract C allows one writer for a terminal. This is
   * only the path the controller does not reach.
   *
   * Never throws: `openRun` does not throw by contract, and a failure to record
   * this failure must not become a second failure the caller cannot see. A
   * terminal that could not be committed is reported at ERROR, which is the
   * loudest thing available for a row that stays stranded — and R1.2's
   * deliberate "only `complete` itself failing leaves the row at `running`"
   * remains true, now with a log line naming it instead of silence.
   *
   * ## The attempt is a PARAMETER, not a lookup
   *
   * `attemptEpoch` is passed in rather than read from `#attemptByRun` so that
   * "this close has no attempt to present" is unrepresentable instead of a
   * silent `undefined`. It matters because `run:complete` is a FENCED write: a
   * payload with no readable attempt is refused as invalid, and the refusal
   * leaves the row exactly as stranded as not having called this at all. The
   * value is the one `openRun` established before `run:create`, which is the
   * same attempt the row was created under.
   */
  async #closeAbandonedRun(
    runId: string,
    sessionId: string,
    stage: RunStartStage,
    reason: string,
    attemptEpoch: number,
  ): Promise<void> {
    const error = {
      code: abandonedRunErrorCode(stage),
      message: `the run was created and then abandoned (${stage}): ${reason}`,
    };
    // The terminal EVENT as well as the terminal STATE.
    //
    // Settling the row alone leaves `run_events` with no record of how the run
    // ended, which is the state R1.2 calls out as the worst outcome: "a
    // transaction that rolls back leaves one `running` row and zero clues about
    // how it ended". Appending first is also R1.2's chosen order — append
    // confirmed, THEN complete — so a crash between the two still leaves the
    // decided terminal in the log for a reconciler to find. One order, both
    // adapters, no divergence.
    const appended = await this.#appendTerminalEvent(runId, sessionId, error, attemptEpoch);
    if (!appended) {
      // The log could not take the event. The row is still settled below, so
      // this is a degraded transcript rather than a stranded run, and saying so
      // is the honest report.
      this.#logger.warn('the abandoned run\'s terminal event could not be appended — the transcript is degraded', {
        runId,
        stage,
      });
    }
    const terminal: RunTerminalState = { status: 'failed', error };
    try {
      const reply = await this.#options.dbRequest('run:complete', { runId, terminal, epoch: attemptEpoch });
      const receipt = readRunReceipt(reply, 'run:complete', runId);
      if (isDurableWrite(receipt)) {
        this.#logger.warn('a run row that was created and never executed has been given a terminal', {
          runId,
          stage,
          state: receipt.state,
        });
        return;
      }
      if (receipt.state === 'absent') {
        // Nothing was stranded: the create never landed either. Said plainly so
        // the two incidents stay distinguishable in the log.
        this.#logger.info('no run row to close — the create never landed either', { runId, stage });
        return;
      }
      if (receipt.state === 'conflict') {
        // Not stranded: another writer already recorded a terminal for this
        // run, so the row is decided and this call has nothing to add.
        this.#logger.info('another writer already recorded a terminal for this run', {
          runId,
          stage,
          committed: receipt.committed?.status,
        });
        return;
      }
      this.#logger.error('a run row was left with no terminal and the attempt to record one was refused', new Error(describeReceipt(receipt)), {
        runId,
        stage,
      });
    } catch (error) {
      this.#logger.error('a run row was left with no terminal and the attempt to record one threw', error instanceof Error ? error : new Error(String(error)), {
        runId,
        stage,
      });
    }
  }

  /**
   * Append the one `run.failed` envelope for a run that never executed.
   *
   * `seq` is read back from the run's own log rather than assumed to be 1: the
   * protocol's sequence is per-run and strictly increasing, and a run whose
   * `run.started` landed before the failure already has events. Guessing would
   * collide with an existing `(runId, seq)` and the store would refuse the whole
   * batch as a content conflict.
   *
   * The attempt rides along because `run:append` is fenced exactly like
   * `run:complete`: this is a write under the run's attempt, and a payload with
   * no attempt is refused rather than made unfenced.
   */
  async #appendTerminalEvent(
    runId: string,
    sessionId: string,
    error: ProtocolErrorInfo,
    attemptEpoch: number,
  ): Promise<boolean> {
    try {
      const existing = await this.#options.dbRequest('run:events', { runId, afterSeq: 0 });
      const rows = Array.isArray(existing) ? (existing as Array<{ seq?: unknown }>) : [];
      const highest = rows.reduce((max, row) => (typeof row.seq === 'number' && row.seq > max ? row.seq : max), 0);
      const reply = await this.#options.dbRequest('run:append', {
        runId,
        epoch: attemptEpoch,
        events: [{ runId, sessionId, seq: highest + 1, payload: { type: 'run.failed', error } }],
      });
      return isDurableWrite(readRunReceipt(reply, 'run:append', runId));
    } catch (thrown) {
      this.#logger.warn('appending the abandoned run\'s terminal event failed', {
        runId,
        reason: thrown instanceof Error ? thrown.message : String(thrown),
      });
      return false;
    }
  }

  /**
   * Keep a handle answerable after its run ends, up to the retention limit.
   *
   * `Map` preserves insertion order, so the first key is the oldest and
   * evicting it evicts the right one without a second structure.
   */
  #retain(runId: string, handle: RunHandle): void {
    this.#handleByRun.delete(runId);
    this.#handleByRun.set(runId, handle);
    while (this.#handleByRun.size > RETAINED_HANDLES) {
      const oldest = this.#handleByRun.keys().next();
      if (oldest.done === true) return;
      this.#handleByRun.delete(oldest.value);
    }
  }

  /**
   * The run's `RunResult` once it has ended, or `null` for a session that never
   * had one.
   *
   * A READ. It waits on the runtime's completion promise and never settles the
   * run, so a host can ask for the receipt after the fact without becoming
   * another thing that can end a turn.
   *
   * ## The `RunResult` is REWRITTEN to the durable terminal
   *
   * `handle.result()` is the Runtime's own in-memory verdict, and it is exactly
   * the value that survives when this Host has downgraded the terminal because
   * the ledger lost events. Handing that to a consumer is how a Desktop client —
   * which reads its run result from `GET /runs/result`, not from the `onEvent`
   * arm — was told `completed` about a run the table calls `failed`.
   *
   * Only the terminal is replaced. The rest of the result is the runtime's: it
   * is a receipt about the execution, and rewriting fields nobody disputed would
   * be inventing data. When the terminal differs the disagreement is logged, so
   * the substitution is never invisible.
   */
  async resultFor(sessionId: string): Promise<RunResult | null> {
    const runId = this.#bySession.get(sessionId) ?? this.#endedBySession.get(sessionId);
    if (runId === undefined) return null;
    const handle = this.#handleByRun.get(runId);
    if (handle === undefined) return null;
    const result = await handle.result();
    const durable = this.#durableTerminalFor(runId, terminalOfResult(result));
    if (durable === null || durable.status === result.status) return result;
    // Only the status and its error move. Every other field of the result is the
    // runtime's own receipt about the execution, and rewriting a field nobody
    // disputed would be inventing data.
    const error = durable.status === 'failed' ? durable.error : undefined;
    return { ...result, status: durable.status, ...(error === undefined ? {} : { error }) };
  }

  /**
   * Drop every trace of a run that is not going to happen.
   *
   * Called on both failure paths out of `openRun`. Leaving the model binding
   * behind would make it one more entry in a map with no delete — and leaving
   * the ATTEMPT binding behind was exactly that: the attempt is established two
   * lines before `controller.start`, so every start that threw used to leave one
   * permanent entry keyed by a run id that will never execute anything.
   */
  #forgetRun(runId: string): void {
    this.#modelByRun.delete(runId);
    this.#attemptByRun.delete(runId);
  }

  /**
   * Tee one normalised worker frame.
   *
   * The router KEEPS WRITING THE FRAME IT PASSED IN. It does not write the
   * `legacy` field this returns. That is the whole mechanism behind "the UI
   * does not change": the live path forwards the exact object the renderer
   * parsed before the run layer existed, and the run layer only takes a copy.
   *
   * Writing the projected frame instead would be a subtle regression rather
   * than a no-op — the projection is lossy by construction (it is many-to-one
   * and drops fields the legacy union never declared), so routing the live
   * stream through it would quietly truncate `goal_updated`, `mode_changed`
   * and `tool_result` payloads. The projector exists for the REPLAY path, not
   * for the live one.
   *
   * @returns The projected frame and a flag, for diagnostics and for a future
   *   replay reader. The live SSE writer ignores both.
   */
  observe(sessionId: string, frame: Record<string, unknown>): ObservedFrame {
    const runId = this.#bySession.get(sessionId);
    if (runId === undefined) {
      // No live run. Whether one ENDED here or never existed is the difference
      // between a worker that kept producing and a routing mistake, and the
      // router cannot tell them apart without asking. A settlement still in
      // flight counts as ended: the run has decided, and the receipt simply has
      // not been written yet.
      const ended = this.#endedBySession.get(sessionId);
      const late =
        this.#finishing.has(sessionId) ||
        (ended !== undefined && this.#controller.receiptFor(ended) !== null);
      if (late) {
        this.#logger.warn('a worker frame arrived after its run had already ended', { sessionId, runId: ended });
      }
      return { legacy: null, forwardOnly: false, late };
    }

    const outcome = this.#controller.observeFrame(runId, frame);
    if (outcome.envelope !== null) {
      const envelope = outcome.envelope;
      if (envelope.payload.type === 'run.completed' || envelope.payload.type === 'run.failed') {
        // HELD, not published. A terminal is the event a client reads as "this
        // succeeded", and the settle below has not yet reached the durable
        // `run:complete`. Publishing it here is exactly the publish-before-
        // commit this run layer must not do, so it waits for `#finish`.
        this.#terminalAwaitingCommit.set(runId, envelope);
        void this.#finish(sessionId, runId);
      } else {
        this.#publish(runId, envelope);
      }
    }
    return { legacy: outcome.legacy, forwardOnly: outcome.forwardOnly, late: outcome.late ?? false };
  }

  /**
   * Settle a session's run on a path that produced no terminal frame.
   *
   * A response that closes with the worker still alive is not a completed run —
   * but a response that closes with the worker GONE and no terminal frame is a
   * run that ended without saying why, and `resolveRunOutcome` records that as
   * `runtime_crash`. Silence is not consent.
   *
   * This is also the router's BACKSTOP (`res.on('close')`), and its whole job
   * is to be certain the run reached a terminal. When a `done` frame has
   * already started that work, this waits for it rather than returning while
   * the terminal write is still crossing the process boundary — which is what
   * made the close event unable to vouch for the run it was closing.
   *
   * @returns The terminal the run reached, or `null` when the session had no
   *   live run to settle. The non-SSE response needs it: it has no stream to
   *   read an outcome off, and answering "interrupted" without saying what the
   *   run recorded is the gap R2.1 closes. `null` is deliberately distinct from
   *   a terminal — "there was no run" is not "the run ended".
   */
  async settleSession(
    sessionId: string,
    opts?: { cancelRequested?: boolean },
  ): Promise<RunTerminalState | null> {
    const inFlight = this.#finishing.get(sessionId);
    if (inFlight !== undefined) {
      await inFlight;
      return this.#terminalFor(sessionId);
    }
    const runId = this.#bySession.get(sessionId);
    if (runId === undefined) return null;
    try {
      await this.#finish(sessionId, runId, opts);
    } catch (error) {
      this.#logger.error('Run settle failed', error instanceof Error ? error : new Error(String(error)), { sessionId, runId });
    }
    return this.#terminalFor(sessionId);
  }

  /**
   * The terminal the session's run COMMITTED, live or ended.
   *
   * This is what a non-SSE caller learns, and it is deliberately the same
   * answer the published event gives: a terminal this Host downgraded before
   * committing is read back here, so "the ledger says failed" and "the caller
   * was told completed" can never both be true. The Runtime's own in-memory
   * verdict is used only when the ledger holds the same thing — otherwise it
   * would report a success no row contains.
   *
   * `controller.receiptFor` answers for ENDED runs only, so a live run is asked
   * directly. `null` means this controller has no record of a run for the
   * session at all.
   */
  #terminalFor(sessionId: string): RunTerminalState | null {
    const runId = this.#bySession.get(sessionId) ?? this.#endedBySession.get(sessionId);
    if (runId === undefined) return null;
    const decided = this.#controller.activeRun(runId)?.terminal ?? this.#controller.receiptFor(runId);
    return this.#durableTerminalFor(runId, decided);
  }

  /**
   * The DURABLE terminal for a run, in place of the Runtime's in-memory verdict.
   *
   * ## Why this exists at all
   *
   * The Runtime's verdict and the ledger's terminal are two different facts, and
   * they disagree in exactly the cases a consumer must not be lied to about:
   *
   *  - this Host downgraded the terminal because the ledger lost native events
   *    (`persistenceFor.complete`): the row is `failed`, the Runtime still
   *    believes it succeeded;
   *  - the Runtime degraded its own verdict because the durable barrier refused
   *    (`persistence_failed`), which `settle` resolved to — that one agrees with
   *    the row already, and passes through untouched.
   *
   * Every route that can TELL a consumer gets this: the settle return value, the
   * `RunResult` read, and the cancel receipt. A consumer told `completed` over a
   * row that says `failed` is the failure this whole layer exists to prevent, and
   * one unguarded read route is enough to reproduce it.
   *
   * While the run is still LIVE the Runtime's verdict is the live truth — the
   * ledger has not decided anything yet — so the override applies only to a run
   * that has ended.
   *
   * A disagreement is LOGGED, not silently resolved: the row and the event
   * stream naming different outcomes is a property an operator has to be able to
   * find, and a quiet substitution would hide it.
   */
  #durableTerminalFor(
    runId: string,
    runtimeTerminal: RunTerminalState | null,
  ): RunTerminalState | null {
    const durable = this.#committedTerminalByRun.get(runId);
    if (durable === undefined) return runtimeTerminal;
    if (this.#controller.activeRun(runId) !== undefined) return runtimeTerminal;
    if (runtimeTerminal !== null && durable.status !== runtimeTerminal.status) {
      this.#logger.warn(
        'the terminal reported to this consumer is the durable one, not the verdict the runtime reached',
        {
          runId,
          durable: durable.status,
          runtime: runtimeTerminal.status,
        },
      );
    }
    return durable;
  }

  /**
   * The ONE path a run leaves through, whichever producer asked.
   *
   * The `done` frame settles from inside `observe`, and the router's
   * `res.on('close')` backstop settles the rest. Before this, the `done` path
   * never released anything, so the session mapping and the model binding were
   * only cleaned if a close event happened to arrive afterwards — and the model
   * binding was never cleaned at all. One exit means the run layer cannot leak
   * on one path while being tidy on the other.
   *
   * ## Why the queue drain lives HERE and not in `settleSession`
   *
   * `#finish` is the one function all three producers call: `observe`'s terminal
   * frame, `settleSession` (the router's close backstop), and `cancelRun`. A
   * barrier in `settleSession` would be skipped by the other two — including the
   * `done`-frame path, which is precisely the one that races the worker's final
   * `run:event` lines. Putting the wait where the run's LAST step happens is
   * also what makes the guarantee hold for the counters: the appends land, and
   * therefore `#nativeLostByRun` is populated, before `settle` reads it to decide
   * whether this run may record a success.
   */
  #finish(
    sessionId: string,
    runId: string,
    opts?: { cancelRequested?: boolean },
  ): Promise<void> {
    // The tail this drain settled on, kept for the identity-guarded cleanup
    // below: a queue entry that a NEWER run replaced must not be dropped by
    // this run's settle.
    let drainedTail: Promise<unknown> | null = null;
    const settling: Promise<void> = this.#drainNativeQueue(sessionId)
      .then(({ tail }: { tail: Promise<unknown> | null }) => {
        drainedTail = tail;
        // `#release` deletes the session->run binding every append checks, and
        // `#attemptByRun` with it. It is therefore reached only AFTER this
        // session's queued appends have been asked, which is the whole point:
        // previously this was the first statement of `#finish`, so any append
        // still behind the orchestrator's own `await` found no live run and was
        // dropped — the terminal envelope first.
        this.#release(sessionId, runId);
        // The terminal this produces is the CONTROLLER's to publish; this path
        // only has to be certain the write was attempted, so the value is dropped
        // explicitly rather than leaking into the promise's type.
        return this.#controller.settle(runId, opts);
      })
      .then((terminal: RunTerminalState) => {
        // `settle` resolving is the COMMIT CONFIRMATION: `persistenceFor.complete`
        // has already read the `run:complete` receipt back and thrown if it was
        // not a durable write. Publishing the held terminal here rather than in
        // `observe` is the whole of "no success before commit confirmation" — a
        // client cannot observe a completed run whose terminal never landed.
        this.#reportNativeChannel(runId);
        this.#releaseTerminalToConsumers(runId, terminal);
      })
      .catch((error: unknown) => {
        // The terminal is DROPPED, not downgraded and not published. The run
        // did not commit its terminal, so any client told otherwise has been
        // told a success that is not durable; the ERROR line is the only honest
        // report this path can make.
        this.#reportNativeChannel(runId);
        const held = this.#terminalAwaitingCommit.get(runId);
        this.#terminalAwaitingCommit.delete(runId);
        if (held !== undefined) {
          this.#logger.error('the run terminal was not published because its durable commit did not land', new Error(held.payload.type), {
            sessionId,
            runId,
            eventType: held.payload.type,
          });
        }
        this.#logger.error('Run settle failed', error instanceof Error ? error : new Error(String(error)), {
          sessionId,
          runId,
        });
      })
      .finally(() => {
        if (this.#finishing.get(sessionId) === settling) this.#finishing.delete(sessionId);
        // The run has ENDED here, so the attempt's lifecycle is over and the
        // binding is dropped — a retired attempt must not survive its own run.
        this.#forgetAttempt(runId);
        // Released with the run it was drained for, so a session cannot
        // accumulate one entry per turn.
        //
        // Unconditional on the run's OWN tail, and no longer skipped when the
        // session had nothing queued: after `#release` the session has no live
        // run, so `queueNativeRunEvent` refuses rather than re-creating an entry
        // (see the guard there). The identity check is kept for the one case
        // that can still legitimately replace the tail — a session whose next
        // run opened while this one was settling.
        if (drainedTail !== null && this.#nativeQueues.get(sessionId) === drainedTail) {
          this.#nativeQueues.delete(sessionId);
        }
        try {
          this.#options.onRunSettled?.(runId);
        } catch (error) {
          this.#logger.warn('live run event stream close failed', {
            runId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    this.#finishing.set(sessionId, settling);
    return settling;
  }

  /**
   * Publish the terminal held since `observe` — but only the terminal that was
   * actually committed.
   *
   * ## The rule, in one sentence
   *
   * A consumer may be told a run SUCCEEDED only if the durable row says it
   * succeeded. `settle` resolving is the commit confirmation, and the terminal
   * it resolved to is the verdict the ledger holds — so the held envelope is
   * announced only when the two agree.
   *
   * ## Why the two can disagree, and what each one is
   *
   *  - `settle` resolved to a terminal the Runtime DEGRADED because the durable
   *    barrier refused (`run-session.ts` turns a refused `persistence.complete`
   *    into `persistence_failed`). The row and the held `run.completed`
   *    envelope then name different outcomes, and announcing the envelope would
   *    hand a client a success that is not on disk.
   *  - this Host downgraded the terminal itself because the ledger lost native
   *    events (see `persistenceFor.complete`). The Runtime's in-memory verdict
   *    is untouched, so `settle` resolves with the SUCCESS it reached.
   *
   * In both cases the envelope is dropped and the disagreement is logged. It is
   * not rewritten: the envelope is the Runtime's, and a Host that edits a
   * `(run, seq)` payload would mint a second identity for one event.
   */
  #releaseTerminalToConsumers(runId: string, committed: RunTerminalState): void {
    const held = this.#terminalAwaitingCommit.get(runId);
    this.#terminalAwaitingCommit.delete(runId);
    if (held === undefined) return;
    const overridden = this.#committedTerminalByRun.get(runId);
    const durable = overridden ?? committed;
    if (durable.status !== terminalStatusOf(held.payload)) {
      this.#logger.error(
        'the run terminal was not published because the durable terminal is not the one this event describes',
        new Error(`run ${runId} is durably ${durable.status}; the withheld event says ${held.payload.type}`),
        {
          runId,
          eventType: held.payload.type,
          committed: durable.status,
          settled: committed.status,
        },
      );
      return;
    }
    this.#publish(runId, held);
  }

  #release(sessionId: string, runId: string): void {
    // Only clear the session if it still points at THIS run. A second turn can
    // have opened while the first was still settling, and clearing the newer
    // run's binding would route its frames nowhere.
    if (this.#bySession.get(sessionId) === runId) {
      this.#bySession.delete(sessionId);
      this.#endedBySession.set(sessionId, runId);
    }
    this.#modelByRun.delete(runId);
    // RETIRED, not deleted. This runs before `controller.settle`, so a delete
    // here would take the number away from the terminal CAS that is about to be
    // written and fence it with nothing. The binding is dropped by
    // `#finish`'s own `finally`, once the run has actually ended — which is
    // also what makes it impossible for a retired attempt to present again.
    this.#retireAttempt(runId);
  }

  /**
   * Stop a session's run through the runtime's own cancel path.
   *
   * The sibling of {@link settleSession}, and deliberately NOT a synonym for it.
   * `settleSession` records a terminal for a run somebody else already stopped —
   * it is what the router's `res.on('close')` backstop uses, where the worker is
   * interrupted on the line above and the run only needs closing. This one asks
   * the run to stop: it issues the interrupt itself and returns what the stop
   * turned into.
   *
   * That distinction is the reason `handleDeleteChat` calls THIS and not the
   * pair. The DELETE route used to interrupt the worker on its own and leave the
   * run `running` forever, while the SSE disconnect path one screen away went
   * through the arbiter — two host-initiated stops, one of which had no terminal
   * at all. Both are now one arbiter with two call styles, and the difference
   * between them is who sends the interrupt, not whether the run is closed.
   *
   * `null` when the session has no live run. "There was no run" is not "the run
   * was cancelled", and a host that reads `null` as a success invents a
   * cancellation for a turn that never started.
   */
  async cancelSession(sessionId: string, reason: string): Promise<CancelOutcome | null> {
    // `#endedBySession` as well as `#bySession`, because a run that has already
    // settled is still answerable: the caller wants to know that stopping it did
    // nothing, and the terminal it reached is the answer. Only a session with
    // neither a live run nor a recent one returns `null`.
    const runId = this.#bySession.get(sessionId) ?? this.#endedBySession.get(sessionId);
    if (runId === undefined) return null;
    return this.cancelRun(sessionId, runId, reason);
  }

  /** Cancel one specific run, even if a newer run now belongs to its session. */
  async cancelRun(sessionId: string, runId: string, reason: string): Promise<CancelOutcome | null> {
    try {
      const outcome = await this.#controller.cancel(runId, { reason: `delete:${reason}` });
      // The controller can settle without a worker terminal frame (hard stop,
      // already closed, or interrupt timeout). Release the Host's ownership and
      // close its live stream before acknowledging cancellation in every case.
      if (outcome.requested) await this.#finish(sessionId, runId, { cancelRequested: true });
      // Read back through the DURABLE gate, and for BOTH cases. Rewriting only
      // the `requested` arm left the more common one unguarded: a cancel
      // against a run that had ALREADY settled — which is what the delete route
      // does whenever the user stops a turn that has finished — returns the
      // runtime's receipt untouched, and that receipt goes straight into the
      // route's JSON body.
      const durable = this.#durableTerminalFor(runId, outcome.terminal);
      if (durable === null || durable === outcome.terminal) return outcome;
      return { ...outcome, terminal: durable };
    } catch (error) {
      this.#logger.error(
        'Run cancel failed',
        error instanceof Error ? error : new Error(String(error)),
        { sessionId, runId },
      );
      // A cancel that could not complete still has to CLOSE the run: the worker
      // is being stopped either way, and leaving the row `running` is the one
      // outcome nobody can reconcile later. The fallback terminal is read once,
      // after the settle, because a receipt that does not exist yet is not a
      // terminal to report.
      await this.#finish(sessionId, runId, { cancelRequested: true });
      // Read once, after the settle, because a receipt that does not exist yet
      // is not a terminal to report — and read back through the DURABLE gate for
      // the same reason `resultFor` is: this receipt is put straight into the
      // cancel route's JSON response, so a runtime verdict that the ledger does
      // not back would be handed to the client as a cancellation that the row
      // contradicts.
      const terminal = this.#durableTerminalFor(runId, this.#controller.receiptFor(runId));
      // `null` rather than a fabricated `completed`: if the settle also failed,
      // this host has no terminal to give and must say so instead of inventing
      // a success for a run it could not close.
      return terminal === null ? null : { requested: true, applied: true, terminal };
    }
  }

  /** The live run for a session, for the cancel path. */
  runForSession(sessionId: string): string | null {
    return this.#bySession.get(sessionId) ?? null;
  }

  isSessionBusy(sessionId: string): boolean {
    return this.#openingSessions.has(sessionId) || this.#bySession.has(sessionId) || this.#finishing.has(sessionId);
  }

  /** Includes the settlement barrier after the live session binding retires. */
  ownsRun(runId: string, sessionId: string): boolean {
    return this.#pendingSessionByRun.has(runId) || this.#bySession.get(sessionId) === runId
      || (this.#finishing.has(sessionId) && this.#endedBySession.get(sessionId) === runId);
  }

  /**
   * Put ONE Runtime-minted envelope into the durable ledger, verbatim.
   *
   * ## Why this is not `observe`
   *
   * `observe` reverse-translates a legacy frame and therefore cannot preserve
   * the identity the Runtime gave an event. This arm takes the envelope as it
   * arrived: the `seq` written is the `seq` the engine minted, so a ledger row
   * can be matched back to the envelope that produced it.
   *
   * ## What is refused, and why each refusal is different
   *
   *  - **A run id that is not this session's live run.** Refused before any
   *    write. A worker holding a stale or foreign run id must never be able to
   *    land rows under a run its session did not open.
   *  - **No live run for the session.** The run either never opened or already
   *    settled; either way appending would create rows on a decided run.
   *  - **A superseded attempt (`fenced`).** Dropped, loudly. The attempt fence
   *    exists precisely so a slow worker cannot mutate a run the Host has moved
   *    on from, and retrying is not an option: the same batch fails identically
   *    every time.
   *  - **A contradicted `(runId, seq)` (`conflict`).** Refused loudly rather
   *    than dropped, because two different envelopes claiming one identity is a
   *    broken transcript, not a retry.
   *
   * Never throws: this runs on the worker's stdout path, and an exception here
   * would be attributed to the run rather than to the message that caused it.
   */
  async persistNativeRunEvent(
    sessionId: string,
    envelope: RunEventEnvelope,
    epoch: number,
  ): Promise<NativeEventAcceptance> {
    return this.#appendNativeRunEvent(sessionId, envelope, epoch);
  }

  /**
   * Take ONE wire-valid `run:event` line without being able to await it.
   *
   * ## Why a host needs this at all
   *
   * The standalone Host's intake is async — `run-execution.ts` awaits every
   * message it decodes — so it can use {@link persistNativeRunEvent} directly.
   * The Desktop router's is not: its stdout tee is a SYNCHRONOUS `onData`
   * handler that must return a frame to write to SSE, and a frame the worker
   * writes after the `done` frame would otherwise be read after `#finish` has
   * already released the session's run.
   *
   * ## What it buys
   *
   * Ordering, not parallelism: the append is chained onto this session's tail
   * and {@link #finish} awaits that tail before releasing the binding. So the
   * seq the worker minted is the seq the ledger holds, in the worker's order,
   * and the terminal envelope lands before the terminal row.
   *
   * ## What it deliberately does NOT do
   *
   * It never throws. This runs on a hot transport path with nobody to catch a
   * rejection, so a wire refusal is logged and an append failure is recorded as
   * a verdict — the same two outcomes {@link persistNativeRunEvent} returns,
   * because it is the same body.
   */
  queueNativeRunEvent(sessionId: string, frame: Record<string, unknown>): void {
    const read = readNativeWireFrame(frame);
    if ('refusal' in read) {
      this.#logger.warn(`dropped a native run:event — ${read.refusal}`, { sessionId, frame: 'run:event' });
      return;
    }
    // ## A late frame must not resurrect an entry nothing will ever clean
    //
    // The chain below is UNCONDITIONALLY written to `#nativeQueues`, and the
    // only cleanup is `#finish`'s `finally`, guarded on the tail it drained. A
    // frame enqueued after that cleanup therefore re-created an entry that
    // nothing deletes until this session's NEXT turn settles — and if the session
    // never runs again, it is never deleted. The map had no bound.
    //
    // The ledger was never at risk (the append below refuses a session with no
    // live run), so this was not a data-loss bug. It was an unbounded map keyed
    // by session id, growing for every conversation that ever ended mid-write,
    // which is a leak that only shows up as a slow memory climb with nothing to
    // attribute it to.
    //
    // Refusing HERE is what closes it: the session has no live run, so this
    // frame can never be appended, and declining to create the entry is what
    // keeps "a session that never runs again retains nothing" true. The check is
    // safe to make synchronously — the session is bound by `onDispatchReady`
    // BEFORE the dispatch command is sent, so no frame the worker can produce
    // can arrive before its run is bound.
    if (!this.#bySession.has(sessionId)) {
      this.#logger.warn(`dropped a native run:event — ${noLiveRunReason(sessionId)}`, {
        sessionId,
        runId: read.envelope.runId,
        seq: read.envelope.seq,
        epoch: read.epoch,
      });
      return;
    }
    const previous = this.#nativeQueues.get(sessionId);
    const queued: Promise<unknown> = (previous ?? Promise.resolve())
      .then(() => this.#appendNativeRunEvent(sessionId, read.envelope, read.epoch))
      .then(
        (verdict: NativeEventAcceptance) => {
          if (!verdict.accepted) {
            this.#logger.warn(`dropped a native run:event — ${verdict.reason}`, {
              sessionId,
              runId: verdict.runId,
              seq: read.envelope.seq,
              epoch: read.epoch,
            });
          }
        },
        (error: unknown) => {
          // `#appendNativeRunEvent` reports its own failures, so reaching this
          // handler means the failure was in the ORCHESTRATOR rather than in the
          // append — a broken chain, which must not become an unhandled
          // rejection with nothing left to settle it.
          this.#logger.error('the native run event queue broke', error instanceof Error ? error : new Error(String(error)), {
            sessionId,
            runId: read.envelope.runId,
            seq: read.envelope.seq,
          });
        },
      );
    this.#nativeQueues.set(sessionId, queued);
  }

  /**
   * Wait until nothing more is queued for this session.
   *
   * Loops rather than awaiting one tail: a frame can be enqueued while the
   * previous tail is still running — the worker is still writing while the
   * `done` frame settles the run — and stopping at the tail this call happened
   * to read would put that frame behind `#release` exactly as before. The
   * identity check is what makes the loop terminate: the map only changes when
   * something was enqueued.
   *
   * Never rejects. A settle that skipped its own drain because a queued append
   * threw would release the run with events still unattempted, which is the
   * failure this whole path exists to prevent.
   *
   * @returns The tail it finished on, WRAPPED. It cannot be returned bare: this
   *   function is `async`, and an async function unwraps a thenable it returns,
   *   so a bare `return tail` would arrive at the caller as `tail`'s RESOLVED
   *   VALUE. `drainedTail` was therefore always `undefined`, the identity check
   *   in `#finish` never matched, and the queue entry was never deleted — for
   *   every session that ever ran a native event, not only for the late frames
   *   this guard was written for. A plain object is not a thenable, so it
   *   survives the boundary intact.
   */
  async #drainNativeQueue(sessionId: string): Promise<{ tail: Promise<unknown> | null }> {
    for (;;) {
      const tail = this.#nativeQueues.get(sessionId);
      if (tail === undefined) return { tail: null };
      try {
        await tail;
      } catch (error) {
        this.#logger.error('draining the native run event queue failed', error instanceof Error ? error : new Error(String(error)), {
          sessionId,
        });
        return { tail };
      }
      if (this.#nativeQueues.get(sessionId) === tail) return { tail };
    }
  }

  /**
   * Validate and append ONE Runtime-minted envelope.
   *
   * The single implementation behind BOTH entry points: the awaiting
   * {@link persistNativeRunEvent} and the fire-and-forget
   * {@link queueNativeRunEvent}. They differ in when they are allowed to return,
   * never in what they accept — a host that could persist an envelope one way and
   * refuse it the other would have two ledgers' worth of rules and one of them
   * untested.
   *
   * The refusal contract is documented on {@link persistNativeRunEvent}; this is
   * that body.
   */
  async #appendNativeRunEvent(
    sessionId: string,
    envelope: RunEventEnvelope,
    epoch: number,
  ): Promise<NativeEventAcceptance> {
    const liveRunId = this.#bySession.get(sessionId);
    if (liveRunId === undefined) {
      return {
        accepted: false,
        runId: null,
        reason: noLiveRunReason(sessionId),
      };
    }
    if (envelope.runId !== liveRunId) {
      return {
        accepted: false,
        runId: liveRunId,
        reason: `envelope names run ${envelope.runId} but session ${sessionId} is executing run ${liveRunId}`,
      };
    }
    const writer = this.#options.nativeWriter;
    if (writer === undefined) {
      return {
        accepted: false,
        runId: liveRunId,
        reason: 'this Host has no native run event writer configured',
      };
    }
    // Durability is the protocol's, not the transport's. `assistant.text_delta`
    // is `ephemeral` and its own registry entry says "counted in metrics, never
    // retained" — so a native channel that persisted everything would turn every
    // streamed token into a permanent ledger row. The worker forwards all of them
    // deliberately, because live consumers want them; deciding what survives a
    // crash is this layer's job, and putting the rule HERE means there is one
    // place it can be applied.
    const durability = eventSpecOf(envelope.payload.type)?.durability;
    if (durability === 'ephemeral') {
      return { accepted: true, runId: liveRunId, seq: envelope.seq };
    }
    let outcome: NativeAppendOutcome;
    try {
      outcome = await writer.append(liveRunId, [envelope], epoch);
    } catch (error) {
      this.#logger.error('the native run:event append threw', error instanceof Error ? error : new Error(String(error)), {
        runId: liveRunId,
        seq: envelope.seq,
        epoch,
      });
      this.#recordNativeLoss(liveRunId, envelope.seq);
      return { accepted: false, runId: liveRunId, reason: 'the durable append threw' };
    }
    switch (outcome.state) {
      case 'written':
      case 'duplicate':
        // A duplicate delivery is a no-op at the store and is counted the same
        // way here: the ledger already holds this envelope's identity, which is
        // all the counter is for.
        this.#nativeEventsByRun.set(liveRunId, (this.#nativeEventsByRun.get(liveRunId) ?? 0) + 1);
        return { accepted: true, runId: liveRunId, seq: envelope.seq };
      case 'fenced': {
        // ## This refusal is the run layer's ONLY view of an advanced attempt
        //
        // The store owns the attempt number and this process may not be able to
        // read it (the Desktop writer hardcodes `0`), so nothing here polls and
        // nothing here can notice a fence that has not fired yet. What CAN be
        // done — and is done here — is name the attempt the run was OPENED
        // under next to the one the store says holds authority, so the log says
        // "moved from N to M" instead of restating the presented number.
        const binding = this.#attemptByRun.get(liveRunId);
        const established = binding?.epoch;
        if (binding !== undefined) binding.superseded = outcome.current;
        this.#logger.warn('dropped a native run event from a superseded attempt', {
          runId: liveRunId,
          seq: envelope.seq,
          established,
          presented: outcome.presented,
          current: outcome.current ?? 'not reported',
          // Stated so a reader does not mistake this for a late discovery: the
          // run layer learned it here, at write time, and not before.
          learnedAt: 'the fenced write, not before',
        });
        return {
          accepted: false,
          runId: liveRunId,
          reason:
            outcome.current === null
              ? `attempt ${outcome.presented} may no longer write`
              : `attempt ${outcome.presented} is superseded by ${outcome.current}`,
        };
      }
      case 'conflict':
        this.#recordNativeLoss(liveRunId, envelope.seq);
        this.#logger.error('refused a native run event whose (run, seq) already holds different content', new Error(`run ${liveRunId} already records a different event at seq ${outcome.seq}`), {
          runId: liveRunId,
          seq: outcome.seq,
          epoch,
        });
        return {
          accepted: false,
          runId: liveRunId,
          reason: `(run ${liveRunId}, seq ${outcome.seq}) already holds different content`,
        };
      case 'failed':
        this.#recordNativeLoss(liveRunId, envelope.seq);
        this.#logger.error('the native run event was not persisted', new Error(outcome.reason), {
          runId: liveRunId,
          seq: envelope.seq,
          epoch,
        });
        return { accepted: false, runId: liveRunId, reason: outcome.reason };
    }
  }

  /**
   * Count one durable envelope the current attempt failed to write.
   *
   * The count is what `persistenceFor` consults before it answers an append and
   * what the settle path consults before it records a terminal, so the two can
   * never disagree about whether the ledger is complete.
   */
  #recordNativeLoss(runId: string, seq: number): void {
    this.#nativeLostByRun.set(runId, (this.#nativeLostByRun.get(runId) ?? 0) + 1);
    this.#logger.warn('this run lost a durable event and will not settle as a success', { runId, seq });
  }

  /**
   * Keep the terminal the LEDGER holds, when it is not the one proposed.
   *
   * Bounded exactly like the retained handles, and pruned in the same pass, so
   * an ended run stays answerable without this becoming a second map that only
   * grows.
   */
  #rememberCommittedTerminal(runId: string, terminal: RunTerminalState): void {
    this.#committedTerminalByRun.delete(runId);
    this.#committedTerminalByRun.set(runId, terminal);
    while (this.#committedTerminalByRun.size > RETAINED_HANDLES) {
      const oldest = this.#committedTerminalByRun.keys().next();
      if (oldest.done === true) return;
      this.#committedTerminalByRun.delete(oldest.value);
    }
  }

  /**
   * The attempt this Host is opening the run under, read at open time.
   *
   * `0` is a real answer, not a placeholder: a run row is created at epoch 0
   * and every pre-fence row reads back as 0. A missing seam also yields 0,
   * which is the same write authority the initial attempt holds.
   */
  #attemptEpochFor(runId: string): number {
    const current = this.#options.nativeWriter?.currentEpoch(runId);
    return typeof current === 'number' && Number.isFinite(current) ? current : 0;
  }

  /**
   * Establish the attempt a run is opened under — the START of the lifecycle.
   *
   * Idempotent by refusal rather than by overwrite: a binding that already
   * exists for this run id means the attempt was established once, and letting a
   * second call reset `superseded` would erase the only observation the run layer
   * ever gets that a fence fired.
   */
  #beginAttempt(runId: string, epoch: number): void {
    const existing = this.#attemptByRun.get(runId);
    if (existing !== undefined) {
      this.#logger.warn('the attempt for this run was already established — keeping the first one', {
        runId,
        established: existing.epoch,
        refused: epoch,
      });
      return;
    }
    this.#attemptByRun.set(runId, { epoch, retired: false, superseded: null });
  }

  /**
   * Retire the attempt, which is NOT the same as forgetting it.
   *
   * Retired means "this run's bindings are gone, so no further frame can land
   * under it" — and the number survives so the terminal CAS, which happens after
   * `#release`, can still be fenced by the attempt it belongs to. Forgetting it
   * is the END of the lifecycle and happens once the run has actually ended.
   */
  #retireAttempt(runId: string): void {
    const binding = this.#attemptByRun.get(runId);
    if (binding === undefined || binding.retired) return;
    binding.retired = true;
  }

  /** The END of the lifecycle: the run is over and the attempt may not present. */
  #forgetAttempt(runId: string): void {
    this.#attemptByRun.delete(runId);
  }

  /**
   * The attempt this Host is presenting for a run, for diagnostics and for the
   * `onEvent` consumer. `null` for a run that has no live attempt — a run that
   * never opened, one that never dispatched, and one that has ended are all
   * `null`, because all three may no longer present.
   */
  attemptFor(runId: string): RunAttemptBinding | null {
    const binding = this.#attemptByRun.get(runId);
    if (binding === undefined || binding.retired) return null;
    return { ...binding };
  }

  /**
   * Attempt bindings still held.
   *
   * A leak detector, in the same shape as {@link retainedModelBindings}: one
   * entry is opened per run and retired when it ends, so a number that only goes
   * up is a number that is wrong.
   */
  get retainedAttempts(): number {
    return this.#attemptByRun.size;
  }

  /**
   * Say out loud that a run's ledger has no Runtime identity in it.
   *
   * Without this, a worker that never emits `run:event` produces a run that
   * looks identical to a healthy one from the outside: a `run` row, a terminal,
   * and no explanation for why the transcript is empty. That is a silent
   * degradation, which is the one failure mode this channel was added to remove.
   */
  #reportNativeChannel(runId: string): void {
    const translated = this.#translatedEventsByRun.get(runId) ?? 0;
    const native = this.#nativeEventsByRun.get(runId) ?? 0;
    const lost = this.#nativeLostByRun.get(runId) ?? 0;
    this.#translatedEventsByRun.delete(runId);
    this.#nativeEventsByRun.delete(runId);
    // Released with the counters it was counted for. `#finish` calls this only
    // AFTER the terminal has been committed or refused, so nothing that still
    // needs the loss count can read a cleared entry.
    this.#nativeLostByRun.delete(runId);
    if (lost > 0) {
      this.#logger.error('this run ended with a durable transcript that lost events', new Error(RunLedgerIncompleteError.describe(runId, lost)), {
        runId,
        lostEvents: lost,
        nativeEvents: native,
      });
    }
    if (translated > 0 && native === 0) {
      this.#logger.warn('this run produced legacy frames but no native run events — its durable transcript has no Runtime identity', {
        runId,
        translatedEvents: translated,
        nativeEvents: 0,
      });
    }
  }

  /** Forward one envelope to the live consumers, reporting a failed tee. */
  #publish(runId: string, envelope: RunEventEnvelope): void {
    try {
      this.#options.onEvent?.(envelope);
    } catch (error) {
      this.#logger.warn('live run event publication failed', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Per-run model bindings still held.
   *
   * A diagnostic, and the one that catches a leak: this map is written once per
   * turn and has to be released when the run ends, so a number that only goes
   * up is a number that is wrong.
   */
  get retainedModelBindings(): number {
    return this.#modelByRun.size;
  }

  /** Sessions with a live run. Should return to zero as sessions finish. */
  get retainedSessionRuns(): number {
    return this.#bySession.size;
  }

  /**
   * Native-append queues still held, one per session with frames in flight.
   *
   * A leak detector, and the one that matters most here: an entry is created by
   * a synchronous tee that cannot be awaited, so anything that creates one
   * without a guaranteed remover is unbounded by construction. This number must
   * return to zero when a session settles, and — because a late frame is refused
   * rather than queued when the session has no live run — it must not come back
   * for a session that never runs again.
   */
  get retainedNativeQueues(): number {
    return this.#nativeQueues.size;
  }

  /**
   * The translation context for one run.
   *
   * `classify` returns `generic` on purpose. The protocol's G-2 is explicit
   * that a runtime must not infer `kind` from `toolName` and emit the result
   * as if it were classified: a derived kind is a guess that then reads as a
   * fact in a durable audit chain. There is no permission coordinator in the
   * agent today, so the honest value is the one that means "not classified".
   *
   * The model identity falls back to the manifest's own `agent` selection when
   * the router supplied none, so a run opened by a caller that only persisted a
   * manifest still emits `turn.started` events that name a real model rather
   * than an empty string.
   */
  #contextFor(runId: string, permissionTimeoutMs: number): TranslateContext {
    const resolved = this.#modelByRun.get(runId);
    return {
      messageId: `m-${runId}`,
      permission: {
        classify: () => 'generic',
        mode: 'generic',
        expiresInMs: permissionTimeoutMs,
        now: () => Date.now(),
      },
      nextTurn: (() => {
        let index = 0;
        return () => {
          index += 1;
          return { turnId: `turn-${index}`, index };
        };
      })(),
      model: resolved ?? { model: 'unknown', providerId: 'unknown', apiFormat: 'anthropic' },
    };
  }
}

/**
 * One non-Desktop producer of agent turns, as measured.
 *
 * `ownedBy` names the slice that is expected to take it over. H8 is the
 * migration; R2.1's rule is that this PR moves Desktop chat and no one else,
 * so this list exists to make "no one else" checkable rather than assumed.
 *
 * Every `*Path` is repo-relative and EXISTSENCE-CHECKED by
 * `run-entry-registration.test.ts`. That is the whole point of separating the
 * path from the note: a note can age, but a path that stops resolving fails a
 * build instead of quietly describing a producer that moved.
 */
export interface ConsumerRegistration {
  readonly consumer: string;
  /** Repo-relative path where the turn begins. */
  readonly startPath: string;
  /** Repo-relative path where the turn is stopped, or `null` when there is none. */
  readonly stopPath: string | null;
  /** Repo-relative path where a permission decision is granted or denied. */
  readonly permissionPath: string;
  /** What it mints today, and why that is not a run identity. */
  readonly identityNote: string;
  /** How it is stopped, when `stopPath` is not self-explanatory. */
  readonly stopNote?: string;
  /** The slice that owns taking this over. */
  readonly ownedBy: string;
}

/**
 * Every agent-turn producer that is NOT Desktop chat, with its real paths.
 *
 * ## Why a constant and not a document
 *
 * A list in prose is unfalsifiable — it drifts silently, and nothing notices
 * until someone migrates a path that has since moved. Here, the paths are
 * typechecked data, and a test fails if a registered file disappears. That
 * turns "did we miss a consumer?" from a review question into a test.
 *
 * ## What is deliberately NOT here
 *
 * `packages/cli` starts no agent run at all: it is HTTP CRUD against the
 * agent-server. The plan lists CLI as a consumer, and the real headless entry is
 * `packages/agent/src/cli/index.ts`, which constructs a `DuyaAgent` directly and
 * therefore bypasses `chat:start` entirely. It is recorded below as a
 * DIVERGENCE rather than as a row, because pretending a consumer exists where
 * none does is the failure this list is meant to prevent.
 */
export const NON_DESKTOP_CONSUMERS: readonly ConsumerRegistration[] = Object.freeze([
  Object.freeze({
    consumer: 'automation (scheduler)',
    startPath: 'apps/desktop/src/main/automation/Scheduler.ts',
    stopPath: null,
    permissionPath: 'packages/agent/src/permissions/permissions.ts',
    // CORRECTED, and the correction is what H8.2 measured. This note used to
    // say the runId "only lives inside a session id string" and never reaches
    // the runs table. That stopped being true when the cron/wake POST moved
    // onto `handlePostChat`, which calls `openRun` — so the turn really does
    // get a Control Plane run row with a canonical runId, a manifest and a
    // terminal. The identity was never the gap.
    //
    // The gap was on the READ side: automation settled on the worker's SSE
    // `done` frame, so its verdict was the executor's opinion rather than the
    // run's terminal. It now reads the `RunResult` back through
    // `GET /sessions/:id/run-result` (`handleGetRunResult`), which makes the
    // run layer's terminal — including `cancelled` and `budget_exhausted`,
    // which a `done` frame cannot express — the authority on success.
    identityNote:
      'a real runId on a real runs-table row via openRun; reads the RunResult back rather than ' +
      'trusting the worker done frame',
    ownedBy: 'H8',
  }),
  Object.freeze({
    // A `workflowRunId` written to a DIFFERENT table. Contract §B: stored
    // alongside run identity, never mixed with it.
    consumer: 'workflow agent runtime',
    startPath: 'apps/desktop/src/main/agents/server/workflow-runtime-manager.ts',
    stopPath: 'apps/desktop/src/main/agents/server/workflow-runtime-manager.ts',
    stopNote: 'workflow:cancel on the child stdin, then SIGTERM',
    permissionPath: 'packages/agent/src/permissions/permissions.ts',
    identityNote: 'mints a workflowRunId into its own table, not `runs`',
    ownedBy: 'H8',
  }),
  Object.freeze({
    // `taskId` / `subAgentSessionId`, not a run id. The child's cancel handle
    // is the only stop, and `subagent:kill` reaches it.
    consumer: 'sub-agent tool',
    startPath: 'packages/agent/src/tool/SubagentTool/SubagentTool.ts',
    stopPath: 'packages/agent/src/process/agent-process-entry.ts',
    stopNote: 'subagent:kill reaches the child lifecycle controller',
    permissionPath: 'packages/agent/src/permissions/permissions.ts',
    // H8.2 measured the seam this row would have to cross, and it is a PROCESS
    // boundary, not a code-shape problem. Recorded here so the next slice
    // inherits the finding instead of rediscovering it.
    //
    // RE-MEASURED, and one of #205's four findings did not survive it. The
    // original note here said the worker has "NO route to it: the worker's
    // `db-client` carries ~230 actions and not one `run:*`", and concluded the
    // missing piece was "a worker->CP run-opening channel". Both are true of
    // the worker's TYPED CLIENT SURFACE. Neither is true of the ROUTE:
    //
    //  - `db-client` sends `db:request` up through `process.send`, and the
    //    agent-server forwards a worker's message verbatim
    //    (`server/router.ts:1039` and three sibling spawn sites).
    //  - Main receives it in `agent-server-lifecycle.ts:160-181` and threads
    //    `{ senderPid: <agent-server pid>, registeredSessionId: null,
    //    role: 'agent-server' }`.
    //  - `db-bridge.ts` routes every `run:*` command into `controlPlane.serve`,
    //    whose authenticated request now uses the shared Host Run API.
    //  - That sender is AUTHORISED: `agent-server-lifecycle.ts:616` registers
    //    the pid, and `main/index.ts:351-355` lists `roleOrigin('agent-server')`
    //    among the production `allowedOrigins`.
    //
    // So the channel, its authorisation and the durable `parentRunId` are all
    // in place already. Proven on real SQLite through the real bridge in
    // `__tests__/h8-2-worker-run-channel-seam.test.ts`, which also shows the
    // gate refusing an unspawned pid, an unregistered role and an unattributed
    // sender, writing nothing in all three cases.
    //
    // What IS still missing is the other half of `openRun`. It is "open AND
    // dispatch", and the dispatch is `workerManager.sendCommand(sessionId, ...)`
    // (`server/index.ts:334`) — session-bound, reached only after
    // `handlePostChat` has spawned a worker for that session, and requiring an
    // SSE consumer to tee the worker's frames into `observe`. A worker-issued
    // child run has neither. That, plus the three observable contracts, is the
    // real remainder:
    //
    //  - The sub-agent's turn is a nested `streamChat` loop INSIDE the parent
    //    worker (`runAgent.ts`), so it executes in the parent's process.
    //  - A child run would execute in a DIFFERENT worker (the parent's is busy
    //    and holds the one-live-run-per-session binding), so the child's
    //    observable contract has to change: its progress is emitted today as
    //    worker-local `chat:agent_progress` frames, `run_in_background` is
    //    owned by `BackgroundAgentLifecycle` in the worker, and
    //    `subagent:kill` stops a child lifecycle controller rather than a run.
    //
    // None of that is done here, and none of it is claimed here.
    identityNote: 'mints taskId / subAgentSessionId, which are not run ids; runs as a nested loop in the parent worker',
    ownedBy: 'H8',
  }),
]);

/**
 * Where the plan and the repository disagree, recorded rather than papered over.
 *
 * `packages/cli` is listed by plan 587 §R2.1 as a consumer of the single run
 * entry. It is not one, and it never was: it exposes HTTP CRUD against the
 * agent-server and constructs no run at all. That half of the finding still
 * stands and is still recorded, because a reader who checks only the second
 * half would conclude the plan's claim is now satisfied.
 *
 * The headless path that DOES construct a run is
 * `packages/agent/src/cli/index.ts`, and H8.1 moved it: it now starts its turn
 * through `HeadlessRunHost`, which composes the same `RunController` and the
 * same in-process transport this module uses, so the CLI's turn carries a
 * canonical `runId`, a runtime-minted `seq`, and a terminal the runtime decided.
 * What it does NOT share with Desktop is the `chat:start` wire — it runs in
 * process, so the frame vocabulary is produced by the shared codec rather than
 * read off a pipe. That is a transport difference, not a run-layer one, and it
 * is the reason this list records the shape rather than declaring the migration
 * finished.
 *
 * Recorded here so the next slice inherits the finding instead of
 * rediscovering it, and so nobody reports the CLI as migrated on the strength
 * of a Desktop-only change.
 */
export const RUN_ENTRY_DIVERGENCES: readonly { readonly claim: string; readonly reality: string }[] =
  Object.freeze([
    Object.freeze({
      claim: 'plan 587 §R2.1 lists packages/cli as a consumer of the single run entry',
      reality:
        'packages/cli starts no agent run (HTTP CRUD only) and never did; the headless entry is ' +
        'packages/agent/src/cli/index.ts. H8.1 moved that entry onto the real Run API via ' +
        'HeadlessRunHost (packages/agent/src/process/headless-run-host.ts), which composes the same ' +
        'RunController and in-process transport as the Desktop path. It does not pass through ' +
        'chat:start, because it runs in process rather than over a pipe — a transport difference, ' +
        'not a run-layer one.',
    }),
  ]);

/**
 * What H8.1 made obsolete, and the condition for removing it.
 *
 * ## Why this is data and not a plan-file line
 *
 * "Delete the old path once nothing uses it" is unfalsifiable: nothing counts
 * the users, so the count is whatever the last reader believed. Here the count
 * is a number in a typechecked file, and `headless-retirement.test.ts` fails if
 * it stops matching the code — which turns "is it safe to delete yet?" from a
 * review question into a test.
 *
 * ## Why the count is not zero
 *
 * One caller still reaches the facade, and it is not this slice's to move: the
 * session-end parity test
 * (`packages/agent/src/process/__tests__/engine-session-end-parity.test.ts`),
 * which drives `DuyaAgent.streamChat` directly to prove that the headless host
 * and the legacy engine end a session the same way.
 *
 * This registry used to name two more — the worker subprocess entry
 * (`agent-process-entry.ts:handleChatStart`, reached only through `openRun`)
 * and the sub-agent turn (`runAgent.ts:runAgent`, a nested loop inside the
 * parent worker) — and both were real when it was written. They are not any
 * more: `agent-process-entry.ts` is now a thin adapter over
 * `@duya/host/worker-process-entry` and `runAgent.ts` a re-export of
 * `@duya/host/worker-subagents/run-agent`, and neither holds a facade call
 * site. A registry that names callers which no longer call is a count that
 * can never reach zero, which is the failure this registry exists to prevent.
 *
 * Everything else that matches `.streamChat(` in `packages/agent/src` is an
 * `@duya/ai` client call that never touches the agent facade — the compaction
 * summariser, the side-question path, the model call inside a turn, the vision
 * client, the title generator, the memory-rollout extractor and the search
 * summariser — plus this registry's own prose, which is data rather than a
 * call. Counting those is how a census inflates itself and how a retirement
 * gate ends up chasing a number that can never reach zero. `Stage1Extractor` is
 * the sharpest case: it holds a field named `streamChat` that is
 * `AIClient['streamChat']` bound to an LLM client, so a receiver-name census
 * counts it as a caller of the facade and a reader concludes the shim is pinned
 * by a class that is not even an agent.
 *
 * The one caller deliberately NOT counted is `headless-run-host.ts`, which is
 * the composition H8.1 introduced: the sanctioned path, not a legacy consumer.
 *
 * The number is MEASURED, not estimated: it is the count of `.streamChat(` call
 * sites on a `duyaAgent`/`subAgent` receiver in `packages/agent/src`, excluding
 * `@duya/ai` client calls (a different type with no run semantics at all),
 * excluding comments, and excluding the sanctioned headless host.
 * `headless-retirement.test.ts` re-derives it from the source and fails if the
 * two disagree, so this number cannot go stale without a red test.
 *
 * It was declared `7` until the re-derivation was made to actually compare. The
 * test that should have caught that compared `measured.length` against
 * `measured.length`, so it passed whatever the number was; the 7 counted the
 * `@duya/ai` calls listed above, which the definition excludes. The declared
 * value is now what the definition measures. The CLI's own turn call sites — the
 * part H8.1 owned — were already gone and stay gone.
 *
 * ## What would retire the shim
 *
 * All three, and the third is the one this slice could not evidence:
 *
 *  1. every remaining `streamChat` caller is a non-turn model call, named here;
 *  2. packaging and host smoke pass — a packaged Electron build reaching the
 *     agent-server `ready`, which H8's exit condition names explicitly;
 *  3. the compatibility window is evidenced rather than assumed.
 *
 * Condition 2 is NOT met by this slice. It cannot be: a packaged Electron host
 * is not buildable in the environment H8.1 ran in, and an unevidenced claim of
 * host smoke is exactly the failure this registry exists to prevent. So the
 * shim stays, and the window is recorded here rather than assumed away.
 */
export interface LegacyRetirement {
  /** The export or path that is now obsolete. */
  readonly obsolete: string;
  /** How many callers still reach it. `0` is necessary, not sufficient. */
  readonly remainingConsumers: number;
  /** Who each remaining consumer is, so the count is auditable. */
  readonly consumers: readonly string[];
  /** What each remaining consumer legitimately is, and why it is not a turn. */
  readonly consumerRationale: string;
  /** What still has to be true before the shim is deleted. */
  readonly removalConditions: readonly string[];
  /** Whether every condition is currently met. `false` keeps the shim. */
  readonly removable: boolean;
  /** Why it is not, stated rather than left to the flag. */
  readonly blockedOn: string;
}

export const LEGACY_RETIREMENT: readonly LegacyRetirement[] = Object.freeze([
  Object.freeze({
    obsolete: 'duyaAgent.streamChat as a CLI TURN entry (packages/agent/src/cli/index.ts)',
    remainingConsumers: 0,
    consumers: Object.freeze([]),
    consumerRationale:
      'Measured, not estimated: NO `.streamChat(` call site on a duyaAgent/subAgent receiver ' +
      'remains in packages/agent/src, excluding @duya/ai client calls (a different type with no ' +
      'run semantics), excluding comments, and excluding the sanctioned headless host. The last ' +
      'one this registry named was the session-end parity test, which drove the facade directly ' +
      'to prove that the headless host and the legacy engine end a session the same way; it went ' +
      'away with the agent package\'s test suite. The two call sites the registry named before ' +
      'that — the worker entry (packages/agent/src/process/agent-process-entry.ts) and the ' +
      'sub-agent runner (packages/agent/src/tool/SubagentTool/runAgent.ts) — are pure ' +
      're-export shims over @duya/host (worker-process-entry and worker-subagents/run-agent) and ' +
      'hold no facade call site at all. Every other call of that method in the package is a ' +
      'one-shot model call with no session, no run identity and no terminal — giving those a run ' +
      'would mean minting runs for work that is not a run. The CLI turn call sites — the part ' +
      'H8.1 owned — are gone, and the CLI now starts its turns through HeadlessRunHost.',
    removalConditions: Object.freeze([
      'every remaining streamChat caller is a named non-turn model call, or has been moved',
      'packaging and host smoke pass: a packaged Electron build reaches agent-server ready',
      'the compatibility window is evidenced rather than assumed',
    ]),
    removable: false,
    blockedOn:
      'Host smoke is not evidenced. H8.1 ran where a packaged Electron build cannot be produced, ' +
      'and H8\'s exit condition names host smoke explicitly. The consumer count is now zero, so ' +
      'the shim stays on the smoke condition alone rather than on two counts.',
  }),
]);

/**
 * Log a durability receipt that was not a durable write.
 *
 * Warned here rather than left to the settle path, because this is the only
 * place that still knows which action and which run were refused — and a run
 * that loses a batch mid-stream and is then hard-killed never reaches a settle
 * that could report it.
 *
 * The state's own word is in the message, because "refused" covers five
 * different situations and an operator reading one line has to be able to tell
 * a busy database (retry) from an absent row (investigate) from a content
 * conflict (a bug) without opening a second log line.
 */
function reportAckLoss(receipt: RunWriteReceipt, logger: RunOrchestratorLogger): void {
  logger.warn(`${describeReceipt(receipt)} — the durable transcript is degraded`, {
    runId: receipt.runId,
    state: receipt.state,
  });
}

/**
 * The ledger of one run is missing events, so the run may not report a success.
 *
 * Thrown at the RUNTIME's append port rather than logged at the store, because
 * the Runtime already owns the settlement rule for a lost transcript: it
 * re-offers the batch, and when it finally gives up it degrades the run AND
 * rewrites the row so no `running` row survives. Inventing a second settlement
 * path here would leave exactly the row this error exists to prevent.
 */
export class RunLedgerIncompleteError extends Error {
  readonly code = 'ledger_incomplete' as const;

  constructor(
    readonly runId: string,
    readonly lostEvents: number,
  ) {
    super(RunLedgerIncompleteError.describe(runId, lostEvents));
    this.name = 'RunLedgerIncompleteError';
  }

  static describe(runId: string, lostEvents: number): string {
    return `run ${runId} lost ${lostEvents} durable run ${lostEvents === 1 ? 'event' : 'events'}`;
  }
}

/**
 * A `RunResult` read as the terminal it names.
 *
 * `RunResult` and `RunTerminalState` are the same four statuses in two shapes —
 * one carries an `error` and no `stopReason`, the other the reverse — so the
 * comparison that decides whether a consumer is told the durable verdict has to
 * start by putting the result on the terminal's side of that line. A `failed`
 * with no error still gets a real `ProtocolErrorInfo`, because the failure code
 * is the point of the arm and an absent one would be a fabricated terminal.
 */
function terminalOfResult(result: RunResult): RunTerminalState {
  if (result.status === 'failed') {
    const reported = result.error;
    if (reported !== undefined) return { status: 'failed', error: reported };
    return {
      status: 'failed',
      error: {
        code: 'internal',
        message: `run ${result.runId} reported a failure with no error code`,
      },
    };
  }
  return { status: result.status, ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }) };
}

/**
 * The terminal a withheld envelope describes.
 *
 * Read from the payload rather than from the envelope's type, because a
 * CANCELLED run announces `run.completed` with `status: 'cancelled'` — the type
 * alone would call it a completion and let it past a gate that exists to keep
 * one verdict on the wire and one in the ledger.
 */
function terminalStatusOf(payload: RunEventEnvelope['payload']): RunTerminalState['status'] {
  if (payload.type === 'run.failed') return 'failed';
  const status = (payload as { status?: unknown }).status;
  if (status === 'cancelled' || status === 'budget_exhausted' || status === 'completed') return status;
  return 'completed';
}

/**
 * One `run:event` line, read off an untrusted wire or refused with a reason.
 *
 * These are WIRE-boundary checks on process output that feeds an append-only
 * ledger, and each one is a refusal rather than a throw because the caller is a
 * transport loop. They are the same five conditions
 * `run-execution.ts:#acceptNativeRunEvent` applies on the Host's async path,
 * held here as well because the Desktop router cannot use that private method
 * and this is the one place both entry points agree on.
 *
 * What is NOT checked here, deliberately: which run the envelope belongs to and
 * whether its attempt is current. Both need the session→run binding and the
 * fence, which the orchestrator owns — {@link RunOrchestrator.persistNativeRunEvent}.
 */
type NativeWireFrame = { readonly envelope: RunEventEnvelope; readonly epoch: number } | { readonly refusal: string };

function readNativeWireFrame(frame: Record<string, unknown>): NativeWireFrame {
  const epoch = frame['epoch'];
  if (typeof epoch !== 'number' || !Number.isFinite(epoch) || !Number.isInteger(epoch)) {
    return { refusal: 'no finite integer attempt to fence against' };
  }
  const envelope = frame['envelope'];
  if (!isRecordValue(envelope)) return { refusal: 'no envelope object' };
  const runId = envelope['runId'];
  if (typeof runId !== 'string' || runId === '') return { refusal: 'no runId' };
  const seq = envelope['seq'];
  // `(runId, seq)` IS the event identity, so a fractional or negative sequence
  // is not a retry — it is a row nobody can order.
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) {
    return { refusal: `seq ${String(seq)} is not a safe integer >= 1` };
  }
  const payload = envelope['payload'];
  if (!isRecordValue(payload) || typeof payload['type'] !== 'string') return { refusal: 'no typed payload' };
  return { envelope: envelope as unknown as RunEventEnvelope, epoch };
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A cause, as one diagnostic line.
 *
 * The `reason` on a `not accepted` acknowledgement is read by an operator
 * deciding what to do next, so it gets the underlying message rather than the
 * wrapper's — `RunStartError`'s own message is the same sentence for every
 * stage, which is exactly the text that tells you nothing.
 */
function describeCause(cause: unknown): string {
  if (cause === undefined || cause === null) return '';
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return String(cause);
}

/**
 * The protocol error code for a run that was created and then abandoned.
 *
 * Mapped from the stage onto codes `agent-protocol` already defines, because the
 * point of this terminal is to be READ by a consumer that already knows the
 * vocabulary. A new code here would be a second vocabulary, and the stage is
 * carried in the message either way.
 */
function abandonedRunErrorCode(stage: RunStartStage): ErrorCode {
  switch (stage) {
    // The row was created but the run cannot be shown to have begun: its
    // `run.started` never became durable, or the create's own reply was not
    // readable. The record is the thing that is wrong.
    case 'run_not_created':
    case 'started_not_durable':
      return 'persistence_failed';
    // The executor was not there to be told to work. Retrying after one spawns
    // is the remedy, which is what `runtime_unavailable` says.
    case 'dispatch_refused':
      return 'runtime_unavailable';
    default:
      return 'internal';
  }
}


/**
 * The one command that begins a chat turn, as the worker sees it.
 *
 * Everything on this object is derived from the run: the `runId` is the
 * canonical one the Control Plane minted, `manifestHash` is the reference to the
 * frozen configuration, and `inputRevision` identifies the exact prompt and
 * options this run was opened with. The executor therefore cannot end up with a
 * second identity, and a run row that says one thing cannot be contradicted by
 * the command that produced it.
 *
 * `id` stays a TURN id, not a run id. `agent-process-entry` threads it as
 * `ChatOptions.turnId` (journal emits, `message_index.turn_id`, turn review)
 * and a run spans one `chat:start`, but the concepts are different: a run is
 * the unit the Control Plane records a terminal for, a turn is the unit the UI
 * groups messages into. Reusing one id for both is how the two got confused in
 * the first place. It is NOT re-minted per run and NOT the canonical id — it is
 * a third thing, correctly named.
 */
export interface ChatStartCommand {
  readonly type: 'chat:start';
  readonly sessionId: string;
  /** Turn id. See above. */
  readonly id: string;
  /** The canonical run id, minted by the Control Plane's start entry. */
  readonly runId: string;
  /** Reference to the frozen manifest: its sha256 fingerprint. */
  readonly manifestHash: string;
  /**
   * The frozen manifest itself (plan 587 R2.2).
   *
   * R2.1 carried only the HASH, and the worker logged it — a digest nobody
   * compares. Verifying it requires the thing it is a digest OF, so the
   * manifest now crosses the boundary and the worker recomputes the hash over
   * what it actually received.
   *
   * It is the PUBLIC manifest: `RunManifest.env` is a reference, drift test #12
   * walks every field for credential-shaped keys, and no secret is added here.
   * That said, the credential for this turn DOES reach the worker by another
   * route — the `init` command's `providerConfig.apiKey` — and this is not the
   * place that fixes it. See `manifest-factory` header note 2 and T3.
   */
  readonly manifest: RunManifest;
  /** Digest of this turn's prompt and options. */
  readonly inputRevision: string;
  readonly prompt: string;
  readonly options: Readonly<Record<string, unknown>>;
}

/**
 * What the host must be able to do for the adapter to dispatch.
 *
 * `dispatch` REPORTS whether the command reached the worker. That boolean is
 * the whole of R2.1's "no fake running run" guarantee at this seam: a `false`
 * means there is no worker to run this on, and the adapter turns it into a
 * refusal so the run is closed with a terminal instead of left looking live.
 * Ignoring it is exactly what the router used to do.
 *
 * Expressed as an OBJECT rather than a callable with a property, because
 * `interrupt` is not optional and a positional second argument is the kind of
 * thing that silently binds to the wrong function when a call site is edited.
 *
 * `interrupt` is deliberately required rather than optional. The Desktop host
 * already has exactly one stop path (`WorkerManager.interruptWorker`, used by
 * the SSE disconnect handler, the DELETE route, and the agent-process pool), and
 * R2.1's job is to bind the runtime's declared `stop` to it — not to add a
 * second one. An optional `stop` is how the previous empty no-op happened.
 */
export interface WorkerExecutionBinding {
  /** Send one `chat:start`. Returns false when no worker accepted it. */
  readonly dispatch: (command: ChatStartCommand) => boolean;
  /**
   * The host's existing single worker-stop function.
   *
   * Returns `null` when there is no worker to stop — which the real host does,
   * and which the adapter turns into a `disposition: 'unavailable'` rather than
   * a cooperative stop for an interrupt that touched nothing. It is NOT a
   * boolean any more: the run layer has to await the outcome, because a grace
   * deadline that ends in a platform kill is invisible to a caller that only
   * learns whether a command was sent.
   */
  readonly interrupt: (sessionId: string, graceMs: number, reason: string) => WorkerInterrupt | null;
}


/**
 * What the adapter needs back from the host's interrupt.
 *
 * A structural type rather than an import of `WorkerManager`'s own, so the
 * adapter can be driven by a test without a `WorkerManager` and without this
 * file taking a dependency on the process pool's internals. It is structurally
 * `WorkerManager.interruptWorker`'s return type.
 */
export type WorkerInterrupt = {
  readonly accepted: boolean;
  readonly settled: Promise<StopDisposition>;
};

/** Why the adapter says the run was not dispatched. */
function refused(reason: string): ExecutionDispatchError {
  return new ExecutionDispatchError(reason);
}

/**
 * The execution channel from the run layer to the legacy worker command.
 *
 * ## It dispatches; it does not stream
 *
 * The router already owns the child's stdout and already normalises every frame,
 * so this adapter does not read a stream — the runtime pushes frames into
 * `observeFrame` through the router's tee. That keeps the run layer from
 * becoming a second consumer of worker stdout, which would mean two parsers of
 * one format.
 *
 * ## `stop` is the host's existing interrupt, not a new one
 *
 * See {@link WorkerExecutionBinding.interrupt}. R2.3 did not add a second stop
 * path either; what it added is the OUTCOME. The host already killed the worker
 * after a grace deadline, and the runtime could not see it happen, so a run
 * whose process was killed was recorded as the clean cancellation it failed to
 * be.
 *
 * ## The budget crosses on the command, and why it has to
 *
 * A ceiling that only the run layer checks is a receipt, not a budget. The run
 * layer learns a turn started when the frame COMES BACK, which is after the
 * model request has been dispatched; stopping the run at that point prevents
 * turn three, not turn two. The only component that knows it is about to make a
 * request is the executor, and the only channel it reads before the turn loop
 * is `chat:start`.
 *
 * So `manifest.budget.maxTurns` is forwarded as `options.maxTurns`, which is
 * the option `DuyaAgent` already checks before dispatching the next turn. A
 * ceiling of `0` is treated as absent, matching `isBudgetExhausted`'s own
 * `isPositive`: forwarding `0` would stop a healthy run after one turn.
 * `openRun` applies the same effective option before hashing it, so the worker
 * sees exactly the options the Control Plane bound to the input revision.
 */
export function createWorkerExecutionChannel(binding: WorkerExecutionBinding): ExecutionChannel {
  return {
    async start(manifest, input): Promise<ExecutionHandle> {
      // The worker reads effort out of the message options (`ChatOptions.effort`
      // → the Anthropic thinking budget), while the manifest carries it under
      // `agent.effort`. Lifting it here keeps ONE source of truth: a caller sets
      // `effort` on the start request and both consumers see the same value,
      // instead of the worker silently ignoring a manifest-level override.
      //
      // The lift MUST be the same rule the pin used (`effectiveRunOptions`),
      // because the worker recomputes the input digest over the options it
      // actually received and refuses a run whose digest does not match the
      // pinned one. Two copies of this rule is how a run with an effort set
      // ended up refused with `input_binding_mismatch`: the pin hashed the
      // options WITHOUT effort while the worker received them WITH it.
      const options = effectiveRunOptions(manifest, input.options);
      const command: ChatStartCommand = {
        type: 'chat:start',
        sessionId: input.sessionId,
        // A turn id, and a fresh one per turn. Deliberately NOT the run id:
        // see `ChatStartCommand`.
        id: randomUUID(),
        runId: manifest.runId,
        manifestHash: manifestFingerprint(manifest),
        // Carried so the worker can recompute the hash above over what it
        // actually received, rather than taking the Control Plane's word.
        manifest,
        inputRevision: input.revision,
        prompt: input.prompt,
        options,
      };
      if (!binding.dispatch(command)) {
        throw refused(`no worker accepted chat:start for session ${input.sessionId}`);
      }
      return {
        stop: async (request): Promise<StopReceipt> => {
          const interrupt = binding.interrupt(input.sessionId, request.graceMs, request.reason);
          if (interrupt === null) {
            // No worker was there. Reporting `cooperative` would credit a stop
            // with a clean exit that nothing produced.
            return {
              requested: false,
              disposition: 'unavailable',
              waitedMs: 0,
              reason: request.reason,
            };
          }
          const disposition = await interrupt.settled;
          return { requested: interrupt.accepted, disposition, waitedMs: 0, reason: request.reason };
        },
      };
    },
  };
}

/** Apply the manifest's executable turn ceiling with the same rule everywhere. */
function optionsWithManifestBudget(
  manifest: RunManifest,
  options: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const maxTurns = manifest.budget.maxTurns;
  return typeof maxTurns === 'number' && Number.isFinite(maxTurns) && maxTurns > 0
    ? { ...options, maxTurns }
    : options;
}

/**
 * The options the worker will actually receive, derived ONCE.
 *
 * Two manifest fields have to cross into the worker's message options: the
 * turn ceiling (`budget.maxTurns`) and the reasoning effort (`agent.effort`).
 * Both the pin (`openRun`) and the execution channel go through this
 * function, because the worker recomputes the input digest over the options
 * it received and refuses the run when it does not match the pinned digest.
 *
 * Duplicating the lift on one side is not a style question: hashing options
 * WITHOUT effort while sending them WITH it produces
 * `input_binding_mismatch` on every run that carries an effort, and nothing
 * else — the same code path is green for every run without one.
 */
function effectiveRunOptions(
  manifest: RunManifest,
  options: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const budgeted = optionsWithManifestBudget(manifest, options);
  const effort = manifest.agent?.effort;
  return effort === undefined ? budgeted : { ...budgeted, effort };
}

const RUNTIME_VERSION = '0.1.0';
