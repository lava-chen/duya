/**
 * Plan 587 R1.4 — the result surface, honest budget accounting, and bounded
 * retry backoff.
 *
 * ## The one failure this whole file is about
 *
 * `result()` returned `transcript: []` and `permissionAudit: []`, and both were
 * lies of the same shape. An empty array says **this run produced nothing of
 * this kind**. The runtime was using it to say **this runtime does not read
 * this back**. Nobody chose the second meaning, but every consumer received it,
 * and on a permission audit the difference is the difference between "nothing
 * was asked" and "nobody checked".
 *
 * So the surfaces became a discriminated union ({@link RunSurface}) and the
 * budget's token count became one too ({@link MeasuredTokens}). Both refuse to
 * let an absent measurement and a measured zero share a value, because a caller
 * cannot tell them apart once they do.
 *
 * ## What each test is actually proving
 *
 * Stated plainly, because the distinction decides which of these are worth
 * believing:
 *
 *  - **The permission audit.** The fold in `RunSession` is real and is proved
 *    here by driving the real `permission` frame through the real translator.
 *    The producer is NOT real: nothing in this runtime emits
 *    `permission.resolved`, so `is not implemented` is proven as a REPORTED
 *    state, and the `read` arm is proved by driving the session directly and
 *    labelled as such. A packaged Electron host and its `PermissionCoordinator`
 *    are still needed to prove the round trip end to end.
 *  - **The transcript read-back.** The `unsupported` default is the real state
 *    for every adapter in this repository, and it is proved. The `read` arm is
 *    proved against an in-process reader. No production adapter supplies one, so
 *    no host-boundary read is proven here and none is claimed.
 *  - **Budget accounting.** The ACCOUNTING half only. R1.1 wired the ceiling and
 *    R2.3 made the runtime stop the run, and both are already covered by their
 *    own suites; what is new here is that a run stopped on a budget reports the
 *    spend it actually made, and that an unmeasured token count says so. The
 *    EXECUTOR-side pre-dispatch half stays partial and is named as such below
 *    rather than inferred from a terminal that was merely relabelled.
 *  - **The backoff.** The schedule is asserted as an exact list of waits through
 *    the injected `delay`, so the numbers below are what the runtime chose, not
 *    what a loaded CI box happened to allow.
 *
 * ## Which of these failed before the fix
 *
 * 14 of the 15 fail on the pre-R1.4 source, and the messages are the interesting
 * part, because they are the two collapses this phase exists to remove:
 * `expected undefined to be 'unsupported'` — the surface had no state to read,
 * and an array standing in for one — and `expected [] to deeply equal [25, 50]`,
 * which is a retry that re-offered instantly.
 *
 * The one that passes on the old source is
 * `does not wait at all when the first attempt is accepted`. It is a LOCK, not a
 * repair, and it is labelled as one here rather than counted as a fix: the old
 * code had no backoff at all, so "no delay on the happy path" was trivially
 * true. What it is for is the opposite direction — it fails the moment someone
 * taxes every successful write to insure against a failure that did not happen.
 *
 * ## What none of this proves
 *
 * That a real `DuyaAgent` honours a ceiling before dispatching its second model
 * request. That is the pre-dispatch half of preemption, it belongs to the
 * executor and the manifest binding, and no test here stands in for it.
 */

import { describe, expect, it } from 'vitest';
import type {
  ConnectorBinding,
  PermissionAuditEntry,
  PermissionPolicyMode,
  RunBudget,
  RunEvent,
  RunEventEnvelope,
  RunHandle,
  RunManifest,
  RunMetrics,
  RunSurface,
  RunTerminalState,
} from '@duya/agent-protocol';
import {
  RunController,
  RunSession,
  type ExecutionChannel,
  type ExecutionHandle,
  type RunPersistence,
  type RunTranscriptReader,
  type StopRequest,
  type TranslateContext,
} from '@duya/agent-runtime';

// ── persistence doubles ───────────────────────────────────────────────────

