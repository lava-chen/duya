/**
 * Plan 600 S2 (cutover): the enumeration of what the legacy drain loop consumed,
 * and where each consumed thing actually lands today.
 *
 * ## Why this file exists
 *
 * The cutover removes the legacy consumer at `DuyaAgent.ts:2690`. Doing that is
 * only safe if something else already carries everything that loop carried --
 * and "the engine's drain" is the candidate. This file is the check that decides
 * whether that is true, run BEFORE the removal rather than after it.
 *
 * ## It RETIRES a caveat that was false
 *
 * `run-engine-ports-drain.test.ts` used to state that importing
 * `@duya/agent-runtime` at run time from that test "resolves to a different
 * worktree's built `dist`", so the adapter half and the engine half could not be
 * composed in one process. That claim is FALSE here: the workspace junction for
 * `@duya/agent-runtime` resolves to this worktree, and the loaded `dist` carries
 * this tree's own engine strings. The first test below is that claim, asserted
 * against a real run rather than against a file path.
 *
 * ## What each test asserts, and why it is not `a === a`
 *
 * The two sides of every assertion come from different code paths: the update is
 * built the way `StreamingToolExecutor` builds it, mapped by the real
 * `toDrainItem`, consumed by the real `RunEngineImpl`, and the expectation is
 * read off the model's REQUEST (produced by `#modelRequest`), the ledger
 * (produced by `#drainOutcomes`), or the record the engine handed the host port.
 * A self-comparison would survive both sides being wrong together.
 *
 * ## The enumeration, and the gaps -- now CLOSED by `TurnOutputPort`
 *
 * The legacy loop body (`DuyaAgent.ts:2690-2826`) does eleven distinct things
 * per update. Three of them landed in the engine's drain when this file was
 * written; the other eight did not, and removing the legacy consumer would have
 * dropped them. `TurnOutputPort` (`packages/agent-runtime/src/engine/ports.ts`)
 * is what closed them: the engine still owns the MOMENT, and the host now owns
 * the six effects that hung off it. Every row is asserted below in the
 * POSITIVE, with the reason, because an unasserted gap is a gap nobody reads --
 * and because an assertion made only by absence cannot see a deletion.
 *
 * | legacy read | line | engine destination | carried |
 * | --- | --- | --- | --- |
 * | `result.deferredContext` | `:2694` | `deferred_context` -> `context.defer` | engine yes, live wiring NO |
 * | `metadata.agentEvent` -> SSE | `:2705` | `subagent_progress` -> `projectSubagentProgress` | engine yes, live wiring NO |
 * | `result.message` (tool result) | `:2713` | `tool_result` -> fragment + ledger | engine yes |
 * | `seq_index` / id assignment | `:2723` | `TurnOutputPort.recordToolResult.turn`; the id stays host-minted | via the port |
 * | `recordToolCatalogSchemaRead` | `:2728` | `record.outcome.metadata` | via the port |
 * | `_pushDurable` (history write) | `:2730` | `recordToolResult` | via the port |
 * | `tool_result` SSE frame | `:2753` | `recordToolResult` -> the host's projection | via the port |
 * | `PostToolUseFailure` hook | `:2770` | `recordToolResult`; the host fires it | via the port |
 * | `mode_changed` SSE frame | `:2813` | `record.toolName`, which is the fact the filter reads | via the port |
 * | `toolResultMessageCount` gate | `:2722` | `TurnOutputPort.finishTurn().results` | via the port, distinct from dispatches |
 *
 * The last row is still the subtle one. `TurnWork.dispatched` counts DISPATCHES
 * and the legacy gate counted RESULTS, so the port carries both, and the test
 * below drives a run where they differ -- which is the only way to show the gate
 * was not quietly replaced.
 *
 * ## `agent_progress` has exactly ONE projection path, on purpose
 *
 * The legacy `:2705` frame and the `:2753` / `:2813` frames are all `chat:`
 * vocabulary, but only the progress frame already had a home: the protocol
 * projection `RunEventStorePort.projectSubagentProgress`, asserted below.
 * Routing it through `TurnOutputPort` as well would be two mechanisms for one
 * symptom, which is how a frame ends up emitted twice instead of emitted once.
 *
 * ## What is still NOT closed, and belongs to the cutover slice
 *
 * The two live-wiring gaps at the bottom are both adapter facts, and neither is
 * a port's business:
 *
 *  - `context.defer`'s collection. The write-only closure array is GONE, replaced
 *    by a named seam (`LegacyEngineSources.deferFragment`), because reading it
 *    back inside `assemble` would pick a side of a decision `ports.ts` leaves
 *    open (inline vs `by_ref` history) and could hand the model the same result
 *    twice. What the engine's own seed carries is asserted below.
 *  - the event port's LIVE binding. b4d replaced the
 *    `publishEvent: (event) => void` no-op with a required
 *    `emitter: Pick<RunEventEmitter, 'emit'>`, because a caller-supplied
 *    function with no emitter in its type could be satisfied with a direct
 *    stream push and an announced terminal reports success before the durable
 *    barrier has answered. NO host supplies one: `buildEnginePorts` has no
 *    production caller, and `agent-process-entry.ts` constructs no
 *    `RunController`, `RunSession` or `RunEventEmitter` at all. Supplying a
 *    real emitter is therefore part of the cutover, and it is the same work as
 *    owning the `chat:*` projection for engine events -- the
 *    `WorkerAdapterSurface` codec -- which cannot be done while the legacy
 *    generator still drives the same frames.
 */

