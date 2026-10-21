/**
 * Plan 610 S1: what the native channel does when the ledger REFUSES it.
 *
 * ## Why this file exists
 *
 * `native-event-ledger-roundtrip.test.ts` measures the happy path: a real turn,
 * a real `RunStore`, real envelopes, and the claim that the ledger holds the
 * Runtime's own `seq`. Every one of those runs had a writer that always said
 * yes. A channel whose tests only ever see `written` has not been tested for
 * the failure that matters most — the ledger is a different process's database
 * and it can refuse, refuse late, or refuse because the attempt that wrote the
 * envelope is no longer the one holding write authority.
 *
 * The failure mode this file is aimed at is SPECIFIC: a refused write that
 * still leaves the run looking healthy. A `run:event` that is dropped quietly
 * is indistinguishable, from the outside, from a run that never produced it.
 * So every case here asserts an OBSERVED CONSEQUENCE — a row, a count, a log
 * line, a receipt — and never "nothing threw".
 *
 * ## The chain under test
 *
 *   real `driveRunWithEngine` (only where a turn is what produces the events)
 *     -> real Runtime envelopes, collected off `onNativeEnvelope`
 *       -> real `RunOrchestrator.persistNativeRunEvent`
 *         -> an INJECTED `nativeWriter` / `dbRequest` that refuses
 *           -> a real temp SQLite `RunStore` for everything that is NOT refused
 *             -> read back with `listEvents` / `getRun`
 *
 * ## What is injected and what is real
 *
 * Real: the driver, the engine, the envelopes, the orchestrator, the store, the
 * migrations, and the schema. Injected: the verdict the store would give on the
 * refused call. That is the only honest way to test a refusal — a real SQLite
 * file cannot be made to fail an `INSERT` on demand without corrupting itself,
 * and a `vi.fn()` standing in for the whole ledger would test nothing.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunEventEnvelope } from '@duya/agent-protocol';
import type { RunTerminalState } from '@duya/agent-runtime';
import type { Message, SSEEvent } from '@duya/host/worker-run-contracts';

const PROBE_TOOL = 'fault_probe';
const PROBE_ANSWER = 'FAULT-PROBE-RAN';
const SESSION_ID = 's-native-faults';
const PROMPT = 'run the probe and report back';
const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

/** The reason the injected refusals carry, so an assertion can name it. */
const APPEND_FAULT = 'injected: the durable append was refused';
const COMPLETE_FAULT = 'injected: run:complete was not acknowledged';

const SCRIPTS: readonly (readonly SSEEvent[])[] = [
  [
    { type: 'text', data: 'calling the probe' },
    { type: 'tool_use', data: { id: 'fp-t1', name: PROBE_TOOL, input: { value: 'alpha' } } },
    DONE,
  ],
  [{ type: 'text', data: 'the probe reported' }, DONE],
];

let providerCalls = 0;
const POOL_LISTENERS = new Set(process.listeners('message'));

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(_messages: Message[], options?: Record<string, unknown>) {
      providerCalls += 1;
      const script = SCRIPTS[Math.min(providerCalls - 1, SCRIPTS.length - 1)];
      const signal = options?.signal as AbortSignal | undefined;
      return (async function* () {
        for (const event of script) {
          if (signal?.aborted) {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            throw err;
          }
          yield event;
        }
      })();
    },
  };
  return { ...actual, createAIClient: () => delegating, createAIClientWithRetry: () => delegating };
});

const { makeWorkerSession, driveTurn, cleanupEngineTurnDirs } = await import('./engine-turn-harness.js');
const { Journal } = await import('@duya/host/worker-journal/Journal');
const { initDbClient } = await import('@duya/host/worker-db-client');
const { RunOrchestrator, createWorkerExecutionChannel } = await import('@duya/host/run-orchestrator');
const { writeRunReceiptOnWire, readRunReceipt } = await import('@duya/host/run-receipt');
const { RunStore, RUN_STORE_MIGRATIONS, RunEpochFencedError, RunEventConflictError } = await import(
  '@duya/data/run-store'
);
// `worker-frames` has no package export entry; reached the way the sibling
// host suites reach unexported modules.
const { normalizeWorkerEvent } = await import('../../src/worker-frames.js');

