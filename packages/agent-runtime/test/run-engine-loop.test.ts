/**
 * The engine's loop, driven by scripted ports.
 *
 * ## What this file asserts, and what it deliberately does not
 *
 * Plan 600 `04-runtime-owns-execution.md` section 0 records that the OLD
 * acceptance gate could be satisfied by wrapping `DuyaAgent.streamChat` in an
 * `ExecutionChannel` while the loop stayed exactly where it was, and that
 * `headless-run-host.ts:26` is that shape in this repository today. So a test
 * that only asserted "the engine can be called" would pass against a port with
 * no implementation, and against an implementation that delegated straight back
 * to the legacy loop.
 *
 * These cases therefore assert the LOOP'S CONTROL FLOW, not its payloads:
 *
 *  - how many times the model was called, and in what order relative to tool
 *    dispatch and result backfill. That is the `model -> tool -> backfill ->
 *    next turn` spine, and it is observable only from the engine.
 *  - that a stop decision is derived from the engine's OWN counters, which
 *    means the test can only move the run's ending by changing the engine's
 *    inputs 鈥?never by telling the engine what to conclude.
 *
 * Every assertion compares two INDEPENDENT sources. The call log is what the
 * scripted ports observed; the expectation is what the loop contract says must
 * have happened. Nothing here compares a measured value against itself.
 */

import { describe, expect, it, vi } from 'vitest';
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
  ToolDescriptor,
  ToolDispatchTicket,
  ToolDrainItem,
  TransientContextFragment,
} from '../src/engine/ports.js';
import type { RunEvent, RunId } from '@duya/agent-protocol';

// ============================================================================
// Scripted ports
//
// Every port records what the ENGINE did to it, so a test can assert the loop
// rather than the payloads it happened to produce.
// ============================================================================

/** One scripted model call. Named so a failure names the turn that broke. */
interface ScriptedTurn {
  readonly frames: readonly ModelFrame[];
  /** Omit the terminal frame to script a stream that dies mid-flight. */
  readonly endsOpen?: boolean;
}

interface Harness {
  readonly ports: RunEnginePorts;
  /** Ordered log of every port interaction, e.g. `model.stream:1`. */
  readonly log: string[];
  /** Tool calls the engine actually dispatched, in order. */
  readonly dispatched: ToolCallRequest[];
  /** Events the engine published, in order. */
  readonly events: RunEvent[];
  /** Terminal candidates the engine proposed. */
  readonly terminals: { state: { status: string }; reason: string }[];
  /** Ledger rows, in the order the ledger was asked to record them. */
  readonly ledger: string[];
  /** Approval asks, in order. */
  readonly approvals: string[];
  /** Fragments handed back to the host. */
  readonly deferred: string[];
  /** Messages the model was actually sent, per turn. */
  readonly sentMessages: ModelMessage[][];
  /** Subtask sweeps, in order, as `reason:includeDetached`. */
  readonly sweeps: string[];
  /** Fences released, in order. */
  readonly released: number[];
  /** Whether `assemble` was called at all before the first model call. */
  assembleCalls(): number;
  /** Queue a result for the next drain, keyed by callId. */
  queueOutcome(item: ToolDrainItem): void;
}

