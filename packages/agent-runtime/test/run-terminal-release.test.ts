/**
 * The terminal RELEASE is wired into the one place that owns the barrier.
 *
 * ## Why this file is separate from `event-emitter-terminal-backpressure.test.ts`
 *
 * That file proves the emitter's DECISION: hold, then publish-or-discard. This
 * file proves the WIRING — that `RunController.settle` actually calls the
 * release, that it calls it AFTER the durable barrier answered, and that it
 * calls it BEFORE the stream closes. A correct emitter that nothing calls is
 * the same as no emitter at all, and the ordering is the part that is easy to
 * get wrong in a way no unit test on the emitter can see.
 *
 * The orderings that matter, and what each one costs when it is wrong:
 *
 *  - **release before the barrier** announces an ending storage has not
 *    accepted — a run that reports success it never reached;
 *  - **close before the release** drops the frame entirely, because
 *    `RunEventStream.push` is a no-op once closed, and a run that ends without
 *    anyone being told is the same hole wearing the opposite hat;
 *  - **no release at all** leaves a run whose ending exists in storage and in
 *    nobody's view.
 *
 * ## The two sides of every assertion
 *
 * The ANNOUNCED side is what a consumer iterating `handle.events()` received.
 * The RECORDED side is what persistence was handed. They are read separately
 * throughout, because "recorded" and "announced" are the two facts this change
 * is about keeping apart, and an assertion that compared one to the other
 * would be meaningless.
 */

import { describe, expect, it } from 'vitest';
import type {
  ConnectorBinding,
  PermissionPolicyMode,
  RunBudget,
  RunEventEnvelope,
  RunHandle,
  RunManifest,
  RunMetrics,
  RunTerminalState,
  StopDisposition,
} from '@duya/agent-protocol';
import {
  RunController,
  type ExecutionChannel,
  type ExecutionHandle,
  type RunPersistence,
  type StopRequest,
  type TranslateContext,
} from '@duya/agent-runtime';

function tick(ms = 20): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * A persistence whose `complete` the test holds shut.
 *
 * The gate is what makes "announced after the barrier" observable: while it is
 * closed, `settle` has not returned, so anything on the stream was announced
 * without the barrier's answer.
 */
class GatedPersistence implements RunPersistence {
  readonly appended: RunEventEnvelope[] = [];
  readonly completed: RunTerminalState[] = [];
  #open = false;
  #release = (): void => {};
  readonly #gate = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  async append(envelopes: readonly RunEventEnvelope[]): Promise<void> {
    this.appended.push(...envelopes);
  }

  async complete(terminal: RunTerminalState, _metrics: RunMetrics): Promise<void> {
    await this.#gate;
    this.completed.push(terminal);
  }

  /** Let `complete` answer. */
  open(): void {
    this.#open = true;
    this.#release();
  }

  get barrierAnswered(): boolean {
    return this.#open;
  }
}

function probeExecutor(): ExecutionChannel {
  return {
    async start(): Promise<ExecutionHandle> {
      return {
        stop: async (request: StopRequest) => ({
          requested: true,
          disposition: 'cooperative' as StopDisposition,
          waitedMs: 0,
          reason: request.reason,
        }),
      };
    },
  };
}