import { describe, expect, it } from 'vitest';
import { RunEngineImpl, RunEventEmitter, RunSession } from '@duya/agent-runtime';
import type {
  ApprovalVerdict,
  AssembledTurn,
  ModelFrame,
  ModelMessage,
  ModelPort,
  ModelRequest,
  RunEnginePorts,
  RunEventStorePort,
  RunInputSnapshot,
  RunManifest,
  ToolDescriptor,
  ToolDispatchTicket,
  ToolDrainItem,
  ToolResultRecord,
  TransientContextFragment,
  TurnOutputSummary,
} from '@duya/agent-runtime';
import type { RunEvent, RunEventEnvelope, RunId } from '@duya/agent-protocol';
import type { AgentProgressEvent, Message } from '@duya/agent-protocol/transcript';
import { buildEnginePorts, toDrainItem } from '../run-engine-ports.js';
import type { CompactionSources, TurnOutputSources } from '../run-engine-ports.js';
import type { MessageUpdate } from '../../tool/StreamingToolExecutor.js';

// ============================================================================
// Sentinels -- each derived from a different code path than the one asserted on
// ============================================================================

/** The tool's answer. Read back off the MODEL REQUEST `#modelRequest` built. */
const RESULT_SENTINEL = 'tool-answer-the-model-must-see';
/** A sub-agent's internal stream. Must appear NOWHERE the model can read. */
const PROGRESS_SENTINEL = 'SUBAGENT-INTERNAL-STREAM-MUST-NOT-LEAK';
/** A follow-up review payload, still pending when the drain ends. */
const DEFERRED_SENTINEL = 'follow-up-review-verdict';
/** The only name in the run, and it lives on the MODEL's request, not the item. */
const TOOL_NAME = 'Task';

const RUN_ID = 'run-cutover' as RunId;

// ============================================================================
// Producer shapes, copied field-for-field from StreamingToolExecutor
// ============================================================================

/**
 * A `role: 'tool'` result, the shape `executeTool` produces
 * (`StreamingToolExecutor.ts:1657` builds exactly this).
 */
function toolResultMessage(content: string): Message {
  return {
    role: 'tool',
    content,
    tool_call_id: 'call-1',
    duration_ms: 42,
    // The producer stamps this, and two legacy consumers read it:
    // `recordToolCatalogSchemaRead(catalogView, metadata)` (`:2728`) and the
    // renderer's preview path (`:2763`).
    metadata: { previewToken: RESULT_SENTINEL },
  } as unknown as Message;
}

/**
 * A sub-agent progress frame, field for field from
 * `StreamingToolExecutor.createAgentProgressMessage` (`:2325-2341`).
 */
function progressMessage(event: AgentProgressEvent): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text: JSON.stringify({ toolUseId: 'call-1' }) }],
    metadata: {
      type: 'agent_progress',
      toolId: 'call-1',
      toolName: 'Task',
      agentEvent: event,
    },
  } as unknown as Message;
}

/** A pending follow-up payload, the shape `drainPendingDeferredContexts` yields. */
function deferredUpdate(promise: Promise<unknown>): MessageUpdate {
  return { deferredContext: { toolUseId: 'call-1', toolName: 'Task', promise } };
}

// ============================================================================
// The engine, driven through its real public entry
// ============================================================================

interface Composition {
  readonly events: RunEvent[];
  readonly ledger: string[];
  readonly modelRequests: ModelMessage[][];
  /** Every fragment the engine handed to `context.defer`, in order. */
  readonly deferred: TransientContextFragment[];
  /** Every record the engine handed `TurnOutputPort.recordToolResult`, in order. */
  readonly records: ToolResultRecord[];
  /** Every turn summary the engine handed `TurnOutputPort.finishTurn`, in order. */
  readonly summaries: TurnOutputSummary[];
  /**
   * Interleaving markers from three DIFFERENT ports, in call order: the ledger,
   * the context port and the turn-output port. One recorder per port, so the
   * order cannot be an artefact of a single call site.
   */
  readonly order: string[];
  /** Every string the model was ever sent, joined. */
  modelSawText(): string;
  /** Every published event, joined. */
  publishedText(): string;
}

