/**
 * Plan 600 S2 (drain contract): the engine consumes all three drained kinds
 * without losing one and without leaking one.
 *
 * ## The failure these tests exist to make impossible
 *
 * Before this contract, `ToolPort.drain` yielded `ToolOutcome` and
 * `#drainOutcomes` treated EVERY item as a result. The real channel
 * (`StreamingToolExecutor.getRemainingResults`) interleaves three kinds, and two
 * of them are not results. So a binding adapter had two bad options -- drop the
 * extra kinds, or stringify them into `content` -- and the second is what a
 * "helpful" adapter does. Under it, ONE mis-typed item produced two wrong
 * outcomes at once:
 *
 *  1. A FALSE LEDGER ROW. A sub-agent progress frame was settled as `succeeded`,
 *     with the sub-agent's own text as the ledger's `detail`. The
 *     crash-recovery reading of that call is then wrong forever, because the
 *     ledger is the only place the answer is kept.
 *  2. A MODEL-VISIBLE LEAK. The frame was also deferred as a
 *     `deferred_tool_context` fragment, and fragments are sent to the MODEL on
 *     the next turn. A sub-agent's internal stream enters the parent's context.
 *
 * **Both are silent, and that is worth being precise about, because the obvious
 * alternative is not.** Folding the kinds in the ENGINE (mutating the `switch`
 * so all three reach the `tool_result` arm) throws immediately -- a
 * `SubagentProgressItem` has no `content`, so the arm's `content.slice` raises
 * and the run fails. Measured: that mutation turns 9 of the 9 tests here red
 * with a TypeError, not with a wrong value. The silent shape is the ADAPTER's,
 * at `toDrainItem`, where a `JSON.stringify` produces a `content` that satisfies
 * every field the old type asked for; that mutation is proven red in
 * `packages/agent/src/process/__tests__/run-engine-ports-drain.test.ts`.
 *
 * So the two halves are pinned separately and for different reasons: this file
 * proves the engine discriminates, and the adapter file proves the mapper does
 * not manufacture a lossy `ToolOutcome` in the first place.
 *
 * ## Why the assertions are not `a === a`
 *
 * Each test puts a SENTINEL string in the drained item and then looks for that
 * sentinel in a place it must NOT be, while a sibling item from the SAME drain
 * carries a different sentinel that MUST appear. So a test fails if the engine
 * drops everything, and it fails if the engine defers everything -- the
 * sentinel has to be in one place and not the other, which only a real
 * discrimination between kinds can produce. The ledger case is the same shape:
 * two call ids, one `begin` row each, and the assertion is that exactly the
 * begun key is settled.
 */

import { describe, expect, it } from 'vitest';
import { RunEngineImpl } from '../src/engine/run-engine.js';
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
  ToolCallRequest,
  ToolDrainItem,
  ToolDescriptor,
  ToolDispatchTicket,
  TransientContextFragment,
} from '../src/engine/ports.js';
import type { AgentProgressEvent } from '@duya/agent-protocol/transcript';
import type { RunEvent, RunId } from '@duya/agent-protocol';

const RUN_ID = 'run-drain' as RunId;

/**
 * A sentinel that cannot appear by accident. Both sides of every assertion below
 * are derived from it, but through DIFFERENT code paths: the item is built by
 * the test, the message list is produced by `#modelRequest`, and the event list
 * by `#drainOutcomes`. A self-comparison would pass even if both paths were
 * wrong in the same way.
 */
const PROGRESS_SENTINEL = 'SUBAGENT-INTERNAL-STREAM-DO-NOT-LEAK';
const RESULT_SENTINEL = 'tool-result-body-the-model-must-see';
const DEFERRED_SENTINEL = 'follow-up-review-payload';

function manifest(): RunManifest {
  return {
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
  } as RunManifest;
}

function input(): RunInputSnapshot {
  return {
    revision: 'rev-1',
    prompt: { role: 'user', id: 'p1', content: 'delegate this' },
    history: { kind: 'inline', value: [] },
    attachments: { kind: 'inline', value: [] },
    catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
    steering: [],
    options: {},
  } as RunInputSnapshot;
}

/** One scripted turn: either "ask for one tool", or "say nothing more". */
interface Harness {
  readonly ports: RunEnginePorts;
  readonly events: RunEvent[];
  readonly sentMessages: ModelMessage[][];
  readonly ledger: string[];
  readonly deferredKeys: string[];
  /** Everything the model was ever sent, as one text blob. */
  modelSawText(): string;
  /** Everything published, as one text blob. */
  publishedText(): string;
}

