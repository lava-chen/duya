/**
 * The headless run host: one `RunController`, one in-process transport, and the
 * real `duyaAgent` behind them.
 *
 * ## The problem this exists to solve
 *
 * `packages/agent/src/cli/index.ts` built a `duyaAgent` and called
 * `agent.streamChat(prompt)` directly. That is not "the CLI consuming the Run
 * API" — it is the CLI bypassing it entirely, which is what R2.1's census
 * recorded as a DIVERGENCE. The moment the CLI owns its own run loop it gets
 * its own answers to every question the run layer already answers: what is the
 * run's identity, when is it over, what happens on cancel, what does a budget
 * exhaustion mean, and which events are durable.
 *
 * ## What "one Run API" means here, mechanically
 *
 * The chain below is the SAME chain the Desktop host builds, with one
 * substitution and no additions:
 *
 * ```
 *   HeadlessRunHost.start
 *     -> RunController.start            (agent-runtime, the real one)
 *          -> manifest frozen, run.started durable
 *          -> InProcessTransport.start  (agent-runtime, the real one)
 *               -> agentExecutionChannel.start   <-- THIS module, and only this
 *                    -> driveRunWithEngine        (the ENGINE driver)
 *                         -> RunEngineImpl.execute  (the real executor)
 *                    -> sse-frame-codec            (the WORKER's codec)
 *          -> RunSession.observe -> emitter mints seq -> ledger
 *     -> handle.events() is the run's ONLY event stream
 * ```
 *
 * The one substituted part is the EXECUTOR, not the run layer. The worker
 * subprocess is replaced by an in-process `duyaAgent`, and the frames it
 * produces are turned into legacy `chat:*` frames by the same codec the
 * subprocess uses, so the runtime downstream of the intake cannot tell the
 * difference. That is the whole claim, and it is checkable: see
 * `headless-run-host.test.ts`, which asserts the host's frames are the frames
 * the worker's own codec produces.
 *
 * ## Plan 610 S4c-d2b: the executor is the ENGINE, not the legacy loop
 *
 * This channel used to call `agent.streamChat(...)` and therefore drove
 * `DuyaAgent`'s own turn generator. It now calls `driveRunWithEngine` -- the
 * same driver `agent-process-entry.ts` calls -- so the headless/CLI path runs
 * `RunEngineImpl` and reaches no turn loop. Three things about that are worth
 * stating rather than leaving to be discovered:
 *
 *  - **There are now TWO run layers for one run, deliberately.** The
 *    `RunController` above this channel owns the caller's truth: the frozen
 *    manifest, the minted `seq`, the ledger and the terminal that
 *    `HeadlessRun` reports. `driveRunWithEngine` opens its OWN spine for the
 *    engine's `run.started` and its own settle, and its envelopes are the
 *    driver's business, not the caller's. The driver's persistence is therefore
 *    deliberately NOT bound to this host's store: both would write the SAME
 *    `runId` into one store with two independent `seq` sequences, and a caller
 *    reading its own transcript would find the two interleaved.
 *  - **The finalized assistant message moved.** The legacy read it off the
 *    generator's RETURN value. The engine does not return one; the assistant row
 *    is written by `recordTurnAssistantMessage` and read back off
 *    `agent.getMessages()`, which is where `agent-process-entry.ts` reads it
 *    from too.
 *  - **A headless run now writes tool-side-effect journals.** The engine
 *    refuses to dispatch anything it cannot ticket, so the ledger is required
 *    rather than optional (see `EngineRunDriverRequest.ledgerDir`).
 *
 * ## Why this is a host ADAPTER and not a runner
 *
 * A "runner" would own the loop: open a run, pump events, decide when it is
 * over, report a terminal. This module owns none of that. It supplies three
 * things the runtime asks for and gets out of the way:
 *
 *  - an `ExecutionChannel` that starts the real executor and forwards frames;
 *  - a `TranslateContext` per run, because the runtime is the component that
 *    owns permission classification and the turn counter;
 *  - a `RunPersistence`, which a headless host has no Control Plane to ask.
 *
 * The terminal decision, the `seq` sequence, the budget verdict and the cancel
 * escalation all come out of `RunController`. If a future change made this
 * class able to answer "did the run finish?" on its own, that is the second
 * state machine this design exists to prevent.
 *
 * ## What is NOT claimed
 *
 * There is no Control Plane here, so `persistenceFor` is the in-memory store.
 * A headless run's transcript lives for the process, and `RunResult.transcript`
 * reports it as what it is rather than pretending a durable row exists. There is
 * also no permission coordinator: `permissionResponder` is absent, so a
 * `permission.requested` in a headless run has nobody to answer it, which is
 * reported as `permissionExpiryClock: 'absent'` rather than advertised.
 */

