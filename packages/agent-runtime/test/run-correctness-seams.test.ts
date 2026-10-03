/**
 * Run-correctness seams — what the run layer REPORTS, not whether it runs.
 *
 * ## Why this is a separate file from `reference-run.test.ts`
 *
 * `reference-run.test.ts` is the happy-path closed loop: a real SQLite
 * Control Plane, a scripted executor, and assertions that the durable log came
 * out right. Every append in that harness succeeds immediately.
 *
 * These tests are the opposite exercise. They need a persistence that HOLDS an
 * append open, one that REFUSES one, and a way to observe whether a public
 * promise has resolved yet. None of that belongs in the closed-loop harness:
 * a gated or failing `RunPersistence` there would turn a proof that the loop
 * works into a proof of the fault injection, and would make the existing
 * assertions depend on barrier timing they have no reason to care about.
 *
 * So: `reference-run.test.ts` answers "does a run get recorded?", and this file
 * answers "does a run tell the truth when recording goes wrong?".
 *
 * ## The contract these lock in
 *
 * `docs/exec-plans/active/587-agent-harness-monorepo/00-contracts.md` §C:
 *
 *   - `result()` 只等待最终结果；不得调用 settle 推动终态.
 *   - 终态只有一个 writer…内存可已决定，但 result/public 完成信号必须遵守
 *     durable barrier。DB 失败返回明确失败/降级 receipt，不伪装 completed。
 *
 * Every test below is written against those two sentences. Each one FAILS on
 * the current code; they are the lock that keeps a fix honest.
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
  RunResult,
  RunTerminalState,
} from '@duya/agent-protocol';
import {
  RunController,
  type ExecutionChannel,
  type ExecutionHandle,
  type RunPersistence,
  type TranslateContext,
} from '@duya/agent-runtime';

/** Returned instead of a status when a public promise has NOT resolved. */
const PENDING = 'pending' as const;

/** Yields to the macrotask queue, so any already-resolved promise has landed. */
function tick(ms = 20): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ── a persistence whose replies the test controls ────────────────────────

type AppendMode = 'pass' | 'hold' | 'fail';

/**
 * Records every durability call and lets the test decide, per call, whether the
 * append is acknowledged immediately, held open, or refused.
 *
 * `hold` is the interesting mode: it is the unacked durable write, and it is
 * the only way to observe whether a public completion signal respects the
 * durable barrier.
 */
class GatedPersistence implements RunPersistence {
  mode: AppendMode = 'pass';
  readonly appended: RunEventEnvelope[][] = [];
  readonly completed: Array<{ terminal: RunTerminalState; metrics: RunMetrics }> = [];
  #releases: Array<() => void> = [];

  async append(envelopes: readonly RunEventEnvelope[]): Promise<void> {
    this.appended.push([...envelopes]);
    if (this.mode === 'fail') {
      throw new Error('durable append refused by storage');
    }
    if (this.mode === 'hold') {
      await new Promise<void>((resolve) => {
        this.#releases.push(resolve);
      });
    }
  }

  async complete(terminal: RunTerminalState, metrics: RunMetrics): Promise<void> {
    this.completed.push({ terminal, metrics });
  }

  holdAppends(): void {
    this.mode = 'hold';
  }

  failAppends(): void {
    this.mode = 'fail';
  }

