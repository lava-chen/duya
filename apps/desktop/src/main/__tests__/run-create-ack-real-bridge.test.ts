/**
 * The `run:create` bridge, end to end, against a real database.
 *
 * ## The defect this file exists for
 *
 * Every desktop chat turn was dropped and every run row was stranded at
 * `status='running'`, `terminal=NULL`, `finished_at=NULL`. The log line was
 *
 *     [WARN] [agent-server] chat turn dispatched without a durable run
 *       {"stage":"run_not_created","reason":"run:create replied without a boolean ok"}
 *
 * The row was written correctly. The REPLY was not readable: the Control Plane
 * produced the wire shape (`{ ok, state, runId }`), `ControlPlaneService.serve`
 * parsed it back into the typed `RunWriteReceipt` union — which has no `ok`
 * member — and `db-bridge` returned that typed object verbatim. The agent-server
 * read it with `readRunReceipt`, which requires `ok: boolean`, so every
 * `run:create` came back `unreadable`, `openRun` reported `run_not_created`, and
 * the worker was never sent `chat:start`.
 *
 * ## Why this file could not exist before
 *
 * `reference-run-closed-loop.test.ts` proves the same run reaches a durable
 * terminal — but it wires `dbRequest` straight to `dispatchControlPlaneAction`,
 * which SKIPS `db-bridge` and therefore skips the hop where the shape was
 * dropped. The eval harness reaches the run layer through the worker directly
 * for the same reason. Every component was proven and the JOIN was not, so a
 * green suite and a totally broken product agreed with each other. That is why
 * this survived to PR #177.
 *
 * So `dbRequest` here goes through `handleDbRequest` — the real `db:request`
 * entry point, with the real bridge, the real `ControlPlaneService`, the real
 * `dispatchControlPlaneAction` and the real `RunStore` on a real SQLite file.
 * Nothing between the orchestrator and the table is substituted. Assertions
 * read the rows DIRECTLY, because asserting through the API that wrote them
 * proves self-consistency rather than that the bytes are on disk.
 *
 * The only doubles are the two process boundaries that genuinely cannot exist in
 * a unit test: the boot-time `getCoreStores()` singleton, and the worker process
 * itself (the execution channel's dispatch). Both are stubbed with REAL
 * behaviour — a real `RunStore`, and a dispatch that actually records the
 * command the worker would have received.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getCoreStores()` is a boot-time singleton over `duya-core.db`. It is the one
 * thing faked, and it is faked with a REAL `RunStore` over a REAL file — the
 * substitution removes a process boundary, not a behaviour.
 */
const hoisted = vi.hoisted(() => ({ stores: null as { runs: unknown; research: unknown } | null }));

vi.mock('../db/core-connection', () => ({
  getCoreStores: () => {
    if (hoisted.stores === null) throw new Error('core stores not set');
    return hoisted.stores;
  },
  getCoreStoresOrNull: () => hoisted.stores,
}));

/**
 * `dispatchDbAction` opens with a `getDatabase()` guard. The `run:*` arm does
 * not use the handle — storage is reached through the Control Plane — but the
 * guard must pass for the arm to be reached at all, so this is the real
 * connection, not a truthy stand-in.
 */
vi.mock('../ipc/db-handlers', () => ({ getDatabase: () => hoisted.stores }));

import { handleDbRequest } from '../agents/db-bridge';
import { normalizeAndObserve, type RouterDeps } from '../agents/server/router';
import { RunOrchestrator, createWorkerExecutionChannel } from '../agents/server/run-orchestrator';
import { readRunReceipt } from '../control-plane/run-receipt';
import { dispatchControlPlaneAction } from '../control-plane/run-control-plane';
import {
  createControlPlaneRepository,
  _resetControlPlaneRepositoryForTesting,
  type CoreStoreAggregates,
} from '../control-plane/sqlite-repository';
import {
  createControlPlane,
  _resetControlPlaneForTesting,
} from '../control-plane/control-plane-service';
import { roleOrigin, type CommandSenderConfig } from '../control-plane/command-receipt';
import { RUN_STORE_MIGRATIONS, RunStore } from '../db/core/run-store';
import { AttachmentStore, GoalStore, PermissionLedger, TaskStore } from '../db/core/stores';
import { Mailbox } from '../db/core/mailbox';

