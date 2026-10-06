/**
 * Plan 610 slice A4, scenarios 1 and 2 (多轮 and 工具报错) driven through the
 * REAL host assembly rather than through recorder ports.
 *
 * ## Why this file is separate from `engine-scenario-turn-behaviour.test.ts`
 *
 * That file proves the ENGINE reaches the right decision. It cannot prove the
 * ADAPTER survives the trip, and the adapter is where the cutover actually
 * loses things: `buildEnginePorts` (`run-engine-ports.ts:264`) and
 * `toDrainItem` (`:422`) are the code the A3 cutover will bind, and both are
 * pure translation with no consumer of their own. A translation layer with no
 * consumer is exactly the shape that can be wrong in a way nothing notices.
 *
 * So every update here is built the way `StreamingToolExecutor` builds it and
 * mapped by the REAL `toDrainItem`, then handed to the REAL `buildEnginePorts`
 * and consumed by the REAL `RunEngineImpl`. The chain under test is
 *
 *   tool executor -> toDrainItem -> buildEnginePorts -> RunEngineImpl
 *
 * with no hand-written `ToolDrainItem` anywhere in it, because a hand-written
 * one would test the engine twice and the adapter not at all.
 *
 * ## The two properties that are ONLY visible here
 *
 *  - **The error bit survives translation.** `ToolOutcome.isError` is tri-state
 *    and the legacy wire carries the failure in three OPTIONAL places
 *    (`ports.ts`, "What the producer SAID, tri-state"). An adapter that rounds
 *    absence to `false` produces a success nobody stated, and it is invisible
 *    to any engine-only test because the engine is handed the rounded value.
 *  - **The marker survives the round trip.** What the tool executor RETURNED is
 *    compared against what the provider-shaped request the model was handed
 *    CONTAINS. Two different vocabularies, two different code paths.
 *
 * ## MUTATION PROOF
 *
 * Both properties were proven by injecting a plausible regression into the
 * adapter and observing this file go red; the counts are in the slice report.
 * The regressions are named at their `describe` blocks. Both were reverted and
 * the tree is clean.
 */

import { describe, expect, it } from 'vitest';
import { RunEngineImpl, RunEventEmitter, RunSession } from '@duya/agent-runtime';
import type {
  ApprovalVerdict,
  AssembledTurn,
  ModelFrame,
  ModelRequest,
  RunEnginePorts,
  RunInputSnapshot,
  RunManifest,
  ToolCallRequest,
  ToolDescriptor,
  ToolDispatchTicket,
  ToolDrainItem,
  ToolResultRecord,
  TransientContextFragment,
  TurnOutputSummary,
} from '@duya/agent-runtime';
import type { RunEvent, RunId } from '@duya/agent-protocol';
import type { Message } from '@duya/agent-protocol/transcript';
import { buildEnginePorts, toDrainItem, toProviderMessages } from '../run-engine-ports.js';
import type { SideEffectLookup } from '../run-engine-ports.js';
import type { MessageUpdate } from '../../tool/StreamingToolExecutor.js';

const RUN_ID = 'run-a4-host' as RunId;

// ============================================================================
// Sentinels
// ============================================================================

/** The successful answer. Written by the executor below, read off the request. */
const OK_MARKER = 'PROBE-OK-4b2e91: alpha';
/** The failure answer, wrapped the way `createErrorMessage` wraps it. */
const ERR_MARKER = 'PROBE-ERR-7d0e13: the write was refused';
const TOOL_NAME = 'probe';
const CALL_ID = 'call-1';

// ============================================================================
// The scripted tool executor
//
// This stands in for the real registry + executor. What matters is that the
// string it RETURNS is generated here and nowhere else, so the later assertion
// that the same string appears in what the model was sent is a comparison
// between two independent sources rather than a restatement.
// ============================================================================

interface ProbeResult {
  readonly text: string;
  readonly isError: boolean;
  /** The Message the real executor would hand the drain. */
  readonly message: Message;
}

