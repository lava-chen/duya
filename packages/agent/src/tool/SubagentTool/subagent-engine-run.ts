/**
 * Plan 610 S4c-d3: the sub-agent's turn is driven by the ENGINE.
 *
 * ## What this replaces
 *
 * `runAgent.ts` used to call `subAgent.streamChat(promptText, options)`, which ran
 * `DuyaAgent`'s own turn generator — the legacy loop. With this module it calls
 * `driveRunWithEngine`, the SAME driver `agent-process-entry.ts` and
 * `headless-run-host.ts` call, so a sub-agent turn runs `RunEngineImpl` and
 * reaches no turn loop.
 *
 * That matters for the GATE and not only for tidiness: `DuyaAgent.streamChat`
 * was the third and last production driver of that loop, so this module is what
 * makes boundary gate G7 ("worker entry does not reach the turn-loop
 * implementation") able to go green once the loop is deleted.
 *
 * ## Why this is a module and not an edit inside `runAgent.ts`
 *
 * Because the change is bigger than the one call it replaces, and `runAgent.ts`
 * already carries 400 lines of event CONSUMPTION whose behaviour must not move.
 * This module owns only the production of that stream; `runAgent.ts` keeps
 * owning the stall watchdog, the abort handling, the progress callbacks and the
 * result message. One side changed, the other side did not — which is what makes
 * the parity tests in `__tests__/subagent-engine-run.test.ts` meaningful.
 *
 * ## The vocabulary problem, stated rather than hidden
 *
 * `driveRunWithEngine` hands its caller TWO surfaces:
 *
 *  - `onFrame` receives `chat:*` frames — the WORKER's wire vocabulary, produced
 *    by `convertSSEToAgentMessage`.
 *  - `legacyFrameCodec` receives the PROJECTED legacy `SSEEvent` vocabulary
 *    (`text`, `thinking`, `tool_use`, `tool_result`, `done`, `error`) that
 *    `projectToLegacyFrame` produces on the way to that codec.
 *
 * `runAgent.ts` consumes the RAW legacy vocabulary, and the projected one is
 * NOT the same shape. Measured against `legacy-sse-projector.ts`:
 *
 * | event | raw (what `runAgent.ts` reads)   | projected              |
 * | ----- | --------------------------------- | ---------------------- |
 * | `text`    | `data: string`         | `data: { content }`    |
 * | `thinking`| `data: string`         | `data: { content }`    |
 * | `error`   | `data: string`         | `data: { message, code }` |
 *
 * The projector's own header says why the first three differ: the router has
 * always sent `data.content` and the renderer has always read it, so "this is
 * the wire".
 *
 * `tool_result` looks like a fourth difference and IS NOT one — see
 * `subagentLegacyEvent`, which explains why its pass-through is correct rather
 * than an oversight.
 *
 * `subagentLegacyEvent` below is therefore ONE adapter at this boundary, and it
 * is the only place that knows either shape. It is not a second mapping table
 * competing with the projector: there is nothing to duplicate, because on this
 * path the raw agent stream does not exist at all — the engine's only output
 * vocabulary IS the projected one. Choosing to adapt once, here, is what lets
 * `runAgent.ts`'s consumer stay byte-identical.
 *
 * ## `result` arrives on the OTHER channel, and that is not an inconsistency
 *
 * `projectToLegacyFrame` has no `result` arm and cannot grow one: `result` is
 * not a legacy SSE type, it is a worker-channel frame. The engine surfaces it
 * through `WorkerAdapterSurface.projectUsageResults`, which calls `onFrame`
 * DIRECTLY, bypassing the codec. So this module reads `result` off `onFrame` and
 * everything else off the codec tap. Both feed the same queue, in the order the
 * driver produced them.
 *
 * ## The queue exists because the driver is a `Promise`, not a generator
 *
 * `runAgent.ts` pulls one event at a time so it can race each pull against its
 * stall watchdog, and that watchdog is product behaviour (it is what turns a
 * wedged provider stream into a reported error instead of a hang).
 * `driveRunWithEngine` is a single awaited call, so the stream has to be
 * republished as a pull-based iterator. `SseEventQueue` is that republishing and
 * nothing else — it does not interpret, reorder, buffer-with-a-policy, or drop.
 *
 * ## What this path has no answer for, and says so
 *
 *  - **Approval.** A sub-agent run has no approver, so `askApproval` reports
 *    `unavailable` — the same reading `headless-run-host.ts` gives, and for the
 *    same reason it does not change any decision: `gateRunApproval` consults the
 *    run's own `assembly.canUseTool` and never calls this port.
 *  - **Tool-side-effect journals.** The engine REFUSES to dispatch anything it
 *    cannot ticket, so this path now WRITES a ledger where the legacy wrote none.
 *    That is a real new on-disk consequence, stated here rather than discovered
 *    later. `ledgerDir` is injectable so a test does not write to the user's
 *    data directory.
 *  - **A session-less sub-agent.** `sessionId` is optional on `RunAgentParams`,
 *    and the driver needs a string. `''` is used rather than a minted id,
 *    because the agent's OWN persistence target is read from the agent (which was
 *    constructed with that `sessionId`), not from the driver's field — minting
 *    one here would have silently re-pointed `_pushDurable` at a session that
 *    does not exist.
 */