let dir: string;
let db: Database.Database;

/**
 * The sender the production agent fork presents: a pid this host spawned, on
 * the `chat` role's origin. Using the real admission path (rather than a null
 * host pid) is deliberate — a test that passes a host-initiated sender would
 * not notice if the trust check started refusing real workers.
 */
const CHAT_PID = 4321;
const SENDER: CommandSenderConfig = {
  allowedOrigins: [roleOrigin('chat')],
  trustedPids: () => new Set([CHAT_PID]),
};
const CHAT_SENDER = { senderPid: CHAT_PID, registeredSessionId: 'session-1', role: 'chat' };

function applySchema(handle: Database.Database): void {
  for (const migration of [...RUN_STORE_MIGRATIONS].sort((a, b) => a.id - b.id)) {
    migration.up(handle);
  }
  for (const store of [PermissionLedger, GoalStore, TaskStore, Mailbox]) {
    for (const migration of [...store.migrations].sort((a, b) => a.id - b.id)) {
      migration.up(handle);
    }
  }
  handle.exec(`
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT,
      filename TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
      path TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'file',
      created_at INTEGER NOT NULL
    );
  `);
}

/** The real bridge, as the agent fork's `dbRequest` sees it. */
async function dbRequestThroughBridge(action: string, payload: Record<string, unknown>): Promise<unknown> {
  const response = await handleDbRequest({ type: 'db:request', id: 'r-1', action, payload }, CHAT_SENDER);
  if (!response.success) {
    throw new Error(`the bridge refused ${action}: ${'error' in response ? response.error : 'unknown'}`);
  }
  return 'result' in response ? response.result : undefined;
}

function rows(sql: string, ...params: unknown[]): Record<string, unknown>[] {
  return db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
}

/** Every command the worker was told, in order. */
type WorkerCommand = { type: string } & Record<string, unknown>;

/**
 * An orchestrator wired to the REAL bridge, with a dispatch that records what
 * the worker would have been sent.
 *
 * `harness.accept` is the worker's reply: `false` is a worker that is not there,
 * which the runtime must report as a refusal rather than as a run that looks
 * live.
 *
 * `harness.degradeReply` replaces the reply the CONSUMER sees, after the real
 * bridge has produced it. It exists to reproduce the historical defect
 * precisely: the row is written by real code, and only the shape on the way
 * back is wrong. Degrading the reply IS the defect; stubbing the write would be
 * a different bug.
 *
 * `harness.mutateCreate` rewrites the `run:create` PAYLOAD on its way to the
 * Control Plane, so a create can be made to genuinely refuse rather than
 * genuinely succeed. A refused create writes no row, which is the one incident
 * reply-degradation cannot produce.
 */
function newOrchestrator(
  harness: {
    accept?: boolean;
    degradeReply?: (action: string, reply: unknown) => unknown;
    mutateCreate?: (payload: Record<string, unknown>) => Record<string, unknown>;
  } = {},
): { orchestrator: RunOrchestrator; dispatched: WorkerCommand[] } {
  const dispatched: WorkerCommand[] = [];
  const channel = createWorkerExecutionChannel({
    dispatch: (command) => {
      dispatched.push(command as WorkerCommand);
      return harness.accept ?? true;
    },
    interrupt: () => ({ accepted: true, settled: Promise.resolve('cooperative') }),
  });
  return {
    orchestrator: new RunOrchestrator({
      channel,
      dbRequest: async (action, payload) => {
        const sent = action === 'run:create' && harness.mutateCreate !== undefined
          ? harness.mutateCreate(payload)
          : payload;
        const reply = await dbRequestThroughBridge(action, sent);
        return harness.degradeReply === undefined ? reply : harness.degradeReply(action, reply);
      },
    }),
    dispatched,
  };
}

