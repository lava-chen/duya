/**
 * Plan 610 file 17 S0, second pass: the REAL ledger, measured.
 *
 * ## Why the first pass of this slice was wrong
 *
 * `native-event-authority-loss.test.ts` stopped at the driver and asserted two
 * things about LOCAL output: that a native event type appears in the
 * engine's `announced` list, and that it is absent from the drained frame
 * vocabulary. Both are true and neither says anything about the Host's ledger.
 * Worse, it read like it did. Two facts it missed:
 *
 *  - **The Host rebuilds `run.started` itself.** `controller.ts:526-543` emits
 *    `run.started` through its own emitter, with the manifest hash, BEFORE the
 *    executor is dispatched, and that copy IS persisted. So the worker's dropped
 *    `run.started` is a harmless duplicate, not a hole.
 *  - **The worker rebuilds `assistant.message_finalized`.**
 *    `worker-process-entry.ts:2433-2438` constructs a `chat:message_finalized`
 *    frame from its own journal state after flush. So the dropped native
 *    envelope is re-derived outside the projection.
 *
 * Reading "the engine dropped it" as "the Host does not have it" was an
 * overreach, and a reviewer caught it. This file removes the gap: it drives the
 * production driver, pushes its REAL frames through the REAL Host receive path,
 * and READS THE ACTUAL `run_events` TABLE.
 *
 * ## What it measures, and the three answers it can give
 *
 * For every native event the engine minted, the ledger can say one of three
 * things, and they need DIFFERENT fixes — which is why "missing" alone was the
 * wrong claim:
 *
 *  1. **absent** — no row carries this fact at all;
 *  2. **rebuilt** — a row carries the fact, but minted by the Host/worker rather
 *     than forwarded from the Runtime, so identity (seq, origin) is not the
 *     Runtime's;
 *  3. **compensated** — the outer layer reconstructed it successfully and the
 *     business fact survives.
 *
 * Only (1) is a data-loss bug. (2) is an authority bug. (3) is not a bug at all
 * today. Reporting them as one number is how a plan ends up "fixing" a
 * compensation path that is the only reason anything is correct now.
 *
 * ## The chain under test
 *
 *   real `driveRunWithEngine` (production arg shape)
 *     -> real `chat:*` frames (real worker codec)
 *       -> real `RunOrchestrator.observe`
 *         -> real `RunController` + `persistenceFor`
 *           -> real `RunStore` on a real temp `better-sqlite3` file
 *             -> read back with `listEvents` / `getRun`
 *
 * The only fakes are the LLM provider (scripted, as in every sibling proof) and
 * the execution channel's `dispatch`, which is an executor standing in for a
 * worker process this file cannot spawn.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunEventEnvelope } from '@duya/agent-protocol';
import type { RunTerminalState } from '@duya/agent-runtime';
import type { Message, SSEEvent } from '@duya/host/worker-run-contracts';

const PROBE_TOOL = 'ledger_probe';
const PROBE_ANSWER = 'LEDGER-PROBE-RAN';
const SESSION_ID = 's-ledger-roundtrip';
const PROMPT = 'run the probe and report back';
const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

const SCRIPTS: readonly (readonly SSEEvent[])[] = [
  [
    { type: 'text', data: 'calling the probe' },
    { type: 'tool_use', data: { id: 'lp-t1', name: PROBE_TOOL, input: { value: 'alpha' } } },
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
const { writeRunReceiptOnWire, readRunReceipt, isDurableWrite } = await import('@duya/host/run-receipt');
const { RunStore, RUN_STORE_MIGRATIONS, RunEpochFencedError, RunEventConflictError } = await import(
  '@duya/data/run-store'
);
// `worker-frames` has no package export entry, so it is reached the way the
// sibling host suites reach unexported modules (e.g. `tests/managed-shell/*.test.ts`).
const { normalizeWorkerEvent } = await import('../../src/worker-frames.js');

const originalEnv = { ...process.env };
let realSend: typeof process.send | undefined;
let cachedDbListener: ((m: unknown) => void) | null = null;
let workspaceDir = '';
let dbDir = '';

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
      throw new Error(`unexpected db action in S0 ledger: ${req.action}`);
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
  for (const dir of [workspaceDir, dbDir]) {
    if (dir === '') continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp dir nobody claimed is not a test failure.
    }
  }
  workspaceDir = '';
  dbDir = '';
});

interface Ledger {
  /** What the ENGINE minted, straight off the driver's own publication. */
  readonly native: readonly RunEventEnvelope[];
  /** The frames the production drain handed out. */
  readonly frames: readonly Record<string, unknown>[];
  /** Everything the Host actually stored, read back from `run_events`. */
  readonly stored: readonly { seq: number; type: string; runId: string; envelope: RunEventEnvelope }[];
  readonly runRow: { terminal: unknown; status: string } | null;
  readonly runId: string | null;
  readonly settleStates: readonly string[];
  /** Envelopes the Host published on its live arm — the ones it also persists. */
  readonly live: readonly RunEventEnvelope[];
  /** What the Host decided when the SAME envelope was offered a second time. */
  readonly redelivery?: { readonly accepted: boolean; readonly reason: string };
  /** The ledger's identities after that re-offer. */
  readonly storedAfterRedelivery: readonly string[];
}