import {
  InProcessTransport,
  InMemoryRunEventStore,
  RunController,
  probeRuntimeCapabilities,
  projectToLegacyFrame,
  type ExecutionChannel,
  type ExecutionHandle,
  type ExecutionSink,
  type LegacySseFrame,
  type RunHandle,
  type RunPersistence,
  type RunStartInput,
  type StopReceipt,
  type TranslateContext,
} from '@duya/agent-runtime';
import type {
  CancelOutcome,
  RunEventEnvelope,
  PermissionPolicyMode,
  RunId,
  RunManifest,
  RunResult,
  RunTerminalState,
  RuntimeCapabilities,
} from '@duya/agent-protocol';
import { manifestFingerprint } from '@duya/agent-protocol';
import { convertSSEToAgentMessage } from './sse-frame-codec.js';
import { buildMessageFinalizedEvent } from './worker-protocol.js';
// Plan 610 S4c-d2b: the ENGINE driver, the same one `agent-process-entry.ts`
// calls. This channel used to call `agent.streamChat` itself, which drove the
// legacy turn loop; the driver is what makes the headless path reach
// `RunEngineImpl` instead.
import { driveRunWithEngine } from './engine-run-driver.js';
import { TurnPipelinePublisher } from '../tool/turn-pipeline-publisher.js';
import type { duyaAgent } from '../agent/DuyaAgent.js';
import type { ChatOptions } from '../types.js';

/** The runtime this host reports in `run.started` and in its probe. */
const RUNTIME_IDENTITY = { name: 'duya-headless-run-host', version: '0.1.0' } as const;

/** The protocol this host speaks. Matches the runtime package's own constant. */
const PROTOCOL = { major: 1, minor: 0 } as const;

/** The schema revision the probe reports. Bumped only with the protocol. */
const SCHEMA_REVISION = 1;

/**
 * The assistant message a turn's FINALIZED frame reads.
 *
 * Structurally the two fields `buildMessageFinalizedEvent` reads, and nothing
 * more. Kept as a name because the question it answers did not change with the
 * flip: the host needs "the row that holds the turn's authoritative message",
 * whether that row arrived as a generator's return value (the legacy) or as the
 * agent's own transcript row (the engine).
 */
export type HeadlessFinalMessage = Readonly<{ id?: string; content?: unknown }>;

/**
 * The slice of `duyaAgent` this host drives.
 *
 * ## Why this is the CLASS and not a port, and what changed in S4c-d2b
 *
 * It used to be an interface with two members -- `streamChat` and `interrupt` --
 * and that was honest FOR THE LEGACY LOOP, which asked nothing else of an
 * executor. The engine asks for the run LIFECYCLE instead: `beginRun` owns the
 * abort controller, `producePromptContextRail` builds the prompt-context track,
 * `commitTurnPromptUserRow` makes the user's own message durable, and
 * `beginTurnAssembly` builds the turn's tool surface and its declared-tools
 * guard. Those are public seams on `duyaAgent` precisely so that a driver can
 * own a run (plan 610 P4/P5).
 *
 * So a narrower interface written HERE would be a second account of what
 * `driveRunWithEngine` already names once, and the cast that got it past the
 * type checker would be a claim about a host that has no engine seams at all --
 * a build where every frame came out identically and nothing was executed by the
 * engine. That is the `headless-run-host` trap this plan documents.
 *
 * ## What naming the class costs
 *
 * The host can no longer be handed a two-method scripted double, because such a
 * double cannot drive a run. That is a real loss of a testing convenience and it
 * is stated here rather than discovered later: the headless proof now builds a
 * real `duyaAgent` over a scripted PROVIDER, which is what the engine proofs in
 * this directory already do. Every production consumer already passed a real
 * `duyaAgent` -- `cli/index.ts`'s three host sites all build one -- so naming the
 * class costs the adapter nothing and removes the fiction.
 */
export type HeadlessAgent = duyaAgent;

/**
 * The two facts the engine driver needs that this module owns rather than reads
 * off the manifest.
 *
 * `now` is the host's injected clock rather than a fresh `Date.now()`, because
 * the host already owns one (`HeadlessRunHostOptions.now`) and a second clock
 * here would be a second account of when this run happened. `ledgerDir` exists
 * because the engine REQUIRES a tool-side-effect ledger -- without one it refuses
 * to dispatch anything that is not `read_only` -- and a test needs to point that
 * somewhere other than the user's temp directory.
 */