/**
 * Drive a real `RunEngineImpl` over updates that the REAL `toDrainItem` maps.
 *
 * The drain port is fed the adapter's output, so the chain under test is
 * producer -> `toDrainItem` -> `#drainOutcomes` -> model request / ledger /
 * turn-output port / events, with no hand-written drain item anywhere in it.
 */
async function runThroughAdapter(
  updates: readonly MessageUpdate[],
  options: { calls?: number } = {},
): Promise<Composition> {
  const mapped = updates.map((update) => toDrainItem(update));
  const events: RunEvent[] = [];
  const ledger: string[] = [];
  const modelRequests: ModelMessage[][] = [];
  const deferred: TransientContextFragment[] = [];
  const records: ToolResultRecord[] = [];
  const summaries: TurnOutputSummary[] = [];
  const order: string[] = [];
  const pending = mapped.filter((item) => item !== null);
  const callCount = options.calls ?? 1;
  let turn = 0;

  const model: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelFrame> {
      turn += 1;
      modelRequests.push([...request.messages]);
      // Ask for tools on turn 1 so the drain runs against real dispatches, and
      // stop cleanly so the engine reaches decision 4.
      if (turn === 1) {
        for (let index = 0; index < callCount; index += 1) {
          yield {
            type: 'tool_use',
            call: {
              callId: index === 0 ? 'call-1' : `call-${index + 1}`,
              name: TOOL_NAME,
              input: {},
              sideEffect: 'read_only',
            },
          };
        }
      }
      yield { type: 'turn_stopped', reason: 'end_turn' };
    },
  };

  const ports: RunEnginePorts = {
    // Required since A3-1. A host with nothing queued SAYS so rather
    // than leaving the port out, which is a compile error -- the
    // engine would otherwise skip the sweep and drop mid-run steering
    // with nothing reporting the loss.
    interTurn: { sweep: () => Promise.resolve({ decision: { action: 'continue', absorbed: false }, injected: [] }) },
    model,
    tools: {
      dispatch(): void {},
      // Replaced below by the real drain; declared here only so the object
      // satisfies `RunEnginePorts` before the override is spread in.
      async *drain(): AsyncIterable<ToolDrainItem> {
        void 0;
      },
      discard(): void {},
      describe: (): readonly ToolDescriptor[] => [
        { name: TOOL_NAME, description: 'delegate', inputSchema: {} },
      ],
    },
    context: {
      async assemble(): Promise<AssembledTurn> {
        return {
          systemPrompt: 'test',
          messages: [],
          tools: [{ name: TOOL_NAME, description: 'delegate', inputSchema: {} }],
          catalogRevision: 'cat-1',
          revision: 'rev-1',
        };
      },
      defer(fragment: TransientContextFragment): void {
        order.push('defer');
        deferred.push(fragment);
      },
    },
    approval: {
      async authorize(): Promise<ApprovalVerdict> {
        return { allowed: true, scope: 'once' };
      },
    },
    events: {
      publish(event: RunEvent): void {
        events.push(event);
      },
      proposeTerminal(): void {},
    } as RunEventStorePort,
    sideEffects: {
      async begin(call): Promise<ToolDispatchTicket> {
        ledger.push(`begin:${call.callId}`);
        return {
          attemptKey: `key:${call.callId}`,
          runId: RUN_ID,
          runEpoch: 1,
          fence: { runId: RUN_ID, runEpoch: 1, token: 1 },
        };
      },
      async settle(input): Promise<void> {
        order.push('settle');
        ledger.push(`settle:${input.attemptKey}:${input.state}`);
      },
      async reconcile(): Promise<void> {},
      async read() {
        return [];
      },
    },
    // The port under test. A recorder, not a mock: it keeps what it was handed
    // so the expectations below are read off the engine's OWN calls.
    turnOutput: {
      async recordToolResult(record: ToolResultRecord): Promise<void> {
        order.push('record');
        records.push(record);
      },
      // Required by the port since b3a and not what this file is about; the
      // assistant message is asserted in
      // `packages/agent-runtime/test/assistant-message-emission.test.ts`.
      async recordAssistantMessage(): Promise<void> {
        order.push('assistant');
      },
      async finishTurn(summary: TurnOutputSummary): Promise<void> {
        order.push('finish');
        summaries.push(summary);
      },
    },
  };

  // The drain yields the ADAPTER'S ITEMS, not hand-built ones, and it yields
  // them ONCE: the engine drains on every turn, and a drain that re-served the
  // same items would settle the same call twice -- a double ledger row that
  // looks exactly like a correct one. Typed through the port's own signature
  // rather than a cast, so a change to `ToolDrainItem` is a compile error here
  // instead of a silent mismatch at run time.
  const withDrain: RunEnginePorts = {
    ...ports,
    tools: {
      ...ports.tools,
      async *drain() {
        for (const item of pending.splice(0, pending.length)) {
          if (item !== null) yield item;
        }
      },
    },
  };

  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 3 });
  await engine
    .execute({
      manifest: MANIFEST,
      input: INPUT,
      signal: new AbortController().signal,
      ports: withDrain,
    })
    .completed();

  return {
    events,
    ledger,
    modelRequests,
    deferred,
    records,
    summaries,
    order,
    modelSawText: () =>
      modelRequests
        .flat()
        .map((message) =>
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        )
        .join('\n'),
    publishedText: () => JSON.stringify(events),
  };
}