async function measure(): Promise<Ledger> {
  installDbIpc();

  // A REAL SQLite file with the REAL run-store migrations. The properties under
  // test ARE the schema, so a `vi.fn()` would hide exactly what we are reading.
  dbDir = mkdtempSync(join(tmpdir(), 'duya-s0-ledger-'));
  const db = new Database(join(dbDir, 'core.db'));
  for (const migration of [...RUN_STORE_MIGRATIONS].sort((a, b) => a.id - b.id)) {
    migration.up(db);
  }
  const store = new RunStore(db);

  const settleStates: string[] = [];
  // The orchestrator's `persistenceFor` speaks `run:*` over `dbRequest`; this is
  // the same adapter shape production uses, with the REAL store behind it.
  const dbRequest = async (action: string, payload: Record<string, unknown>): Promise<unknown> => {
    if (action === 'run:create') {
      const input = payload as unknown as Parameters<RunStore['createRun']>[0];
      const outcome = store.createRun(input);
      const runId = outcome.runId;
      if (outcome.state === 'created') return writeRunReceiptOnWire({ state: 'created', runId });
      if (outcome.state === 'reused') return writeRunReceiptOnWire({ state: 'reused', runId });
      return writeRunReceiptOnWire({ state: 'conflict', runId, reason: outcome.reason });
    }
    if (action === 'run:append') {
      const { events } = payload as { events: readonly RunEventEnvelope[] };
      const written = store.appendEvents(events);
      // `run:append`'s receipt must carry the WRITTEN COUNT. `readRunReceipt`
      // refuses `applied` without one ("claimed applied without a written
      // count"), so an adapter that reports success without saying how many
      // rows it actually wrote is read as `unreadable` — a false "nothing was
      // durable", not a false success.
      return writeRunReceiptOnWire({ state: 'applied', runId: (payload as { runId: string }).runId }, { written });
    }
    if (action === 'run:complete') {
      const { runId, terminal } = payload as { runId: string; terminal: RunTerminalState; metrics?: unknown };
      const outcome = store.settleRun(runId, terminal, (payload as { metrics?: unknown }).metrics);
      settleStates.push(outcome.state);
      if (outcome.state === 'applied' || outcome.state === 'reconciled') {
        return writeRunReceiptOnWire(
          outcome.state === 'applied'
            ? { state: 'applied', runId }
            : { state: 'reconciled', runId, committed: outcome.committed },
        );
      }
      return writeRunReceiptOnWire({ state: 'conflict', runId, reason: outcome.state });
    }
    return writeRunReceiptOnWire({ state: 'invalid', runId: '', reason: `unhandled action ${action}` });
  };

  const liveEnvelopes: RunEventEnvelope[] = [];
  const orchestrator = new RunOrchestrator({
    // The production durable writer, over the REAL store. Same mapping the
    // router builds in `run-execution.ts`: a refusal is named, never flattened
    // into a false success, because "written" and "the envelope was a retry"
    // are different facts the caller has to be able to see.
    nativeWriter: {
      currentEpoch: (id: string) => store.currentEpoch(id),
      append: (id: string, envelopes: readonly RunEventEnvelope[], presented: number) => {
        try {
          const written = store.appendEvents(envelopes, presented);
          return written === 0 ? { state: 'duplicate' } : { state: 'written', written };
        } catch (error) {
          if (error instanceof RunEpochFencedError) {
            return { state: 'fenced', presented, current: store.currentEpoch(id) ?? 0 };
          }
          if (error instanceof RunEventConflictError) {
            return { state: 'conflict', seq: envelopes[0]?.seq ?? 0 };
          }
          return { state: 'failed', reason: error instanceof Error ? error.message : String(error) };
        }
      },
    },
    onEvent: (envelope: RunEventEnvelope) => {
      liveEnvelopes.push(envelope);
    },
    logger: {
      warn: (message: string, meta?: Record<string, unknown>) => console.log('S0_HOST warn:', message, JSON.stringify(meta ?? {})),
      info: () => {},
      error: (message: string) => console.log('S0_HOST error:', message),
    } as never,
    dbRequest: dbRequest as never,
    channel: createWorkerExecutionChannel({
      dispatch: () => true,
      interrupt: () => ({ accepted: true, settled: Promise.resolve('cooperative' as const) }),
    } as never),
  });

  workspaceDir = mkdtempSync(join(tmpdir(), 'duya-s0-ws-'));
  const probeFile = join(workspaceDir, 'probe-ran.txt');
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
        writeFileSync(probeFile, PROBE_ANSWER, 'utf-8');
        return { ok: true, result: PROBE_ANSWER };
      },
    } as never,
  );

  // The PRODUCTION turn entry, before the engine: the Host opens the run, so the
  // `run.started` under test is the one the Controller emits on its own.
  const opened = await orchestrator.openRun(SESSION_ID, {
    prompt: PROMPT,
    options: { sessionId: SESSION_ID },
    model: 'claude-test',
    providerId: 'anthropic',
    workingDirectory: workspaceDir,
  } as never);
  const runId = opened.accepted ? opened.runId : null;

  // The NATIVE half, collected off the driver exactly where
  // `worker-process-entry.ts` collects it — same hook, same order.
  const nativeOutbound: RunEventEnvelope[] = [];
  const result = await driveTurn(agent as never, PROMPT, {
    // The Host's canonical runId, exactly as production gets it from the
    // `chat:start` command. Without this the engine mints its own and every
    // envelope is refused as belonging to a different run — which is the
    // native channel working, not a harness bug.
    ...(runId === null ? {} : { runId: runId as never }),
    onNativeEnvelope: (envelope) => {
      nativeOutbound.push(envelope);
    },
  });

  // The Host receive path for a native message, as `run-execution.ts` performs
  // it: validate, then hand the envelope to the orchestrator under the attempt
  // the run is on. This is the ONLY writer of `run_events` now — the legacy
  // frames below go to the SSE tee and must not be persisted twice.
  const epoch = runId === null ? 0 : (store.currentEpoch(runId) ?? 0);
  const acceptances: Array<{ seq: number; accepted: boolean; reason: string }> = [];
  for (const envelope of nativeOutbound) {
    const verdict = await orchestrator.persistNativeRunEvent(SESSION_ID, envelope, epoch);
    acceptances.push({
      seq: envelope.seq,
      accepted: verdict.accepted,
      reason: verdict.accepted ? '' : verdict.reason,
    });
  }

  // Re-offer the FIRST envelope verbatim. An at-least-once wire does this
  // routinely, and the ledger must be identical afterwards.
  const redeliveryTarget = nativeOutbound.find((envelope) => isDurableType(envelope.payload.type));
  const redelivery =
    redeliveryTarget === undefined
      ? undefined
      : await orchestrator.persistNativeRunEvent(SESSION_ID, redeliveryTarget, epoch);
  const storedAfterRedelivery =
    runId === null
      ? []
      : store.listEvents(runId, 0).map((row) => `${row.event_type}#${row.seq}`);

  // The legacy channel still runs, and still feeds the SSE tee — but NOT the
  // ledger. Keeping the loop is the point: dropping it would make this test
  // pass by removing the old consumer instead of by separating the two paths.
  for (const frame of result.frames) {
    const normalized = normalizeWorkerEvent(frame);
    if (normalized === null) continue;
    orchestrator.observe(SESSION_ID, normalized);
  }

  // The `chat:done` frame settles the run; `settleSession` awaits whatever is
  // already in flight rather than starting a second settlement. Without this
  // await the buffered appends have not reached the store yet, and reading the
  // ledger early reports "nothing was persisted" for a run that simply has not
  // flushed yet — which is the same mistake as reading before the write.
  await orchestrator.settleSession(SESSION_ID);

  const stored = runId === null
    ? []
    : store.listEvents(runId, 0).map((row) => ({
        seq: row.seq,
        type: row.event_type,
        runId: row.run_id,
        envelope: JSON.parse(row.envelope_json) as RunEventEnvelope,
      }));
  const runRow = runId === null ? null : (store.getRun(runId) as unknown as { terminal: unknown; status: string } | null);

  db.close();

  return {
    native: result.outcome.announced,
    frames: result.frames,
    stored,
    runRow,
    runId,
    settleStates,
    live: liveEnvelopes,
    ...(redelivery === undefined
      ? {}
      : { redelivery: { accepted: redelivery.accepted, reason: redelivery.accepted ? '' : redelivery.reason } }),
    storedAfterRedelivery,
  };
}