const originalEnv = { ...process.env };
let realSend: typeof process.send | undefined;
let cachedDbListener: ((m: unknown) => void) | null = null;
const tempDirs: string[] = [];

function trackTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function installDbIpc(): void {
  if (cachedDbListener === null) {
    initDbClient();
    cachedDbListener = (process
      .listeners('message')
      .filter((l) => !POOL_LISTENERS.has(l))[0] ?? null) as ((m: unknown) => void) | null;
    if (cachedDbListener === null) throw new Error('db-client registered no message listener');
  }
  const dbListener = cachedDbListener;
  realSend = process.send;
  process.send = ((msg: unknown) => {
    const req = msg as { type?: string; action?: string; id?: string; payload?: { messages?: unknown[] } };
    if (req?.type !== 'db:request') return true;
    if (req.action !== 'mailbox:claimBatch' && req.action !== 'message:append' && req.action !== 'modeState:get') {
      throw new Error(`unexpected db action in the fault suite: ${req.action}`);
    }
    const result =
      req.action === 'mailbox:claimBatch'
        ? { rows: [], claimTokens: [] }
        : req.action === 'message:append'
          ? { success: true, count: req.payload?.messages?.length ?? 0 }
          : null;
    setImmediate(() => dbListener({ type: 'db:response', id: req.id, success: true, result }));
    return true;
  }) as unknown as typeof process.send;
}

beforeEach(() => {
  vi.stubEnv('DUYA_TEST', '1');
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
  providerCalls = 0;
});

afterEach(() => {
  process.send = realSend;
  cleanupEngineTurnDirs();
  vi.unstubAllEnvs();
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp dir nobody claimed is not a test failure.
    }
  }
});

interface LogLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly detail: string;
}

interface LedgerRow {
  readonly seq: number;
  readonly type: string;
  readonly epoch: number;
}

/** What a fault produced. Every case asserts on some field of this. */
interface FaultMeasurement {
  readonly runId: string | null;
  /** The Runtime envelopes the driver announced, whatever happened to them. */
  readonly native: readonly RunEventEnvelope[];
  /** One verdict per envelope offered to the native channel, in order. */
  readonly verdicts: readonly { readonly seq: number; readonly accepted: boolean; readonly reason: string }[];
  /** What the ledger actually holds afterwards. */
  readonly stored: readonly LedgerRow[];
  readonly runRow: {
    readonly status: string;
    readonly terminal: unknown;
    readonly finished_at: unknown;
    readonly epoch: number;
  } | null;
  /** Every log line the orchestrator emitted, flattened for `some()` claims. */
  readonly logs: readonly LogLine[];
  /** Envelope types handed to live consumers (`onEvent`). */
  readonly liveTypes: readonly string[];
  /** What `settleSession` told the caller the run reached. */
  readonly settleTerminal: RunTerminalState | null;
  /** The receipts the Control Plane returned for `run:complete`. */
  readonly completeStates: readonly string[];
}

/** How this run should misbehave. Everything not named behaves normally. */
interface FaultPlan {
  /** The native writer answers `failed` for every durable append. */
  readonly refuseAppend?: boolean;
  /** `run:complete` answers a receipt that is not a durable write. */
  readonly refuseComplete?: boolean;
  /** Drive a real turn. Default `true`; `false` models a worker that never spoke. */
  readonly drive?: boolean;
  /** Tee the legacy frames and settle. Default `true`. */
  readonly settle?: boolean;
  /** Runs after `openRun` and before any envelope is offered. */
  readonly afterOpen?: (ctx: {
    readonly store: RunStore;
    readonly runId: string;
    readonly orchestrator: InstanceType<typeof RunOrchestrator>;
    readonly epoch: number;
    readonly appendUnder: (envelope: RunEventEnvelope, epoch: number) => number;
    readonly notes: Record<string, unknown>;
  }) => void | Promise<void>;
}