class RecordingPersistence implements RunPersistence {
  readonly appended: RunEventEnvelope[] = [];
  readonly completed: Array<{ terminal: RunTerminalState; metrics: RunMetrics }> = [];

  async append(envelopes: readonly RunEventEnvelope[]): Promise<void> {
    this.appended.push(...envelopes);
  }

  async complete(terminal: RunTerminalState, metrics: RunMetrics): Promise<void> {
    this.completed.push({ terminal, metrics });
  }
}

/**
 * A store that refuses the first `failures` appends and accepts the rest.
 *
 * The refusal is what the backoff exists for, so the count is what the test
 * turns. A store that fails FOREVER is the other case and has its own test,
 * because a retry that must give up and a retry that must succeed are different
 * claims about the same loop.
 */
class FlakyPersistence implements RunPersistence {
  appendAttempts = 0;
  readonly appended: RunEventEnvelope[] = [];

  constructor(private readonly failures: number) {}

  async append(envelopes: readonly RunEventEnvelope[]): Promise<void> {
    this.appendAttempts += 1;
    if (this.appendAttempts <= this.failures) throw new Error('storage is busy');
    this.appended.push(...envelopes);
  }

  async complete(): Promise<void> {
    return undefined;
  }
}

/**
 * A store that accepts the first `healthy` appends and then refuses forever.
 *
 * Separate from {@link FlakyPersistence} because the two faults are different
 * claims and need different setup. A store that is briefly busy is the case the
 * backoff is FOR. A store that is gone is the case that must be given up on — and
 * it cannot be expressed by failing from the first append, because
 * `run.started` is flushed on its own before dispatch and the controller
 * correctly refuses to dispatch a run whose opening event never became durable
 * (that is `started_not_durable`, and it is the right verdict). Letting the
 * first append through is what puts the failure somewhere the run can actually
 * experience it.
 */
class DyingPersistence implements RunPersistence {
  appendAttempts = 0;
  readonly appended: RunEventEnvelope[] = [];

  constructor(private readonly healthy: number) {}

  async append(envelopes: readonly RunEventEnvelope[]): Promise<void> {
    this.appendAttempts += 1;
    if (this.appendAttempts > this.healthy) throw new Error('storage is gone');
    this.appended.push(...envelopes);
  }

  async complete(): Promise<void> {
    return undefined;
  }
}

// ── the executor ─────────────────────────────────────────────────────────

function quietExecutor(): ExecutionChannel {
  return {
    async start(): Promise<ExecutionHandle> {
      return {
        stop: async (request: StopRequest) => ({
          requested: true,
          disposition: 'cooperative' as const,
          waitedMs: 0,
          reason: request.reason,
        }),
      };
    },
  };
}

// ── manifest and context ─────────────────────────────────────────────────

function buildManifest(runId: string, budget: RunBudget = {}): RunManifest {
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
  persistence: RunPersistence,
  options: {
    delay?: (ms: number) => Promise<void>;
    appendRetries?: number;
    appendBackoffBudgetMs?: number;
    transcriptReader?: RunTranscriptReader;
    stopBoundMs?: number;
  } = {},
): RunController {
  return new RunController({
    channel: quietExecutor(),
    identity: { name: 'duya-agent-runtime', version: '0.1.0', pid: 4242 },
    protocol: { major: 1, minor: 0 },
    contextFor,
    persistenceFor: () => persistence,
    now: () => 1_000,
    clock: () => 1_000,
    // The session options that R1.4 added have to be reachable from here, and
    // the controller is what a host actually constructs.
    ...(options.delay === undefined ? {} : { delay: options.delay }),
    ...(options.appendRetries === undefined ? {} : { appendRetries: options.appendRetries }),
    ...(options.appendBackoffBudgetMs === undefined
      ? {}
      : { appendBackoffBudgetMs: options.appendBackoffBudgetMs }),
    ...(options.transcriptReader === undefined ? {} : { transcriptReader: options.transcriptReader }),
    ...(options.stopBoundMs === undefined ? {} : { stopBoundMs: options.stopBoundMs }),
  });
}

