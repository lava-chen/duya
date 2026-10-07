/**
 * Plan 610 S4c-d2a: the worker entry's DRIVER.
 *
 * ## What this file is
 *
 * The one place an engine-driven `chat:start` run is assembled and executed.
 * Before it, `agent-process-entry.ts` drove a turn by draining
 * `DuyaAgent.streamChat`'s own `for await` body; the composition seams
 * (`composeLegacyRunPorts` / `createRunEventSpine` /
 * `createWorkerAdapterSurface`) existed with no production caller, so the entry
 * reached nothing below it. This file is the caller, and the entry's handler now
 * calls IT rather than spelling the assembly out inside a 1400-line function.
 *
 * The ORDER below is the contract, and each step is load-bearing for a
 * different reason:
 *
 *   1. `beginRun`            -- owns the abort controller, the turn id, the fork
 *                               reset and the approval ledger, and RESETS the
 *                               prompt-context rail.
 *   2. `producePromptContextRail` -- the seven producers. Step 1 reset the rail,
 *                               and `UserPromptSubmit` ASSIGNS it, so this must
 *                               run after the reset and before anything reads it.
 *   3. `commitTurnPromptUserRow` -- makes the user's own message durable, and
 *                               RESOLVES the fork marker against the committed
 *                               timeline. Before step 4, because the assembly
 *                               projects the transcript this row lands on.
 *   4. `beginTurnAssembly`   -- the per-run tool surface and the declared-tools
 *                               guard. Projects with `injectHookContexts: true`,
 *                               which is the consumptive drain that delivers step
 *                               2's rail to the provider.
 *   5. `selectRunDriverLeg`  -- the ONE routing decision. An orchestrator mode
 *                               owns the whole stream and is routed to its own
 *                               frames; everything else is assembled on the
 *                               engine.
 *   6. `composeLegacyRunPorts` + `RunEngineImpl.execute` -- the turn.
 *
 * ## The obligation this file exists partly to discharge
 *
 * `RunEventStream` is a push queue with no self-termination, and the engine
 * PROPOSES its terminal (`ports.ts`: `RunSession.settle` is the single writer and
 * no host calls it). So a host that drains the spine's stream MUST both settle
 * the run and close the stream itself, or the `for await` never returns. See
 * {@link settleAndCloseSpine} for the ordering and why each part is where it is.
 *
 * ## What this file does NOT do
 *
 * It does not project frames. `createWorkerAdapterSurface` does, and the caller
 * routes what the surface returns. It does not decide a turn's prompt, tools or
 * stop reason -- the engine does. And it does not delete the legacy generator:
 * `headless-run-host.ts` and `SubagentTool/runAgent.ts` still drive it.
 */

import {
  RunEngineImpl,
  createWorkerAdapterSurface,
  type RunEnginePorts,
  type RunInputSnapshot,
  type RunPersistence,
  type TerminalCandidate,
  type ToolSideEffectLedger,
} from '@duya/agent-runtime';
import { existsSync, readFileSync } from 'node:fs';
import { FIRST_EPOCH, firstAttemptFence, manifestFingerprint } from '@duya/agent-protocol';
import type {
  RunEvent,
  RunEventEnvelope,
  RunFence,
  RunId,
  RunManifest,
  RunTerminalState,
} from '@duya/agent-protocol';
import type { LegacyFrameCodec } from '@duya/agent-runtime';
import type { ChatOptions, MessageContent, SSEEvent, TokenUsage } from '../types.js';
import type { duyaAgent } from '../agent/DuyaAgent.js';
import type { TurnPipelinePublisher } from '../tool/turn-pipeline-publisher.js';
import {
  buildLegacyRunInput,
  buildLegacyRunManifest,
  composeLegacyRunPorts,
  createLegacyAssembleTurn,
  selectRunDriverLeg,
  type LegacyRunFacts,
  type LegacyRunHost,
} from './run-composition.js';
import { createRunEventSpine, type RunEventSpine } from './run-event-spine.js';
import { createToolSideEffectLedger, defaultLedgerDir, ledgerFile } from './tool-side-effect-ledger.js';

/** The runtime this worker reports in `run.started`. */
const RUNTIME_IDENTITY = { name: 'duya-worker-entry', version: '0.1.0' } as const;