function harness(options: {
  readonly turns: readonly ScriptedTurn[];
  readonly allow?: (call: ToolCallRequest) => ApprovalVerdict;
  readonly budget?: RunEnginePorts['budget'];
  readonly subtasks?: RunEnginePorts['subtasks'];
  readonly sideEffects?: boolean;
  readonly extensionVeto?: boolean;
  readonly manifestOverrides?: Partial<RunManifest>;
  readonly onAssemble?: () => void;
} ): Harness {
  const log: string[] = [];
  const dispatched: ToolCallRequest[] = [];
  const events: RunEvent[] = [];
  const terminals: { state: { status: string }; reason: string }[] = [];
  const ledger: string[] = [];
  const approvals: string[] = [];
  const deferred: string[] = [];
  const sentMessages: ModelMessage[][] = [];
  const sweeps: string[] = [];
  const released: number[] = [];
  const queued: ToolDrainItem[] = [];
  let assembles = 0;
  let turnIndex = 0;

  const model: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelFrame> {
      const turn = turnIndex + 1;
      log.push(`model.stream:${turn}`);
      sentMessages.push([...request.messages]);
      const scripted = options.turns[turnIndex];
      if (scripted === undefined) {
        yield { type: 'turn_stopped', reason: 'end_turn' };
        turnIndex += 1;
        return;
      }
      turnIndex += 1;
      for (const frame of scripted.frames) yield frame;
      if (scripted.endsOpen !== true) yield { type: 'turn_stopped', reason: 'end_turn' };
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
      dispatch(call: ToolCallRequest): void {
        log.push(`tools.dispatch:${call.name}`);
        dispatched.push(call);
        // A dispatched call produces a result, unless the test wants it to hang.
        if (call.name !== 'hang') {
          queued.push({
            // Plan 600 S2 drain contract: `kind` is now required, so a result
            // says it IS one. Deliberate, visible churn -- the alternative is an
            // item with no content satisfying `ToolOutcome` and being settled
            // into the ledger as one.
            kind: 'tool_result',
            callId: call.callId,
            content: `result of ${call.name}`,
            isError: false,
            durationMs: 1,
          });
        }
      },
      async *drain(): AsyncIterable<ToolDrainItem> {
        log.push('tools.drain');
        for (const outcome of queued.splice(0, queued.length)) yield outcome;
      },
      discard(reason: string): void {
        log.push(`tools.discard:${reason}`);
        queued.length = 0;
      },
      describe: (): readonly ToolDescriptor[] => [
        { name: 'write', description: 'write a file', inputSchema: {} },
      ],
    },
    context: {
      async assemble(): Promise<AssembledTurn> {
        assembles += 1;
        log.push('context.assemble');
        options.onAssemble?.();
        return {
          systemPrompt: 'you are a test',
          messages: [],
          tools: [{ name: 'write', description: 'write a file', inputSchema: {} }],
          catalogRevision: 'cat-1',
          revision: 'rev-1',
        };
      },
      defer(fragment: TransientContextFragment): void {
        deferred.push(fragment.key);
      },
    },
    approval: {
      async authorize(request): Promise<ApprovalVerdict> {
        log.push(`approval.authorize:${request.toolName}`);
        approvals.push(request.toolName);
        return options.allow?.(request as unknown as ToolCallRequest) ?? { allowed: true, scope: 'once' };
      },
    },
    events: {
      publish(event: RunEvent): void {
        log.push(`events.publish:${event.type}`);
        events.push(event);
      },
      proposeTerminal(candidate): void {
        log.push('events.proposeTerminal');
        terminals.push({ state: candidate.state as { status: string }, reason: candidate.reason });
      },
    },
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.subtasks === undefined
      ? {}
      : {
          subtasks: {
            register: () => ({ terminate: () => Promise.resolve({ subtaskId: 's', reason: 'completed' as const, outcome: 'killed' as const }) }),
            async terminateAll(reason, rule) {
              sweeps.push(`${reason}:${String(rule.includeDetached)}`);
              log.push(`subtasks.terminateAll:${reason}`);
              return [{ subtaskId: 's1', reason, outcome: 'killed' as const }];
            },
            list: () => ['s1'],
          },
        }),
    ...(options.sideEffects === false
      ? {}
      : {
          sideEffects: {
            async begin(call: ToolCallRequest): Promise<ToolDispatchTicket> {
              log.push(`ledger.begin:${call.name}`);
              ledger.push(`begin:${call.name}`);
              return {
                attemptKey: `key:${call.callId}`,
                runId: 'run-1',
                runEpoch: 1,
                fence: { runId: 'run-1', runEpoch: 1, token: 1 },
              };
            },
            async settle(input): Promise<void> {
              ledger.push(`settle:${input.attemptKey}:${input.state}`);
              log.push(`ledger.settle:${input.attemptKey}:${input.state}`);
            },
            async reconcile(): Promise<void> {},
            async read() {
              return [];
            },
          },
        }),
    ...(options.extensionVeto === true
      ? {
          extensions: {
            list: (phase: string) =>
              phase === 'before_finalize'
                ? [
                    {
                      id: 'veto-1',
                      phase: 'before_finalize' as const,
                      order: 0,
                      timeoutMs: 1000,
                      contribute: async () => [
                        { key: 'veto', content: { veto: true as const, reason: 'keep going' }, binding: true },
                      ],
                    },
                  ]
                : [],
            unload: async () => {},
          },
        }
      : {}),
  };

  return {
    ports,
    log,
    dispatched,
    events,
    terminals,
    ledger,
    approvals,
    deferred,
    sentMessages,
    sweeps,
    released,
    assembleCalls: () => assembles,
    queueOutcome(item: ToolDrainItem): void {
      queued.push(item);
    },
  };
}