async function runWithFaults(plan: FaultPlan = {}): Promise<FaultMeasurement> {
  installDbIpc();

  // A REAL SQLite file with the REAL run-store migrations. A refused write is
  // injected above this layer, but everything the refusal must NOT corrupt is
  // the real schema.
  const dbDir = trackTempDir('duya-s1-faults-');
  const db = new Database(join(dbDir, 'core.db'));
  for (const migration of [...RUN_STORE_MIGRATIONS].sort((a, b) => a.id - b.id)) {
    migration.up(db);
  }
  const store = new RunStore(db);

  const logs: LogLine[] = [];
  const liveTypes: string[] = [];
  const completeStates: string[] = [];
  const notes: Record<string, unknown> = {};
  let measuredVerdicts: Array<{ seq: number; accepted: boolean; reason: string }> = [];

  const dbRequest = async (action: string, payload: Record<string, unknown>): Promise<unknown> => {
    if (action === 'run:create') {
      const outcome = store.createRun(payload as unknown as Parameters<RunStore['createRun']>[0]);
      if (outcome.state === 'created') return writeRunReceiptOnWire({ state: 'created', runId: outcome.runId });
      if (outcome.state === 'reused') return writeRunReceiptOnWire({ state: 'reused', runId: outcome.runId });
      return writeRunReceiptOnWire({ state: 'conflict', runId: outcome.runId, reason: outcome.reason });
    }
    if (action === 'run:append') {
      const { events } = payload as { events: readonly RunEventEnvelope[] };
      const written = store.appendEvents(events);
      return writeRunReceiptOnWire({ state: 'applied', runId: (payload as { runId: string }).runId }, { written });
    }
    if (action === 'run:complete') {
      const { runId, terminal } = payload as { runId: string; terminal: RunTerminalState; metrics?: unknown };
      if (plan.refuseComplete === true) {
        // The refusal under test: the row is NOT touched, and the receipt says
        // so. Reporting `applied` here would be the bug, not the fault.
        completeStates.push('injected_refusal');
        return writeRunReceiptOnWire({ state: 'conflict', runId, reason: COMPLETE_FAULT });
      }
      const outcome = store.settleRun(runId, terminal, (payload as { metrics?: unknown }).metrics);
      completeStates.push(outcome.state);
      if (outcome.state === 'applied') return writeRunReceiptOnWire({ state: 'applied', runId });
      if (outcome.state === 'reconciled') {
        return writeRunReceiptOnWire({ state: 'reconciled', runId, committed: outcome.committed });
      }
      return writeRunReceiptOnWire({ state: 'conflict', runId, reason: outcome.state });
    }
    return writeRunReceiptOnWire({ state: 'invalid', runId: '', reason: `unhandled action ${action}` });
  };

  const orchestrator = new RunOrchestrator({
    nativeWriter: {
      currentEpoch: (id: string) => store.currentEpoch(id),
      append: (id: string, envelopes: readonly RunEventEnvelope[], presented: number) => {
        if (plan.refuseAppend === true) return { state: 'failed', reason: APPEND_FAULT };
        try {
          const written = store.appendEvents(envelopes, presented);
          return written === 0 ? { state: 'duplicate' } : { state: 'written', written };
        } catch (error) {
          if (error instanceof RunEpochFencedError) {
            return { state: 'fenced', presented: error.presented, current: store.currentEpoch(id) ?? 0 };
          }
          if (error instanceof RunEventConflictError) {
            return { state: 'conflict', seq: envelopes[0]?.seq ?? 0 };
          }
          return { state: 'failed', reason: error instanceof Error ? error.message : String(error) };
        }
      },
    },
    onEvent: (envelope: RunEventEnvelope) => {
      liveTypes.push(envelope.payload.type);
    },
    logger: {
      info: (message: string, data?: Record<string, unknown>) => {
        logs.push({ level: 'info', message, detail: JSON.stringify(data ?? {}) });
      },
      warn: (message: string, data?: Record<string, unknown>) => {
        logs.push({ level: 'warn', message, detail: JSON.stringify(data ?? {}) });
      },
      error: (message: string, error?: Error, data?: Record<string, unknown>) => {
        logs.push({
          level: 'error',
          message,
          detail: `${error?.message ?? ''} ${JSON.stringify(data ?? {})}`.trim(),
        });
      },
    } as never,
    dbRequest: dbRequest as never,
    channel: createWorkerExecutionChannel({
      dispatch: () => true,
      interrupt: () => ({ accepted: true, settled: Promise.resolve('cooperative' as const) }),
    } as never),
  });

  const workspaceDir = trackTempDir('duya-s1-faults-ws-');
  const opened = await orchestrator.openRun(SESSION_ID, {
    prompt: PROMPT,
    options: { sessionId: SESSION_ID },
    model: 'claude-test',
    providerId: 'anthropic',
    workingDirectory: workspaceDir,
  } as never);
  const runId = opened.accepted ? opened.runId : null;

  const epoch = runId === null ? 0 : (store.currentEpoch(runId) ?? 0);
  if (runId !== null && plan.afterOpen !== undefined) {
    await plan.afterOpen({
      store,
      runId,
      orchestrator,
      epoch,
      appendUnder: (envelope: RunEventEnvelope, presented: number) => store.appendEvents([envelope], presented),
      notes,
    });
  }

  // The native half, collected exactly where `worker-process-entry.ts` collects
  // it, then offered to the Host under the attempt the run was opened on.
  const nativeOutbound: RunEventEnvelope[] = [];
  if (plan.drive !== false) {
    const agent = makeWorkerSession({
      apiKey: 'test-key',
      model: 'claude-test',
      provider: 'anthropic',
      sessionId: SESSION_ID,
      workingDirectory: workspaceDir,
      permissionMode: 'bypassPermissions',
    });
    agent.journal = new Journal({ sessionId: SESSION_ID });
    agent.activeMCPRegistry.register(
      {
        name: PROBE_TOOL,
        description: 'a probe that records its own execution on disk',
        input_schema: { type: 'object', properties: { value: { type: 'string' } } },
      } as never,
      {
        execute: async () => {
          const { writeFileSync } = await import('node:fs');
          writeFileSync(join(workspaceDir, 'probe-ran.txt'), PROBE_ANSWER, 'utf-8');
          return { ok: true, result: PROBE_ANSWER };
        },
      } as never,
    );
    const result = await driveTurn(agent as never, PROMPT, {
      ...(runId === null ? {} : { runId: runId as never }),
      onNativeEnvelope: (envelope) => {
        nativeOutbound.push(envelope);
      },
    });

    // The native half FIRST, while the session is still bound to its run. That
    // is the order the wire has: the worker's envelopes arrive during the turn,
    // and `settleSession` releases the binding. Offering them afterwards would
    // be refused as "no live run" and would measure the harness's ordering
    // rather than the channel.
    const verdicts: Array<{ seq: number; accepted: boolean; reason: string }> = [];
    for (const envelope of nativeOutbound) {
      const verdict = await orchestrator.persistNativeRunEvent(SESSION_ID, envelope, epoch);
      verdicts.push({
        seq: envelope.seq,
        accepted: verdict.accepted,
        reason: verdict.accepted ? '' : verdict.reason,
      });
    }

    if (plan.settle !== false) {
      for (const frame of result.frames) {
        const normalized = normalizeWorkerEvent(frame);
        if (normalized === null) continue;
        orchestrator.observe(SESSION_ID, normalized);
      }
    }
    measuredVerdicts = verdicts;
  }

  const settleTerminal =
    plan.settle === false ? null : await orchestrator.settleSession(SESSION_ID);

  const stored: LedgerRow[] =
    runId === null
      ? []
      : store.listEvents(runId, 0).map((row) => ({ seq: row.seq, type: row.event_type, epoch: row.epoch }));
  const runRow =
    runId === null
      ? null
      : (store.getRun(runId) as unknown as {
          status: string;
          terminal: unknown;
          finished_at: unknown;
          epoch: number;
        } | null);

  db.close();

  return { runId, native: nativeOutbound, verdicts: measuredVerdicts, stored, runRow, logs, liveTypes, settleTerminal, completeStates };
}