/**
 * Build the `Message` a real tool execution produces.
 *
 * Field for field from `StreamingToolExecutor.createErrorMessage` (`:229-236`)
 * for the failure arm and from `executeTool`'s success path (`:1657`) for the
 * other: a `role: 'tool'` message with the call id and a `duration_ms`.
 */
function probeExecuted(text: string, isError: boolean): ProbeResult {
  return {
    text,
    isError,
    message: {
      role: 'tool',
      // The marker arm is an INFERENCE the adapter has to make, so the
      // `<tool_error>` wrapper is load-bearing and is reproduced verbatim.
      content: isError ? `<tool_error>${text}</tool_error>` : text,
      tool_call_id: CALL_ID,
      duration_ms: 11,
    } as unknown as Message,
  };
}

// ============================================================================
// Composition
// ============================================================================

interface Composition {
  /** Provider-shaped requests the model was actually handed, one per turn. */
  readonly providerRequests: ReadonlyArray<readonly { role: string; content: unknown }>[];
  /** The exact Message the tool executor produced. */
  readonly produced: ProbeResult;
  /** Ledger rows, in the order the ledger was asked to write them. */
  readonly ledger: string[];
  /** Records handed to `TurnOutputPort.recordToolResult`. */
  readonly records: ToolResultRecord[];
  /** Summaries handed to `TurnOutputPort.finishTurn`. */
  readonly summaries: TurnOutputSummary[];
  /** Events the engine offered the port, in order. */
  readonly events: RunEvent[];
  /** Terminal candidates the engine proposed. */
  readonly terminals: { state: { status: string }; reason: string }[];
  /** Calls the engine dispatched into the pipeline. */
  readonly queued: ToolCallRequest[];
  /** The drain was entered this many times. */
  drainEntries(): number;
  /** Every provider-shaped request, joined, for a substring read-out. */
  providerSawText(): string;
}

interface RunOptions {
  /** How many turns the model asks for the tool on. */
  readonly toolTurns: readonly number[];
  /** Fail the tool on its first execution. */
  readonly isError?: boolean;
}

/**
 * Drive a real engine over the real adapter, with a real emitter behind it.
 *
 * The emitter and session are real because `buildEnginePorts` binds
 * `sources.emitter` and a recorder would let the adapter's actual publication
 * path go untested.
 */