function buildManifest(runId: string, budget: RunBudget): RunManifest {
  const permissionPolicy = {
    mode: 'default' as PermissionPolicyMode,
    hostSwitch: 'ask' as const,
    defaultTimeoutMs: 300_000,
  };
  const connectorBindings: readonly ConnectorBinding[] = [];
  return {
    version: 1,
    runId,
    projectId: null,
    workspaceId: 'ws-1',
    roots: ['/tmp/workspace'],
    cwd: '/tmp/workspace',
    permissionPolicy,
    capabilities: { profiles: [], modes: ['general'], tools: ['Read'] },
    connectorBindings,
    env: { ref: 'env:session-1', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
    budget,
    deterministic: false,
  };
}

function contextFor(): TranslateContext {
  return {
    messageId: 'msg-1',
    permission: {
      classify: () => 'tool_use',
      mode: 'generic',
      expiresInMs: 300_000,
      now: () => Date.now(),
    },
    nextTurn: (() => {
      let n = 0;
      return () => {
        n += 1;
        return { turnId: `turn-${n}`, index: n };
      };
    })(),
    model: { model: 'test-model', providerId: 'test-provider', apiFormat: 'anthropic' },
  };
}

function buildController(persistence: RunPersistence): RunController {
  return new RunController({
    channel: probeExecutor(),
    identity: { name: 'duya-agent-runtime', version: '0.1.0', pid: 4242 },
    protocol: { major: 1, minor: 0 },
    contextFor,
    persistenceFor: () => persistence,
    cancelGraceMs: 10,
  });
}

/** Everything a consumer iterating the run's event source received. */
async function collect(handle: RunHandle, sink: RunEventEnvelope[]): Promise<void> {
  for await (const envelope of handle.events()) {
    sink.push(envelope as RunEventEnvelope);
  }
}

const terminalOf = (seen: readonly RunEventEnvelope[]): RunEventEnvelope[] =>
  seen.filter((e) => e.payload.type === 'run.completed' || e.payload.type === 'run.failed');

describe('the run announces its ending only after the durable barrier answers', () => {
  it('holds the terminal while the barrier is shut, then releases it once', async () => {
    const persistence = new GatedPersistence();
    const controller = buildController(persistence);
    const handle = await controller.start(buildManifest('run-gate', {}), {
      prompt: 'p',
      sessionId: 'session-1',
    });

    // The consumer is attached from the start, so "not announced yet" is a fact
    // about what it received rather than about a stream nobody was reading.
    const seen: RunEventEnvelope[] = [];
    const draining = collect(handle, seen);

    controller.observeFrame('run-gate', { type: 'done', data: {} });

    // The barrier is shut. The run has decided and the ledger has the event, but
    // `settle` has not returned, so nothing may be announced.
    const settling = controller.settle('run-gate');
    await tick(40);

    // ANNOUNCED: nothing yet.
    expect(terminalOf(seen)).toHaveLength(0);
    // RECORDED: the terminal event is already durable, which is exactly why the
    // announcement — not the persistence — is what has to wait.
    expect(persistence.appended.some((e) => e.payload.type === 'run.completed')).toBe(true);
    // And the barrier genuinely has not answered, read from persistence itself
    // rather than inferred from the absence above.
    expect(persistence.barrierAnswered).toBe(false);

    persistence.open();
    const terminal = await settling;
    await draining;

    // The barrier's answer, from persistence.
    expect(persistence.completed).toHaveLength(1);
    expect(persistence.completed[0]?.status).toBe('completed');
    expect(terminal.status).toBe('completed');

    // ANNOUNCED: exactly one terminal, and it reached a reader.
    expect(terminalOf(seen)).toHaveLength(1);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('announces the terminal exactly once when the run is settled twice', async () => {
    const persistence = new GatedPersistence();
    const controller = buildController(persistence);
    const handle = await controller.start(buildManifest('run-twice', {}), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    const seen: RunEventEnvelope[] = [];
    const draining = collect(handle, seen);

    controller.observeFrame('run-twice', { type: 'done', data: {} });
    const settling = controller.settle('run-twice');
    persistence.open();
    await settling;
    // A second settle is the shape a retry, a `close` backstop, or a budget
    // stop colliding with the run's own terminal produces.
    const again = await controller.settle('run-twice');
    await draining;

    expect(again.status).toBe('completed');
    // The count is the assertion, not the verdict: two terminals on one run is
    // a consumer that closes the UI twice and a ledger with two endings.
    expect(terminalOf(seen)).toHaveLength(1);
  });

  it('a run whose tool never answered still releases its terminal exactly once', async () => {
    // The case the hold was untested for, and the one the ordering in
    // `RunSession.observe` exists to keep possible: the run declared its ending
    // while a tool call was still open. A terminal minted first used to make
    // that close impossible, the throw escaped `settle`, and this release never
    // ran at all.
    const persistence = new GatedPersistence();
    const controller = buildController(persistence);
    const handle = await controller.start(buildManifest('run-dangling', {}), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    const seen: RunEventEnvelope[] = [];
    const draining = collect(handle, seen);

    controller.observeFrame('run-dangling', { type: 'turn_start', data: { turnCount: 1 } });
    controller.observeFrame('run-dangling', {
      type: 'tool_use',
      data: { id: 'call-dangling', name: 'Read', input: { path: 'a.txt' } },
    });
    // The ending, from the same producer every run's terminal comes from.
    controller.observeFrame('run-dangling', { type: 'done', data: {} });

    const settling = controller.settle('run-dangling');
    await tick(40);
    // The barrier is shut, so the terminal is held rather than announced. Read
    // from what the consumer received, which is the side the hold governs.
    expect(terminalOf(seen)).toHaveLength(0);

    persistence.open();
    const terminal = await settling;
    await draining;

    expect(terminal.status).toBe('completed');
    // Exactly one ending announced, and the barrier answered with the same
    // verdict the run declared -- otherwise this would be a discard.
    expect(terminalOf(seen)).toHaveLength(1);
    expect(persistence.completed).toHaveLength(1);
    expect(persistence.completed[0]?.status).toBe('completed');

    // RECORDED, and in this order: the unanswered call was closed at a seq
    // BELOW the terminal, so the durable log never says the run ended while a
    // question of its own was still open.
    const closes = persistence.appended.filter((e) => e.payload.type === 'tool.call_completed');
    const declared = persistence.appended.find((e) => e.payload.type === 'run.completed');
    expect(closes).toHaveLength(1);
    expect(declared).toBeDefined();
    expect(closes[0]?.seq ?? Number.MAX_SAFE_INTEGER).toBeLessThan(declared?.seq ?? 0);
    if (closes[0]?.payload.type !== 'tool.call_completed') throw new Error('expected a close');
    expect(closes[0].payload.outcome.outcome).toBe('indeterminate');
  });

  it('a lifecycle violation does not push the terminal a second time by hand', async () => {
    const persistence = new GatedPersistence();
    const controller = buildController(persistence);
    const handle = await controller.start(buildManifest('run-violation', {}), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    const seen: RunEventEnvelope[] = [];
    const draining = collect(handle, seen);

    // A tool result for a call that never started: the ledger's lifecycle
    // invariant, which is what drives `#onLifecycleViolation`.
    persistence.open();
    controller.observeFrame('run-violation', {
      type: 'tool_result',
      data: { toolUseId: 'never-started', content: 'x' },
    } as never);
    await tick(60);
    await draining;

    // The emitter's own push plus a manual one is what used to reach the stream
    // twice, because `RunEventStream` has no seq dedupe — so the exact list,
    // not just the count of terminals, is the assertion. Measured on the fixed
    // tree: seq 1 `run.started`, seq 2 `run.failed`, and nothing else.
    expect(seen.map((e) => ({ seq: e.seq, type: e.payload.type }))).toEqual([
      { seq: 1, type: 'run.started' },
      { seq: 2, type: 'run.failed' },
    ]);
  });
});
