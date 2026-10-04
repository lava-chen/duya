/**
 * run-orchestrator.ts — the agent-server's half of the run layer.
 *
 * ## What this file is for
 *
 * The agent-server is a fork with no access to `duya-core.db`, and it is the
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
 * `observe` is a tee: it returns the legacy frame for the router to write and
 * keeps the protocol envelope for `run_events`. The router never learns the
 * protocol, and the run layer never learns about `http.ServerResponse`.
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
import { buildRunManifest } from '../../control-plane/manifest-factory';
import type { RunIntent } from '../../control-plane/manifest-factory';
import {
  describeReceipt,
  isDurableWrite,
  readRunReceipt,
  reasonOf,
  type RunWriteReceipt,
} from '../../control-plane/run-receipt';
import { runInputRevision } from '@duya/agent-protocol';
import type { ControlPlaneRequest } from '../../control-plane/run-control-plane';
import { logger } from './logger';

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

export interface RunOrchestratorOptions {
  readonly dbRequest: DbRequest;
  /**
   * The worker's command channel. Supplied by the router, which owns
   * `WorkerManager`; the runtime reaches the worker only through this seam, so
   * a replacement executor needs no change here.
   */
  readonly channel: ExecutionChannel;
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

  constructor(options: RunOrchestratorOptions) {
    this.#options = options;
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
        logger.warn(`${action} channel failed — the durable transcript is degraded`, {
          runId,
          reason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
    this.#controller = new RunController({
      channel: options.channel,
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
          append: async (envelopes) => {
            // Both Control Plane failure shapes are reported HERE rather than
            // left to the settle path, because a run that loses a batch
            // mid-stream and is then hard-killed never reaches a settle that
            // could report it. A thrown channel is re-thrown so the caller still
            // learns the batch is gone.
            const reply = await request('run:append', runId, { runId, events: envelopes });
            // The Control Plane never throws for a failed write — it answers a
            // receipt and moves on, because losing one batch of a user's
            // transcript is a degradation. That answer is only useful if
            // somebody reads it, and discarding it is what turned a refused
            // write into a silent one.
            const receipt = readRunReceipt(reply, 'run:append', runId);
            if (!isDurableWrite(receipt)) {
              reportAckLoss(receipt);
              throw new Error(`run:append was not acknowledged: ${describeReceipt(receipt)}`);
            }
          },
          complete: async (terminal, metrics) => {
            const reply = await request('run:complete', runId, { runId, terminal, metrics });
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
            if (!isDurableWrite(receipt)) {
              reportAckLoss(receipt);
              throw new Error(`run:complete was not acknowledged: ${describeReceipt(receipt)}`);
            }
            if (receipt.state === 'reconciled') {
              logger.info('run:complete lost the CAS to a writer that agreed — the run is settled as decided', {
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
  async openRun(sessionId: string, intent: RunTurnIntent): Promise<RunStartAcceptance> {
    const runId = randomUUID();
    // An active binding is NEVER overwritten. The router's STREAMING 409 is what
    // normally guarantees one live run per session, and that guarantee lives in
    // a different process from this map — so two turns that pass it (a retry of
    // the HTTP request, a reconnect) would otherwise silently rebind the
    // session, and the first run's frames would then be teed into the second
    // run's ledger. Refusing here is the only thing that keeps the map's
    // invariant true, and it is checked at the one place the binding is taken.
    const active = this.#bySession.get(sessionId);
    if (active !== undefined) {
      logger.warn('a second run was opened for a session that already has a live one', {
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
      // The input revision is computed ONCE here, by the protocol's canonical
      // function, and the SAME string goes to the Control Plane and to the
      // controller. The Control Plane persists it into the run row so a reused
      // `runId` can be compared; the controller puts it on the executor's
      // command. Two derivations of one value in two places is the drift
      // `controller.ts:542-547` warns about, so the derivation happens at the
      // one call site that already holds all three inputs.
      const inputHash = runInputRevision({ sessionId, prompt: turnPrompt, options: turnOptions });
      const created = await this.#options.dbRequest('run:create', {
        runId,
        sessionId,
        manifest: built.manifest,
        manifestHash: built.manifestHash,
        inputHash,
        ...(intent.parentRunId === undefined ? {} : { parentRunId: intent.parentRunId }),
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
          logger.warn('Control Plane reports this runId was already opened — not dispatched again', {
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
        logger.warn('Control Plane refused the run — the chat turn has no durable record', {
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
        await this.#closeAbandonedRun(runId, sessionId, 'run_not_created', reason);
        return { accepted: false, runId: null, stage: 'run_not_created', reason };
      }

      // Start the run so `run.started` is recorded with its manifest hash
      // BEFORE the worker produces anything. This is what makes a run that
      // crashes on its first frame still answerable.
      //
      // The session is bound by `onDispatchReady`, after `run.started` is
      // durable and before the executor is told to begin. It used to be bound
      // FIRST, which meant a start that failed left the session pointing at a
      // run with no `run.started` and no place in the Control Plane — and the
      // worker's very next frame was then teed into it. Binding first is also
      // what R2.1 requires now, since the dispatch happens inside this call and
      // its first frame can arrive before `openRun` returns.
      const handle = await this.#controller.start(built.manifest, {
        prompt: turnPrompt,
        sessionId,
        options: turnOptions,
        // The revision computed above, verbatim. Passing it is what keeps the
        // digest on the executor's command identical to the one now in the run
        // row; letting the controller recompute it would be a second
        // derivation of the same value.
        revision: inputHash,
      });
      this.#retain(runId, handle);
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
        logger.warn(`${error.code}: the run was not dispatched — the run layer is degraded`, {
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
      logger.warn('openRun failed — chat proceeds without a durable record', {
        sessionId,
        error: reason,
      });
      await this.#closeAbandonedRun(runId, sessionId, 'unknown', reason);
      return { accepted: false, runId, stage: 'unknown', reason };
    } finally {
      // The one cleanup that has to cover every exit, including the early
      // `run_not_created` return above. See the note at the top of this method.
      this.#pendingSessionByRun.delete(runId);
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
   */
  async #closeAbandonedRun(runId: string, sessionId: string, stage: RunStartStage, reason: string): Promise<void> {
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
    const appended = await this.#appendTerminalEvent(runId, sessionId, error);
    if (!appended) {
      // The log could not take the event. The row is still settled below, so
      // this is a degraded transcript rather than a stranded run, and saying so
      // is the honest report.
      logger.warn('the abandoned run\'s terminal event could not be appended — the transcript is degraded', {
        runId,
        stage,
      });
    }
    const terminal: RunTerminalState = { status: 'failed', error };
    try {
      const reply = await this.#options.dbRequest('run:complete', { runId, terminal });
      const receipt = readRunReceipt(reply, 'run:complete', runId);
      if (isDurableWrite(receipt)) {
        logger.warn('a run row that was created and never executed has been given a terminal', {
          runId,
          stage,
          state: receipt.state,
        });
        return;
      }
      if (receipt.state === 'absent') {
        // Nothing was stranded: the create never landed either. Said plainly so
        // the two incidents stay distinguishable in the log.
        logger.info('no run row to close — the create never landed either', { runId, stage });
        return;
      }
      if (receipt.state === 'conflict') {
        // Not stranded: another writer already recorded a terminal for this
        // run, so the row is decided and this call has nothing to add.
        logger.info('another writer already recorded a terminal for this run', {
          runId,
          stage,
          committed: receipt.committed?.status,
        });
        return;
      }
      logger.error('a run row was left with no terminal and the attempt to record one was refused', new Error(describeReceipt(receipt)), {
        runId,
        stage,
      });
    } catch (error) {
      logger.error('a run row was left with no terminal and the attempt to record one threw', error instanceof Error ? error : new Error(String(error)), {
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
   */
  async #appendTerminalEvent(
    runId: string,
    sessionId: string,
    error: ProtocolErrorInfo,
  ): Promise<boolean> {
    try {
      const existing = await this.#options.dbRequest('run:events', { runId, afterSeq: 0 });
      const rows = Array.isArray(existing) ? (existing as Array<{ seq?: unknown }>) : [];
      const highest = rows.reduce((max, row) => (typeof row.seq === 'number' && row.seq > max ? row.seq : max), 0);
      const reply = await this.#options.dbRequest('run:append', {
        runId,
        events: [{ runId, sessionId, seq: highest + 1, payload: { type: 'run.failed', error } }],
      });
      return isDurableWrite(readRunReceipt(reply, 'run:append', runId));
    } catch (thrown) {
      logger.warn('appending the abandoned run\'s terminal event failed', {
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
   */
  async resultFor(sessionId: string): Promise<RunResult | null> {
    const runId = this.#bySession.get(sessionId) ?? this.#endedBySession.get(sessionId);
    if (runId === undefined) return null;
    const handle = this.#handleByRun.get(runId);
    if (handle === undefined) return null;
    return handle.result();
  }

  /**
   * Drop every trace of a run that is not going to happen.
   *
   * Called on both failure paths out of `openRun`. Leaving the model binding
   * behind would make it one more entry in a map with no delete.
   */
  #forgetRun(runId: string): void {
    this.#modelByRun.delete(runId);
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
        logger.warn('a worker frame arrived after its run had already ended', { sessionId, runId: ended });
      }
      return { legacy: null, forwardOnly: false, late };
    }

    const outcome = this.#controller.observeFrame(runId, frame);
    if (outcome.envelope !== null && (outcome.envelope.payload.type === 'run.completed' || outcome.envelope.payload.type === 'run.failed')) {
      // The run has decided. Settle asynchronously: the terminal write is a
      // round trip to the main process and the router's caller is still inside
      // a synchronous frame handler.
      void this.#finish(sessionId, runId);
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
      logger.error('Run settle failed', error instanceof Error ? error : new Error(String(error)), { sessionId, runId });
    }
    return this.#terminalFor(sessionId);
  }

  /**
   * The terminal the session's run decided, live or ended.
   *
   * `controller.receiptFor` answers for ENDED runs only, so a live run is asked
   * directly. `null` means this controller has no record of a run for the
   * session at all.
   */
  #terminalFor(sessionId: string): RunTerminalState | null {
    const runId = this.#bySession.get(sessionId) ?? this.#endedBySession.get(sessionId);
    if (runId === undefined) return null;
    return this.#controller.activeRun(runId)?.terminal ?? this.#controller.receiptFor(runId);
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
   */
  #finish(
    sessionId: string,
    runId: string,
    opts?: { cancelRequested?: boolean },
  ): Promise<void> {
    this.#release(sessionId, runId);
    const settling: Promise<void> = this.#controller
      .settle(runId, opts)
      // The terminal this produces is the CONTROLLER's to publish; this path
      // only has to be certain the write was attempted, so the value is dropped
      // explicitly rather than leaking into the promise's type.
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.error('Run settle failed', error instanceof Error ? error : new Error(String(error)), {
          sessionId,
          runId,
        });
      })
      .finally(() => {
        if (this.#finishing.get(sessionId) === settling) this.#finishing.delete(sessionId);
      });
    this.#finishing.set(sessionId, settling);
    return settling;
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
    try {
      return await this.#controller.cancel(runId, { reason: `delete:${reason}` });
    } catch (error) {
      logger.error(
        'Run cancel failed',
        error instanceof Error ? error : new Error(String(error)),
        { sessionId, runId },
      );
      // A cancel that could not complete still has to CLOSE the run: the worker
      // is being stopped either way, and leaving the row `running` is the one
      // outcome nobody can reconcile later. The fallback terminal is read once,
      // after the settle, because a receipt that does not exist yet is not a
      // terminal to report.
      await this.settleSession(sessionId, { cancelRequested: true });
      const terminal = this.#controller.receiptFor(runId);
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
    // A runId that lives only inside a `cron:<job>:<ts>:<runId>` session id
    // string and never reaches the Control Plane's `runs` table.
    identityNote: 'mints a runId that only lives inside a session id string',
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
    identityNote: 'mints taskId / subAgentSessionId, which are not run ids',
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
 * `duyaAgent.streamChat` still has callers, and none of them is this slice's to
 * move: the sub-agent turn stream, the compaction summariser, the side-question
 * path, the title generator, the memory-rollout extractor and the worker's own
 * subprocess entry are all in-process or worker-side model calls that are not
 * Desktop chat turns. Several of them are genuinely turns — the sub-agent runner
 * most of all — and moving those is a later slice with its own census row
 * (`NON_DESKTOP_CONSUMERS` above), not something H8.1 could finish honestly.
 * The CLI's three turn call sites ARE gone, and that is the part H8.1 owned.
 *
 * The number is MEASURED, not estimated: it is the count of `.streamChat(` call
 * sites on a `duyaAgent`/`subAgent` receiver in `packages/agent/src`, excluding
 * `@duya/ai` client calls (which are a different type with no run semantics at
 * all) and excluding comments. `headless-retirement.test.ts` re-derives it from
 * the source and fails if the two disagree, so this number cannot go stale
 * without a red test.
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
    remainingConsumers: 7,
    consumers: Object.freeze([
      'packages/agent/src/tool/SubagentTool/runAgent.ts (sub-agent turn)',
      'packages/agent/src/agent/TurnStreamRunner.ts (sub-agent turn stream)',
      'packages/agent/src/process/agent-process-entry.ts (worker subprocess chat:start)',
      'packages/agent/src/agent/DuyaAgent.ts:780 (compaction summariser)',
      'packages/agent/src/agent/DuyaAgent.ts:4426 (side question)',
      'packages/agent/src/session/title-generator.ts (title generation)',
      'packages/agent/src/memory-rollout/extractor.ts (memory extraction)',
    ]),
    consumerRationale:
      'Measured, not estimated: seven `.streamChat(` call sites on a duyaAgent/subAgent receiver ' +
      'remain in packages/agent/src, excluding @duya/ai client calls (a different type with no run ' +
      'semantics) and comments. Of those, the sub-agent runner and the worker entry ARE turns and ' +
      'belong to later slices with their own NON_DESKTOP_CONSUMERS rows; the rest are one-shot ' +
      'model calls with no session, no run identity and no terminal, and giving them a run would ' +
      'mean minting runs for work that is not a run. The CLI turn call sites — the part H8.1 ' +
      'owned — are gone, and the CLI now starts its turns through HeadlessRunHost.',
    removalConditions: Object.freeze([
      'every remaining streamChat caller is a named non-turn model call, or has been moved',
      'packaging and host smoke pass: a packaged Electron build reaches agent-server ready',
      'the compatibility window is evidenced rather than assumed',
    ]),
    removable: false,
    blockedOn:
      'Host smoke is not evidenced. H8.1 ran where a packaged Electron build cannot be produced, ' +
      'and H8\'s exit condition names host smoke explicitly. The remaining consumers are also ' +
      'non-zero, so the shim stays on both counts rather than on one.',
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
function reportAckLoss(receipt: RunWriteReceipt): void {
  logger.warn(`${describeReceipt(receipt)} — the durable transcript is degraded`, {
    runId: receipt.runId,
    state: receipt.state,
  });
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
 */
export function createWorkerExecutionChannel(binding: WorkerExecutionBinding): ExecutionChannel {
  return {
    async start(manifest, input): Promise<ExecutionHandle> {
      const maxTurns = manifest.budget.maxTurns;
      const options: Readonly<Record<string, unknown>> =
        typeof maxTurns === 'number' && Number.isFinite(maxTurns) && maxTurns > 0
          ? { ...input.options, maxTurns }
          : input.options;
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

const RUNTIME_VERSION = '0.1.0';