async function runThroughRealAssembly(options: RunOptions): Promise<Composition> {
  const providerRequests: ReadonlyArray<readonly { role: string; content: unknown }>[] = [];
  const ledger: string[] = [];
  const records: ToolResultRecord[] = [];
  const summaries: TurnOutputSummary[] = [];
  const events: RunEvent[] = [];
  const terminals: Composition['terminals'] = [];
  const queued: ToolCallRequest[] = [];
  /** Updates the "pipeline" is holding, waiting for a drain. */
  let updates: MessageUpdate[] = [];
  let drainEntries = 0;
  let turn = 0;
  let produced: ProbeResult | null = null;

  const session = new RunSession({
    runId: RUN_ID,
    sessionId: 'sess-a4-host',
    now: () => 1_000,
    startedAt: 0,
    clock: () => 0,
    persistence: { append: async () => undefined, complete: async () => undefined },
    flushEvery: 1_000,
  });
  const announced: RunEvent[] = [];
  const emitter = new RunEventEmitter({
    runId: RUN_ID,
    session,
    stream: { push: (envelope) => announced.push(envelope) },
  });
  emitter.emit({
    type: 'run.started',
    manifestHash: 'hash-1',
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'test', version: '0.0.0' },
  });

  // The scripted provider. It is handed the PROJECTION of the engine's request,
  // which is what a real model leg does, and it records that projection rather
  // than the engine's own runtime vocabulary -- so the assertion below is about
  // the bytes that would go on the wire, not about an internal array.
  async function* openModelStream(request: ModelRequest): AsyncIterable<ModelFrame> {
    turn += 1;
    providerRequests.push(toProviderMessages(request.messages));
    if (options.toolTurns.includes(turn)) {
      yield {
        type: 'tool_use',
        call: { callId: CALL_ID, name: TOOL_NAME, input: { value: 'alpha' }, sideEffect: 'read_only' },
      };
    } else {
      yield { type: 'text', text: 'the tool has reported; nothing else to do' };
    }
    yield { type: 'turn_stopped', reason: 'end_turn' };
  }

  // The "pipeline". `queueTool` is `ToolExecutionPipeline.addTool`: queued, not
  // awaited, and the result only exists once the executor has run.
  function queueTool(call: ToolCallRequest): void {
    queued.push(call);
    produced ??= probeExecuted(options.isError === true ? ERR_MARKER : OK_MARKER, options.isError === true);
    updates.push({ message: produced.message });
  }

  const lookup: SideEffectLookup = {
    sideEffectOf: (name) => (name === TOOL_NAME ? 'read_only' : null),
    toolNames: () => [TOOL_NAME],
    describe: (name): ToolDescriptor | null =>
      name === TOOL_NAME ? { name, description: 'scripted probe', inputSchema: {} } : null,
  };

  const ports: RunEnginePorts = buildEnginePorts({
    openModelStream,
    queueTool,
    // THE REAL ADAPTER. The engine is handed whatever `toDrainItem` makes of
    // the executor's own Message, so a lossy translation is visible here and
    // nowhere else.
    async *drainTools() {
      drainEntries += 1;
      for (const update of updates.splice(0, updates.length)) {
        const item: ToolDrainItem | null = toDrainItem(update);
        if (item !== null) yield item;
      }
    },
    discardTools() {
      updates = [];
    },
    lookup,
    async assembleTurn(): Promise<AssembledTurn> {
      return {
        systemPrompt: 'you are a test',
        messages: [],
        tools: [{ name: TOOL_NAME, description: 'scripted probe', inputSchema: {} }],
        catalogRevision: 'cat-1',
        revision: 'rev-1',
      };
    },
    async askApproval(): Promise<ApprovalVerdict> {
      return { allowed: true, scope: 'once' };
    },
    emitter,
    proposeTerminal(candidate) {
      terminals.push({ state: candidate.state as { status: string }, reason: candidate.reason });
    },
    async beginTicket(call: ToolCallRequest): Promise<ToolDispatchTicket> {
      ledger.push(`begin:${call.callId}`);
      return {
        attemptKey: `key:${call.callId}`,
        runId: RUN_ID,
        runEpoch: 1,
        fence: { runId: RUN_ID, runEpoch: 1, token: 1 },
      };
    },
    async settleTicket(input) {
      ledger.push(`settle:${input.attemptKey}:${input.state}`);
    },
    turnOutput: {
      onToolResult(record: ToolResultRecord) {
        records.push(record);
      },
      onTurnResults(summary: TurnOutputSummary) {
        summaries.push(summary);
      },
    },
    deferFragment(_fragment: TransientContextFragment) {},
  });

  // The event port is the adapter's own, so wrap it to RECORD what the engine
  // offered. The adapter's `publish` is synchronous, so this cannot reorder
  // anything relative to the engine's own call order.
  const recordingEvents = {
    ...ports.events,
    publish(event: RunEvent): void {
      events.push(event);
      ports.events?.publish(event);
    },
  };

  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 4 });
  await engine
    .execute({
      manifest: MANIFEST,
      input: INPUT,
      signal: new AbortController().signal,
      ports: { ...ports, events: recordingEvents },
    })
    .completed();

  if (produced === null) throw new Error('the scripted executor never ran');
  return {
    providerRequests,
    produced: produced as ProbeResult,
    ledger,
    records,
    summaries,
    events,
    terminals,
    queued,
    drainEntries: () => drainEntries,
    providerSawText: () =>
      providerRequests
        .flat()
        .map((message) =>
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        )
        .join('\n'),
  };
}