const RUN_ID = 'run-1' as RunId;

function manifestFor(overrides: Partial<RunManifest> = {}): RunManifest {
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
    ...overrides,
  } as RunManifest;
}

function inputFor(overrides: Partial<RunInputSnapshot> = {}): RunInputSnapshot {
  return {
    revision: 'rev-1',
    prompt: { role: 'user', id: 'p1', content: 'write a file' },
    history: { kind: 'inline', value: [] },
    attachments: { kind: 'inline', value: [] },
    catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
    steering: [],
    options: {},
    ...overrides,
  } as RunInputSnapshot;
}

/** A clock the test moves by hand, so budget arithmetic is not timing-dependent. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function engineWith(clock: { now: () => number }, maxTurns?: number): RunEngineImpl {
  return new RunEngineImpl({
    now: clock.now,
    ...(maxTurns === undefined ? {} : { defaultMaxTurns: maxTurns }),
  });
}

async function run(
  engine: RunEngineImpl,
  h: Harness,
  options: { signal?: AbortSignal; manifest?: RunManifest } = {},
): Promise<void> {
  const controller = new AbortController();
  const handle = engine.execute({
    manifest: options.manifest ?? manifestFor(),
    input: inputFor(),
    signal: options.signal ?? controller.signal,
    ports: h.ports,
  });
  await handle.completed();
}

// ============================================================================
// Acceptance 1 鈥?the loop exists here and it is the four-step spine
// ============================================================================

describe('the engine owns the model -> tool -> backfill -> next turn loop', () => {
  it('runs model, then dispatch, then backfill, then the next turn 鈥?in that order', async () => {
    const h = harness({
      turns: [
        {
          frames: [
            { type: 'text', text: 'writing' },
            {
              type: 'tool_use',
              call: {
                callId: 'call-1',
                name: 'write',
                input: { file_path: 'a.txt' },
                sideEffect: 'reconcilable',
              },
            },
          ],
        },
        { frames: [{ type: 'text', text: 'done' }] },
      ],
    });
    const clock = fakeClock();

    await run(engineWith(clock), h);

    // The spine, asserted as an ORDER over interactions the ports observed.
    // A delegating facade cannot produce this: it would show one `model.stream`
    // for the whole run and no per-turn drain at all.
    //
    // `turn.started` is published BEFORE its stream opens, and the drain for a
    // turn follows its dispatch 鈥?the two orderings that make the count rules in
    // `run-budget.ts:18-24` true.
    //
    // The three assistant entries are the b3a emissions, and their POSITIONS are
    // the claim: each turn's `assistant.text_block` lands as its stream closes
    // and BEFORE that turn's drain (the OpenAI ordering, `DuyaAgent.ts:2641`),
    // and the single `assistant.message_finalized` lands after the last drain but
    // BEFORE `proposeTerminal`, because the message stops changing strictly
    // before the run ends (`agent-process-entry.ts:3482-3488`). One per run, not
    // one per turn; see `RunEngineImpl.#finalizeLastMessage`.
    //
    // The b4a `assistant.text_delta` entries are in this list for the same
    // reason, and their position is the b4a claim: each one lands BETWEEN its
    // `model.stream` and everything that turn went on to do, which is only
    // possible from inside the loop. The block for that turn still follows the
    // whole spine, so delta and block are both present and the block is last.
    //
    // The b4d `tool.call_completed` entry is here for the same reason, and its
    // POSITION is the specification rather than a side effect: it sits between
    // `ledger.settle` and the next `context.assemble`. That is the four-step
    // order at `#drainOutcomes` -- the durable record of the effect exists
    // before the effect is visible anywhere. Publishing it before the settle
    // would put a durable "it worked" ahead of the ledger row that proves it.
    //
    // `run.completed` is deliberately ABSENT from this list, and its absence is
    // asserted in `engine-publication.test.ts`: the engine proposes a terminal
    // and does not publish one, because publishing it here would make
    // `RunSession.#closeDanglingTools` write a `tool.call_completed` after the
    // run's own terminal.
    expect(h.log).toEqual([
      'context.assemble',
      'events.publish:turn.started',
      'model.stream:1',
      'events.publish:assistant.text_delta',
      'approval.authorize:write',
      'ledger.begin:write',
      'events.publish:tool.call_started',
      'tools.dispatch:write',
      'events.publish:assistant.text_block',
      'tools.drain',
      'ledger.settle:key:call-1:succeeded',
      'events.publish:tool.call_completed',
      'context.assemble',
      'events.publish:turn.started',
      'model.stream:2',
      'events.publish:assistant.text_delta',
      'events.publish:assistant.text_block',
      'tools.drain',
      'events.publish:assistant.message_finalized',
      'events.proposeTerminal',
    ]);
  });

  it('feeds the tool result back to the model on the NEXT turn, not the current one', async () => {
    const h = harness({
      turns: [
        {
          frames: [
            {
              type: 'tool_use',
              call: { callId: 'call-1', name: 'write', input: {}, sideEffect: 'read_only' },
            },
          ],
        },
        { frames: [{ type: 'text', text: 'ok' }] },
      ],
    });
    const clock = fakeClock();

    await run(engineWith(clock), h);

    // Turn 1's request must NOT contain turn 1's own result. The two sides are
    // independent: `sentMessages` is what the model port received, and the
    // expectation is what the backfill contract requires.
    const [turnOne, turnTwo] = h.sentMessages;
    expect(turnOne!.map((m) => m.id)).toEqual(['p1']);
    expect(turnTwo!.map((m) => m.id)).toEqual(['fragment:tool_result:call-1']);

    // And the host was told to defer it, once.
    expect(h.deferred).toEqual(['tool_result:call-1']);
  });

  it('appends the prompt on the first turn only', async () => {
    const h = harness({
      turns: [
        {
          frames: [
            {
              type: 'tool_use',
              call: { callId: 'c1', name: 'write', input: {}, sideEffect: 'read_only' },
            },
          ],
        },
        { frames: [{ type: 'text', text: 'ok' }] },
      ],
    });
    const clock = fakeClock();

    await run(engineWith(clock), h);

    // A prompt re-sent every turn is how a conversation teaches a model to
    // repeat itself, so the count is pinned rather than the contents.
    const promptOccurrences = h.sentMessages.flatMap((messages) =>
      messages.filter((m) => m.id === 'p1'),
    );
    expect(promptOccurrences).toHaveLength(1);
  });

  it('reports a CANDIDATE terminal and never settles one', async () => {
    const h = harness({ turns: [{ frames: [{ type: 'text', text: 'hi' }] }] });
    const clock = fakeClock();

    await run(engineWith(clock), h);

    // The engine's whole terminal surface. A `settle` here would be a second
    // writer, which `run-session.ts:519,527` already is.
    expect(h.log.filter((entry) => entry.includes('Terminal') || entry.includes('settle'))).toEqual([
      'events.proposeTerminal',
    ]);
    expect(h.terminals).toHaveLength(1);
    expect(h.terminals[0]!.state).toEqual({ status: 'completed' });
  });
});

// ============================================================================
// Acceptance 2 鈥?budget is decided INSIDE the engine
// ============================================================================

describe('the engine enforces the budget', () => {
  it('stops before a model call the budget already forbade', async () => {
    // maxTurns: 1, and the model asks for a tool 鈥?so the run NEEDS a second
    // turn to finish. The engine must refuse to open it.
    const h = harness({
      turns: [
        {
          frames: [
            {
              type: 'tool_use',
              call: { callId: 'c1', name: 'write', input: {}, sideEffect: 'read_only' },
            },
          ],
        },
        { frames: [{ type: 'text', text: 'never reached' }] },
      ],
      budget: {
        budget: { maxTurns: 1 },
        spend: () => ({ turns: 0, toolCalls: 0, tokens: 0 }),
        evaluate: () => ({ exhausted: false, breaches: [] }),
      },
    });
    const clock = fakeClock();

    await run(engineWith(clock), h, { manifest: manifestFor({ budget: { maxTurns: 1 } }) });

    // One model call, not two. The `portGuards`-level claim "the budget port is
    // consulted" would pass on a run that made two calls and merely asked; this
    // pins the EFFECT.
    expect(h.log.filter((entry) => entry.startsWith('model.stream'))).toEqual(['model.stream:1']);
    // And the queued work was dropped rather than left to fire.
    expect(h.log).toContain('tools.discard:budget_exhausted');
  });

  it('a ceiling is the engine\'s own count, not a number the host handed it', async () => {
    const h = harness({
      turns: [
        {
          frames: [
            {
              type: 'tool_use',
              call: { callId: 'c1', name: 'write', input: {}, sideEffect: 'read_only' },
            },
          ],
        },
        { frames: [{ type: 'text', text: 'ok' }] },
      ],
    });
    const clock = fakeClock();

    // The manifest names NO ceiling, so the engine's own default is the only
    // limit. Two turns complete, and the third is refused.
    await run(engineWith(clock, 2), h);

    expect(h.log.filter((e) => e.startsWith('model.stream'))).toEqual([
      'model.stream:1',
      'model.stream:2',
    ]);
    expect(h.terminals[0]!.reason).toContain('ceiling');
  });

  it('counts a turn that started even when its model stream produced nothing', async () => {
    // `run-budget.ts:20` counts `turn.started`, not `turn.completed`, because a
    // turn that died mid-flight still consumed budget. The engine publishes
    // `turn.started` BEFORE opening the stream, so the count survives the death.
    const h = harness({ turns: [{ frames: [], endsOpen: true }] });
    const clock = fakeClock();

    await run(engineWith(clock), h);

    const turnStartedIndex = h.log.indexOf('events.publish:turn.started');
    const streamIndex = h.log.indexOf('model.stream:1');
    expect(turnStartedIndex).toBeGreaterThanOrEqual(0);
    expect(turnStartedIndex).toBeLessThan(streamIndex);
    expect(h.terminals[0]!.state).toEqual({
      status: 'failed',
      error: expect.objectContaining({ message: expect.stringContaining('no frames') }),
    });
  });
});

// ============================================================================
// Acceptance 3 鈥?cancellation propagates INTO the engine
// ============================================================================

describe('cancellation reaches the engine', () => {
  it('a caller abort stops the run before the next turn opens', async () => {
    const controller = new AbortController();
    let openedTurns = 0;
    const h = harness({
      turns: [
        {
          frames: [
            {
              type: 'tool_use',
              call: { callId: 'c1', name: 'write', input: {}, sideEffect: 'read_only' },
            },
          ],
        },
        { frames: [{ type: 'text', text: 'never' }] },
      ],
    });
    const clock = fakeClock();

    // Abort DURING the first turn's stream, which is the only way to prove the
    // signal reaches the loop rather than being read once at the start.
    const originalStream = h.ports.model.stream;
    const spy = vi.fn(async function* (request: ModelRequest, signal: AbortSignal) {
      openedTurns += 1;
      if (openedTurns === 1) controller.abort(new Error('user cancelled'));
      yield* originalStream.call(h.ports.model, request, signal);
    });
    h.ports.model.stream = spy as ModelPort['stream'];

    await run(engineWith(clock), h, { signal: controller.signal });

    expect(openedTurns).toBe(1);
    expect(h.terminals[0]!.state).toEqual({ status: 'cancelled' });
    expect(h.log).toContain('tools.discard:abandoned');
  });

  it('a caller abort reaches the signal every port was handed', async () => {
    const controller = new AbortController();
    /** Signals the PORTS received, observed from inside the port itself. */
    const portSignals: AbortSignal[] = [];
    const h = harness({ turns: [{ frames: [{ type: 'text', text: 'hi' }] }] });
    const clock = fakeClock();

    // The stream parks until the signal aborts, so the abort provably lands
    // while the run is LIVE. The engine detaches its abort listener once the run
    // settles 鈥?correct, since a listener outliving its run is the leak 鈥?so an
    // abort issued afterwards would prove nothing about propagation.
    h.ports.model.stream = (async function* (_request: ModelRequest, signal: AbortSignal) {
      portSignals.push(signal);
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'turn_stopped', reason: 'cancelled' as const };
    }) as ModelPort['stream'];

    const handle = engineWith(clock).execute({
      manifest: manifestFor(),
      input: inputFor(),
      signal: controller.signal,
      ports: h.ports,
    });
    // Give the stream a turn of the event loop to register its listener.
    await Promise.resolve();
    controller.abort(new Error('caller stopped the run'));
    await handle.completed();

    expect(portSignals).toHaveLength(1);
    // The port's signal is deliberately NOT the caller's object 鈥?a port cannot
    // abort a signal it was given, so the engine owns one controller and
    // forwards the caller's abort into it. Asserting identity would pin an
    // implementation detail and would forbid the engine from honouring its own
    // `handle.stop`. What must hold is PROPAGATION, asserted next.
    expect(portSignals[0]).not.toBe(controller.signal);

    // The propagation itself: the signal the model port received aborted when
    // the caller's did. Two independent observations 鈥?the caller's own state,
    // and the state observed inside the port.
    expect(controller.signal.aborted).toBe(true);
    expect(portSignals[0]!.aborted).toBe(true);
  });

  it('a stop after the run ended reports that it reached no live run', async () => {
    const h = harness({ turns: [{ frames: [{ type: 'text', text: 'hi' }] }] });
    const clock = fakeClock();
    const controller = new AbortController();
    const engine = engineWith(clock);

    const handle = engine.execute({
      manifest: manifestFor(),
      input: inputFor(),
      signal: controller.signal,
      ports: h.ports,
    });
    await handle.completed();
    const receipt = await handle.stop({ graceMs: 0, reason: 'too late' });

    // Claiming `cooperative` here would report a clean stop for a run that had
    // already finished on its own.
    expect(receipt.requested).toBe(false);
    expect(receipt.disposition).toBe('unavailable');
  });

  it('a stop on a live run is reported as applied', async () => {
    const h = harness({
      turns: [
        {
          frames: [
            {
              type: 'tool_use',
              call: { callId: 'c1', name: 'hang', input: {}, sideEffect: 'read_only' },
            },
          ],
        },
      ],
    });
    const clock = fakeClock();
    const engine = engineWith(clock);
    const controller = new AbortController();

    const handle = engine.execute({
      manifest: manifestFor(),
      input: inputFor(),
      signal: controller.signal,
      ports: h.ports,
    });
    // Stop while the run is between turns.
    const stopping = handle.stop({ graceMs: 50, reason: 'user pressed stop' });
    await stopping;

    expect((await stopping).requested).toBe(true);
    expect((await stopping).disposition).toBe('cooperative');
    await handle.completed();
  });
});