const MANIFEST = {
  version: 1,
  runId: RUN_ID,
  projectId: null,
  workspaceId: 'ws',
  roots: ['/tmp'],
  cwd: '/tmp',
  permissionPolicy: { mode: 'default', hostSwitch: 'ask', defaultTimeoutMs: 1000 },
  capabilities: { profiles: [], modes: [], tools: [] },
  connectorBindings: [],
  env: { ref: 'env:test', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
  agent: { model: 'test-model', providerId: 'test-provider' },
  budget: {},
  deterministic: false,
  provenance: {
    roots: { source: 'unsupported', synthesised: true },
    cwd: { source: 'unsupported', synthesised: true },
    permissionPolicy: { source: 'unsupported', synthesised: true },
    capabilities: { source: 'unsupported', synthesised: true },
    connectorBindings: { source: 'unsupported', synthesised: true },
    env: { source: 'unsupported', synthesised: true },
    agent: { source: 'unsupported', synthesised: true },
    budget: { source: 'unsupported', synthesised: true },
    workspaceId: { source: 'unsupported', synthesised: true },
    projectId: { source: 'unsupported', synthesised: true },
  },
} as unknown as RunManifest;

const INPUT = {
  revision: 'rev-1',
  prompt: { role: 'user', id: 'p1', content: 'delegate this' },
  history: { kind: 'inline', value: [] },
  attachments: { kind: 'inline', value: [] },
  catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
  steering: [],
  options: {},
} as unknown as RunInputSnapshot;

// ============================================================================
// 0. The caveat this file retires
// ============================================================================

describe('the adapter and the engine compose in one process, in this tree', () => {
  it('the loaded engine is functional, not a stub from another checkout', async () => {
    // The old claim was that the import resolved elsewhere, so the two halves
    // could not meet. Asserted as BEHAVIOUR: a real run over a real adapter
    // output has to produce a real ledger row and a real second model request.
    // A stub, or a different tree's engine, produces neither.
    const c = await runThroughAdapter([{ message: toolResultMessage(RESULT_SENTINEL) }]);

    expect(c.ledger).toEqual(['begin:call-1', 'settle:key:call-1:succeeded']);
    expect(c.modelRequests.length).toBeGreaterThan(1);
  });
});

// ============================================================================
// 1. The three cases the engine's drain DOES carry
// ============================================================================

describe('what the engine drain carries from the legacy loop', () => {
  it('carries a tool result to the model and settles the ledger key begin minted', async () => {
    const c = await runThroughAdapter([{ message: toolResultMessage(RESULT_SENTINEL) }]);

    // Read off the request `#modelRequest` built, not off the item the test made.
    expect(c.modelSawText()).toContain(RESULT_SENTINEL);
    // The key is the ledger's, from `begin` -- not the callId, which would be a
    // settle against a row that does not exist.
    expect(c.ledger).toEqual(['begin:call-1', 'settle:key:call-1:succeeded']);
  });

  it('keeps a sub-agent progress frame out of the model and out of the ledger', async () => {
    const frame: AgentProgressEvent = {
      type: 'text',
      data: PROGRESS_SENTINEL,
      agentId: 'sub-1',
      agentName: 'researcher',
    };
    // One drain, two items, two sentinels: only real discrimination can pass this.
    const c = await runThroughAdapter([
      { message: progressMessage(frame) },
      { message: toolResultMessage(RESULT_SENTINEL) },
    ]);

    expect(c.modelSawText()).not.toContain(PROGRESS_SENTINEL);
    expect(c.modelSawText()).toContain(RESULT_SENTINEL);
    // Exactly one settle -- a progress frame must not mint a ledger row.
    expect(c.ledger).toEqual(['begin:call-1', 'settle:key:call-1:succeeded']);
  });

  it('counts an unmapped progress frame as a diagnostic instead of dropping it', async () => {
    // The live worker supplies no projector, so this is the path that runs.
    const frame: AgentProgressEvent = {
      type: 'text',
      data: PROGRESS_SENTINEL,
      agentId: 'sub-1',
      agentName: 'researcher',
    };
    const c = await runThroughAdapter([{ message: progressMessage(frame) }]);

    const diagnostics = c.events.filter((event) => event.type === 'diagnostic');
    expect(diagnostics).toHaveLength(1);
    expect(c.publishedText()).toContain('has no protocol destination');
  });

  it('carries a deferred context pending, and resolves it into the next request', async () => {
    const c = await runThroughAdapter([
      { message: toolResultMessage(RESULT_SENTINEL) },
      deferredUpdate(Promise.resolve(DEFERRED_SENTINEL)),
    ]);

    expect(c.modelSawText()).toContain(DEFERRED_SENTINEL);
    // The real result rode the same drain and is still there -- a deferred
    // context must not displace it.
    expect(c.modelSawText()).toContain(RESULT_SENTINEL);
  });

  it('hands the host BOTH fragments, under two distinct keys', async () => {
    // The obligation this pins is the CALL, not the array's private contents:
    // `#drainOutcomes` must reach `context.defer` once per drained result and
    // once per drained deferred context. Asserting only "the model saw it"
    // would still pass if the engine deferred one and dropped the other, and
    // asserting only "it did not reappear" (the live-wiring test below) cannot
    // see a dropped fragment at all. This is the assertion that made the
    // `defer`-dropping mutation RED.
    const c = await runThroughAdapter([
      { message: toolResultMessage(RESULT_SENTINEL) },
      deferredUpdate(Promise.resolve(DEFERRED_SENTINEL)),
    ]);

    expect(c.deferred).toHaveLength(2);
    // Distinct keys, because a shared prefix would let one overwrite the other
    // in a host's keyed map.
    expect(new Set(c.deferred.map((fragment) => fragment.key)).size).toBe(2);
    // And each fragment carries the payload it was made for, so a swap is
    // visible rather than merely plausible.
    expect(c.deferred.some((fragment) => fragment.text === RESULT_SENTINEL)).toBe(true);
    expect(c.deferred.some((fragment) => fragment.pending !== undefined)).toBe(true);
  });
});

// ============================================================================
// 2. The six effects the port closed, asserted in the POSITIVE
//
// Each of these was asserted in the NEGATIVE when this file was written, and a
// negative assertion cannot tell "not carried" from "carried and then deleted":
// a mutation that removed the call entirely left every one of them green. Each
// row below now asserts that the fact ARRIVES, with its value read off the
// engine's own call.
// ============================================================================

describe('the six legacy effects, carried to the host by TurnOutputPort', () => {
  it('reaches the host once per result, with the exact answer the model will see', async () => {
    // `:2730` `_pushDurable` + `:2753` the `tool_result` frame. The durable
    // append and the frame are the host's two writes; what the engine owes is
    // that it happened, once, with this content. A `not.toContain` assertion
    // would pass on a run where `recordToolResult` was never called at all.
    const c = await runThroughAdapter([{ message: toolResultMessage(RESULT_SENTINEL) }]);

    expect(c.records).toHaveLength(1);
    expect(c.records[0].outcome.content).toBe(RESULT_SENTINEL);
    expect(c.records[0].outcome.callId).toBe('call-1');
    // `tool_resultId` was `message.tool_call_id` (`:2739`) and `duration_ms`
    // was forwarded whole (`:2760`); both are fields the renderer reads.
    expect(c.records[0].outcome.durationMs).toBe(42);
    // The turn, which is what the host orders by instead of a `seq` it cannot
    // mint here (`:2723`).
    expect(c.records[0].turn).toBe(1);
  });

  it('carries the producer metadata, which is the ONLY channel to the catalog read-tracking', async () => {
    // `:2728` `recordToolCatalogSchemaRead(catalogView, result.message.metadata)`.
    // The sentinel is the one the PRODUCER stamped on the message, and the
    // assertion reads it off the record -- so a `metadata` dropped between the
    // drain and the port turns this red, which an assertion on `isError` alone
    // would not have done.
    const c = await runThroughAdapter([{ message: toolResultMessage(RESULT_SENTINEL) }]);

    expect(c.records[0].outcome.metadata).toMatchObject({ previewToken: RESULT_SENTINEL });
  });

  it('hands over the error flag AND the tool name a PostToolUseFailure hook needs', async () => {
    // `:2770` fires the hook, whose payload is built from `toolResultError` and
    // `turnToolCallIds.get(toolResultId)` (`:2771`). The engine has no hook bus
    // and the host has no `callId -> name` map, so BOTH facts have to arrive or
    // the hook goes out with an empty tool name and filters on nothing.
    const c = await runThroughAdapter([
      { message: toolResultMessage('<tool_error>boom</tool_error>') },
    ]);

    expect(c.records[0].outcome.isError).toBe(true);
    expect(c.records[0].toolName).toBe(TOOL_NAME);
    // Read from the engine's own dispatch, so the classifier agrees with the
    // ledger rather than being re-derived from the text.
    expect(c.ledger).toEqual(['begin:call-1', 'settle:key:call-1:failed']);
  });

  it('hands over the tool name the mode_changed filter reads, and nothing else about modes', async () => {
    // `:2793` looks the call up in `modeSwitchToolIds` and `:2799-2807` decides
    // the next mode from the tool's NAME. Both are host facts: the runtime layer
    // must not learn the word `plan`. So the port carries the name and stops,
    // and the host filters on it. Asserted positively because a host that
    // received `''` here would silently never emit `mode_changed`.
    const c = await runThroughAdapter([{ message: toolResultMessage(RESULT_SENTINEL) }]);

    expect(c.records[0].toolName).toBe(TOOL_NAME);
    // And the mode vocabulary really is absent from what crossed the port.
    expect(Object.keys(c.records[0]).sort()).toEqual(['outcome', 'toolName', 'turn']);
  });

  it('reports a RESULT count, which a dispatch count would have got wrong', async () => {
    // `:2722` `toolResultMessageCount` gates `PostToolUse` (`:2858`) and the
    // preflight compaction probe (`:2935`). Two calls dispatched, ONE answer
    // drained: the legacy gate was false and a dispatch-count gate would be
    // true. This is the assertion that cannot be faked by counting dispatches.
    const c = await runThroughAdapter([{ message: toolResultMessage(RESULT_SENTINEL) }], {
      calls: 2,
    });

    expect(c.summaries[0]).toEqual({ turn: 1, results: 1, dispatched: 2 });
    // Turn 2 drained nothing and still reported: "this turn landed nothing" is
    // an answer the host needs, not a silence.
    expect(c.summaries).toHaveLength(2);
    expect(c.summaries[1]).toEqual({ turn: 2, results: 0, dispatched: 0 });
  });

  it('writes the ledger row before the host is told, and the summary after every record', async () => {
    // The ordering a host cannot reconstruct for itself: the durable record of an
    // effect exists before the effect is visible anywhere, and the host's "results
    // are committed" moment is after every per-result call. Read from three
    // different ports -- the ledger, `context.defer`, and the turn-output port --
    // each with its own recorder, so it cannot be an artefact of one call site.
    const c = await runThroughAdapter([{ message: toolResultMessage(RESULT_SENTINEL) }]);

    // Turn 1: the assembled assistant message, then ledger, then the model seed,
    // then the host, then the summary. Turn 2 drained nothing and still
    // reported, which is why 'finish' appears twice. The leading 'assistant' is
    // the OpenAI ordering rule (`DuyaAgent.ts:2641-2642`): the message is stored
    // before any tool result, and it can only be assembled once the stream ends.
    expect(c.order).toEqual([
      'assistant',
      'settle',
      'defer',
      'record',
      'finish',
      'assistant',
      'finish',
    ]);
  });
});

/**
 * A port bundle from the REAL `buildEnginePorts`, optionally with the host's
 * fragment collector bound.
 *
 * `collector` is the array the test owns, which is what makes the assertion
 * distinguishable from anything the adapter might hold privately.
 *
 * `emitted` collects whatever reaches the EMITTER. It is not a `publishEvent`
 * stand-in that the adapter could satisfy with a bare array push: the point of
 * the b4d binding change is that a host hands over an emitter, and a recorder
 * shaped like one is the closest honest thing a test can supply. The tests
 * below that assert on `emitted` are the ones that make the difference
 * observable.
 */
function realPorts(
  collector?: TransientContextFragment[],
  turnOutput?: TurnOutputSources,
  emitted?: RunEvent[],
): RunEnginePorts {
  return buildEnginePorts({
    openModelStream: () => (async function* () {})(),
    queueTool: () => {},
    drainTools: () => (async function* () {})(),
    discardTools: () => {},
    lookup: { sideEffectOf: () => null, toolNames: () => [], describe: () => null },
    assembleTurn: () =>
      Promise.resolve({
        systemPrompt: 'p',
        messages: [],
        tools: [],
        catalogRevision: 'c',
        revision: 'r',
      }),
    askApproval: () => Promise.resolve({ allowed: true, scope: 'once' as const }),
    // A REAL `RunEventEmitter`, not a recorder shaped like one and not the
    // `publishEvent: () => {}` this replaced. The difference is the whole point
    // of the b4d binding change: a host now hands over the object that mints,
    // field-checks and HOLDS a terminal, so a direct stream push is not a
    // binding the adapter can express. A recorder would satisfy the type while
    // testing none of that.
    emitter: realEmitter(emitted),
    proposeTerminal: () => {},
    // A REQUIRED source, and the no-op is stated rather than omitted. Nothing
    // is queued in this harness, and saying so is the contract: the source has
    // no "absent" state, because a host that forgot to wire inter-turn input
    // would silently stop honouring mid-run steering.
    interTurn: {
      claim: () => Promise.resolve({ action: 'continue', absorbed: false }),
      seqIndex: 0,
      wakeRun: false,
    },
    // A REQUIRED source since A3-2a, for the same reason `interTurn` above is:
    // a forgotten binding is a lost transcript rather than a lost guardrail, and
    // test dirs are excluded from every tsconfig so the compiler would not say
    // so. INERT here -- `skip` is a real answer, and a harness that is not
    // testing compaction declines to compact. The binding itself is exercised
    // in `engine-compaction-binding.test.ts`.
    compaction: skippingCompaction(),
    ...(collector === undefined ? {} : { deferFragment: (fragment) => collector.push(fragment) }),
    ...(turnOutput === undefined ? {} : { turnOutput }),
  });
}

/**
 * A compaction source that always declines, for harnesses that do not test it.
 *
 * `skip` rather than a stub that pretends to compact: a harness whose turns are
 * empty has nothing to compact, and a source that returned a `replaced` outcome
 * would swap the transcript out from under a test asserting something else.
 */
export function skippingCompaction(): CompactionSources {
  return {
    decide: () => Promise.resolve({ kind: 'skip', reason: 'not under test' }),
    compact: () => Promise.resolve({ kind: 'declined', reason: 'not under test' }),
    nextCompactionId: () => 'cmp-inert',
  };
}

/**
 * A real emitter over a real session, with persistence that accepts everything.
 *
 * `emitted` receives the EVENT payloads, which is what lets a test assert that
 * a publish reached the run layer at all. The stream records separately,
 * because the difference between "minted" and "announced" is precisely what the
 * terminal tests are about.
 */
function realEmitter(emitted?: RunEvent[]): RunEventEmitter {
  const persistence = {
    append: async () => undefined,
    complete: async () => undefined,
  };
  const session = new RunSession({
    runId: 'run-real-1',
    sessionId: 'sess-real-1',
    now: () => 1_000,
    startedAt: 0,
    clock: () => 0,
    persistence,
    flushEvery: 1,
  });
  return new RunEventEmitter({
    runId: 'run-real-1',
    session,
    stream: {
      push: (envelope: RunEventEnvelope) => {
        if (emitted !== undefined) emitted.push(envelope.payload);
      },
    },
  });
}

// ============================================================================
// 3. The two LIVE-WIRING gaps, driven through the real exported functions
// ============================================================================

describe('buildEnginePorts routes every published event through the run s emitter', () => {
  it('a terminal published through the REAL adapter is HELD, never announced', async () => {
    // The pin for the b4d binding change, and the property the whole terminal
    // story rests on.
    //
    // `LegacyEngineSources.publishEvent` used to be a bare
    // `(event) => void`, which a host could satisfy with a direct stream push.
    // A terminal pushed straight at a stream is announced before the durable
    // barrier has flushed the transcript and written the terminal row -- a run
    // reporting success it never reached, which is the defect `8b62fc82` fixed.
    // The port now requires an EMITTER, and this asserts what that buys: the
    // run's ending is minted, numbered and held, and the stream is untouched.
    //
    // Driven through `buildEnginePorts` rather than a hand-built port object,
    // because the binding under test is the adapter's.
    const announced: RunEventEnvelope[] = [];
    const session = new RunSession({
      runId: 'run-bind-1',
      sessionId: 'sess-bind-1',
      now: () => 1_000,
      startedAt: 0,
      clock: () => 0,
      persistence: { append: async () => undefined, complete: async () => undefined },
      flushEvery: 1,
    });
    const emitter = new RunEventEmitter({
      runId: 'run-bind-1',
      session,
      stream: {
        push: (envelope: RunEventEnvelope): void => {
          announced.push(envelope);
        },
      },
    });
    const ports = buildEnginePorts({
      openModelStream: () => (async function* () {})(),
      queueTool: () => {},
      drainTools: () => (async function* () {})(),
      discardTools: () => {},
      lookup: { sideEffectOf: () => null, toolNames: () => [], describe: () => null },
      assembleTurn: () =>
        Promise.resolve({
          systemPrompt: 'p',
          messages: [],
          tools: [],
          catalogRevision: 'c',
          revision: 'r',
        }),
      askApproval: () => Promise.resolve({ allowed: true, scope: 'once' as const }),
      emitter,
      proposeTerminal: () => {},
      // Required source. Inert: this test drives the EVENT binding, not the
      // turn loop, so nothing is queued and the claim never runs.
      interTurn: {
        claim: () => Promise.resolve({ action: 'continue', absorbed: false }),
        seqIndex: 0,
        wakeRun: false,
      },
      // Required since A3-2a. Inert for the same reason as `interTurn` above.
      compaction: skippingCompaction(),
    });

    ports.events.publish({ type: 'run.completed', status: 'completed' });

    // Not announced. That is the entire claim.
    expect(announced).toEqual([]);
    expect(emitter.hasHeldTerminal).toBe(true);

    // And the release is the controller's to make, not the adapter's.
    const committed = await session.settle();
    const release = await emitter.publishCommittedTerminal(committed);
    expect(release.outcome).toBe('published');
    expect(announced.map((e) => e.payload.type)).toEqual(['run.completed']);
    expect(announced[0]?.runId).toBe('run-bind-1');
  });
});

describe('buildEnginePorts no longer pretends to carry a deferred fragment', () => {
  it('forwards a deferred fragment to the host collector, by identity', () => {
    // The POSITIVE half, and the one that keeps the negative half honest. The
    // engine DID hand the host the fragment -- the two sides of `toBe` are the
    // object this test made and the object the collector received -- so
    // "collected but unread" is now a claim about a NAMED seam
    // (`LegacyEngineSources.deferFragment`) rather than about a private array
    // nobody outside could observe.
    const forwarded: TransientContextFragment[] = [];
    const ports = realPorts(forwarded);

    const fragment: TransientContextFragment = {
      kind: 'deferred_tool_context',
      key: 'tool_result:call-1',
      text: RESULT_SENTINEL,
    };
    ports.context.defer(fragment);

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toBe(fragment);
  });

  it('a fragment handed to context.defer does NOT reappear in the next assembly', async () => {
    // Re-asserted, with the reason changed. It used to read "the adapter's array
    // is never read back", which is true of a by-ref host but was a misleading
    // reason: on this wiring the model gets the fragment from the ENGINE's own
    // seed (asserted in the test above), and `#modelRequest` reads
    // `assembled.messages` only for a `by_ref` history. Injecting here would
    // therefore have been inert for this input and DOUBLE for a by-ref one --
    // which is the duplication `run-engine.ts:414-420` records as having
    // already happened once.
    const ports = realPorts();

    const fragment: TransientContextFragment = {
      kind: 'deferred_tool_context',
      key: 'tool_result:call-1',
      text: RESULT_SENTINEL,
    };
    ports.context.defer(fragment);

    const assembled = await ports.context.assemble({
      runId: RUN_ID,
      runEpoch: 0,
      turn: 2,
      history: { kind: 'inline', value: [] },
      attachments: { kind: 'inline', value: [] },
      catalog: { kind: 'by_ref', digest: 'd', locator: 'catalog://1' },
      digest: 'rev-1',
    });

    expect(JSON.stringify(assembled.messages)).not.toContain(RESULT_SENTINEL);
  });
});

describe('buildEnginePorts binds the turn-output seam all-or-nothing', () => {
  it('builds NO turnOutput port when the host supplies none', () => {
    // The live worker's state, asserted structurally rather than inferred from a
    // missing effect. A port that existed and did nothing would look identical
    // from the outside and would swallow the obligation the cutover has to
    // discharge; `undefined` is the honest answer and it is checkable.
    expect(realPorts().turnOutput).toBeUndefined();
  });

  it('forwards BOTH halves to the host, and awaits them', async () => {
    // All-or-nothing because a half-bound port is indistinguishable from one that
    // was never asked: `finishTurn` without `recordToolResult` would report
    // counts for results the host was never handed. Both members are checked, and
    // the record that comes out the far side is the one that went in.
    const records: ToolResultRecord[] = [];
    const summaries: TurnOutputSummary[] = [];
    const ports = realPorts(undefined, {
      onToolResult: (record) => {
        records.push(record);
      },
      onTurnResults: (summary) => {
        summaries.push(summary);
      },
    });
    const output = ports.turnOutput;
    expect(output).toBeDefined();

    const record: ToolResultRecord = {
      turn: 1,
      toolName: TOOL_NAME,
      outcome: {
        kind: 'tool_result',
        callId: 'call-1',
        content: RESULT_SENTINEL,
        isError: false,
        durationMs: 42,
      },
    };
    await output?.recordToolResult(record);
    await output?.finishTurn({ turn: 1, results: 1, dispatched: 2 });

    expect(records).toEqual([record]);
    expect(summaries).toEqual([{ turn: 1, results: 1, dispatched: 2 }]);
  });
});