describe('plan-610 S0 — what the Host ledger actually holds after a real turn', () => {
  /** `type#seq`, the identity this slice is really about. */
  function ids(of: readonly { type?: string; payload: { type: string }; seq: number }[]): readonly string[] {
    return of.map((e) => `${e.payload.type}#${e.seq}`);
  }

  it('the run really executed and the Host really committed its terminal', async () => {
    const ledger = await measure();

    // The engine really ran two turns and one tool call, so the ledger below is
    // about a real turn and not about a run that produced nothing.
    expect(ledger.native.filter((e) => e.payload.type === 'turn.started')).toHaveLength(2);
    // The Host committed a terminal, and committed it EXACTLY once.
    expect(ledger.settleStates).toEqual(['applied']);
    expect(ledger.runRow?.status).toBe('completed');
    expect(ledger.runRow?.terminal).toBe('completed');
  });

  it('every durable Runtime event lands under the Runtime s OWN sequence', async () => {
    const ledger = await measure();

    // This case used to assert the OPPOSITE — that rows carried Host-minted
    // sequence numbers. That defect is what plan 610 S1 removed, so the case was
    // rewritten rather than deleted: it is the same measurement, pointed the
    // other way, and it is the one place the numbers are pinned.
    const storedIdentity = new Set(ledger.stored.map((row) => `${row.type}#${row.seq}`));
    const misnumbered = ledger.native
      .filter((envelope) => isDurableType(envelope.payload.type))
      .filter((envelope) => !storedIdentity.has(`${envelope.payload.type}#${envelope.seq}`))
      .map((envelope) => `${envelope.payload.type}#${envelope.seq}`);
    expect(misnumbered).toEqual([]);
  });

  it('assistant.message_finalized reaches the ledger on its own identity', async () => {
    const ledger = await measure();

    // Previously measured as CATEGORY `absent`: durable, minted by the Runtime,
    // and carried by no row at all. It now arrives because the native channel
    // forwards the envelope instead of relying on the worker reconstructing a
    // `chat:message_finalized` frame from its own journal state afterwards.
    const minted = ledger.native.filter((e) => e.payload.type === 'assistant.message_finalized');
    expect(minted).toHaveLength(1);
    const row = ledger.stored.filter((e) => e.type === 'assistant.message_finalized');
    expect(row).toHaveLength(1);
    expect(row[0]?.seq).toBe(minted[0]?.seq);
  });

  it('ephemeral deltas are absent by design, and their absence is not a gap', async () => {
    const ledger = await measure();

    // `assistant.text_delta` is `durability: 'ephemeral'`, so it is NOT in the
    // ledger — which is why the stored sequence has holes. Asserting this
    // explicitly is what keeps "a missing seq" from reading as data loss: the
    // authority contract says gaps are legal and completeness comes from the
    // receipt, not from `seq + 1` being continuous.
    const deltas = ledger.native.filter((e) => e.payload.type === 'assistant.text_delta');
    expect(deltas.length).toBeGreaterThan(0);
    expect(ledger.stored.filter((e) => e.type === 'assistant.text_delta')).toHaveLength(0);
    // The stored sequence is the RUNTIME's, holes and all. That is the strongest
    // form of the identity claim: a Host that renumbered would have to compress
    // these gaps away, and the fact that they survive is what distinguishes
    // "forwarded" from "rebuilt". It is also why the authority contract says
    // `seq + 1` continuity proves nothing — the ledger is legitimately sparse.
    const runtimeSeqs = ledger.native
      .filter((e) => isDurableType(e.payload.type))
      .map((e) => e.seq);
    expect(ledger.stored.map((e) => e.seq)).toEqual(runtimeSeqs);
  });

  it('the Host ledger carries the run it opened, and no foreign run', async () => {
    const ledger = await measure();

    expect(ledger.runId).not.toBeNull();
    for (const row of ledger.stored) {
      expect(row.runId).toBe(ledger.runId);
    }
    // `run.started` really is the first row, which is what makes a crash one
    // millisecond after dispatch answerable. It is the RUNTIME's now: the Host
    // stopped minting its own, because two events claiming seq 1 would have made
    // the authoritative one permanently unwritable.
    expect(ledger.stored[0]?.type).toBe('run.started');
  });

  // ==========================================================================
  // The S1 acceptance gate.
  //
  // These two ran under `it.fails` while the defect was open, and went RED the
  // moment the native channel landed — which is the wrapper doing its job: it
  // made "fixed" a visible event instead of a silent green. The wrappers are
  // now gone and the cases are ordinary assertions.
  //
  // They replaced two contract cases in `native-event-authority-loss.test.ts`
  // that asserted things about the PROJECTOR and about a recorder never handed
  // to the subject under test. Neither could tell "fixed" from "still broken",
  // which is the only property an acceptance gate has to have.
  // ==========================================================================

  it('CONTRACT (S1): every durable Runtime event is findable in the ledger', async () => {
    const ledger = await measure();

    const storedTypes = new Set(ledger.stored.map((row) => row.type));
    const missing = [
      ...new Set(
        ledger.native
          .filter((envelope) => isDurableType(envelope.payload.type))
          .map((envelope) => envelope.payload.type),
      ),
    ].filter((type) => !storedTypes.has(type));
    expect(missing).toEqual([]);
  });

  it('CONTRACT (S1): a redelivered envelope is a no-op, not a second row', async () => {
    const ledger = await measure();

    // The native channel is an at-least-once wire, so duplicate delivery is the
    // normal case rather than an edge case. `appendEvents` answers 0 for a
    // re-offer of an identical envelope and the writer maps that to `duplicate`
    // — never a second row, and never an error a caller would retry forever.
    expect(ledger.redelivery).toBeDefined();
    expect(ledger.redelivery?.accepted).toBe(true);
    expect(ledger.storedAfterRedelivery).toEqual(ledger.stored.map((e) => `${e.type}#${e.seq}`));
  });
});

/**
 * The durable subset, named rather than derived.
 *
 * Deriving it from the protocol registry would make the expectation track the
 * code under test: a registry that reclassified one of these as volatile would
 * silently empty this set and turn the gate green with nothing having been
 * fixed. These are the facts a transcript reader needs, written out.
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