/** The protocol this worker speaks. Matches the runtime package's own constant. */
const PROTOCOL = { major: 1, minor: 0 } as const;

/**
 * The prompt's text, for the one field that is a plain string.
 *
 * Joined rather than JSON-stringified, and that is deliberate: the model-facing
 * text of a `MessageContent[]` prompt IS its text blocks, and the same rule
 * `DuyaAgent._isDuplicatePrompt` compares by is the rule this must not
 * contradict. Image and document blocks are excluded because a base64 payload
 * is not a prompt.
 */
function toPromptText(prompt: string | MessageContent[]): string {
  if (typeof prompt === 'string') return prompt;
  return prompt
    .filter((block): block is Extract<MessageContent, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

/** What the caller must supply. Everything else is DERIVED here. */
export interface EngineRunDriverRequest {
  readonly agent: duyaAgent;
  readonly sessionId: string;
  /** The run's own identity. `resolveTurnRunId`'s answer, never a second one. */
  readonly runId: RunId;
  /** `Date.now()` taken once per run, as the legacy takes it once per `streamChat`. */
  readonly seqIndex: number;
  /** The `ChatOptions` the turn is run with. `beginRun` reads its own half. */
  readonly options: ChatOptions;
  /** The prompt as the run holds it, images and document blocks included. */
  readonly prompt: string | MessageContent[];
  /**
   * The Control Plane's digest of this run's input, when it sent one.
   *
   * Carried SEPARATELY rather than read off `options` because it is a
   * `chat:start` field, not a `ChatOptions` one: it describes the message the
   * worker received rather than a turn's behaviour. Preferred over a synthesised
   * revision because it is the value the run row was persisted under.
   */
  readonly inputRevision?: string;
  /** The model the run's provider client is bound to. `agent.model`. */
  readonly model: string;
  /** The provider id the client was constructed with. */
  readonly providerId: string;
  readonly workingDirectory: string;
  readonly permissionMode: 'default' | 'acceptEdits' | 'plan';
  readonly maxTurns?: number;
  readonly wakeRun: boolean;
  readonly imageInputSupported: boolean;
  readonly turnPipelines: TurnPipelinePublisher;
  /** Asks the user. Resolves; never throws for a refusal. */
  readonly askApproval: LegacyRunHost['askApproval'];
  /** The worker's OWN `chat:*` codec, `convertSSEToAgentMessage`. */
  readonly legacyFrameCodec: LegacyFrameCodec;
  /**
   * Called once per provider `result` frame, with the provider's own block.
   *
   * The entry's billing authority, fed pre-narrowing so the cache buckets
   * survive. See `ClientModelPortOptions.onPerCallUsage` for why the seam is the
   * tap and not the `ModelFrame`.
   */
  readonly onPerCallUsage: (usage: TokenUsage) => void;
  /** Where the run's tool-side-effect journals go. Defaults to the worker's own. */
  readonly ledgerDir?: string;
  /** Durable sink for the spine's events. A run with no Control Plane omits it. */
  readonly persistence?: RunPersistence;
}

/** What one driven run produced. */
export interface EngineRunOutcome {
  /**
   * Every envelope the SPINE announced, in mint order.
   *
   * Returned rather than streamed so a caller (and a test) can read the run's
   * own durable record without holding the drain open.
   */
  readonly announced: readonly RunEventEnvelope[];
  /** The candidate the engine proposed, as the SPINE recorded it. */
  readonly proposed: TerminalCandidate | null;
  /** The terminal `RunSession.settle` committed. `null` only on an orchestrator run. */
  readonly terminal: RunTerminalState | null;
  /** The ports the engine actually ran on. `null` on an orchestrator run. */
  readonly ports: RunEnginePorts | null;
  /**
   * The `user` row the model is answering, as `commitTurnPromptUserRow` named it.
   *
   * Reported rather than re-derived: duplicate suppression returns the EXISTING
   * row's id, and a driver that minted its own would be a second account of the
   * row the transcript holds.
   */
  readonly promptRowId: string | null;
  /** The frames `producePromptContextRail` returned, for the caller to route. */
  readonly railFrames: readonly SSEEvent[];
}

/**
 * Drain the spine's stream, projecting each envelope to the renderer's frame.
 *
 * ## Why the drain is SEPARATE from the execution
 *
 * Because the two must overlap. The engine publishes synchronously through the
 * emitter, and `RunEventStream` is BOUNDED (1024 envelopes, oldest dropped), so
 * a host that awaited the execution before reading would lose the run's first
 * frames to the queue's own overflow. The execution is started first and the
 * drain runs beside it, exactly as `RunController` does.
 *
 * `onEnvelope` receives the ENVELOPE, not a projected frame: projection is the
 * surface's job and a second projector here would be a second mapping table that
 * could disagree with the first.
 */
async function drainSpine(
  spine: RunEventSpine,
  onEnvelope: (envelope: RunEventEnvelope) => void | Promise<void>,
): Promise<void> {
  for await (const envelope of spine.stream) {
    await onEnvelope(envelope as unknown as RunEventEnvelope);
  }
}

/**
 * Settle the run, release its held terminal, and CLOSE the stream.
 *
 * ## The obligation
 *
 * Nothing in the tree closes a `RunEventStream`, and the engine only PROPOSES
 * its terminal. A drain therefore never terminates on its own: the `for await`
 * parks on a waiter that only `close()` resolves. This is the close, and it is
 * the reason the flip is executable at all rather than merely correct.
 *
 * ## Step 0 exists because `settle` DECIDES from observed events
 *
 * `RunSession.settle` is the single writer, and it resolves the terminal with
 * `resolveRunOutcome(this.#terminalEvents, ...)` -- the events the run OBSERVED.
 * The engine publishes `run.completed` / `run.failed` nowhere (it states so at
 * `run-engine.ts:984` and only calls `proposeTerminal`), so a host that settled
 * straight from the candidate would hand the session an EMPTY terminal-event set
 * and every run would end `failed` with `runtime_crash: the run stream ended with
 * no terminal event`.
 *
 * So the candidate is published as a terminal EVENT through the emitter first.
 * That is not the driver deciding: the emitter HOLDS the terminal
 * (`event-emitter.ts:300-308`) instead of announcing it, and
 * `publishCommittedTerminal` below discards the held frame whenever the session's
 * committed terminal contradicts it. The session therefore still decides, and a
 * disagreement is still reported rather than papered over -- which is exactly the
 * `run.completed` that became `failed` downgrade the emitter documents.
 *
 * Publishing it HERE also keeps the "announced before durable" hole shut: the
 * event is held, so a consumer sees the run's ending only after the settle
 * barrier answered.
 *
 * ## The ORDER, and why each step is where it is
 *
 * 0. `emitter.emit(terminalEvent)` FIRST, and only when the engine proposed
 *    something. A run that proposed nothing has no ending to record, and
 *    `settle(undefined)` is then the honest input -- the session synthesises from
 *    its own observations.
 * 1. `session.settle(candidate)` next. It is the single writer of the terminal
 *    (`ports.ts:1028-1035`), and it flushes the transcript and writes the
 *    terminal row. Nothing may be announced before that barrier answered.
 * 2. `emitter.publishCommittedTerminal(terminal)` THIRD. It releases the frame the
 *    emitter HELD, and `RunEventStream.push` is a no-op once closed -- so closing
 *    first would drop the run's own ending, which is the exact hole the hold
 *    exists to close (`controller.ts:912-927`).
 * 3. `stream.close()` LAST, and unconditionally. Even a settle that threw must
 *    not leave a drain parked forever, so the close is in a `finally`.
 */
async function settleAndCloseSpine(
  spine: RunEventSpine,
  candidate: TerminalCandidate | null,
): Promise<RunTerminalState> {
  try {
    if (candidate !== null) {
      const state = candidate.state;
      // The event the CANDIDATE names, in the union's own vocabulary. Projected
      // rather than asserted: the candidate carries a `RunTerminalState`, and
      // `run.failed` is the one arm whose required `error` has no counterpart on
      // the completed arms.
      const event: RunEvent =
        state.status === 'failed'
          ? { type: 'run.failed', error: state.error }
          : {
              type: 'run.completed',
              status: state.status,
              ...(state.stopReason === undefined ? {} : { stopReason: state.stopReason }),
            };
      // Through the EMITTER, never a direct `session.observe`: the emitter is
      // what holds the terminal, and a bypass would announce the run's ending
      // before its durable barrier answered.
      spine.emitter.emit(event);
    }
    const terminal = await spine.session.settle(
      candidate === null
        ? undefined
        : candidate.state.status === 'cancelled'
          ? { cancelRequested: true, requestedReason: candidate.reason }
          : {},
    );
    await spine.emitter.publishCommittedTerminal(terminal);
    return terminal;
  } finally {
    // Unconditional, and LAST. See the ordering note above.
    spine.stream.close();
  }
}

/**
 * The run's FIRST tool-side-effect fence, derived rather than asserted.
 *
 * ## Why the file check is a CHECKED claim and not a default
 *
 * `firstAttemptFence` refuses to mint a fence for a run that is not on its first
 * attempt, because a resumed run handed `GROUND_FENCE` would write records
 * indistinguishable from its dead predecessor's -- and a crash would then read as
 * a duplicate dispatch rather than an unattributable one.
 *
 * So the `state` is a QUESTION somebody went and answered. The answer here is
 * read off DURABLE STORAGE: the ledger journal for this run at `FIRST_EPOCH`.
 * The ledger is the only `RunFence` producer in this process and its `begin` is
 * the only `fenceToken` writer, so:
 *
 *  - the file is ABSENT  -> nothing has ever written a fence for this run at
 *    epoch 1 -> `{ committed: false }`, and `GROUND_FENCE` is the floor the store
 *    itself reports rather than a guess;
 *  - the file is PRESENT -> an epoch-1 attempt DID commit a fence -> the run is
 *    not on its first attempt, and `firstAttemptFence` refuses it by name.
 *
 * `ledgerFile(...)` needs no fence to compute, which is what makes the check
 * possible at all.
 *
 * ## The two caveats this leaves, stated rather than hidden
 *
 *  - The check is scoped to EPOCH 1's file. A run whose earlier attempt was a
 *    recovered attempt (epoch >= 2) is not covered by this question, because
 *    that file is a different one; the honest reading is that the worker entry
 *    opens first attempts, and a resumed run arrives through a Control Plane
 *    that mints the next fence itself.
 *  - The ledger DIRECTORY is shared across runs, keyed only by a sanitised
 *    `runId`. Two runs with colliding sanitised ids would read each other's
 *    answer. Real run ids are UUIDs (`run-identity.ts`), so this is stated as a
 *    property of the naming rather than defended against.
 */
export function deriveFirstAttemptFence(input: {
  readonly runId: RunId;
  readonly dir?: string;
  readonly exists?: (file: string) => boolean;
}): RunFence {
  const dir = input.dir ?? defaultLedgerDir();
  const file = ledgerFile({ dir, runId: input.runId, runEpoch: FIRST_EPOCH });
  const exists = input.exists ?? existsSync;
  return firstAttemptFence({
    runId: input.runId,
    state: exists(file)
      ? { committed: true, committedFence: readCommittedFenceToken(file) }
      : { committed: false },
  });
}

/**
 * The highest `fenceToken` the journal at `file` records, or `0`.
 *
 * Read rather than invented, so the refusal message `firstAttemptFence` builds
 * names the fence the dead attempt actually wrote. An unreadable or unparseable
 * line is not silently skipped: the file's mere PRESENCE is what the caller
 * already established, and a token of `0` reports "present, token unknown"
 * rather than asserting a number nobody read.
 */
function readCommittedFenceToken(file: string): number {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  let highest = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line) as { fenceToken?: unknown };
      if (typeof entry.fenceToken === 'number' && entry.fenceToken > highest) {
        highest = entry.fenceToken;
      }
    } catch {
      // See the doc comment: presence is the claim, not the token.
    }
  }
  return highest;
}