// ============================================================================
// Acceptance 4 鈥?subtask reclamation is the engine's
// ============================================================================

describe('the engine reclaims subtasks', () => {
  it('records the reason the run ACTUALLY ended, per exit', async () => {
    const build = (frames: ModelFrame[], extra: { sideEffects?: boolean } = {}) => {
      const h = harness({
        turns: [{ frames }],
        ...(extra.sideEffects === undefined ? {} : { sideEffects: extra.sideEffects }),
      });
      const subtasks = {
        register: () => ({
          terminate: () =>
            Promise.resolve({ subtaskId: 's', reason: 'completed' as const, outcome: 'killed' as const }),
        }),
        async terminateAll(reason: never, rule: { includeDetached: boolean }) {
          h.sweeps.push(`${reason}:${String(rule.includeDetached)}`);
          return [{ subtaskId: 's1', reason, outcome: 'killed' as const }];
        },
        list: () => ['s1'],
      };
      (h.ports as { subtasks?: unknown }).subtasks = subtasks;
      return h;
    };
    const clock = fakeClock();

    // (a) completed -> `completed`, detached INCLUDED=false
    const done = build([{ type: 'text', text: 'hi' }]);
    await run(engineWith(clock), done);
    expect(done.sweeps).toEqual(['completed:false']);

    // (b) a fatal model frame -> `parent_failure`, detached INCLUDED=true.
    //     Two INDEPENDENT sources: the reason string and the rule, both
    //     observed by the registry the engine called.
    const failed = build([{ type: 'error', message: 'provider died', code: 'x', retryable: false }]);
    await run(engineWith(clock), failed);
    expect(failed.sweeps).toEqual(['parent_failure:true']);

    // (c) a detached subtask is not swept on a cancel: a user who started a
    //     background job and then stopped the chat did not ask for it to die.
    const cancelled = build([{ type: 'turn_stopped', reason: 'cancelled' }]);
    await run(engineWith(clock), cancelled);
    expect(cancelled.sweeps).toEqual(['parent_cancel:false']);
  });

  it('sweeps even when the run threw, and does not let the sweep replace the terminal', async () => {
    const h = harness({ turns: [{ frames: [{ type: 'text', text: 'hi' }] }] });
    h.ports.context.assemble = () => {
      throw new Error('assemble exploded');
    };
    const subtasks = {
      register: () => ({
        terminate: () => Promise.resolve({ subtaskId: 's', reason: 'completed' as const, outcome: 'killed' as const }),
      }),
      async terminateAll(reason: never, rule: { includeDetached: boolean }) {
        h.sweeps.push(`${reason}:${String(rule.includeDetached)}`);
        throw new Error('the sweep itself failed');
      },
      list: () => ['s1'],
    };
    (h.ports as { subtasks?: unknown }).subtasks = subtasks;
    const clock = fakeClock();

    await run(engineWith(clock), h);

    // A throwing sweep must not destroy the real terminal: a rejection here
    // would replace a failure with a synthetic one.
    expect(h.sweeps).toEqual(['parent_failure:true']);
    expect(h.terminals).toHaveLength(1);
    expect(h.terminals[0]!.reason).toBe('the run failed');
  });
});