import type { RunId } from '@duya/agent-protocol';
import type { LegacyFrameCodec } from '@duya/agent-runtime';
import type { duyaAgent } from '../../agent/DuyaAgent.js';
import type { PermissionMode } from '../../permissions/types.js';
import type { ChatOptions, SSEEvent, TokenUsage } from '../../types.js';
import { driveRunWithEngine } from '../../process/engine-run-driver.js';
import { manifestPermissionMode, isValidAgentMode } from '../../process/permission-profile-bridge.js';
import type { AgentPermissionMode } from '../../process/permission-profile-bridge.js';
import type { AgentStreamEvent } from '../../process/sse-frame-codec.js';
import { convertSSEToAgentMessage } from '../../process/sse-frame-codec.js';
import { TurnPipelinePublisher } from '../turn-pipeline-publisher.js';

/** What `driveSubagentRunWithEngine` needs. Everything else it derives. */
export interface SubagentEngineRunRequest {
  readonly agent: duyaAgent;
  /** The stable sub-agent id. Progress correlation only; never a run identity. */
  readonly agentId: string;
  readonly prompt: string;
  /**
   * The turn's `ChatOptions`. The SAME object the legacy passed to `streamChat`,
   * including its `toolRegistry` and `maxTurns`.
   */
  readonly options: ChatOptions;
  /**
   * The turn's whole-turn ceiling, and the engine's `defaultMaxTurns`.
   *
   * Passed BOTH here and inside `options` because the worker entry does the
   * same: the engine reads its ceiling from this field, while other consumers of
   * the options bag read it from there. Supplying only one of the two is how a
   * sub-agent silently stops respecting `agentDefinition.maxTurns`.
   *
   * Absent means UNCAPPED, which is the legacy's own reading — `undefined`
   * reaches `RunEngineImpl` as no `defaultMaxTurns` at all rather than as a
   * silent default that would truncate a long run.
   */
  readonly maxTurns?: number;
  readonly workingDirectory: string;
  /**
   * The provider the child was CONSTRUCTED with.
   *
   * Supplied rather than read off the agent because `duyaAgent.provider` is
   * private and has no accessor — `agent-process-entry.ts`'s own
   * `agent.provider` is a plain config object, not the agent instance. The
   * caller that built the child is the one place this is known, so it is passed
   * through instead of guessed.
   */
  readonly providerId: string;
  /**
   * The sub-agent's own DB session, when it has one. Optional because
   * `RunAgentParams.sessionId` is, and `''` is used for the manifest rather than
   * a minted id (see the header).
   */
  readonly sessionId?: string;
  readonly permissionMode?: PermissionMode;
  /** Where the engine's tool-side-effect journals go. Defaults to the driver's own. */
  readonly ledgerDir?: string;
  /** Wall clock, injected so a test is not at the mercy of the machine. */
  readonly now?: () => number;
  /** Mint the run id, injected so a test can pin it. */
  readonly mintRunId?: () => RunId;
}