/**
 * Drive one run to its end, on whichever leg owns it.
 *
 * ## The orchestrator leg
 *
 * `selectRunDriverLeg` returns frames rather than yielding, and an orchestrator
 * mode owns the WHOLE stream in the legacy `SSEEvent` vocabulary -- which
 * `agent-runtime`'s ports deliberately do not carry. So those frames are routed
 * to the caller's own consumer verbatim and the engine is never offered the run.
 * No registered production mode declares an orchestrator today, so this arm is
 * routed rather than exercised; it is here because a driver that omitted it
 * would drop the mode SILENTLY, which is the failure class this whole plan
 * exists to prevent.
 */
export async function driveRunWithEngine(
  request: EngineRunDriverRequest,
  onFrame: (frame: Record<string, unknown>) => void,
  onOrchestratorFrames?: (frames: AsyncIterable<SSEEvent>) => Promise<void>,
): Promise<EngineRunOutcome> {
  const { agent, sessionId, runId, seqIndex, options, prompt, turnPipelines } = request;

  // 1. The run. Owns the abort controller, the turn id, the fork / approval
  // resets AND the prompt-context rail reset.
  const run = await agent.beginRun({ options, prompt });

  const announced: RunEventEnvelope[] = [];
  let ports: RunEnginePorts | null = null;

  try {
    // 2. The rail. Seven producers, and `UserPromptSubmit` ASSIGNS the whole
    // rail -- so this must run AFTER `beginRun`'s reset (which is what makes the
    // assignment replace an empty array rather than a previous run's blocks) and
    // BEFORE the assembly projects it.
    //
    // The frames are RETURNED, not yielded: a driver cannot consume a `yield`,
    // which is the whole reason the seam exists. The caller routes them.
    const railFrames = await agent.producePromptContextRail(run);

    // 3. The ONE routing decision, and it comes BEFORE the turn is assembled:
    // an orchestrator mode owns the whole stream and never reaches
    // `beginTurnAssembly` (measured -- `streamChat` returns before the assembly
    // call). Assembling first and routing afterwards would build a turn nobody
    // executes.
    const leg = selectRunDriverLeg(agent, run);
    if (leg.kind === 'orchestrator') {
      if (onOrchestratorFrames !== undefined) await onOrchestratorFrames(leg.frames);
      return {
        announced,
        proposed: null,
        terminal: null,
        ports: null,
        promptRowId: null,
        railFrames,
      };
    }

    // 4. The run's OWN prompt user row, durably committed. Before the assembly,
    // because the assembly projects the transcript this row lands on, and
    // because the seam RESOLVES the fork marker against the committed timeline.
    const commit = agent.commitTurnPromptUserRow({
      prompt,
      // The engine has no working transcript of its own, so it is handed a
      // fresh one -- `claimInterTurn`'s documented shape. The row still lands on
      // the agent's own timeline, which is what the assembly projects.
      messages: [],
      seqIndex,
      ...(options.clientMsgId === undefined ? {} : { clientMsgId: options.clientMsgId }),
      ...(options.displayContent === undefined
        ? {}
        : { displayContent: options.displayContent }),
      ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
      ...(request.wakeRun ? { wakeRun: true } : {}),
      ...(options.replyToId === undefined ? {} : { replyToId: options.replyToId }),
      ...(options.branched === true ? { branched: true } : {}),
    });

    // 5. The run's tool surface, its system prompt, and the declared-tools
    // guard. The `publisher` is the SAME per-run publisher the composition's
    // tool legs read, so `queue` / `drain` / `discard` reach this turn.
    const assembly = await agent.beginTurnAssembly({
      options,
      prompt,
      appliedProfile: run.appliedProfile,
      turnContext: run.turnContext,
      publisher: turnPipelines,
    });

    // The prompt row's id, or a minted one when the seam had no id to name.
    // `buildLegacyRunInput` requires an id and the ENGINE re-resolves history by
    // reference, so this value is what turn 2 correlates against.
    const promptRowId = commit.messageId ?? `prompt-${runId}`;

    const facts: LegacyRunFacts = {
      runId,
      cwd: request.workingDirectory,
      model: request.model,
      providerId: request.providerId,
      sessionId,
      projectId: null,
      // The revision is the digest of what this process was handed, not a
      // constant: two runs over different inputs must not hash the same. The
      // Control Plane's `inputRevision` is preferred when it sent one, because
      // that is the value the run row was persisted under.
      revision:
        request.inputRevision !== undefined && request.inputRevision.length > 0
          ? request.inputRevision
          : `worker:${sessionId}:${seqIndex}`,
      catalogRevision: agent.activeMCPRegistry.getCatalogRevision(),
      permissionMode: request.permissionMode,
      ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
    };
    const manifest: RunManifest = buildLegacyRunManifest(facts);
    const input: RunInputSnapshot = buildLegacyRunInput(
      facts,
      {
        role: 'user',
        id: promptRowId,
        // The prompt's TEXT. `RunInputSnapshot.prompt` is a string field and the
        // engine's first turn is assembled from the handle's own projection
        // (`ContextPort.assemble`), so what this carries is the run's opening
        // turn identity rather than the full multimodal payload -- the blocks
        // reach the provider through the assembly, which is the same path they
        // took on the legacy.
        content: toPromptText(prompt),
      },
      // The digest of the transcript the run STARTED from. The engine re-resolves
      // the locator itself, so this is provenance rather than payload -- but it
      // must be the run's own starting point, or two runs over different
      // histories would claim the same one. The run's OWN prompt row is excluded
      // because it was committed by this driver, moments ago, and is not part of
      // what the run was given.
      agent
        .getMessages()
        .filter((row) => row.id !== promptRowId)
        .map((row) => ({
          role: row.role as 'user' | 'assistant' | 'tool',
          id: row.id ?? '',
          content: row.content,
        })),
    );

    // 6. The event spine: the run's ledger, its stream, and the emitter that
    // MINTS every `seq`. `onAnnounce` is a second consumer arm on the one
    // publication, so nothing is announced twice.
    const spine = createRunEventSpine({
      runId,
      sessionId,
      seqIndex,
      ...(request.persistence === undefined ? {} : { persistence: request.persistence }),
      onAnnounce: (envelope) => {
        announced.push(envelope as RunEventEnvelope);
      },
    });

    // `run.started` BEFORE the execution is dispatched, because the event
    // carries the manifest hash and its whole purpose is to answer "what was
    // this run given?" for a run that crashed a millisecond later.
    const started = spine.emitter.emit({
      type: 'run.started',
      manifestHash: manifestFingerprint(manifest),
      protocol: PROTOCOL,
      runtime: RUNTIME_IDENTITY,
    });
    if (!started.ok) {
      throw new Error(`run.started was refused for ${runId}: ${started.message}`);
    }

    // The tool-side-effect ledger, and the fence it writes at. REQUIRED rather
    // than optional: `RunEngineImpl.#ticket` refuses to dispatch anything that
    // is not `read_only` with no ledger attached, and `composeLegacyRunSources`
    // resolves EVERY tool to `undeclared`. A run with no ledger dispatches
    // nothing and still reports `completed` -- the mute-pipeline trap.
    //
    // The directory is resolved ONCE and shared by the fence derivation and the
    // ledger, because the fence's answer is a claim about a file in THAT
    // directory: two resolutions could disagree about which file was checked.
    const ledgerDir = request.ledgerDir ?? defaultLedgerDir();
    const fence = deriveFirstAttemptFence({ runId, dir: ledgerDir });
    const ledger: ToolSideEffectLedger = createToolSideEffectLedger({
      dir: ledgerDir,
      runId,
      runEpoch: FIRST_EPOCH,
      fence,
    });

    const host: LegacyRunHost = {
      turnPipelines,
      assembleTurn: createLegacyAssembleTurn(assembly),
      // REQUIRED, and required for the reason `LegacyRunHost.refreshDeclaredTools`
      // gives: the guard's live set is a closure local of `beginTurnAssembly`, so
      // nothing outside the handle can fill it. Omitting it leaves the guard
      // EMPTY -- it denies anything outside itself -- and the run completes
      // having dispatched nothing.
      refreshDeclaredTools: () => assembly.refreshDeclaredTools(),
      askApproval: request.askApproval,
      emitter: spine.emitter,
      // ADVISORY. `createRunEventSpine`'s own recorder, so the run's last
      // candidate is read back off the spine rather than re-derived here; the
      // DECISION is `settleAndCloseSpine`'s.
      proposeTerminal: spine.proposeTerminal,
      // REQUIRED: an unbound compaction port means no transcript is ever
      // replaced. `engineCompactionSources` is the member that supplies it, and
      // it binds the agent's own coordinator -- the same one the legacy used.
      compaction: agent.engineCompactionSources({
        systemPromptContent: () => assembly.systemPrompt,
        messages: () => agent.getMessages(),
      }),
      seqIndex,
      sessionId,
      workingDirectory: request.workingDirectory,
      wakeRun: request.wakeRun,
      imageInputSupported: request.imageInputSupported,
      beginTicket: (call) => ledger.begin(call),
      settleTicket: (settle) => ledger.settle(settle),
      // The per-call usage tap. The provider's OWN block, before
      // `toModelFrame` narrows it, so the entry's cache buckets survive.
      onPerCallUsage: request.onPerCallUsage,
    };

    // THE composition: the one assembly path, reached through exactly the
    // arguments a production caller passes.
    ports = composeLegacyRunPorts(agent, host);

    // The ONE `chat:*` projection, bound to the SAME emitter the run published
    // through -- so what is projected is this run's own events rather than a
    // hand-made envelope.
    const surface = createWorkerAdapterSurface({
      emitter: spine.emitter,
      legacyFrameCodec: request.legacyFrameCodec,
    });

    const engine = new RunEngineImpl({
      now: () => Date.now(),
      // `undefined` means UNCAPPED, which is the legacy's own reading
      // (`DuyaAgent.ts:4851-4854`): a silent default would truncate a long run
      // without anything recording why.
      ...(request.maxTurns === undefined ? {} : { defaultMaxTurns: request.maxTurns }),
    });

    const execution = engine.execute({
      manifest,
      input,
      // The run's OWN signal, so a stop reaches the controller the engine
      // actually hands to its ports rather than a controller this file owns.
      signal: run.signal,
      ports,
    });

    // The drain runs BESIDE the execution, for the bounded-queue reason
    // `drainSpine` gives. Started, not awaited.
    const drained = drainSpine(spine, (envelope) => {
      const typed = envelope as RunEventEnvelope;
      // The `result` frame the entry's billing ledger reads. `result` is NOT a
      // legacy SSE type -- the legacy consumed it upstream of the codec -- so
      // the projector has no arm for it and the surface owns it.
      for (const result of surface.projectUsageResults(typed.payload)) {
        onFrame(result as unknown as Record<string, unknown>);
      }
      const frame = surface.surface.projectToLegacyFrame(typed);
      // THEN the worker's own codec. The surface projects a protocol event into
      // the LEGACY `SSEEvent` vocabulary (`text_delta`, `turn_start`, `done`),
      // and the caller's handler is written against the `chat:*` frames
      // `convertSSEToAgentMessage` produces. Handing over the projection
      // un-codec'd would silently miss every `chat:*` arm.
      //
      // A frame the codec returns `null` for is DROPPED here rather than passed
      // on, so a caller that kept a legacy arm open would see it -- the codec's
      // own drop is the product's answer, not a gap this driver should paper
      // over by inventing a frame.
      // The surface's DECLARED return is `unknown` (`ports.ts:2144`), deliberately --
      // the interface documents the projection's envelope argument rather than
      // its shape. So the one thing the codec needs is checked here at run time
      // rather than asserted: a projection that is not an object carrying a
      // string `type` is not something `convertSSEToAgentMessage` can read, and
      // handing it over would throw inside the drain.
      if (frame != null && typeof frame === 'object' && typeof (frame as { type?: unknown }).type === 'string') {
        const chatFrame = request.legacyFrameCodec(frame as { readonly type: string });
        if (chatFrame !== null) onFrame(chatFrame as unknown as Record<string, unknown>);
      }
    });

    // Whatever the execution does, the drain MUST terminate. `settleAndCloseSpine`
    // closes the stream in a `finally`, so an execution that threw still releases
    // the waiter this drain is parked on.
    try {
      await execution.completed();
    } finally {
      // THE obligation. The engine PROPOSED its terminal; this settles the run
      // through the single writer, releases the held frame, and closes the
      // stream. See `settleAndCloseSpine` for why that order is the only one
      // that neither drops the run's ending nor parks the drain forever.
      await settleAndCloseSpine(spine, spine.proposedTerminal());
    }
    await drained;

    return {
      announced,
      proposed: spine.proposedTerminal(),
      terminal: spine.session.terminal,
      ports,
      promptRowId,
      railFrames,
    };
  } finally {
    // `close` is identity-checked, so a handle closed after a superseded run
    // releases nothing rather than detaching a live run's controller. It also
    // RELEASES the rail, the fork marker, the approval ledger and the turn
    // output sink, which is what stops a finished run addressing the next one.
    run.close();
  }
}