export interface HeadlessEngineWiring {
  readonly now?: () => number;
  readonly ledgerDir?: string;
  /**
   * The executor's tool registry, forwarded onto the driver's options.
   *
   * A WIRING MEMBER rather than something smuggled through
   * `RunStartInput.options`, and that placement is load-bearing. The run
   * input's option bag is canonical JSON — `runInputRevision` derives the run's
   * revision by serialising it, and `asJson` rejects anything whose prototype
   * is not `Object.prototype`. A `ToolRegistry` is a class instance, so putting
   * it in that bag makes `RunController.start` throw before the run opens,
   * which is why `--task` and the REPL could not start at all. The registry is
   * a capability handle, not data, and data is what that boundary carries.
   */
  readonly toolRegistry?: unknown;
}

/** What the host needs to build a run's frozen decision. */
export interface HeadlessRunIntent {
  /** The user's prompt. Travels through the run, never beside it. */
  readonly prompt: string;
  /** The session this turn belongs to. */
  readonly sessionId: string;
  /** Absolute working directory for the run. */
  readonly cwd: string;
  /** Extra roots the host has already validated. */
  readonly roots?: readonly string[];
  readonly model: string;
  readonly providerId: string;
  readonly permissionMode?: PermissionPolicyMode;
  /** The run's whole-turn ceiling, forwarded onto the executor's options. */
  readonly maxTurns?: number;
}

export interface HeadlessRunHostOptions {
  readonly agent: HeadlessAgent;
  /**
   * The executor's tool registry, forwarded onto `streamChat`'s options.
   *
   * A PORT MEMBER, and that placement is load-bearing rather than stylistic.
   * `RunStartInput.options` is canonical JSON — `runInputRevision` derives the
   * run's revision digest from it, and `asJson` (`@duya/agent-protocol`) refuses
   * any value whose prototype is not `Object.prototype`/`null`. A `ToolRegistry`
   * is a class, so a registry carried there made `RunController.start` throw
   * `... which has no canonical JSON form` before the run opened at all: `-t`
   * and the REPL died at start while `--print` (which passes no registry)
   * survived. This is the same rule plan 610 P9 applied when it moved the
   * `ApprovalPort` off `RunStartInput.options`: a capability handle is not data.
   *
   * Per-HOST rather than per-run because the handle belongs to the executor the
   * host owns, and a headless host builds one registry for its process.
   *
   * `unknown` rather than a registry type, and deliberately: this module sits in
   * the same package as `duyaAgent` and importing the registry's interface here
   * would couple the run layer to a tool-system type it has no business knowing.
   * The value is opaque to the host — it is passed through untouched, and the
   * executor is the only thing that reads it.
   */
  readonly toolRegistry?: unknown;
  /**
   * Mint the run id, injected so a test can pin it and a host can prefix it
   * with its own authority. The default is a random UUID, which is the honest
   * default for a host with no id scheme of its own.
   */
  readonly mintRunId?: () => RunId;
  /** Wall clock, injected so a test is not at the mercy of the machine. */
  readonly now?: () => number;
  /**
   * Where the engine's tool-side-effect journals go. Defaults to the driver's
   * own resolution.
   *
   * Exposed because the engine REFUSES to dispatch anything it cannot ticket,
   * so this directory is written on every headless run that calls a tool -- a
   * real on-disk consequence of driving the engine rather than the legacy loop,
   * and a test needs to point it somewhere disposable.
   */
  readonly ledgerDir?: string;
}

/**
 * One headless run, as the host hands it back.
 *
 * Deliberately not the protocol's `RunHandle`: that type carries `pause()` and
 * `respondToPermission()`, and a headless host can do neither. Exposing them
 * would be advertising two capabilities this host has not got — the same
 * dishonesty the capability probe exists to prevent — so the surface here is
 * the honest subset.
 */