/**
 * A pull-based republishing of a push-based producer, and nothing else.
 *
 * Deliberately NOT a bounded buffer with a drop policy. A drop here would be a
 * silent hole in the sub-agent's transcript, and the alternative — blocking the
 * engine's drain — would change the ORDER guarantee the spine makes. Growth is
 * the honest failure mode for a stream whose consumer is a watchdog loop.
 */
class SseEventQueue {
  readonly #items: SSEEvent[] = [];
  readonly #waiters: Array<(result: IteratorResult<SSEEvent, void>) => void> = [];
  #closed = false;

  push(event: SSEEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: event, done: false });
      return;
    }
    this.#items.push(event);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<SSEEvent, void>> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise<IteratorResult<SSEEvent, void>>((resolve) => {
      this.#waiters.push(resolve);
    });
  }
}

/**
 * `runAgent.ts` reads `data` as the string it always was.
 *
 * `projectToLegacyFrame` sends `text` and `thinking` as `data: { content }` — its
 * own header says the router has always sent `data.content` and the renderer has
 * always read it, "both are wrong in the union and right on the wire". Reading
 * that field is what makes the returned message the model's text rather than the
 * literal `{"content":"…"}`.
 */
function readContentString(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data !== null && typeof data === 'object') {
    const content = (data as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  return '';
}

/**
 * One projected legacy frame → the shape `runAgent.ts` already consumes.
 *
 * Only THREE arms are translated, and each one exists because the projector's
 * shape is not the raw one. Everything else passes through untouched, including
 * `tool_result` — and that pass-through is DELIBERATE:
 *
 * `DuyaAgent._buildToolResultFrame` sets `name: ''` on purpose, with the reason
 * in its own header: "the renderer's `ToolResultInfo` resolves the name from the
 * preceding `tool_use`, and filling it from the record would be a second answer
 * to a question the stream already answered". `projectToLegacyFrame` carries no
 * name either, so `runAgent.ts`'s `resultData?.name || ''` yields `''` here
 * exactly as it did on the legacy. Correlating the name back in would have made
 * the sub-agent progress row RICHER than before — a product change, not a
 * parity fix, and not this slice's to make.
 *
 * So the name index that would have supplied it was deleted rather than kept,
 * and this comment is what stops the next reader from re-adding it as a bug.
 *
 * Total by construction: an arm that cannot produce the legacy shape produces
 * the empty string rather than throwing inside the engine's drain, because the
 * alternative is a sub-agent that dies on a field the projector chose to omit.
 */
export function subagentLegacyEvent(frame: AgentStreamEvent): SSEEvent {
  const data = frame.data as Record<string, unknown> | undefined;
  switch (frame.type) {
    case 'text':
      return { type: 'text', data: readContentString(frame.data) };
    case 'thinking':
      return { type: 'thinking', data: readContentString(frame.data) };
    case 'error':
      return {
        type: 'error',
        data: readContentString(data?.message),
        ...(typeof data?.code === 'string' ? { code: data.code } : {}),
      };
    default:
      return frame as unknown as SSEEvent;
  }
}

/**
 * Narrow the AGENT's permission vocabulary to the three names the manifest has.
 *
 * `readPermissionMode` answers with `InternalPermissionMode`, which is wider
 * than `AgentPermissionMode` by four names (`acceptEdits`, `plan`, `bubble`, and
 * anything a future mode adds). A mode the manifest cannot name is reported as
 * `default` rather than cast into one of the three: the field this feeds is a
 * LABEL (`RunEngineImpl` stamps it on an approval request and nothing more —
 * `gateRunApproval` decides from the assembly), so an unlabelable mode losing
 * its label costs nothing, whereas a wrong one would be a claim the run cannot
 * back up.
 */
function subagentAgentMode(mode: PermissionMode): AgentPermissionMode {
  return isValidAgentMode(mode) ? mode : 'default';
}

/**
 * Drive one sub-agent turn on the ENGINE and republish it as the legacy event
 * stream `runAgent.ts` consumes.
 *
 * The generator RE-THROWS whatever the drive threw, after the queue has closed,
 * so `runAgent.ts`'s existing `catch` reports it as
 * `[Error during agent execution: …]` exactly as it reported a throwing
 * `streamChat`. Inventing an `error` EVENT instead would have produced a
 * different message on a path that already has one.
 */
export async function* driveSubagentRunWithEngine(
  request: SubagentEngineRunRequest,
): AsyncGenerator<SSEEvent, void, unknown> {
  const now = request.now ?? Date.now;
  const queue = new SseEventQueue();

  /**
   * The codec tap. It forwards to the worker's OWN codec unchanged — this is a
   * tap in the same sense `onPerCallUsage` is, not a second projection — and the
   * frame it observes is the one the driver would have handed downstream anyway.
   */
  const tapCodec: LegacyFrameCodec = (frame) => {
    queue.push(subagentLegacyEvent(frame as AgentStreamEvent));
    return convertSSEToAgentMessage(frame as AgentStreamEvent);
  };

  // ONE publisher per run, for the reason `headless-run-host.ts` creates one per
  // `chat:start`: it is a per-TURN record, and a publisher reused across runs
  // would refuse the second run's first turn. Omitting it is not neutral — the
  // tool leg would have no producer.
  const turnPipelines = new TurnPipelinePublisher();

  let failure: unknown = null;
  let failed = false;

  // Started, NOT awaited: the consumer below must be able to observe events as
  // the engine produces them, which is the same overlap `drainSpine` performs.
  const drive = driveRunWithEngine(
    {
      agent: request.agent,
      sessionId: request.sessionId ?? '',
      // A sub-agent turn has no Control Plane to mint a run id for, so one is
      // minted HERE and nowhere else. `deriveFirstAttemptFence` reads a per-run
      // ledger file, so a fresh id per run is also what keeps two sub-agent runs
      // from colliding on one fence.
      runId: (request.mintRunId ?? (() => `subagent-${crypto.randomUUID()}` as RunId))(),
      seqIndex: now(),
      options: request.options,
      prompt: request.prompt,
      model: request.agent.model,
      providerId: request.providerId,
      workingDirectory: request.workingDirectory,
      ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
      permissionMode: manifestPermissionMode(subagentAgentMode(
        request.permissionMode ?? request.agent.readPermissionMode(),
      )),
      // A sub-agent prompt is a plain string, so no image or document block can
      // reach this turn.
      wakeRun: false,
      imageInputSupported: false,
      turnPipelines,
      askApproval: async () => ({ allowed: false, reason: 'unavailable' }) as const,
      legacyFrameCodec: tapCodec,
      // A sub-agent run has no Control Plane and therefore no billing ledger.
      // The usage still reaches the caller through the `result` event below.
      onPerCallUsage: () => {},
      ...(request.ledgerDir === undefined ? {} : { ledgerDir: request.ledgerDir }),
    },
    // The `chat:*` frames are the WORKER's wire vocabulary and a sub-agent run
    // has no renderer. The one frame that matters here is `result`, which the
    // engine produces on THIS channel because `projectToLegacyFrame` has no
    // `result` arm (see the header).
    (frame) => {
      if (frame['type'] === 'result') {
        queue.push({ type: 'result', data: frame['data'] as TokenUsage });
      }
    },
    // The orchestrator leg, routed rather than dropped. No registered production
    // mode declares an orchestrator today, so this arm is unexercised; it is
    // here because a driver that omitted it would drop the mode SILENTLY.
    async (frames) => {
      for await (const frame of frames) {
        queue.push(frame);
      }
    },
  )
    .catch((error: unknown) => {
      failed = true;
      failure = error;
    })
    .finally(() => {
      // Closed on EVERY ending, including a throw: a consumer parked on `next()`
      // would otherwise wait forever.
      queue.close();
    });

  try {
    for (;;) {
      const next = await queue.next();
      if (next.done === true) break;
      yield next.value;
    }
  } finally {
    // The consumer may stop early (`return()` on the stall path). The drive is
    // left to settle on its own signal — `runAgent.ts` calls `subAgent.interrupt()`
    // first, which aborts the controller `beginRun` installed — so this waits for
    // nothing and strands nothing.
    void drive;
  }

  if (failed) throw failure;
}