function harness(options: {
  /** Call the model asks for on turn 1. Omit for a run that answers directly. */
  readonly call?: ToolCallRequest;
  /** What the drain yields, in order, on the first drain. */
  readonly drained: readonly ToolDrainItem[];
  /** Supply a projector, or omit it to exercise the unmapped path. */
  readonly project?: (event: AgentProgressEvent) => RunEvent | null;
  /** Withhold the ledger entirely. */
  readonly noLedger?: boolean;
  /** Called on every context assembly, 1-based. */
  readonly onAssemble?: () => void;
  /** Called the moment the drain generator finishes, pending item or not. */
  readonly onDrainEnd?: () => void;
} = { drained: [] }): Harness {
  const events: RunEvent[] = [];
  const sentMessages: ModelMessage[][] = [];
  const ledger: string[] = [];
  const deferredKeys: string[] = [];
  const pending = [...options.drained];
  let turn = 0;
  let drains = 0;

  const model: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelFrame> {
      turn += 1;
      sentMessages.push([...request.messages]);
      if (turn === 1 && options.call !== undefined) {
        yield { type: 'tool_use', call: options.call };
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
    // The three ports the legacy-still-drives window closed (plan 610 D4, then
    // D1 for `modeExit`), each the smallest honest answer. The DRAIN is this
    // file's subject, so a bound sink or mode exit here would consume items or
    // end the run before the contract under test is reached.
    turnOutput: {
      recordToolResult: () => Promise.resolve(),
      recordAssistantMessage: () => Promise.resolve(),
      finishTurn: () => Promise.resolve(),
      recordInjectedMessage: () => Promise.resolve(),
    },
    compaction: {
      decide: () => Promise.resolve({ kind: 'skip' as const, reason: 'not under test' }),
      run: () => Promise.resolve({ kind: 'declined' as const, reason: 'not under test' }),
      nextCompactionId: () => 'cmp-drain',
    },
    modeExit: { onRunExit: () => Promise.resolve() },
    model,
    tools: {
      dispatch(): void {},
      async *drain(): AsyncIterable<ToolDrainItem> {
        for (const item of pending.splice(0, pending.length)) yield item;
        // The drain runs EVERY turn, so only the first one can answer "was the
        // payload still in flight when this turn's results were handed over".
        if (drains === 0) options.onDrainEnd?.();
        drains += 1;
      },
      discard(): void {},
      describe: (): readonly ToolDescriptor[] => [
        { name: 'Task', description: 'delegate', inputSchema: {} },
      ],
    },
    context: {
      async assemble(): Promise<AssembledTurn> {
        options.onAssemble?.();
        return {
          systemPrompt: 'test',
          messages: [],
          tools: [{ name: 'Task', description: 'delegate', inputSchema: {} }],
          catalogRevision: 'cat-1',
          revision: 'rev-1',
        };
      },
      defer(fragment: TransientContextFragment): void {
        deferredKeys.push(fragment.key);
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
      ...(options.project === undefined
        ? {}
        : { projectSubagentProgress: (event: AgentProgressEvent) => options.project!(event) }),
    } as RunEventStorePort,
    ...(options.noLedger === true
      ? {}
      : {
          sideEffects: {
            async begin(call: ToolCallRequest): Promise<ToolDispatchTicket> {
              ledger.push(`begin:${call.callId}`);
              return {
                attemptKey: `key:${call.callId}`,
                runId: RUN_ID,
                runEpoch: 1,
                fence: { runId: RUN_ID, runEpoch: 1, token: 1 },
              };
            },
            async settle(input): Promise<void> {
              ledger.push(`settle:${input.attemptKey}:${input.state}`);
            },
            async reconcile(): Promise<void> {},
            async read() {
              return [];
            },
          },
        }),
  };

  return {
    ports,
    events,
    sentMessages,
    ledger,
    deferredKeys,
    // Joined from the CONTENT values, not from `JSON.stringify` of the array.
    // Re-encoding escapes every quote, so a search for a stringified object
    // payload would fail against a correct engine -- a test that cannot fail for
    // the right reason is worse than no test.
    modelSawText: () =>
      sentMessages
        .flat()
        .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
        .join('\n'),
    publishedText: () => JSON.stringify(events),
  };
}

async function run(h: Harness): Promise<void> {
  const controller = new AbortController();
  const engine = new RunEngineImpl({ now: () => 1_000 });
  await engine.execute({ manifest: manifest(), input: input(), signal: controller.signal, ports: h.ports })
    .completed();
}

const CALL: ToolCallRequest = {
  callId: 'call-task',
  name: 'Task',
  input: {},
  sideEffect: 'read_only',
};

/** A progress frame whose text is the leak sentinel. */
function progressFrame(callId: string): AgentProgressEvent {
  return { type: 'text', data: PROGRESS_SENTINEL, agentId: 'sub-1', agentName: 'researcher' };
}

// ============================================================================
// The two silent defects
// ============================================================================

describe('a sub-agent progress frame is neither a tool result nor model input', () => {
  it('keeps the frame out of the model payload and out of the ledger, in the same drain that settles a real result', async () => {
    // ONE drain, two items, two sentinels. This is the whole test: the only way
    // to pass is for the engine to discriminate on `kind`.
    const h = harness({
      call: CALL,
      drained: [
        {
          kind: 'subagent_progress',
          callId: 'call-task',
          event: progressFrame('call-task'),
        },
        {
          kind: 'tool_result',
          callId: 'call-task',
          content: RESULT_SENTINEL,
          isError: false,
          durationMs: 4,
        },
      ],
      project: () => ({ type: 'diagnostic', level: 'info', message: 'projected' }) as RunEvent,
    });

    await run(h);

    // (1) NOT model-visible. The sub-agent's internal stream must not be in the
    //     context window; the real result in the SAME drain must be.
    expect(h.modelSawText()).not.toContain(PROGRESS_SENTINEL);
    expect(h.modelSawText()).toContain(RESULT_SENTINEL);

    // (2) NOT a ledger event. Exactly one settle, and it is the key the ledger
    //     itself minted at `begin`. A second settle would be the false row.
    expect(h.ledger).toEqual(['begin:call-task', 'settle:key:call-task:succeeded']);
  });

  it('reaches the host as a published event rather than vanishing', async () => {
    // The host projector is the only thing that can put this frame into the
    // protocol vocabulary, so the frame must be handed to it VERBATIM. The two
    // sides are different objects in the causal chain -- the one the test built
    // and put in the drain, and the one the engine passed on -- so `toBe`
    // measures a real hand-off rather than a value comparison.
    const frame = progressFrame('call-task');
    const seen: AgentProgressEvent[] = [];
    const h = harness({
      call: CALL,
      drained: [{ kind: 'subagent_progress', callId: 'call-task', event: frame }],
      project: (event) => {
        seen.push(event);
        return { type: 'diagnostic', level: 'info', message: 'subagent frame' } as RunEvent;
      },
    });

    await run(h);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(frame);
    expect(h.publishedText()).toContain('subagent frame');
  });

  it('publishes a diagnostic when the host has no projector, so an unmapped frame is counted', async () => {
    // A dropped progress frame is invisible in any test that only checks the
    // model's input. A diagnostic is a failure a consumer can see.
    const h = harness({
      call: CALL,
      drained: [{ kind: 'subagent_progress', callId: 'call-task', event: progressFrame('call-task') }],
    });

    await run(h);

    const diagnostics = h.events.filter((event) => event.type === 'diagnostic');
    expect(diagnostics).toHaveLength(1);
    expect(h.publishedText()).toContain('has no protocol destination');
    // And the frame's type is named, so the gap is diagnosable.
    expect(h.publishedText()).toContain('"text"');
  });

  it('publishes a diagnostic when the projector declines a specific frame', async () => {
    const h = harness({
      call: CALL,
      drained: [{ kind: 'subagent_progress', callId: 'call-task', event: progressFrame('call-task') }],
      project: () => null,
    });

    await run(h);

    expect(h.events.filter((event) => event.type === 'diagnostic')).toHaveLength(1);
  });
});

// ============================================================================
// The deferred context: pending, then resolved on the NEXT turn
// ============================================================================

describe('a deferred tool context is carried pending and resolved by the next turn', () => {
  it('is still unresolved when the drain ends, and reaches the model one turn later', async () => {
    // The two sides of this assertion come from different sources: the promise's
    // OWN settlement, and the drain generator's completion. Neither can produce
    // the other's value.
    let resolveIt: (value: unknown) => void = () => {};
    const pending = new Promise<unknown>((resolve) => {
      resolveIt = resolve;
    });
    let promiseSettled = false;
    void pending.then(
      () => {
        promiseSettled = true;
      },
      () => {
        promiseSettled = true;
      },
    );

    // Resolved from the SECOND assembly, i.e. the turn that is allowed to see
    // it. An engine that awaited inside the drain would deadlock on this and
    // fail on the test timeout -- which is the violation this pins, expressed as
    // a hang rather than as a value comparison.
    let assembleCalls = 0;
    let resolvedDuringDrain: boolean | null = null;

    const h = harness({
      call: CALL,
      drained: [
        { kind: 'tool_result', callId: 'call-task', content: RESULT_SENTINEL, isError: false, durationMs: 1 },
        { kind: 'deferred_context', callId: 'call-task', toolName: 'Task', pending },
      ],
      onAssemble: () => {
        assembleCalls += 1;
        if (assembleCalls === 2) resolveIt(DEFERRED_SENTINEL);
      },
      onDrainEnd: () => {
        resolvedDuringDrain = promiseSettled;
      },
    });

    await run(h);

    // The drain completed with the payload still in flight.
    expect(resolvedDuringDrain).toBe(false);
    // And the next turn carried it, alongside the real result.
    expect(h.modelSawText()).toContain(DEFERRED_SENTINEL);
    expect(h.modelSawText()).toContain(RESULT_SENTINEL);
    // Turn 1's request cannot have carried it: it did not exist yet.
    expect(assembleCalls).toBe(2);
  });

  it('stringifies a non-string payload rather than sending an object', async () => {
    const h = harness({
      call: CALL,
      drained: [
        { kind: 'tool_result', callId: 'call-task', content: RESULT_SENTINEL, isError: false, durationMs: 1 },
        {
          kind: 'deferred_context',
          callId: 'call-task',
          toolName: 'Task',
          pending: Promise.resolve({ verdict: 'looks-right' }),
        },
      ],
    });

    await run(h);

    expect(h.modelSawText()).toContain(JSON.stringify({ verdict: 'looks-right' }));
  });

  it('skips a rejected deferred context instead of failing the turn', async () => {
    const h = harness({
      call: CALL,
      drained: [
        { kind: 'tool_result', callId: 'call-task', content: RESULT_SENTINEL, isError: false, durationMs: 1 },
        {
          kind: 'deferred_context',
          callId: 'call-task',
          toolName: 'Task',
          pending: Promise.reject(new Error('the review never came')),
        },
      ],
    });

    await run(h);

    // The run completed, the real result is still there, and the rejection left
    // no trace in the model's input. The legacy rule at `DuyaAgent.ts:4215`.
    expect(h.modelSawText()).toContain(RESULT_SENTINEL);
    expect(h.modelSawText()).not.toContain('the review never came');
    expect(h.events.filter((event) => event.type === 'diagnostic')).toHaveLength(0);
  });

  it('keeps a deferred context from overwriting a real result for the same call id', async () => {
    // The host's fragment map is keyed, and a shared prefix would make the
    // second `defer` overwrite the first. Both keys must be distinct.
    const h = harness({
      call: CALL,
      drained: [
        { kind: 'tool_result', callId: 'call-task', content: RESULT_SENTINEL, isError: false, durationMs: 1 },
        {
          kind: 'deferred_context',
          callId: 'call-task',
          toolName: 'Task',
          pending: Promise.resolve(DEFERRED_SENTINEL),
        },
      ],
    });

    await run(h);

    expect(h.deferredKeys).toHaveLength(2);
    expect(new Set(h.deferredKeys).size).toBe(2);
    expect(h.modelSawText()).toContain(RESULT_SENTINEL);
    expect(h.modelSawText()).toContain(DEFERRED_SENTINEL);
  });
});

// ============================================================================
// Nothing settles that was never dispatched
// ============================================================================

describe('an errored result settles as failed, and a progress frame settles at all neither way', () => {
  it('records `failed` for an errored result and nothing at all for a frame', async () => {
    const h = harness({
      call: CALL,
      drained: [
        { kind: 'subagent_progress', callId: 'call-task', event: progressFrame('call-task') },
        {
          kind: 'tool_result',
          callId: 'call-task',
          content: '<tool_error>boom</tool_error>',
          isError: true,
          durationMs: 2,
        },
      ],
    });

    await run(h);

    expect(h.ledger).toEqual(['begin:call-task', 'settle:key:call-task:failed']);
  });
});