export interface HeadlessRun {
  readonly runId: RunId;
  /** The manifest this run was frozen with, and its hash. */
  readonly manifest: RunManifest;
  readonly manifestHash: string;
  /** Resolves exactly once, with the terminal the RUNTIME decided. */
  readonly terminal: Promise<RunTerminalState>;
  /**
   * The run's event stream, in `seq` order.
   *
   * The only channel through which run state reaches the caller, on purpose: a
   * second one would be a place for a consumer to learn something the durable
   * record does not say.
   */
  events(): AsyncGenerator<RunEventEnvelope, void, unknown>;
  /**
   * The run's events projected onto the legacy `{ type, data }` frames.
   *
   * This is the SAME projection the Desktop renderer already reads, from the
   * SAME runtime projector, so a headless consumer and a Desktop consumer are
   * looking at one vocabulary rather than two. Events with no legacy
   * counterpart (`run.started`, `tool.timed_out`, `permission.resolved`) are
   * dropped, which is the projector's contract rather than a loss this host
   * chose: those events live in `transcriptTypes()`, not on a UI frame.
   */
  frames(): AsyncGenerator<LegacySseFrame, void, unknown>;
  /** Ask the run to stop. Reports what the stop turned into. */
  cancel(reason: string): Promise<CancelOutcome>;
  /** The run's measured result. */
  result(): Promise<RunResult>;
  /**
   * The event types the run's DURABLE record holds, in append order.
   *
   * Distinct from `events()` on purpose, and the distinction is not cosmetic:
   * the runtime's own header (`events/event-emitter.ts`) records that
   * `session.observe` does not push to the live stream, so a terminal the
   * runtime SYNTHESISES on settle is durable without ever appearing on the
   * stream a consumer is iterating. A headless caller that only read `events()`
   * would conclude the run produced no terminal at all.
   *
   * Exposed because a headless host's whole job is to hand a caller an honest
   * account of the run, and "the stream ended" is a weaker account than "here is
   * what was written down".
   */
  transcriptTypes(): Promise<readonly string[]>;
  /** Durable-envelope count, for a caller that wants to know what was kept. */
  readonly durableCount: number;
}

/**
 * The stop reason a `chat:message_finalized` frame may carry, or `undefined`.
 *
 * ## Why this function exists at all
 *
 * `chat:message_finalized` REQUIRES a stop reason. `translateMessageFinalized`
 * calls `mapStopReason`, and a reason the protocol's `StopReason` union cannot
 * state leaves the frame UNMAPPED -- which means the run layer drops it and the
 * assistant message never reaches the run's ledger at all. A missing reason is
 * therefore not a cosmetic gap; it silently deletes the run's final message.
 *
 * ## Why the `done` FRAME cannot supply it
 *
 * `legacy-sse-projector.ts` writes the terminal's reason as `done.data.reason`,
 * while `sse-frame-codec.ts` reads `event.reason` -- the two never meet, so a
 * `chat:done` frame produced from a protocol event carries NO reason at all.
 * (This is a pre-existing mismatch between those two modules and it also affects
 * the worker entry, which scrapes the same frame. It is NOT fixed here: the
 * projector and the codec are shared surfaces and neither is this slice's.)
 *
 * ## What is used instead, and what is deliberately absent
 *
 * The engine's OWN terminal, which is the runtime's decision rather than a
 * re-derivation. Measured: for a normal completion the driver settles
 * `{ status: 'completed' }` with NO `stopReason`, so the terminal's own field is
 * absent far more often than not and the status is the only fact available.
 *
 * `budget_exhausted` has NO honest token in `mapStopReason`'s table, so this
 * returns `undefined` for it and the frame is omitted rather than invented. The
 * run layer then refuses the frame, which is the runtime's documented behaviour
 * for a stop reason it cannot state -- an absent message beats a fabricated one.
 */
function finalizedStopReason(
  terminal: RunTerminalState | null,
  fromDoneFrame: string | undefined,
): string | undefined {
  if (terminal !== null && 'stopReason' in terminal && terminal.stopReason !== undefined) {
    return terminal.stopReason;
  }
  if (terminal === null) return fromDoneFrame;
  switch (terminal.status) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'aborted';
    case 'failed':
      return 'error';
    case 'budget_exhausted':
      return undefined;
  }
}

/**
 * The `ExecutionChannel` from the run layer to a real `duyaAgent`, driven on
 * the ENGINE.
 *
 * This is the ONLY place the headless path touches the executor, and it does
* three things: drive the turn, forward each frame the driver produces, and
 * report a stop as the interrupt it issued.
 *
 * ## What drives the turn, and why the manifest is the source
 *
 * `driveRunWithEngine` is the same driver `agent-process-entry.ts` calls, so the
 * two production turn entries assemble their runs through one implementation
 * rather than two. Everything it needs that is already DECIDED is read off the
 * `manifest` the run layer froze above this channel -- run id, cwd, model,
 * provider, permission mode, turn budget -- rather than re-derived from the
 * intent. Two answers to "what was this run given" is the failure class this
 * module's whole design exists to prevent, and the engine's internal manifest is
 * built from these same values, so the two manifests cannot disagree about a
 * field the driver read here.
 *
 * ## What this channel adds on top of the driver
 *
 * The driver ends at the terminal. Two obligations remain and they belong to the
 * frame vocabulary rather than to the engine, which is why they live here:
 *
 *  - `chat:done` is HELD until the turn has ended. The authoritative assistant
 *    message is only known then, so forwarding `done` inline would put
 *    `run.completed` into the ledger ahead of the message it finalises, and the
 *    run would already have terminated by the time the finalized frame arrived.
 *    `agent-process-entry.ts` holds it for exactly the same reason.
 *  - `chat:message_finalized` is BUILT here, from the assistant row the engine
 *    wrote via `recordTurnAssistantMessage`. The driver does not produce it and
 *    `projectToLegacyFrame` has no arm for it; on the worker path the entry
 *    builds it after the drive, and this is that same step for this host.
 *
 * ## Where the tool registry goes
 *
 * `wiring.toolRegistry` is injected HERE, on the way to the driver's options,
 * and never through `input.options` — see `HeadlessEngineWiring.toolRegistry`
 * for why that boundary cannot carry it. `input.options` is still forwarded
 * WHOLE (spread, not copied field by field), so anything else a caller
 * legitimately puts there still reaches the executor; the registry is simply
 * added on top, last, so the host's own handle is the one that arrives.
 */