const MANIFEST = {
  version: 1,
  runId: RUN_ID,
  projectId: null,
  workspaceId: 'ws',
  roots: ['/tmp'],
  cwd: '/tmp',
  permissionPolicy: { mode: 'default', hostSwitch: 'ask', defaultTimeoutMs: 1_000 },
  capabilities: { profiles: [], modes: [], tools: [] },
  connectorBindings: [],
  env: { ref: 'env:test', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
  agent: { profileId: null, model: 'test-model', providerId: 'test-provider' },
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
    deterministic: { source: 'unsupported', synthesised: true },
  },
} as unknown as RunManifest;

const INPUT = {
  revision: 'rev-1',
  prompt: { role: 'user', id: 'p1', content: 'run the probe' },
  history: { kind: 'inline', value: [] },
  attachments: { kind: 'inline', value: [] },
  catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
  steering: [],
  options: {},
} as unknown as RunInputSnapshot;

// ============================================================================
// 1. 多轮 -- through the real adapter
//
// MIS-IMPLEMENTATION PROVEN AGAINST: `buildEnginePorts`'s `drain` rebound to
// yield nothing (`run-engine-ports.ts:277`). A binding that hands the engine an
// empty drain passes every engine-only test and loses every tool result on the
// way to the model.
// ============================================================================

describe('host assembly, multi-turn: the adapter hands the engine a result it can backfill', () => {
  it('the executor s own answer reaches the SECOND provider request', async () => {
    const c = await runThroughRealAssembly({ toolTurns: [1] });

    // POSITIVE EVIDENCE first. Without it, "the answer is in the request" would
    // also describe a run that never called the tool.
    expect(c.queued.map((call) => call.callId)).toEqual([CALL_ID]);
    expect(c.drainEntries()).toBeGreaterThanOrEqual(1);
    expect(c.providerRequests.length).toBeGreaterThanOrEqual(2);
    expect(c.ledger).toContain(`begin:${CALL_ID}`);

    // THE CROSS-SOURCE ASSERTION. Left: `OK_MARKER` was produced by the
    // scripted executor and written into the Message it returned. Right: the
    // same string, read out of the PROVIDER-SHAPED request the model port was
    // invoked with. Different vocabularies, different code paths, and the
    // engine cannot guess the string.
    expect(c.produced.text).toBe(OK_MARKER);
    expect(c.providerSawText()).toContain(OK_MARKER);

    // It arrived on a LATER turn than the call, which is the "feeds the result
    // back on the next turn" property and not merely "the string is present".
    const turnOfTheAnswer = c.providerRequests.findIndex((messages) =>
      messages.some((message) => JSON.stringify(message.content).includes(OK_MARKER)),
    );
    expect(turnOfTheAnswer).toBe(1);
    // And the request that asked for the call did not already contain it, which
    // is what makes the index above meaningful rather than a coincidence.
    const firstRequest = JSON.stringify(c.providerRequests[0]);
    expect(firstRequest).not.toContain(OK_MARKER);
  });

  it('the host is handed the SAME result the model was, by identity not by re-derivation', async () => {
    const c = await runThroughRealAssembly({ toolTurns: [1] });

    // `recordToolResult` is how a result reaches the transcript. The record's
    // outcome must BE the drain item, so its content and its error bit are the
    // adapter's output rather than a second reading of the same message.
    expect(c.records).toHaveLength(1);
    expect(c.records[0]?.outcome.kind).toBe('tool_result');
    expect(c.records[0]?.outcome.content).toBe(OK_MARKER);
    expect(c.records[0]?.toolName).toBe(TOOL_NAME);
    // The result count is a RESULT count, not a dispatch count.
    expect(c.summaries.map((summary) => summary.results)).toEqual([1, 0]);
  });
});