function messagesMatching(logs: readonly LogLine[], pattern: RegExp): readonly LogLine[] {
  return logs.filter((line) => pattern.test(`${line.message} ${line.detail}`));
}

describe('plan-610 S1 — the native channel when the ledger refuses it', () => {
  it('CASE 1: a refused append is refused loudly and lands nothing', async () => {
    const measured = await runWithFaults({ refuseAppend: true });

    // The turn really produced events, so "nothing landed" is a refusal and not
    // an empty run.
    const durable = measured.native.filter((e) => isDurableType(e.payload.type));
    expect(durable.length).toBeGreaterThan(0);
    expect(measured.verdicts).toHaveLength(measured.native.length);

    // A refusal is a COUNT, not an absence: every durable envelope was refused,
    // and every refusal names the store's own reason rather than "failed".
    const refusals = measured.verdicts.filter((verdict) => !verdict.accepted);
    expect(refusals.length).toBeGreaterThan(0);
    expect(new Set(refusals.map((verdict) => verdict.reason))).toEqual(
      new Set([APPEND_FAULT]),
    );

    // The consequence a client can measure: the ledger holds NOTHING. A run row
    // that reads `completed` over an empty transcript is the silent-degradation
    // failure this suite exists to catch.
    expect(measured.stored).toHaveLength(0);

    // The row is NOT a healthy run. A ledger that holds nothing cannot back a
    // `completed`, so the settle commits a DEGRADED terminal instead of the
    // verdict the Runtime reached in memory — which is the whole point of
    // injecting the fault here rather than merely counting refusals.
    expect(measured.runRow?.status).toBe('failed');
    expect(measured.runRow?.terminal).toBe('failed');
    expect(measured.settleTerminal?.status).not.toBe('completed');

    // The downgrade is explained rather than silent, and it is reported at two
    // levels: per refused message, and once for the run at settle time.
    const perMessage = messagesMatching(measured.logs, new RegExp(APPEND_FAULT.replace(/[()]/g, '\\$&')));
    expect(perMessage.length).toBeGreaterThan(0);
    expect(messagesMatching(measured.logs, /no native run events/).length).toBeGreaterThan(0);
    expect(
      messagesMatching(measured.logs, /will not settle as a success/).length,
    ).toBeGreaterThan(0);

    // The LIVE arm follows the row. No `run.completed` reaches a consumer for a
    // run whose ledger lost every event, and the refusal to publish is itself
    // reported — so a client streaming this run is told the terminal was not
    // the one this event describes, rather than being shown a success the
    // ledger cannot support.
    expect(measured.liveTypes.filter((type) => type === 'run.completed')).toHaveLength(0);
    expect(
      messagesMatching(measured.logs, /was not published because the durable terminal/).length,
    ).toBeGreaterThan(0);
  });

  it('CASE 2: a run:complete that is not acknowledged is not published as succeeded', async () => {
    const measured = await runWithFaults({ refuseComplete: true });

    // The turn ran and its events DID land — this case is about the terminal,
    // not about the transcript.
    expect(measured.stored.length).toBeGreaterThan(0);
    expect(measured.stored.some((row) => row.type === 'run.started')).toBe(true);

    // What the durable ledger says, and the divergence that IS the consequence:
    // the transcript holds the engine's own terminal envelope, because that
    // arrived on the native channel, while the ROW was never advanced because
    // `run:complete` was refused. Two disagreeing records of the same run is
    // precisely what a client has to be able to see — and the row is the one
    // that governs, so it must not read `completed`.
    expect(measured.completeStates).toContain('injected_refusal');
    expect(measured.stored.some((row) => row.type === 'run.completed')).toBe(true);
    expect(measured.runRow?.terminal).toBeNull();
    expect(measured.runRow?.status).toBe('running');

    // What the run layer tells the caller: NOT success. A caller branching on
    // this value cannot mistake a refused terminal for a finished run.
    expect(measured.settleTerminal).not.toBeNull();
    expect(measured.settleTerminal?.status).not.toBe('completed');

    // And it is said out loud: the loss of acknowledgement is reported, not
    // swallowed by a `catch` that returns a fabricated terminal.
    expect(messagesMatching(measured.logs, /was not acknowledged/).length).toBeGreaterThan(0);
  });

  it('CASE 3: a late terminal from a superseded attempt is fenced and the run row is untouched', async () => {
    const notes: Record<string, unknown> = {};
    const measured = await runWithFaults({
      // No settle: the assertion below is about a run row NOTHING wrote a
      // terminal to, so settling it here would be the test destroying its own
      // subject.
      settle: false,
      afterOpen: ({ store, runId, appendUnder, epoch }) => {
        // One event committed by the attempt that still holds authority.
        notes.earlyWritten = appendUnder(
          { runId, sessionId: SESSION_ID, seq: 1, payload: { type: 'turn.started' } } as RunEventEnvelope,
          epoch,
        );
        // The Host gives up on this attempt and starts another.
        notes.newEpoch = store.beginAttempt(runId);
        // The superseded attempt now reports its terminal, late.
        notes.lateSettle = store.settleRun(runId, { status: 'completed' }, undefined, epoch);
        notes.presentedEpoch = epoch;
      },
    });

    expect(measured.runId).not.toBeNull();
    // The early write committed under the live attempt.
    expect(notes['earlyWritten']).toBe(1);
    // `beginAttempt` really moved the fence on, so the refusal below is the
    // fence firing and not a run that was already decided.
    expect(notes['newEpoch']).toBe(1);
    expect(notes['presentedEpoch']).toBe(0);

    const late = notes['lateSettle'] as { state: string; presented: number; current: number };
    expect(late.state).toBe('fenced');
    expect(late.presented).toBe(0);
    expect(late.current).toBe(1);

    // The row is untouched: still running, no terminal, never finished.
    expect(measured.runRow?.status).toBe('running');
    expect(measured.runRow?.terminal).toBeNull();
    expect(measured.runRow?.finished_at).toBeNull();

    // Every envelope the superseded attempt still tries to push is refused on
    // the same fence, and the ledger grows by exactly zero rows.
    const refusals = measured.verdicts.filter((verdict) => !verdict.accepted);
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.every((verdict) => /superseded by/.test(verdict.reason))).toBe(true);
    expect(measured.stored.map((row) => row.seq)).toEqual([1]);
    expect(measured.stored[0]?.epoch).toBe(0);
  });

  it('CASE 4: a worker that dies before its first event leaves an explained run, not a healthy one', async () => {
    const measured = await runWithFaults({ drive: false });

    expect(measured.runId).not.toBeNull();
    expect(measured.verdicts).toHaveLength(0);

    // There is no `run.started` row, and that is CORRECT rather than missing:
    // the Host no longer mints that envelope itself (`persistenceFor.append`
    // writes nothing), so the ONLY writer of `run.started` is the Runtime. A
    // worker that dies before its first event mints none, and the Host must not
    // invent one — a fabricated row would claim a fact about a run that never
    // started executing.
    expect(measured.stored).toHaveLength(0);
    expect(measured.native).toHaveLength(0);

    // The run row exists and is not a healthy run: the Host's own backstop
    // settled it, and a worker that produced nothing cannot have completed.
    expect(measured.runRow?.status).not.toBe('completed');
    expect(measured.runRow?.terminal).not.toBeNull();
    expect(measured.runRow?.terminal).not.toBe('running');

    // ...and the terminal it reached is an explanation, not a success.
    expect(measured.settleTerminal).not.toBeNull();
    expect(measured.settleTerminal?.status).not.toBe('completed');

    // The ledger is still empty: the backstop closes the run through the
    // Control Plane, and a transcript is only ever written by the native
    // channel, so nothing here fabricated rows.
    expect(measured.stored).toHaveLength(0);
  });
});

/**
 * The durable subset, named rather than derived.
 *
 * Deriving it from the protocol registry would make these expectations track
 * the code under test. These are the facts a transcript reader needs, written
 * out — the same list the roundtrip proof pins.
 */
const DURABLE_TYPES: ReadonlySet<string> = new Set([
  'run.started',
  'turn.started',
  'tool.call_started',
  'tool.call_completed',
  'assistant.text_block',
  'assistant.message_finalized',
  'run.completed',
]);

function isDurableType(type: string): boolean {
  return DURABLE_TYPES.has(type);
}