export function createAgentExecutionChannel(
  agent: HeadlessAgent,
  wiring: HeadlessEngineWiring = {},
): ExecutionChannel {
  const now = wiring.now ?? Date.now;
  const toolRegistry = wiring.toolRegistry;
  return {
    async start(
      manifest: RunManifest,
      input: RunStartInput,
      sink: ExecutionSink,
    ): Promise<ExecutionHandle> {
      // The budget crosses on the command, for the same reason it does for the
      // worker adapter (`createWorkerExecutionChannel`): the run layer learns a
      // turn started when the frame comes BACK, which is after the model request
      // went out. A ceiling of `0` is treated as absent, matching
      // `isBudgetExhausted`'s own `isPositive` — forwarding `0` would stop a
      // healthy run after one turn.
const manifestMaxTurns = manifest.budget.maxTurns;
      const maxTurns =
        typeof manifestMaxTurns === 'number' &&
        Number.isFinite(manifestMaxTurns) &&
        manifestMaxTurns > 0
          ? manifestMaxTurns
          : undefined;

      // `input.options` is the run layer's own bag. It is forwarded whole
      // rather than re-listed, because a field-by-field copy is where a
      // registry would be dropped again -- which is exactly what P10 measured
      // happening before the transport began forwarding the real input. The
      // host's own registry is layered on LAST so its handle wins over
      // anything a caller put in the bag; the bag itself cannot carry a class
      // instance through the canonical-JSON boundary at all, which is why this
      // arrives via `wiring` instead.
      const options = {
        ...input.options,
        ...(toolRegistry === undefined ? {} : { toolRegistry }),
        sessionId: input.sessionId,
      } as unknown as ChatOptions;

      // Pump the run onto the sink. Deliberately NOT awaited: `start` must
      // return a handle so the caller can cancel, and awaiting the whole turn
      // here would make a cancel impossible to issue for the duration of it.
      void (async (): Promise<void> => {
        let stopReason: string | undefined;
        // `chat:done` is HELD, not forwarded inline, for the reason this
        // function's header gives.
        let heldDone: Record<string, unknown> | null = null;

        /** Every frame except `done`, which waits for the finalized message. */
        const forward = (frame: Record<string, unknown>): void => {
          if (frame['type'] === 'chat:done') {
            // The producer's own stop reason, read off the frame rather than
            // off a raw event, so the reason that travels with the finalized
            // message is the one the terminal frame carries.
            const reason = frame['reason'];
            if (typeof reason === 'string' && reason !== '') stopReason = reason;
            heldDone = frame;
            return;
          }
          sink.frame(frame);
        };

        try {
          // ONE publisher per run, for the reason `agent-process-entry.ts`
          // creates one per `chat:start`: it is a per-TURN record, and a
          // publisher reused across runs would refuse the second run's first
          // turn. Omitting it entirely is not the neutral choice -- the tool leg
          // would have no producer and a model asking for a tool would get a
          // thrown refusal instead of a result.
          const turnPipelines = new TurnPipelinePublisher();

          const outcome = await driveRunWithEngine(
            {
              agent,
              sessionId: input.sessionId,
              // The run's OWN id, read off the manifest the run layer froze. A
              // channel that minted a second one beside the dispatch would be
              // the second run-identity source R2.1 removed.
              runId: manifest.runId,
              seqIndex: now(),
              options,
              prompt: input.prompt,
              model: manifest.agent?.model ?? '',
              providerId: manifest.agent?.providerId ?? '',
              workingDirectory: manifest.cwd,
              // The manifest's own recorded mode, which `buildLegacyRunInput`
              // then carries onto the run INPUT. Measured, not assumed: the
              // engine reads its approval label from
              // `input.options.permissionMode` and falls back to `'default'`
              // when that is absent.
              permissionMode: manifest.permissionPolicy.mode,
              ...(maxTurns === undefined ? {} : { maxTurns }),
              // A headless run has no wake source and its prompt is a plain
              // string, so no image or document block can reach the turn.
              wakeRun: false,
              imageInputSupported: false,
              turnPipelines,
              // A headless host has NO approver, and this is reported as
              // `unavailable` rather than as a denial for the reason
              // `agent-process-entry.ts` gives: conflating them makes a missing
              // bridge look like a user saying no.
              //
              // What ENFORCES the mode is not this: `gateRunApproval` consults
              // the run's own `assembly.canUseTool` -- which reads the AGENT's
              // live session mode -- and does not call this port at all. So the
              // decision is unchanged by the value bound here, and the port is
              // present because it is required, not because it decides.
              askApproval: async () => ({ allowed: false, reason: 'unavailable' }) as const,
              // The WORKER's codec, not a second one. See `sse-frame-codec.ts`:
              // two frame producers is the case the transport equivalence test
              // cannot catch, because it compares transports and not producers.
              legacyFrameCodec: convertSSEToAgentMessage,
              // The entry's per-call BILLING tap. A headless run has no Control
              // Plane and therefore no ledger to feed, so this records nothing
              // rather than forwarding a second copy: the turn-level usage
              // already reaches the caller through the surface's `result`
              // frames, which the translator turns into `assistant.usage`. Wiring
              // this to emit as well would record every call's usage twice.
              onPerCallUsage: () => {},
              ...(wiring.ledgerDir === undefined ? {} : { ledgerDir: wiring.ledgerDir }),
            },
            forward,
            // The orchestrator leg, routed rather than dropped. No registered
            // production mode declares an orchestrator today, so this arm is
            // unexercised; it is here because a channel that omitted it would
            // drop the mode SILENTLY.
            async (frames) => {
              for await (const frame of frames) {
                forward(frame as unknown as Record<string, unknown>);
              }
            },
          );

          // The turn's authoritative assistant message, read at the one point
          // this function already knows the turn has ended. `null` when the turn
          // produced none, and `buildMessageFinalizedEvent` then returns `null`
          // too -- which is the correct wire for "there was no message to
          // finalise", not a frame carrying an empty content.
          const lastAssistant = [...agent.getMessages()]
            .reverse()
            .find((message) => message.role === 'assistant');

          // The stop reason comes from the ENGINE'S OWN TERMINAL rather than from
          // the `chat:done` frame. `finalizedStopReason` gives the full
          // reasoning and the one terminal for which it honestly returns nothing.
          const finalized = buildMessageFinalizedEvent(
            input.sessionId,
            lastAssistant as HeadlessFinalMessage | undefined,
            finalizedStopReason(outcome.terminal, stopReason),
          );
          if (finalized !== null) {
            sink.frame(finalized as unknown as Record<string, unknown>);
          }
          if (heldDone !== null) sink.frame(heldDone);
        } catch (error) {
          // A turn that threw is a FAILED run, not a silent one. The runtime
          // synthesises the terminal from the frames it received, and without
          // this frame a turn that died mid-flight would leave the run looking
          // live until something else closed it.
          sink.frame({
            type: 'chat:error',
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          sink.end();
        }
      })();

      return {
        stop: async (request): Promise<StopReceipt> => {
          // The interrupt is the agent's own, so the stop is genuinely
          // cooperative: the executor is asked to leave and reports that it
          // was asked. `waitedMs: 0` because there is no separate process whose
          // exit could be timed — `beginRun` installed the abort controller this
          // aborts, the engine holds that run's signal, and the run layer
          // observes the turn ending as `sink.end()`.
          agent.interrupt();
          return { requested: true, disposition: 'cooperative', waitedMs: 0, reason: request.reason };
        },
      };
    },
  };
}

/**
 * Build the run's frozen decision.
 *
 * A factory rather than a literal at the call site, for one reason that is
 * load-bearing: `provenance` is a `Record` over a CLOSED field set, so a
 * manifest assembled field-by-field at six call sites is six places to forget
 * an attribution. Here it is stated once, and `synthesised: true` on every
 * value the CLI actually invented says so out loud rather than by omission.
 */
export function buildHeadlessManifest(
  intent: HeadlessRunIntent,
  runId: RunId,
): RunManifest {
  const unsupported = { source: 'unsupported', synthesised: true } as const;
  return {
    version: 1,
    runId,
    projectId: null,
    workspaceId: 'headless',
    roots: intent.roots ?? [intent.cwd],
    cwd: intent.cwd,
    permissionPolicy: {
      mode: intent.permissionMode ?? 'default',
      hostSwitch: 'ask',
      defaultTimeoutMs: 300_000,
    },
    capabilities: { profiles: [], modes: [], tools: [] },
    connectorBindings: [],
    // NO SECRETS. A headless host has no secret resolver, so it names a ref it
    // cannot resolve and a digest of nothing rather than inlining an API key
    // into a value the runtime hashes into every event it emits.
    env: { ref: 'env:headless', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
    agent: { profileId: null, model: intent.model, providerId: intent.providerId },
    budget: intent.maxTurns === undefined ? {} : { maxTurns: intent.maxTurns },
    deterministic: false,
    provenance: {
      roots: unsupported,
      cwd: unsupported,
      permissionPolicy: unsupported,
      capabilities: unsupported,
      connectorBindings: unsupported,
      env: unsupported,
      agent: unsupported,
      budget: unsupported,
      workspaceId: unsupported,
      deterministic: unsupported,
    },
  };
}

/**
 * The headless run host.
 *
 * One instance per process is the intended shape, and it is not enforced,
 * because nothing about the composition requires it: the controller is
 * stateless between runs, so a second host is a second controller rather than a
 * second state machine.
 */
export class HeadlessRunHost {
  readonly #controller: RunController;
  readonly #store: InMemoryRunEventStore;
  readonly #transport: InProcessTransport;
  readonly #agent: HeadlessAgent;
  readonly #mintRunId: () => RunId;
  readonly #now: () => number;

  constructor(options: HeadlessRunHostOptions) {
    this.#agent = options.agent;
    this.#store = new InMemoryRunEventStore();
    this.#mintRunId = options.mintRunId ?? (() => crypto.randomUUID());
    this.#now = options.now ?? Date.now;

    this.#transport = new InProcessTransport({
channel: createAgentExecutionChannel(options.agent, {
        // The host's OWN clock, so `seqIndex` and the run's timestamps come from
        // the one injected time source rather than a second `Date.now()` here.
        now: this.#now,
        ...(options.ledgerDir === undefined ? {} : { ledgerDir: options.ledgerDir }),
        ...(options.toolRegistry === undefined ? {} : { toolRegistry: options.toolRegistry }),
      }),
      // The probe is the runtime's OWN, asked of a host that supplies the facts
      // it cannot measure for itself. It reports `NO_RESUME` and
      // `deterministic: false` because that is what the runtime supports today,
      // and a headless host that advertised otherwise would be claiming D7.1's
      // state machine is a shipping capability.
      capabilities: () => this.probe(),
    });

    this.#controller = new RunController({
      channel: {
        start: async (manifest, input, sink): Promise<ExecutionHandle> => {
          // The run layer's REAL input crosses here, whole. This bridge used to
          // accept `input` and drop it on the floor, forwarding only the sink;
          // the transport then had nothing to dispatch and fabricated an empty
          // one, so the executor's `streamChat` was called with `''` no matter
          // what the caller passed to `HeadlessRunHost.start`. `require` is
          // position three on the port and this adapter ignores it, so it is
          // passed through as `undefined` rather than reordered away.
          const run = await this.#transport.start(
            manifest,
            {
              frame: (raw) => sink.frame(raw),
              end: () => sink.end(),
            },
            undefined,
            input,
          );
          return run.handle;
        },
      },
      identity: RUNTIME_IDENTITY,
      protocol: PROTOCOL,
      contextFor: (manifest) => this.#contextFor(manifest),
      persistenceFor: () => this.#persistence(),
      now: this.#now,
      clock: this.#now,
    });
  }

  /**
   * The translation context for one run.
   *
   * `classify` returns `'generic'` on purpose, for the reason the Desktop
   * orchestrator's does: protocol G-2 forbids inferring a permission's `kind`
   * from the tool name. A headless host has no permission coordinator, so it
   * has nothing better to say than "not classified", and saying that is what
   * keeps `permission.requested` honest rather than confidently wrong.
   */
  #contextFor(manifest: RunManifest): TranslateContext {
    const startedAt = this.#now();
    return {
      messageId: `m-${manifest.runId}`,
      permission: {
        classify: () => 'generic',
        mode: 'generic',
        expiresInMs: startedAt + manifest.permissionPolicy.defaultTimeoutMs,
        now: this.#now,
      },
      nextTurn: (() => {
        let index = 0;
        return () => {
          index += 1;
          return { turnId: `turn-${index}`, index };
        };
      })(),
      model: {
        model: manifest.agent?.model ?? 'unknown',
        providerId: manifest.agent?.providerId ?? 'unknown',
        apiFormat: 'anthropic',
      },
    };
  }

  #persistence(): RunPersistence {
    return {
      append: async (envelopes) => {
        await this.#store.append(envelopes);
      },
      complete: async () => undefined,
    };
  }

  /** What this host can honestly do. Asked, never restated. */
  async probe(): Promise<RuntimeCapabilities> {
    return probeRuntimeCapabilities({
      transport: 'in-process',
      protocol: PROTOCOL,
      schemaRevision: SCHEMA_REVISION,
      identity: RUNTIME_IDENTITY,
      // `provides` is the runtime's declaration of what it can actually
      // produce, and it is the field `assertCapabilityConsistency` checks the
      // whole advertised event set against. `tool_preview` is required and not
      // optional: the probe advertises the WHOLE registry, so a runtime that
      // emits `tool.call_preview` has to declare it. Understating it does not
      // make this host more honest — it makes the probe REFUSE, which is the
      // guard working rather than a value to be trimmed to fit.
      provides: ['tool_preview'],
      // A headless host has no permission coordinator, so it can adjudicate
      // nothing. The empty list is the honest answer, and it is why the probe
      // reports `permissionExpiryClock: 'absent'`: nobody is shown a deadline
      // this host would not enforce.
      permissionActions: [],
      permissionDefaultTimeoutMs: 300_000,
      permissionMaxTimeoutMs: 300_000,
      // A headless host holds no replay window: the in-memory store is what it
      // has, and it is the same store the run just wrote. `0` is the honest
      // answer rather than a bound this host does not enforce.
      oldestAvailableSeq: 0,
      latestSeq: 0,
      catalog: { profiles: [], modes: [], tools: [], connectorProviders: [] },
    });
  }

  /**
   * Start one run and hand back the handle.
   *
   * The run id is minted HERE, by the host, and travels on the manifest — which
   * is what makes it the canonical id. An adapter that minted its own id beside
   * the dispatch would be a second run-identity source, and the thing R2.1
   * unified.
   */
  async start(intent: HeadlessRunIntent): Promise<HeadlessRun> {
    const runId = this.#mintRunId();
    const manifest = buildHeadlessManifest(intent, runId);
    const handle: RunHandle = await this.#controller.start(manifest, {
      prompt: intent.prompt,
      sessionId: intent.sessionId,
      // Canonical JSON only. The registry travels on the host, not here — see
      // `HeadlessRunHostOptions.toolRegistry`.
      options: {},
    });
    return this.#wrap(handle, manifest);
  }

  #wrap(handle: RunHandle, manifest: RunManifest): HeadlessRun {
    // Captured, not reached for through `this`, because these closures outlive
    // the method call and `this` inside them would be the `HeadlessRun` object
    // rather than the host.
    const store = this.#store;
    return {
      runId: handle.runId,
      manifest,
      manifestHash: manifestFingerprint(manifest),
      terminal: handle.terminal,
      events: async function* (): AsyncGenerator<RunEventEnvelope, void, unknown> {
        for await (const envelope of handle.events()) {
          yield envelope as unknown as RunEventEnvelope;
        }
      },
      cancel: (reason: string) => handle.cancel('user', { reason }),
      result: () => handle.result(),
      frames: async function* (): AsyncGenerator<LegacySseFrame, void, unknown> {
        for await (const envelope of handle.events()) {
          // The runtime's OWN projector, not a second mapping. A headless host
          // that projected events itself would be the second frame vocabulary
          // this whole design exists to avoid, one layer further out.
          const frame = projectToLegacyFrame(envelope as unknown as RunEventEnvelope);
          if (frame !== null) yield frame;
        }
      },
      transcriptTypes: async () => {
        // `readSince` rather than a whole-transcript read, because the reader's
        // window is the durable one and `mintedLatest` is an INPUT only the live
        // runtime knows. `Number.MAX_SAFE_INTEGER` is the honest "everything up
        // to now" for a run that has already settled, and it is passed as the
        // minted ceiling rather than inferred from the store.
        const envelopes = await store.readSince({
          runId: handle.runId,
          afterSeq: 0,
          limit: Number.MAX_SAFE_INTEGER,
        });
        return envelopes.map((envelope) => envelope.payload.type);
      },
      get durableCount(): number {
        return store.lastReceipt.accepted.length;
      },
    };
  }

  /** The agent this host drives, for a caller that needs its post-run state. */
  get agent(): HeadlessAgent {
    return this.#agent;
  }
}

/** Build a host. A function so the composition is visible at the call site. */
export function createHeadlessRunHost(options: HeadlessRunHostOptions): HeadlessRunHost {
  return new HeadlessRunHost(options);
}