// ============================================================================
// Side-effect ledger ordering (contract 4)
// ============================================================================

describe('a dispatch is unreachable without a ledger ticket', () => {
  it('takes the ticket BEFORE dispatching, and settles it after', async () => {
    const h = harness({
      turns: [
        {
          frames: [
            {
              type: 'tool_use',
              call: { callId: 'call-9', name: 'write', input: {}, sideEffect: 'non_retryable' },
            },
          ],
        },
        { frames: [{ type: 'text', text: 'ok' }] },
      ],
    });
    const clock = fakeClock();

    await run(engineWith(clock), h);

    // The order is the contract. `begin` after `dispatch` would leave a process
    // that died mid-call with an effect nobody recorded.
    const beginIndex = h.log.indexOf('ledger.begin:write');
    const dispatchIndex = h.log.indexOf('tools.dispatch:write');
    const settleIndex = h.log.indexOf('ledger.settle:key:call-9:succeeded');
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(beginIndex).toBeLessThan(dispatchIndex);
    expect(dispatchIndex).toBeLessThan(settleIndex);
    expect(h.ledger).toEqual(['begin:write', 'settle:key:call-9:succeeded']);
  });

  it('asks for approval BEFORE taking a durable ticket for the call', async () => {
    const h = harness({
      turns: [
        {
          frames: [
            {
              type: 'tool_use',
              call: { callId: 'c1', name: 'write', input: {}, sideEffect: 'reconcilable' },
            },
          ],
        },
        { frames: [{ type: 'text', text: 'ok' }] },
      ],
    });
    const clock = fakeClock();

    await run(engineWith(clock), h);

    // A `planned` row for a call that is then denied describes a call that will
    // never exist.
    expect(h.log.indexOf('approval.authorize:write')).toBeLessThan(h.log.indexOf('ledger.begin:write'));
  });

  it('a denied call is never dispatched and takes no ticket', async () => {
    const h = harness({
      turns: [
        {
          frames: [
            {
              type: 'tool_use',
              call: { callId: 'c1', name: 'write', input: {}, sideEffect: 'reconcilable' },
            },
          ],
        },
        { frames: [{ type: 'text', text: 'ok' }] },
      ],
      allow: () => ({ allowed: false, reason: 'denied' }),
    });
    const clock = fakeClock();

    await run(engineWith(clock), h);

    expect(h.dispatched).toEqual([]);
    expect(h.ledger).toEqual([]);
    // And the refusal is REPORTED, not dropped: a broken bridge must not read
    // as a run that simply had no tools.
    expect(h.events.map((e) => e.type)).toContain('tool.timed_out');
  });

  it('refuses a side-effecting call when no ledger is attached', async () => {
    const h = harness({
      turns: [
        {
          frames: [
            {
              type: 'tool_use',
              call: { callId: 'c1', name: 'write', input: {}, sideEffect: 'non_retryable' },
            },
          ],
        },
      ],
      sideEffects: false,
    });
    const clock = fakeClock();

    await run(engineWith(clock), h);

    // `ports.ts`: an absent ledger means "no tool with a side effect may be
    // dispatched", NOT "assume none exist". The run fails rather than making an
    // effect no crash could classify.
    expect(h.dispatched).toEqual([]);
    expect(h.terminals[0]!.reason).toBe('the run failed');
  });
});