// ============================================================================
// 2. 工具报错 -- through the real adapter
//
// MIS-IMPLEMENTATION PROVEN AGAINST: `readToolResultPayload`'s
// `role: 'tool'` arm changed from `text.includes('<tool_error>') ? true :
// undefined` to a bare `false` (`run-engine-ports.ts:539`). That is the exact
// regression the function's own doc comment records, and it is invisible to any
// engine-only test because the engine is handed the rounded value.
// ============================================================================

describe('host assembly, tool error: the failure bit survives translation', () => {
  it('a stated failure fails the ledger row and reaches the model as text', async () => {
    const c = await runThroughRealAssembly({ toolTurns: [1], isError: true });

    // POSITIVE EVIDENCE: the executor really produced a failure, wrapped the
    // way the legacy wraps it.
    expect(c.produced.isError).toBe(true);
    expect(c.produced.message.content).toBe(`<tool_error>${ERR_MARKER}</tool_error>`);
    expect(c.ledger).toContain(`begin:${CALL_ID}`);

    // The LEDGER's answer. A silent `false` here would record a failed call as a
    // landed effect, which is the state that tells crash-recovery "this
    // happened, retrying is safe" when it is not.
    expect(c.ledger).toEqual([`begin:${CALL_ID}`, `settle:key:${CALL_ID}:failed`]);

    // The EVENT's answer, which is a different question and resolves the same
    // tri-state differently on purpose: the event needs three values.
    const completed = c.events.find((event) => event.type === 'tool.call_completed');
    expect(completed).toBeDefined();
    if (completed?.type !== 'tool.call_completed') throw new Error('expected tool.call_completed');
    expect(completed.outcome).toEqual({
      outcome: 'tool_error',
      error: { code: 'tool_failed', message: `<tool_error>${ERR_MARKER}</tool_error>` },
    });

    // And the failure TEXT reached the model. A swallowed error loses exactly
    // here and nowhere else, which is why the model-side assertion is not a
    // restatement of the ledger one.
    expect(c.providerSawText()).toContain(ERR_MARKER);

    // The host record carries the same tri-state, not a rounded one.
    expect(c.records).toHaveLength(1);
    expect(c.records[0]?.outcome.isError).toBe(true);
  });

  it('a marker-less result is INDETERMINATE, never a fabricated success', async () => {
    // The complement to the failure case, and the one a mutation that simply
    // hard-codes `true` would still pass.
    //
    // A `role: 'tool'` message carries no status field, so the absence of a
    // `<tool_error>` marker is NOT a statement that the call succeeded -- it is
    // the absence of a marker in a format that cannot state one. The adapter
    // resolves it to `undefined`, and the two consumers then differ on purpose:
    // the EVENT says `indeterminate` (it has no evidence either way) while the
    // LEDGER says `succeeded` (a call nobody reported on did not FAIL).
    //
    // Both halves are asserted because they are separate rules, and collapsing
    // either one is a real regression: rounding to `false` fabricates a
    // success, and rounding to `true` fabricates a failure.
    const c = await runThroughRealAssembly({ toolTurns: [1], isError: false });

    // The event: no evidence either way. The `note` is part of the contract --
    // an `indeterminate` that does not say WHY it is indeterminate is the same
    // silence as a drop.
    const completed = c.events.find((event) => event.type === 'tool.call_completed');
    if (completed?.type !== 'tool.call_completed') throw new Error('expected tool.call_completed');
    expect(completed.outcome.outcome).toBe('indeterminate');
    expect(completed.outcome).toMatchObject({
      note: expect.stringContaining('without stating whether it failed'),
    });
    expect(completed.outcome).not.toEqual({ outcome: 'success' });

    // The ledger: the binary the effect ledger needs.
    expect(c.ledger).toEqual([`begin:${CALL_ID}`, `settle:key:${CALL_ID}:succeeded`]);

    // And the host record carries the ABSENCE, not a false.
    expect(c.records[0]?.outcome.isError).toBeUndefined();
  });
});