  /** Acknowledge every held append, and return to acknowledging immediately. */
  releaseAppends(): void {
    this.mode = 'pass';
    for (const release of this.#releases.splice(0)) release();
  }
}

// ── the executor ─────────────────────────────────────────────────────────

interface ExecutorProbe {
  stops: number;
}

/**
 * An executor that stays open and never ends the stream.
 *
 * Deliberately never calls `sink.end()`: the controller wires `end` to settle
 * the run (`controller.ts:228`), so an executor that ended on its own would
 * settle the run before a test could install its barrier, and the test would
 * pass or fail for the wrong reason. Frames are fed in by hand instead, which
 * is also what the real router does.
 */
function openExecutor(probe: ExecutorProbe): ExecutionChannel {
  return {
    async start(): Promise<ExecutionHandle> {
      return {
        stop: async () => {
          probe.stops += 1;
        },
      };
    },
  };
}

// ── the manifest and translation context ─────────────────────────────────

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

// ── shared builders ──────────────────────────────────────────────────────

function buildController(channel: ExecutionChannel, persistence: RunPersistence): RunController {
  return new RunController({
    channel,
    identity: { name: 'duya-agent-runtime', version: '0.1.0', pid: 4242 },
    protocol: { major: 1, minor: 0 },
    contextFor,
    persistenceFor: () => persistence,
  });
}

/**
 * The status a run's PUBLIC completion signal reports, or `PENDING` if it has
 * not reported one.
 *
 * The distinction is the whole point of seam 3: a run may decide in memory
 * early, but the signal a host waits on must not pass the durable barrier, so
 * "still pending" and "reported success" are different observations.
 */
async function publicTerminal(
  handle: Pick<RunHandle, 'terminal'>,
): Promise<RunTerminalState['status'] | typeof PENDING> {
  return Promise.race([handle.terminal.then((state) => state.status), tick().then(() => PENDING)]);
}

// ── seam 1: the manifest budget never reaches the decision ───────────────

describe('seam 1 — the manifest budget reaches the terminal decision', () => {
  it('reaches a budget verdict instead of reporting the run as finished', async () => {
    // `RunControllerOptions` has no `budget` field (controller.ts:66), and
    // `start()` builds the RunSession without one (controller.ts:174-181), so
    // `#budgetVerdict` reads `budget === undefined` and returns false for
    // every run (run-session.ts:284-290). The manifest's ceiling is therefore
    // never measured.
    const persistence = new GatedPersistence();
    const probe: ExecutorProbe = { stops: 0 };
    const runId = 'run-budget-verdict';
    const manifest = buildManifest(runId, { maxTurns: 1 });
    const controller = buildController(openExecutor(probe), persistence);

    await controller.start(manifest, { prompt: 'p', sessionId: 'session-1' });

    // One turn started, executor still live. The run is mid-flight and has
    // spent exactly the one turn its budget allows.
    controller.observeFrame(runId, { type: 'turn_start', data: { turnCount: 1 } });

    const session = controller.activeRun(runId);
    // Preconditions, asserted so the failure below cannot be misread as
    // "the test forgot to set a budget" or "the turn never counted".
    expect(manifest.budget.maxTurns).toBe(1);
    expect(session?.spend.turns).toBe(1);

    const terminal = await controller.settle(runId);

    // The run reached its ceiling. `completed` means the budget was ignored;
    // `failed`/`runtime_crash` means the verdict was never evaluated at all —
    // which is what a missing budget in RunSession produces today.
    expect(terminal.status).toBe('budget_exhausted');
  });

  it('does not report a run it has no record of as completed', async () => {
    // `settle` returns a hardcoded `{ status: 'completed' }` when the run id is
    // unknown (controller.ts:307), and the same fallback sits behind both the
    // in-flight and post-settle returns (controller.ts:311, :327). Settling a
    // run nobody opened is not a success; it is the absence of a run, and a
    // host that counts it as completed inflates its own success metrics.
    const controller = buildController(openExecutor({ stops: 0 }), new GatedPersistence());

    const terminal = await controller.settle('run-that-was-never-opened');

    expect(terminal.status).not.toBe('completed');
  });
});

// ── seam 2: result() is a read, not a settle ────────────────────────────

describe('seam 2 — result() is a read, not a settle', () => {
  it('leaves the run live when result() is read before the executor finishes', async () => {
    // `result()` falls through to `this.settle()` when no terminal has been
    // decided (run-session.ts:255). Reading a result therefore decides the
    // run's fate, closes the session, writes a terminal row, and reports
    // success for an executor that is still working. Contract §C: `result()`
    // only waits; it must never drive the terminal.
    const persistence = new GatedPersistence();
    const probe: ExecutorProbe = { stops: 0 };
    const runId = 'run-result-read';
    const manifest = buildManifest(runId, { maxTurns: 12 });
    const controller = buildController(openExecutor(probe), persistence);

    const handle = await controller.start(manifest, { prompt: 'p', sessionId: 'session-1' });
    controller.observeFrame(runId, { type: 'turn_start', data: { turnCount: 1 } });

    let resolved: RunResult | undefined;
    void handle.result().then((result) => {
      resolved = result;
    });
    await tick();

    // The executor has not finished, so there is no result to report yet.
    expect(resolved).toBeUndefined();
    // …and reading it changed nothing: no decision, no row, no stop.
    expect(controller.activeRun(runId)?.terminal).toBeNull();
    expect(persistence.completed).toHaveLength(0);
    expect(probe.stops).toBe(0);
  });
});

// ── seam 3: the public terminal obeys the durable barrier ────────────────

describe('seam 3 — the public terminal obeys the durable barrier', () => {
  it('does not publish a terminal while the durable append is unacked', async () => {
    // `settle` sets `#terminal` and resolves `#terminalPromise` BEFORE
    // `await this.flush()` and `persistence.complete` (run-session.ts:227-233),
    // so the public signal is answered while the last batch is still in flight.
    // Contract §C allows the in-memory DECISION to be made early, but not the
    // public completion signal to pass the barrier.
    const persistence = new GatedPersistence();
    const runId = 'run-durable-barrier';
    const manifest = buildManifest(runId, { maxTurns: 12 });
    const controller = buildController(openExecutor({ stops: 0 }), persistence);

    // `run.started` must be acknowledged for `start` to return, so the barrier
    // is installed after the run is open.
    const handle = await controller.start(manifest, { prompt: 'p', sessionId: 'session-1' });

    persistence.holdAppends();
    controller.observeFrame(runId, { type: 'done', data: {} });

    let published: RunTerminalState | undefined;
    void handle.terminal.then((state) => {
      published = state;
    });

    // Deliberately not awaited: the settlement cannot finish while the append
    // is held, and that is the state under test.
    const settling = controller.settle(runId);
    try {
      await tick();
      expect(published).toBeUndefined();
      // The terminal row cannot be written before the events it describes.
      expect(persistence.completed).toHaveLength(0);
    } finally {
      persistence.releaseAppends();
      await settling;
    }
  });

  it('does not report success when the durable append fails', async () => {
    // The same ordering, read from the failure side. `#terminal` is set and
    // `#terminalPromise` resolved before the flush throws, so the run has
    // already published `completed` by the time storage refused the write.
    // Contract §C: a DB failure must yield an explicit failure or degraded
    // receipt, and must never be dressed up as `completed`.
    const persistence = new GatedPersistence();
    const runId = 'run-durable-failure';
    const manifest = buildManifest(runId, { maxTurns: 12 });
    const controller = buildController(openExecutor({ stops: 0 }), persistence);

    const handle = await controller.start(manifest, { prompt: 'p', sessionId: 'session-1' });

    persistence.failAppends();
    controller.observeFrame(runId, { type: 'done', data: {} });

    // The settlement is allowed to either resolve with a degraded receipt or
    // reject; both are honest. Silently resolving as success is not.
    const settlement = await controller.settle(runId).then(
      (terminal) => ({ kind: 'settled' as const, status: terminal.status }),
      () => ({ kind: 'rejected' as const, status: PENDING }),
    );

    expect({
      publicSignal: await publicTerminal(handle),
      settlement,
    }).toMatchObject({ publicSignal: expect.not.stringMatching(/^completed$/) });

    // Whatever happened, storage was never told the run completed.
    expect(persistence.completed.map((c) => c.terminal.status)).not.toContain('completed');
  });
});