const INTENT = {
  workingDirectory: '/repo',
  model: 'claude-opus',
  providerId: 'anthropic-main',
  apiFormat: 'anthropic',
  prompt: 'hello',
  options: {},
} as const;

beforeEach(() => {
  _resetControlPlaneRepositoryForTesting();
  _resetControlPlaneForTesting();
  dir = mkdtempSync(join(tmpdir(), 'duya-run-create-ack-'));
  db = new Database(join(dir, 'core.db'));
  applySchema(db);
  const aggregates: CoreStoreAggregates = {
    runs: new RunStore(db),
    attachments: new AttachmentStore(db, dir),
    permissions: new PermissionLedger(db),
    goals: new GoalStore(db),
    tasks: new TaskStore(db),
    mailbox: new Mailbox(db),
  };
  hoisted.stores = { runs: aggregates.runs, research: null };
  // The real composition: one repository, one Control Plane, and the real
  // dispatcher as its route to the run write path.
  createControlPlaneRepository({ stores: aggregates, legacyDatabase: () => null });
  createControlPlane({
    repository: createControlPlaneRepository({ stores: aggregates, legacyDatabase: () => null }),
    senderConfig: SENDER,
    request: dispatchControlPlaneAction,
  });
});

afterEach(() => {
  _resetControlPlaneForTesting();
  _resetControlPlaneRepositoryForTesting();
  hoisted.stores = null;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the run:create reply is readable across the real bridge', () => {
  it('carries the boolean the agent-server reads, so the run reads as created', async () => {
    const reply = await dbRequestThroughBridge('run:create', {
      runId: 'run-ack-1',
      sessionId: 'session-1',
      manifest: { runId: 'run-ack-1', sessionId: 'session-1' },
      manifestHash: 'hash-1',
      inputHash: 'input-1',
    });

    // The exact sentence the dropped turns produced. Asserted on the raw reply
    // as well as through the reader, because the failure was a SHAPE and the
    // shape is what regressed.
    expect(reply).toMatchObject({ ok: true, state: 'created', runId: 'run-ack-1' });
    const receipt = readRunReceipt(reply, 'run:create', 'run-ack-1');
    expect(receipt.state).toBe('created');
    // A typed receipt, not a stringly-typed one: the reason is the producer's.
    expect(receipt).toMatchObject({ state: 'created', runId: 'run-ack-1' });
  });

  it('still answers a read with the run row rather than with a receipt', async () => {
    // The four read actions share the bridge arm with the three writes. When the
    // arm returned `receipt.write` for everything, a read handed the caller an
    // `unreadable` receipt where a run row was asked for.
    const created = await dbRequestThroughBridge('run:create', {
      runId: 'run-ack-2',
      sessionId: 'session-1',
      manifest: { runId: 'run-ack-2', sessionId: 'session-1' },
      manifestHash: 'hash-2',
      inputHash: 'input-2',
    });
    expect(created).toMatchObject({ state: 'created' });

    const got = await dbRequestThroughBridge('run:get', { runId: 'run-ack-2' });
    expect(got).toMatchObject({ id: 'run-ack-2', session_id: 'session-1' });
    const events = await dbRequestThroughBridge('run:events', { runId: 'run-ack-2', afterSeq: 0 });
    expect(Array.isArray(events)).toBe(true);
  });

  it('reports a refusal in the receipt vocabulary, with the reason intact', async () => {
    // No sender the host spawned: the real refusal path, which reaches storage
    // never and so has no `write` receipt to serialise.
    const response = await handleDbRequest(
      { type: 'db:request', id: 'r-1', action: 'run:create', payload: { runId: 'run-refused' } },
      { senderPid: 9999, registeredSessionId: 'session-1', role: 'chat' },
    );
    expect(response.success).toBe(true);
    const result = 'result' in response ? response.result : undefined;
    const receipt = readRunReceipt(result, 'run:create', 'run-refused');
    // Readable, not `unreadable` — a refusal the reader cannot parse is the
    // same defect wearing a different hat.
    expect(receipt.state).toBe('invalid');
    expect(receipt.state === 'invalid' ? receipt.reason : '').toContain('untrusted_sender');
  });
});