// ============================================================================
// Extension rules
// ============================================================================

describe('a binding veto reopens the turn without taking the loop over', () => {
  it('runs another turn after a veto, and the ceiling still wins', async () => {
    const h = harness({
      turns: [{ frames: [{ type: 'text', text: 'a' }] }, { frames: [{ type: 'text', text: 'b' }] }],
      extensionVeto: true,
    });
    const clock = fakeClock();

    await run(engineWith(clock, 2), h);

    // The veto stopped `shouldStop` from returning `completed`, so the loop
    // went round again 鈥?and the CEILING, which is not negotiable, ended it.
    expect(h.log.filter((e) => e.startsWith('model.stream'))).toEqual([
      'model.stream:1',
      'model.stream:2',
    ]);
    expect(h.terminals[0]!.reason).toContain('ceiling');
  });
});

// ============================================================================
// Anti-vacuity: the engine is not a facade over the legacy loop
// ============================================================================

describe('the engine is an implementation, not a delegating port', () => {
  it('drives N turns from a N-turn script without any host loop', async () => {
    // A facade that called `duyaAgent.streamChat` once would show ONE
    // `model.stream` and no per-turn `context.assemble`. The counts below are
    // the discriminator, and they come from the ports' own observations.
    const turnCount = 4;
    const h = harness({
      turns: Array.from({ length: turnCount }, (_unused, index) => ({
        frames: [
          {
            type: 'tool_use' as const,
            call: { callId: `c${index}`, name: 'write', input: {}, sideEffect: 'read_only' as const },
          },
        ],
      })),
    });
    const clock = fakeClock();

    await run(engineWith(clock, turnCount), h);

    const streams = h.log.filter((e) => e.startsWith('model.stream'));
    const assembles = h.log.filter((e) => e === 'context.assemble');
    const drains = h.log.filter((e) => e === 'tools.drain');
    expect(streams).toHaveLength(turnCount);
    expect(assembles).toHaveLength(turnCount);
    expect(drains.length).toBeGreaterThanOrEqual(turnCount);
    expect(h.dispatched.map((c) => c.callId)).toEqual(['c0', 'c1', 'c2', 'c3']);
  });

  it('never mints a seq: the event store takes whole events with no seq field', async () => {
    const h = harness({ turns: [{ frames: [{ type: 'text', text: 'hi' }] }] });
    const clock = fakeClock();

    await run(engineWith(clock), h);

    // Every published event must lack `seq`, checked against the OBJECT the
    // engine handed over rather than against a re-derivation of it.
    for (const event of h.events) {
      expect(Object.prototype.hasOwnProperty.call(event, 'seq')).toBe(false);
    }
    // And the store's own surface offers no allocator to call.
    const storeKeys = Object.keys(h.ports.events).sort();
    expect(storeKeys).toEqual(['proposeTerminal', 'publish']);
  });
});
