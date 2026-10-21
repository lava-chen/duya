/**
 * Plan 587 R2.3 — cancel is bounded and honest, and a budget check happens
 * BEFORE the work it limits.
 *
 * ## Why this file is separate from `run-correctness-seams.test.ts`
 *
 * That file is about the durable barrier: whether a public signal respects
 * storage, and what a run reports when recording fails. Everything here is
 * about the OTHER half of the lifecycle: what happens while a run is still
 * live, when somebody asks it to stop.
 *
 * The distinction matters because the two need different doubles. A cancel test
 * needs an executor whose `stop` can be made to hang, to escalate, or to report
 * nothing at all; injecting a failing persistence into the closed-loop harness
 * would prove the fault injection rather than the cancel.
 *
 * ## What was actually broken when these were written
 *
 *  - `ExecutionHandle.stop` returned `Promise<void>`. The host's
 *    `interruptWorker` is synchronous and fire-and-forget, so the await
 *    resolved before the grace window had even started: a cancel reported
 *    `applied: true` for a worker that was still running, and no caller could
 *    tell a clean stop from a kill.
 *  - `resolveRunOutcome` has always mapped `escalated: true` to `failed` /
 *    `runtime_crash` (`run-outcome.ts:109`), and NOTHING produced
 *    `escalated: true`. The hardkill verdict existed with no producer, so a
 *    hard kill was reported as a cooperative `cancelled` — the clean-cancel
 *    path reported as honoured when it was not.
 *  - `isBudgetExhausted` was only ever consulted inside `settle`, so it decided
 *    the verdict AFTER the fact and never stopped anything. A run with
 *    `maxTurns: 1` would let the second model request leave for the provider
 *    and then record `budget_exhausted` on the way back.
 *
 * ## What these tests do NOT prove
 *
 * They prove the runtime's own bookkeeping, in process, with a scripted
 * executor. They do NOT prove that a real `DuyaAgent` honours a turn ceiling,
 * and they do NOT prove that a real Electron host escalates a real kill — the
 * worker-side gate is `run-cancel-stop-path.test.ts`, and a real process is
 * still open work.
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

/** Returned instead of a value when a promise has NOT settled. */
const PENDING = 'pending' as const;

function tick(ms = 20): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ── persistence ──────────────────────────────────────────────────────────

class RecordingPersistence implements RunPersistence {
  readonly appended: RunEventEnvelope[] = [];
  readonly completed: Array<{ terminal: RunTerminalState; metrics: RunMetrics }> = [];

  async append(envelopes: readonly RunEventEnvelope[]): Promise<void> {
    this.appended.push(...envelopes);
  }

  async complete(terminal: RunTerminalState, metrics: RunMetrics): Promise<void> {
    this.completed.push({ terminal, metrics });
  }

  /** Every durable event of one type, in the order it was written. */
  typesOf(type: string): RunEventEnvelope[] {
    return this.appended.filter((envelope) => envelope.payload.type === type);
  }
}

// ── the executor ─────────────────────────────────────────────────────────

interface StopProbe {
  readonly requests: StopRequest[];
  /** What the executor's `stop` reports. */
  disposition: StopDisposition;
  /** Make `stop` never resolve, to prove the await is bounded. */
  hang: boolean;
  /** Call the sink's `end` from inside `stop` (a cooperative terminal). */
  endOnStop: boolean;
}

function probeExecutor(probe: StopProbe, sinkBox: { end: () => void } | null = null): ExecutionChannel {
  return {
    async start(): Promise<ExecutionHandle> {
      return {
        stop: async (request: StopRequest) => {
          probe.requests.push(request);
          if (probe.hang) return new Promise<never>(() => undefined);
          if (probe.endOnStop) sinkBox?.end();
          return {
            requested: true,
            disposition: probe.disposition,
            waitedMs: 0,
            reason: request.reason,
          };
        },
      };
    },
  };
}