describe('a desktop chat turn, opened through the real bridge', () => {
  it('dispatches chat:start and reaches a durable terminal with events written', async () => {
    const { orchestrator, dispatched } = newOrchestrator();

    const start = await orchestrator.openRun('session-1', INTENT);

    // The user-visible half of the defect: before the fix this was
    // `accepted: false` with stage `run_not_created`, and nothing was sent.
    expect(start.accepted, `openRun refused: ${JSON.stringify(start)}`).toBe(true);
    if (!start.accepted) throw new Error(`unreachable: ${start.stage} ${start.reason}`);
    const runId = start.runId;

    // The worker was told to go, and the command carries the CANONICAL run id —
    // the same one the Control Plane minted and the row records.
    expect(dispatched).toHaveLength(1);
    const command = dispatched[0]!;
    expect(command['type']).toBe('chat:start');
    expect(command['runId']).toBe(runId);

    // `run.started` is durable BEFORE the dispatch (R1.2), so a crash here
    // still leaves a recoverable run.
    const afterStart = rows('SELECT * FROM runs WHERE id = ?', runId)[0]!;
    expect(afterStart['status']).toBe('running');

    // Drive a turn through the REAL router tee, exactly as the router does.
    const deps = { runOrchestrator: orchestrator } as unknown as RouterDeps;
    for (const frame of [
      { type: 'chat:turn_start', data: { turnCount: 1 } },
      { type: 'chat:text', data: 'Hello from the worker' },
      { type: 'chat:done' },
    ]) {
      normalizeAndObserve('session-1', frame, deps);
    }
    await orchestrator.settleSession('session-1');

    // Read the table directly: a terminal, a finish time, and a real log.
    const run = rows('SELECT * FROM runs WHERE id = ?', runId)[0]!;
    expect(run['status']).toBe('completed');
    expect(run['terminal']).toBe('completed');
    expect(run['finished_at']).not.toBeNull();

    const events = rows('SELECT seq, event_type FROM run_events WHERE run_id = ? ORDER BY seq', runId);
    // `run_events` was 0 rows for every dropped turn. It is the whole point.
    expect(events.length).toBeGreaterThan(0);
    const types = events.map((e) => e['event_type']);
    expect(types).toContain('run.started');
    expect(types.some((t) => t === 'run.completed' || t === 'run.failed')).toBe(true);
  });
});