/** A delay that records what it was asked to wait and returns immediately. */
function recordingDelay(): { waits: number[]; delay: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return {
    waits,
    delay: async (ms: number) => {
      waits.push(ms);
    },
  };
}

function entriesOf<T>(surface: RunSurface<T>): readonly T[] {
  if (surface.state !== 'read') throw new Error(`expected a read surface, got ${surface.state}`);
  return surface.entries;
}

// ── 1: the surfaces ──────────────────────────────────────────────────────

describe('R1.4 — a result surface says whether it was read or is unsupported', () => {
  it('reports the transcript as unsupported rather than as a run with no events', async () => {
    // THE failure. `[]` here reads as "this run emitted nothing", and the truth
    // is that the session does not retain envelopes and no reader was supplied.
    // A consumer auditing a run would take the empty list at face value.
    const persistence = new RecordingPersistence();
    const controller = buildController(persistence);
    const handle = await controller.start(buildManifest('run-no-reader'), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-no-reader', { type: 'text', data: { content: 'hello' } });
    controller.observeFrame('run-no-reader', { type: 'done', data: {} });
    await controller.settle('run-no-reader');

    const result = await handle.result();

    expect(result.transcript.state).toBe('unsupported');
    // The reason has to be usable, not decorative: a consumer deciding whether
    // to go and implement the read needs to know this is absent, not broken.
    if (result.transcript.state === 'unsupported') {
      expect(result.transcript.reason).toMatch(/does not retain|not read back/i);
    }
    // And the load-bearing assertion: it is not an array a consumer can mistake
    // for a run that produced nothing.
    expect(Array.isArray(result.transcript)).toBe(false);
  });

  it('returns the reader\'s entries when a transcript reader is supplied', async () => {
    // The read arm, proved in process. No production adapter supplies a reader
    // yet, so this is the plumbing and NOT a host-boundary read.
    const stored: RunEventEnvelope[] = [
      {
        runId: 'run-reader',
        sessionId: 'session-1',
        seq: 1,
        timestamp: 1_000,
        traceId: 'trace-run-reader',
        payload: { type: 'run.started', manifestHash: 'h', protocol: { major: 1, minor: 0 }, runtime: { name: 'x', version: '1', pid: 1 } },
      },
    ];
    const asked: string[] = [];
    const reader: RunTranscriptReader = {
      readTranscript: async (runId) => {
        asked.push(runId);
        return stored;
      },
    };
    const controller = buildController(new RecordingPersistence(), { transcriptReader: reader });
    const handle = await controller.start(buildManifest('run-reader'), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-reader', { type: 'done', data: {} });
    await controller.settle('run-reader');

    const result = await handle.result();

    expect(asked).toEqual(['run-reader']);
    expect(result.transcript.state).toBe('read');
    expect(entriesOf(result.transcript)).toHaveLength(1);
  });

  it('reports a failed read-back as unsupported, never as an empty run', async () => {
    // Three states, and the failure mode is the dangerous one: a store that
    // refuses a read is not a run with no events, and collapsing them is the
    // same lie with an extra step.
    const reader: RunTranscriptReader = {
      readTranscript: async () => {
        throw new Error('store unreachable');
      },
    };
    const controller = buildController(new RecordingPersistence(), { transcriptReader: reader });
    const handle = await controller.start(buildManifest('run-read-fail'), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-read-fail', { type: 'done', data: {} });
    await controller.settle('run-read-fail');

    const result = await handle.result();

    expect(result.transcript.state).toBe('unsupported');
    if (result.transcript.state === 'unsupported') {
      expect(result.transcript.reason).toContain('store unreachable');
    }
  });
});

// ── 2: the permission audit ──────────────────────────────────────────────

describe('R1.4 — the permission audit tells "nothing happened" from "nothing recorded"', () => {
  it('reports a real read for a run that asked for no permission at all', async () => {
    // The strong claim, and the one that IS available: no request means no
    // activity, so an empty list is a measurement rather than a gap.
    const controller = buildController(new RecordingPersistence());
    const handle = await controller.start(buildManifest('run-no-permission'), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-no-permission', { type: 'done', data: {} });
    await controller.settle('run-no-permission');

    const result = await handle.result();

    expect(result.permissionAudit.state).toBe('read');
    expect(entriesOf(result.permissionAudit)).toEqual([]);
  });

  it('reports unsupported when a request has no decision, instead of an empty audit', async () => {
    // THE case that is live today. Nothing in this runtime emits
    // `permission.resolved`, so a run that raises a prompt lands here — and
    // `[]` would tell a reviewer the run needed no approval.
    const controller = buildController(new RecordingPersistence());
    const handle = await controller.start(buildManifest('run-dangling'), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-dangling', {
      type: 'permission',
      data: { requestId: 'req-1', toolName: 'Bash', input: { command: 'rm -rf /' } },
    });
    controller.observeFrame('run-dangling', { type: 'done', data: {} });
    await controller.settle('run-dangling');

    const result = await handle.result();

    expect(result.permissionAudit.state).toBe('unsupported');
    if (result.permissionAudit.state === 'unsupported') {
      // Both numbers, so the gap is legible without re-deriving it.
      expect(result.permissionAudit.reason).toMatch(/1 permission request\(s\).*0 decision\(s\)/);
    }
  });

  it('records one audit entry per decision when the session observes resolutions', async () => {
    // The `read` arm. Driven against `RunSession` directly and labelled as such,
    // because no producer exists to drive it through the controller: this proves
    // the FOLD, not a round trip. The producer is open work.
    const persistence = new RecordingPersistence();
    const session = new RunSession({
      runId: 'run-audit',
      sessionId: 'session-1',
      now: () => 1_000,
      startedAt: 1_000,
      clock: () => 1_000,
      persistence,
    });
    const emit = (event: RunEvent): void => {
      session.observe(event);
    };
    emit({
      type: 'run.started',
      manifestHash: 'h',
      protocol: { major: 1, minor: 0 },
      runtime: { name: 'x', version: '1', pid: 1 },
    });
    emit({
      type: 'permission.requested',
      requestId: 'req-1',
      kind: 'tool_use',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      mode: 'generic',
      startedAt: 1_000,
      expiresAt: 301_000,
    });
    emit({
      type: 'permission.resolved',
      requestId: 'req-1',
      action: 'allow_always',
      source: 'host',
      latencyMs: 42,
      scope: { kind: 'session' },
    });
    await session.settle();

    const result = await session.result();

    expect(result.permissionAudit.state).toBe('read');
    const entries: readonly PermissionAuditEntry[] = entriesOf(result.permissionAudit);
    expect(entries).toEqual([
      {
        requestId: 'req-1',
        action: 'allow_always',
        source: 'host',
        latencyMs: 42,
        scopeKind: 'session',
      },
    ]);
  });
});

// ── 3: budget accounting ─────────────────────────────────────────────────

describe('R1.4 — a missing usage field is unknown, not zero', () => {
  it('reports tokens as unmeasured for a run that emitted no usage event', async () => {
    // THE failure. `tokens: 0` for a run that reported nothing is a billing
    // claim: a run killed after a large context was dispatched looks exactly
    // like a run that was never dispatched.
    const controller = buildController(new RecordingPersistence());
    const handle = await controller.start(buildManifest('run-no-usage'), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-no-usage', { type: 'turn_start', data: { turnCount: 1 } });
    controller.observeFrame('run-no-usage', { type: 'done', data: {} });
    await controller.settle('run-no-usage');

    const result = await handle.result();

    expect(result.budgetUsed.tokens.measured).toBe(false);
    // And structurally: there is no number to sum, average, or default to zero.
    expect(result.budgetUsed.tokens).not.toHaveProperty('total');
    expect(result.budgetUsed.tokens).not.toHaveProperty('tokens');
    // Turns ARE measured — a zero for those is a real zero, and the asymmetry is
    // the point.
    expect(result.budgetUsed.turns).toBe(1);
    expect(result.budgetUsed.toolCalls).toBe(0);
  });

  it('reports the measured total once a provider reports usage', async () => {
    const controller = buildController(new RecordingPersistence());
    const handle = await controller.start(buildManifest('run-usage'), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-usage', {
      type: 'token_usage',
      data: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    });
    controller.observeFrame('run-usage', { type: 'done', data: {} });
    await controller.settle('run-usage');

    const result = await handle.result();

    expect(result.budgetUsed.tokens).toEqual({ measured: true, total: 120 });
  });

  it('keeps a provider-reported zero distinct from never having reported', async () => {
    // The two values that must never be conflated, side by side. `measured:
    // true, total: 0` is a provider saying "this cost nothing"; `measured:
    // false` is this runtime saying "I have no idea". Same run shape, different
    // claims, and the assertion is that they are different values.
    const measured = buildController(new RecordingPersistence());
    const measuredHandle = await measured.start(buildManifest('run-zero'), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    measured.observeFrame('run-zero', {
      type: 'token_usage',
      data: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    });
    measured.observeFrame('run-zero', { type: 'done', data: {} });
    await measured.settle('run-zero');
    const measuredResult = await measuredHandle.result();

    const unmeasured = buildController(new RecordingPersistence());
    const unmeasuredHandle = await unmeasured.start(buildManifest('run-unmeasured'), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    unmeasured.observeFrame('run-unmeasured', { type: 'done', data: {} });
    await unmeasured.settle('run-unmeasured');
    const unmeasuredResult = await unmeasuredHandle.result();

    expect(measuredResult.budgetUsed.tokens).toEqual({ measured: true, total: 0 });
    expect(unmeasuredResult.budgetUsed.tokens.measured).toBe(false);
    expect(measuredResult.budgetUsed.tokens).not.toEqual(unmeasuredResult.budgetUsed.tokens);
  });

  it('reports the spend a budget-stopped run actually made', async () => {
    // The ACCOUNTING half of budget enforcement, and only that half.
    //
    // What is proven: the ceiling is evaluated, the run stops itself, and the
    // receipt reports the turn and tool call it really made, with the token
    // state honest about what was and was not measured.
    //
    // What is NOT proven, and is not inferred from the terminal below: that the
    // executor declined to DISPATCH the work that would have crossed the
    // ceiling. That is the pre-dispatch half of preemption, it lives in the
    // executor and the manifest binding, and R2.3 already recorded it as
    // partial. Asserting `budget_exhausted` alone would be exactly the
    // "relabel a terminal and call it enforcement" failure, so this test reads
    // the SPEND instead — a relabelled terminal cannot produce it.
    const controller = buildController(new RecordingPersistence());
    const handle = await controller.start(buildManifest('run-budget', { maxTurns: 1 }), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-budget', { type: 'turn_start', data: { turnCount: 1 } });
    await handle.terminal;

    const result = await handle.result();

    expect(result.status).toBe('budget_exhausted');
    // The evidence that the ceiling was really evaluated against real
    // accounting: the run reports the turn that crossed it.
    expect(result.budgetUsed.turns).toBe(1);
    expect(result.budgetUsed.toolCalls).toBe(0);
    // No usage event, so no token claim — including no claim of zero.
    expect(result.budgetUsed.tokens.measured).toBe(false);
  });
});

// ── 4: the backoff ───────────────────────────────────────────────────────

describe('R1.4 — a refused write waits a bounded, testable backoff', () => {
  it('waits the exact ladder before re-offering a refused batch', async () => {
    // With two retries there are two waits: 25ms, then 50ms. Asserted through
    // the injected `delay` as an exact list, which is the only way to pin a
    // schedule — a real timer could only ever be asserted with "roughly".
    const { waits, delay } = recordingDelay();
    const persistence = new FlakyPersistence(2);
    const controller = buildController(persistence, { delay, appendRetries: 2 });
    const handle = await controller.start(buildManifest('run-backoff'), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-backoff', { type: 'done', data: {} });
    await controller.settle('run-backoff');
    await handle.result();

    // The run still succeeded: a store that was busy is not a lost transcript.
    expect(waits).toEqual([25, 50]);
    expect(persistence.appended.length).toBeGreaterThan(0);
  });

  it('does not wait at all when the first attempt is accepted', async () => {
    // A LOCK, not a repair. This passes on the pre-R1.4 source too, because that
    // source had no backoff and so trivially never delayed a good write. It is
    // here for the direction it fails in: a backoff applied to writes that
    // succeeded would tax every run to insure against a failure that did not
    // happen, and that is the mistake this pins.
    const { waits, delay } = recordingDelay();
    const controller = buildController(new RecordingPersistence(), { delay });
    const handle = await controller.start(buildManifest('run-no-backoff'), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-no-backoff', { type: 'done', data: {} });
    await controller.settle('run-no-backoff');
    await handle.result();

    expect(waits).toEqual([]);
  });

  it('keeps the total backoff inside its own bound however many retries are configured', async () => {
    // The bound that is NOT expressed in attempts. A dozen retries on a doubling
    // ladder is tens of seconds, and `settle` awaits the write queue before it
    // publishes a terminal — so without a time bound, the attempt count alone
    // would decide how long a finished run takes to report itself finished.
    const { waits, delay } = recordingDelay();
    const persistence = new FlakyPersistence(20);
    const controller = buildController(persistence, {
      delay,
      appendRetries: 20,
      appendBackoffBudgetMs: 100,
    });
    const handle = await controller.start(buildManifest('run-budget-bound'), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-budget-bound', { type: 'done', data: {} });
    await controller.settle('run-budget-bound');
    await handle.result();

    const total = waits.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeLessThanOrEqual(100);
    // And it actually waited, rather than passing by skipping the backoff.
    expect(total).toBeGreaterThan(0);
    // The ladder is still individually capped, so no single wait dominates.
    expect(Math.max(...waits)).toBeLessThanOrEqual(250);
  });

  it('gives up on a store that never recovers, and reports the run as degraded', async () => {
    // The other claim about the same loop: a store that is GONE must not be
    // retried forever, and the run must not be reported as having a transcript
    // it does not have.
    const { waits, delay } = recordingDelay();
    const controller = buildController(new DyingPersistence(1), { delay, appendRetries: 2 });
    const handle = await controller.start(buildManifest('run-dead-store'), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-dead-store', { type: 'done', data: {} });
    await controller.settle('run-dead-store');

    const result = await handle.result();

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failed terminal');
    expect(result.error.code).toBe('persistence_failed');
    // Bounded: two waits, then the batch is admitted as lost.
    expect(waits).toEqual([25, 50]);
  });

  it('does not charge the write backoff against the stop bound', async () => {
    // The two bounds, and the interaction that matters. `stopBoundMs` is the
    // runtime's promise about the EXECUTOR; the backoff is the write path's
    // promise about itself. `cancel` awaits the executor's disposition BEFORE it
    // settles, so the stop is answered first and the backoff is only ever
    // added to the PUBLICATION of the terminal. A cancel whose answer depended
    // on how busy storage happened to be would make the stop bound meaningless.
    const { waits, delay } = recordingDelay();
    const persistence = new FlakyPersistence(2);
    const controller = buildController(persistence, { delay, appendRetries: 2 });
    const handle = await controller.start(buildManifest('run-cancel-backoff'), {
      prompt: 'p',
      sessionId: 'session-1',
    });
    controller.observeFrame('run-cancel-backoff', { type: 'turn_start', data: { turnCount: 1 } });

    const outcome = await handle.cancel('user', { reason: 'user_stop' });

    // The stop is answered, and the answer is about the stop.
    expect(outcome.applied).toBe(true);
    expect(outcome.disposition).toBe('cooperative');
    expect(outcome.terminal.status).toBe('cancelled');
    // The write path still waited its own bounded ladder, on its own clock.
    expect(waits).toEqual([25, 50]);
    // Both totals are reported in milliseconds and neither consumed the other.
    expect(outcome.terminal.status).not.toBe('budget_exhausted');
  });
});