function newProbe(overrides: Partial<StopProbe> = {}): StopProbe {
  return {
    requests: [],
    disposition: 'cooperative',
    hang: false,
    endOnStop: false,
    ...overrides,
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

function buildController(
  channel: ExecutionChannel,
  persistence: RunPersistence,
  options: { cancelGraceMs?: number; stopBoundMs?: number } = {},
): RunController {
  return new RunController({
    channel,
    identity: { name: 'duya-agent-runtime', version: '0.1.0', pid: 4242 },
    protocol: { major: 1, minor: 0 },
    contextFor,
    persistenceFor: () => persistence,
    ...(options.cancelGraceMs === undefined ? {} : { cancelGraceMs: options.cancelGraceMs }),
    ...(options.stopBoundMs === undefined ? {} : { stopBoundMs: options.stopBoundMs }),
  });
}

/**
 * Whether a call has settled, without waiting for it.
 *
 * The bound is the assertion: if `cancel()` is going to hang, the race settles
 * as `PENDING` and the test says so rather than blocking the suite until a
 * timeout.
 */
async function settled<T>(work: Promise<T>): Promise<T | typeof PENDING> {
  return Promise.race([work, tick().then(() => PENDING)]);
}

// ── item 1 + 2: the stop receipt, and escalation as runtime_crash ────────

describe('R2.3 — a cancel reports what the stop actually did', () => {
  it('awaits the stop and reports a cooperative disposition', async () => {
    // `stop` returned `Promise<void>` and the host's interrupt is synchronous, so
    // this await resolved before the grace window opened. The receipt is the
    // only thing a host can read to know whether its stop reached the executor.
    const persistence = new RecordingPersistence();
    const probe = newProbe({ disposition: 'cooperative' });
    const controller = buildController(probeExecutor(probe), persistence, { cancelGraceMs: 20 });

    const handle = await controller.start(buildManifest('run-coop', {}), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-coop', { type: 'turn_start', data: { turnCount: 1 } });

    const outcome = await handle.cancel();

    expect(probe.requests).toHaveLength(1);
    expect(outcome.requested).toBe(true);
    expect(outcome.applied).toBe(true);
    expect(outcome.disposition).toBe('cooperative');
    expect(outcome.terminal.status).toBe('cancelled');
  });

  it('records a hard kill as runtime_crash with the reason it was asked for', async () => {
    // `resolveRunOutcome` has always mapped `escalated: true` to `runtime_crash`
    // (run-outcome.ts:109) and nothing produced it, so a kill that never came
    // back cleanly was reported as the clean cancel it failed to be. The
    // requested reason belongs in the durable receipt: it is the only thing that
    // says WHO asked for the kill.
    const persistence = new RecordingPersistence();
    const probe = newProbe({ disposition: 'escalated' });
    const controller = buildController(probeExecutor(probe), persistence, { cancelGraceMs: 20 });

    const handle = await controller.start(buildManifest('run-kill', {}), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-kill', { type: 'turn_start', data: { turnCount: 1 } });

    const outcome = await handle.cancel('user', { reason: 'user_stop' });

    expect(probe.requests[0]?.reason).toBe('user_stop');
    expect(outcome.disposition).toBe('escalated');
    expect(outcome.terminal.status).toBe('failed');
    if (outcome.terminal.status !== 'failed') throw new Error('expected a failed terminal');
    expect(outcome.terminal.error.code).toBe('runtime_crash');
    expect(outcome.terminal.error.details).toMatchObject({ escalated: true });
    expect(outcome.terminal.error.details).toMatchObject({ requestedReason: 'user_stop' });
  });

  it('returns applied: false for a run that had already finished', async () => {
    // The whole point of `applied` is that a host can tell "I stopped this" from
    // "it was already over". Reporting `true` here would credit the caller with
    // a stop that never touched anything.
    const persistence = new RecordingPersistence();
    const probe = newProbe();
    const controller = buildController(probeExecutor(probe), persistence);

    const handle = await controller.start(buildManifest('run-over', {}), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-over', { type: 'done', data: {} });
    await controller.settle('run-over');

    const outcome = await handle.cancel();

    expect(outcome.requested).toBe(true);
    expect(outcome.applied).toBe(false);
    expect(outcome.terminal.status).toBe('completed');
    expect(probe.requests).toHaveLength(0);
  });

  it('resolves even when the executor never answers the stop', async () => {
    // The failure this prevents: `cancel()` awaiting a handle that never
    // resolves, with the run's terminal decision held behind it. A run whose
    // worker is wedged must still be closable.
    const persistence = new RecordingPersistence();
    const probe = newProbe({ hang: true });
    const controller = buildController(probeExecutor(probe), persistence, {
      cancelGraceMs: 10,
      stopBoundMs: 60,
    });

    const handle = await controller.start(buildManifest('run-hang', {}), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-hang', { type: 'turn_start', data: { turnCount: 1 } });

    // The stop is asked for, and the run does not close while it is unanswered.
    expect(await settled(handle.cancel())).toBe(PENDING);

    // The bound is what releases it, and an unanswered stop is reported as an
    // escalation rather than as a clean stop nobody can vouch for.
    const outcome = await handle.cancel();
    expect(outcome.disposition).toBe('escalated');
    expect(outcome.terminal.status).toBe('failed');
    if (outcome.terminal.status !== 'failed') throw new Error('expected a failed terminal');
    expect(outcome.terminal.error.code).toBe('runtime_crash');
  }, 5000);
});

// ── item 3: the budget check happens before the work, not after ──────────

describe('R2.3 — a budget is checked before the next unit of work starts', () => {
  it('stops the run at maxTurns: 1 rather than only reporting it afterwards', async () => {
    // `isBudgetExhausted` was only called inside `settle`, so it produced a
    // verdict and never a stop. The second model request had already left for
    // the provider by the time anything noticed the ceiling.
    const persistence = new RecordingPersistence();
    const probe = newProbe();
    const controller = buildController(probeExecutor(probe), persistence, { cancelGraceMs: 10 });

    const handle = await controller.start(buildManifest('run-turns', { maxTurns: 1 }), {
      prompt: 'p',
      sessionId: 'session-1',
    });

    // Precondition: the ceiling is real and reachable.
    expect(controller.activeRun('run-turns')?.spend.turns).toBe(0);

    // The first turn starts. That consumes the entire budget.
    controller.observeFrame('run-turns', { type: 'turn_start', data: { turnCount: 1 } });
    const terminal = await handle.terminal;

    // The run stopped ITSELF. A stop that the runtime never asked for means the
    // ceiling is only being recorded, not enforced.
    expect(terminal.status).toBe('budget_exhausted');
    expect(probe.requests.length).toBeGreaterThanOrEqual(1);
    expect(probe.requests[0]?.reason).toBe('budget');
  });

  it('stops the run when a usage report crosses the token ceiling', async () => {
    // Usage is the one budget input that arrives mid-flight, so the check has to
    // run on the report as well as before the operation.
    const persistence = new RecordingPersistence();
    const probe = newProbe();
    const controller = buildController(probeExecutor(probe), persistence, { cancelGraceMs: 10 });

    const handle = await controller.start(buildManifest('run-tokens', { maxTokens: 100 }), {
      prompt: 'p',
      sessionId: 'session-1',
    });

    controller.observeFrame('run-tokens', {
      type: 'token_usage',
      data: { input_tokens: 120, output_tokens: 34, total_tokens: 154 },
    });

    const terminal = await handle.terminal;
    expect(terminal.status).toBe('budget_exhausted');
    expect(probe.requests[0]?.reason).toBe('budget');
  });

  it('stops the run when the wallclock ceiling is reached', async () => {
    // A wallclock ceiling cannot be checked "before the operation" in any
    // useful sense — the only thing that can act on it is a timer. So the
    // runtime arms one, and it is the SAME stop path a user cancel uses.
    const persistence = new RecordingPersistence();
    const probe = newProbe();
    const controller = buildController(probeExecutor(probe), persistence, { cancelGraceMs: 10 });

    const handle = await controller.start(buildManifest('run-wall', { maxWallClockMs: 30 }), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-wall', { type: 'turn_start', data: { turnCount: 1 } });

    const terminal = await handle.terminal;

    expect(terminal.status).toBe('budget_exhausted');
    expect(probe.requests[0]?.reason).toBe('budget');
  }, 5000);

  it('does not stop an executor that has already reported its terminal', async () => {
    // A run that crosses its ceiling and then finishes NORMALLY needs no stop:
    // the executor has already left, and interrupting it now would put a
    // `chat:interrupt` on a worker that has nothing left to interrupt. The
    // VERDICT still moves — `resolveRunOutcome` measures the ceiling at settle.
    //
    // `budgetBreached` rather than a manifest ceiling, because the point is to
    // have the run ALREADY be over budget with nothing sent yet. With a
    // manifest ceiling the earlier `turn_start` would fire the stop first, and
    // this test would be measuring that instead.
    const persistence = new RecordingPersistence();
    const probe = newProbe();
    const controller = new RunController({
      channel: probeExecutor(probe),
      identity: { name: 'duya-agent-runtime', version: '0.1.0', pid: 4242 },
      protocol: { major: 1, minor: 0 },
      contextFor,
      persistenceFor: () => persistence,
      cancelGraceMs: 10,
      budgetBreached: () => true,
    });

    const handle = await controller.start(buildManifest('run-over-done', {}), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-over-done', { type: 'done', data: {} });
    const terminal = await controller.settle('run-over-done');
    await tick(60);

    // Over budget, so the run is reported as such...
    expect(terminal.status).toBe('budget_exhausted');
    // ...but nothing was stopped, because nothing was left to stop.
    expect(probe.requests).toHaveLength(0);
    expect(handle.runId).toBe('run-over-done');
  });

  it('sends exactly one stop when a stop and a terminal land together', async () => {
    // `agent-process-entry` treats a SECOND `chat:interrupt` as "clear the
    // command queue", which is a different behaviour from the first. A budget
    // stop followed by the worker's own terminal is the easy way to send one by
    // accident, and the assertion is on the COUNT, not on the verdict.
    const persistence = new RecordingPersistence();
    const probe = newProbe();
    const controller = buildController(probeExecutor(probe), persistence, { cancelGraceMs: 10 });

    await controller.start(buildManifest('run-one-stop', { maxTurns: 1 }), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-one-stop', { type: 'turn_start', data: { turnCount: 1 } });
    controller.observeFrame('run-one-stop', { type: 'done', data: {} });
    await controller.settle('run-one-stop');
    await tick(60);

    expect(probe.requests).toHaveLength(1);
  });

  it('clears the wallclock timer when the run ends on its own', async () => {
    // A budget timer that outlives its run is a leak that also stops a LATER
    // run's executor, and it is invisible until an unrelated turn mysteriously
    // ends. `liveRuns` is the cheap way to make the leak observable.
    const persistence = new RecordingPersistence();
    const probe = newProbe();
    const controller = buildController(probeExecutor(probe), persistence, { cancelGraceMs: 10 });

    const handle = await controller.start(buildManifest('run-cleanup', { maxWallClockMs: 40 }), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-cleanup', { type: 'done', data: {} });
    // Settled explicitly, the way the router's close backstop does it. Left to
    // the timer, the run would be closed BY the ceiling, and the test would be
    // asserting that the leak it is looking for.
    const terminal = await controller.settle('run-cleanup');

    expect(terminal.status).toBe('completed');

    // Well past the ceiling. If the timer survived, it would have fired a stop
    // against an executor for a run that no longer exists.
    await tick(120);
    expect(probe.requests).toHaveLength(0);
    expect(controller.liveRuns).toBe(0);
  }, 5000);
});

// ── item 4: a kill is not an undo ───────────────────────────────────────

describe('R2.3 — a tool left running is recorded as unknown, never as undone', () => {
  it('completes a dangling tool call as indeterminate before the terminal', async () => {
    // Contract §D: a running tool either completes correctly or is marked
    // unknown, and the side-effect reconciliation is D7. Writing `cancelled`
    // here would be the lie — a cancelled stop tells the reader the tool did
    // not finish, which is not the same as "nobody knows what it did".
    const persistence = new RecordingPersistence();
    const probe = newProbe();
    const controller = buildController(probeExecutor(probe), persistence, { cancelGraceMs: 10 });

    const handle = await controller.start(buildManifest('run-tool', {}), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-tool', { type: 'turn_start', data: { turnCount: 1 } });
    controller.observeFrame('run-tool', {
      type: 'tool_use',
      data: { id: 'call-1', name: 'Write', input: { path: 'a.ts', content: 'x' } },
    });

    await handle.cancel();

    const completions = persistence.typesOf('tool.call_completed');
    expect(completions).toHaveLength(1);
    const payload = completions[0]?.payload as {
      toolCallId: string;
      outcome: { outcome: string; note?: string };
    };
    expect(payload.toolCallId).toBe('call-1');
    expect(payload.outcome.outcome).toBe('indeterminate');
    // The note has to say what is unknown, or `indeterminate` is just a shrug.
    expect(payload.outcome.note).toContain('call-1');

    // And the terminal is a cancellation, not a claim that the write was undone.
    const terminal = persistence.completed.at(-1)?.terminal;
    expect(terminal?.status).toBe('cancelled');
  });

  it('leaves a tool that reported its own result alone', async () => {
    // The synthesis is for DANGLING calls. Inventing a second completion for a
    // call that finished would make the ledger reject the run, and would
    // overwrite a real result with a shrug.
    const persistence = new RecordingPersistence();
    const probe = newProbe();
    const controller = buildController(probeExecutor(probe), persistence, { cancelGraceMs: 10 });

    const handle = await controller.start(buildManifest('run-tool-ok', {}), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-tool-ok', { type: 'turn_start', data: { turnCount: 1 } });
    controller.observeFrame('run-tool-ok', {
      type: 'tool_use',
      data: { id: 'call-1', name: 'Read', input: { path: 'a.ts' } },
    });
    controller.observeFrame('run-tool-ok', {
      type: 'tool_result',
      data: { id: 'call-1', result: 'contents', error: false, duration_ms: 12 },
    });

    await handle.cancel();

    const completions = persistence.typesOf('tool.call_completed');
    expect(completions).toHaveLength(1);
    const payload = completions[0]?.payload as { outcome: { outcome: string } };
    expect(payload.outcome.outcome).toBe('success');
  });
});

// ── item 5: disconnect and cancel are not the same event ─────────────────

describe('R2.3 — the executor ending is not a cancel', () => {
  it('records an executor that simply stopped as a crash, not a cancellation', async () => {
    // Contract §D separates disconnect from cancel, and R2.1 made the
    // difference load-bearing: a run whose executor went quiet with no stop
    // requested has to read as `runtime_crash`, because nothing here asked it
    // to stop and claiming otherwise would hide a real failure.
    const persistence = new RecordingPersistence();
    const probe = newProbe();
    const controller = buildController(
      {
        async start(): Promise<ExecutionHandle> {
          return {
            stop: async (request: StopRequest) => {
              probe.requests.push(request);
              return {
                requested: true,
                disposition: 'cooperative' as StopDisposition,
                waitedMs: 0,
                reason: request.reason,
              };
            },
          };
        },
      },
      persistence,
    );

    const handle = await controller.start(buildManifest('run-silence', {}), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-silence', { type: 'turn_start', data: { turnCount: 1 } });

    // The executor's stream ends on its own. No stop was requested by anyone.
    const terminal = await controller.settle('run-silence');

    expect(terminal.status).toBe('failed');
    if (terminal.status !== 'failed') throw new Error('expected a failed terminal');
    expect(terminal.error.code).toBe('runtime_crash');
    expect(probe.requests).toHaveLength(0);
    // The run is over, so a cancel that arrives now is refused rather than
    // pretending to have stopped something.
    const outcome = await handle.cancel();
    expect(outcome.applied).toBe(false);
  });
});