describe('when a run cannot be opened, the failure is loud and durable', () => {
  it('closes a row that was written by a run:create whose reply was unreadable', async () => {
    // THE stranded row, reproduced on purpose.
    //
    // The reply the real bridge used to send had no `ok` on it, so this test
    // puts exactly that reply back: the row is written by the REAL
    // `dispatchControlPlaneAction`, and only the shape the consumer sees is
    // degraded. That is the historical failure, and it is the one that left
    // every desktop turn at `status='running'`, `terminal=NULL` forever —
    // because `openRun` returned before the controller was ever reached, so
    // nothing downstream owned the row.
    const { orchestrator, dispatched } = newOrchestrator({
      degradeReply: (action, reply) =>
        action === 'run:create' ? { state: 'created', runId: String((reply as { runId?: unknown }).runId ?? '') } : reply,
    });

    const start = await orchestrator.openRun('session-1', INTENT);

    // The refusal is honest and names itself — the same stage the dropped turns
    // reported — and nothing was dispatched.
    expect(start.accepted).toBe(false);
    if (start.accepted) throw new Error('unreachable');
    expect(start.stage).toBe('run_not_created');
    expect(dispatched).toHaveLength(0);

    // But the row is no longer stranded. This is the assertion the old code
    // could not make: nothing was left to move it.
    const run = rows('SELECT * FROM runs')[0]!;
    expect(run['status']).toBe('failed');
    expect(run['terminal']).toBe('failed');
    expect(run['finished_at']).not.toBeNull();

    // Classified in the protocol's own codes, not a new one: the record is what
    // went wrong, so the remedy is a Control Plane, not a retried model call.
    const error = JSON.parse(String(run['error_json'])) as { code: string; message: string };
    expect(error.code).toBe('persistence_failed');
    expect(error.message).toContain('run_not_created');

    // And the log carries a terminal event, so a reconciler can see how it
    // ended rather than inferring it from a NULL.
    const types = rows('SELECT event_type FROM run_events WHERE run_id = ?', run['id']).map(
      (e) => e['event_type'],
    );
    expect(types).toContain('run.failed');
  });

  it('leaves no row to strand when the create never landed', async () => {
    // The other half of the same path, and a different incident. A create
    // missing its `manifestHash` is refused by the REAL `createRun` BEFORE it
    // writes, so there is no row — and `run:complete` answers `absent`, which
    // is the truth. This is the one case reply-degradation cannot produce,
    // because the write is real.
    const { orchestrator, dispatched } = newOrchestrator({
      mutateCreate: ({ manifestHash: _dropped, ...rest }) => rest,
    });

    const start = await orchestrator.openRun('session-1', INTENT);

    expect(start.accepted).toBe(false);
    if (start.accepted) throw new Error('unreachable');
    expect(start.stage).toBe('run_not_created');
    // The producer's own sentence, which is the reason a typed receipt carries
    // one: an operator can act on "requires manifestHash" and not on a
    // synthesised "reported invalid".
    expect(start.reason).toContain('manifestHash');
    expect(dispatched).toHaveLength(0);
    // "No activity" is not "a run happened and left no trace": no row is
    // claimed, and none is fabricated.
    expect(rows('SELECT id FROM runs')).toHaveLength(0);
  });

  it('leaves a refused dispatch settled rather than stranded', async () => {
    // The worker refuses the dispatch. Here the RUNTIME is the terminal writer
    // — its `#failStart` emits `run.failed` and settles the run before throwing
    // `RunStartError` — so the host must not write a second terminal on top.
    const { orchestrator, dispatched } = newOrchestrator({ accept: false });

    const start = await orchestrator.openRun('session-1', INTENT);

    expect(start.accepted).toBe(false);
    expect(dispatched).toHaveLength(1);
    if (start.accepted) throw new Error('unreachable');
    expect(start.stage).toBe('dispatch_refused');
    expect(start.runId).not.toBeNull();

    const run = rows('SELECT * FROM runs WHERE id = ?', start.runId!)[0]!;
    expect(run['status']).toBe('failed');
    expect(run['terminal']).toBe('failed');
    expect(run['finished_at']).not.toBeNull();
    // Exactly ONE terminal event, which is what "one writer" means: a second
    // writer's attempt would be refused as a conflict and would have logged a
    // settled run as a stranded one.
    const failed = rows("SELECT seq FROM run_events WHERE run_id = ? AND event_type = 'run.failed'", start.runId!);
    expect(failed).toHaveLength(1);
  });

  it('refuses to dispatch and leaves no row at all when the Control Plane has no durable owner', async () => {
    // Composition never created a Control Plane. There is no row, so there is
    // nothing to strand — and the refusal must be READABLE, or the orchestrator
    // reports the same "unreadable" as a broken reply and cannot tell the two.
    _resetControlPlaneForTesting();
    const { orchestrator, dispatched } = newOrchestrator();

    const start = await orchestrator.openRun('session-1', INTENT);

    expect(start.accepted).toBe(false);
    if (start.accepted) throw new Error('unreachable');
    expect(start.stage).toBe('run_not_created');
    // The producer's own sentence, not a synthesised `run:create reported
    // unavailable`: the remedy ("call createControlPlane at composition") is the
    // whole reason a typed receipt carries a reason.
    expect(start.reason).toContain('Control Plane');
    // The user-visible half: nothing was sent, and the host is told so.
    expect(dispatched).toHaveLength(0);
    expect(rows('SELECT id FROM runs')).toHaveLength(0);
  });
});
