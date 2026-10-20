/**
 * Plan 610 S1: the DESKTOP side's native run-event closed loop.
 *
 * ## Why this file exists
 *
 * The run layer's authority flipped: the native `run:event` channel is the only
 * writer of the durable `run_events` ledger (`cdee21d5`), and the legacy
 * `chat:*` frames are reverse-translated and refused.
 *
 * Every Desktop test that builds a `RunOrchestrator` predates that flip. All
 * nine construct it as `new RunOrchestrator({ dbRequest, channel })` — no
 * `nativeWriter` — and eight of them drive **legacy** frames through the real
 * router tee while asserting a durable event log. That contract was removed on
 * purpose, so those files cannot be revived by wiring: their subject is gone.
 *
 * The result is that the Desktop bridge had **no native-path closed loop at
 * all**. Its host-side counterpart exists
 * (`packages/host/tests/worker-product-runtime/native-event-ledger-roundtrip.test.ts`),
 * and `terminal-publication-barrier.test.ts` wires the writer, but that file is
 * about the terminal publication barrier. Nothing asserted that a Desktop run
 * lands its Runtime's events, gapless, under the Runtime's own sequence.
 *
 * ## What is REAL here
 *
 * Real `normalizeAndObserve` (the router tee, the only production caller of
 * `queueNativeRunEvent`), the real `RunOrchestrator`, the real
 * `createDesktopNativeRunEventWriter`, the real `handleDbRequest` bridge, the
 * real `ControlPlaneService` and repository, and a real SQLite `RunStore` over a
 * real file with the real migrations. Frames are written exactly as
 * `worker-process-entry.ts` writes them.
 *
 * The only fakes are two process boundaries a unit test cannot have: the
 * boot-time `getCoreStores()` singleton, and the worker process itself (a
 * dispatch that records the command).
 *
 * ## What it does NOT claim
 *
 * It is not an end-to-end Desktop test: no Electron, no real worker, no real
 * provider. What it pins is that the **Desktop wiring** — tee, writer, bridge,
 * store — turns a Runtime's native lines into a gapless durable log, and that
 * the legacy vocabulary adds nothing to it.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { manifestFingerprint } from '@duya/agent-protocol';

/** The boot-time store singleton, replaced with a REAL RunStore over a REAL file. */
const hoisted = vi.hoisted(() => ({ stores: null as { runs: unknown; research: unknown } | null }));

vi.mock('../db/core-connection', () => ({
  getCoreStores: () => {
    if (hoisted.stores === null) throw new Error('core stores not set');
    return hoisted.stores;
  },
  getCoreStoresOrNull: () => hoisted.stores,
}));

/** The `run:*` arm reaches storage through the Control Plane, but the guard must pass. */
vi.mock('../ipc/db-handlers', () => ({ getDatabase: () => hoisted.stores }));

import { handleDbRequest } from '../agents/db-bridge';
import { normalizeAndObserve, type RouterDeps } from '../agents/server/router';
import { RunOrchestrator, createWorkerExecutionChannel } from '../agents/server/run-orchestrator';
import { createDesktopNativeRunEventWriter } from '../agents/server/native-run-event-writer';
import { dispatchControlPlaneAction, __setDesktopHostRunApiForTesting } from '../control-plane/run-control-plane';
import { createHostRunApi } from '@duya/host/run-api';
import {
  createControlPlaneRepository,
  _resetControlPlaneRepositoryForTesting,
  type CoreStoreAggregates,
} from '../control-plane/sqlite-repository';
import { HOST_APPROVAL_API_STUBS } from '../control-plane/__tests__/host-approval-api-stubs';
import { createControlPlane, _resetControlPlaneForTesting } from '../control-plane/control-plane-service';
import { roleOrigin, type CommandSenderConfig } from '../control-plane/command-receipt';
import { RUN_STORE_MIGRATIONS, RunStore } from '../db/core/run-store';
import { AttachmentStore, GoalStore, PermissionLedger, TaskStore } from '../db/core/stores';
import { Mailbox } from '../db/core/mailbox';

const SESSION_ID = 'session-native-loop-1';
const CHAT_PID = 5150;
const SENDER: CommandSenderConfig = {
  allowedOrigins: [roleOrigin('chat')],
  trustedPids: () => new Set([CHAT_PID]),
};
const CHAT_SENDER = { senderPid: CHAT_PID, registeredSessionId: SESSION_ID, role: 'chat' };

let dir: string;
let db: Database.Database;

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
  const response = await handleDbRequest(
    { type: 'db:request', id: 'r-1', action, payload },
    CHAT_SENDER as never,
  );
  if (!response.success) {
    throw new Error(`the bridge refused ${action}: ${'error' in response ? response.error : 'unknown'}`);
  }
  return 'result' in response ? response.result : undefined;
}

function rows(sql: string, ...params: unknown[]): Record<string, unknown>[] {
  return db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
}

/** One `run:event` line, exactly as `worker-process-entry.ts` writes it. */
function nativeFrame(runId: string, seq: number, type: string): Record<string, unknown> {
  return {
    type: 'run:event',
    epoch: 0,
    envelope: { runId, sessionId: SESSION_ID, seq, payload: { type } },
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

/**
 * The orchestrator exactly as `agents/server/index.ts` composes it: the real
 * bridge, the real Desktop native writer, and no `onEvent`.
 */
function desktopOrchestrator() {
  const reported: string[] = [];
  const logger = {
    info: (message: string) => reported.push(message),
    warn: (message: string) => reported.push(message),
    error: (message: string) => reported.push(message),
  };
  const dispatched: unknown[] = [];
  const orchestrator = new RunOrchestrator({
    dbRequest: dbRequestThroughBridge as never,
    nativeWriter: createDesktopNativeRunEventWriter({
      request: dbRequestThroughBridge as never,
      logger: { warn: (message: string) => reported.push(message) },
    }),
    logger: logger as never,
    channel: createWorkerExecutionChannel({
      dispatch: (command: unknown) => {
        dispatched.push(command);
        return true;
      },
      interrupt: () => ({ accepted: true, settled: Promise.resolve('cooperative' as const) }),
    } as never),
  });
  return { orchestrator, dispatched, reported };
}

const depsFor = (orchestrator: RunOrchestrator): RouterDeps =>
  ({ runOrchestrator: orchestrator, logger: { info: () => {}, warn: () => {}, error: () => {} } }) as unknown as RouterDeps;

beforeEach(() => {
  _resetControlPlaneRepositoryForTesting();
  _resetControlPlaneForTesting();
  dir = mkdtempSync(join(tmpdir(), 'duya-native-loop-'));
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
  __setDesktopHostRunApiForTesting(createHostRunApi({ runs: aggregates.runs }));
  createControlPlaneRepository({ stores: aggregates, ...HOST_APPROVAL_API_STUBS });
  createControlPlane({
    repository: createControlPlaneRepository({ stores: aggregates, ...HOST_APPROVAL_API_STUBS }),
    senderConfig: SENDER,
    request: dispatchControlPlaneAction,
  });
});

afterEach(() => {
  __setDesktopHostRunApiForTesting(null);
  _resetControlPlaneForTesting();
  _resetControlPlaneRepositoryForTesting();
  hoisted.stores = null;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the Desktop native run loop, closed', () => {
  it('lands the Runtime\'s own events, gapless, under the sequence it minted', async () => {
    const { orchestrator, dispatched } = desktopOrchestrator();
    const deps = depsFor(orchestrator);

    const start = await orchestrator.openRun(SESSION_ID, { ...INTENT });
    expect(start.accepted).toBe(true);
    const runId = start.runId as string;
    expect(dispatched.length).toBe(1);

    // ── the run row exists before any event does ─────────────────────────
    const run = rows('SELECT * FROM runs WHERE id = ?', runId)[0];
    expect(run).toBeDefined();
    expect(run!['session_id']).toBe(SESSION_ID);
    expect(run!['status']).toBe('running');
    expect(manifestFingerprint(JSON.parse(String(run!['manifest_json'])) as never)).toBe(run!['manifest_hash']);
    expect(rows('SELECT * FROM run_events WHERE run_id = ?', runId)).toHaveLength(0);

    // ── the Runtime's lines, through the REAL tee ────────────────────────
    for (const [seq, type] of [
      [1, 'run.started'],
      [2, 'turn.started'],
      [3, 'assistant.text_block'],
      [4, 'run.completed'],
    ] as const) {
      normalizeAndObserve(SESSION_ID, nativeFrame(runId, seq, type), deps);
    }
    // A legacy frame in the middle of a native stream must add NOTHING. This
    // is the flip's contract stated positively: if the writer ever starts
    // accepting reverse-translated frames again, this count moves.
    normalizeAndObserve(SESSION_ID, { type: 'chat:text', data: 'legacy chatter' }, deps);
    normalizeAndObserve(SESSION_ID, { type: 'chat:done', reason: 'completed' }, deps);
    await orchestrator.settleSession(SESSION_ID);

    // ── the durable log is the Runtime's, not the projection's ───────────
    const events = rows(
      'SELECT seq, event_type FROM run_events WHERE run_id = ? ORDER BY seq',
      runId,
    );
    expect(events.map((e) => `${e['event_type']}#${e['seq']}`)).toEqual([
      'run.started#1',
      'turn.started#2',
      'assistant.text_block#3',
      'run.completed#4',
    ]);
    // Gapless and 1-based: the sequence belongs to the Runtime, so a hole
    // here means the writer dropped something rather than renumbered it.
    expect(events.map((e) => e['seq'])).toEqual([1, 2, 3, 4]);

    // ── and the row reports the verdict the ledger holds ─────────────────
    const settled = rows('SELECT * FROM runs WHERE id = ?', runId)[0];
    expect(settled!['status']).toBe('completed');
    expect(settled!['terminal']).toBe('completed');
    expect(settled!['error_json']).toBeNull();
    expect(settled!['finished_at']).not.toBeNull();

    // Every envelope round-trips: what a reader parses back is what the
    // Runtime sent, under this run's identity.
    const first = rows('SELECT envelope_json FROM run_events WHERE run_id = ? AND seq = 1', runId)[0];
    const envelope = JSON.parse(String(first!['envelope_json'])) as { runId: string; seq: number };
    expect(envelope.runId).toBe(runId);
    expect(envelope.seq).toBe(1);
  });

  it('reports no events at all for a run whose worker only speaks the legacy vocabulary', async () => {
    // The counterpart, and the reason D6/D7 could go unnoticed for so long:
    // a legacy-only run is NOT a broken native run. It settles with a
    // deliberately empty ledger, and the orchestrator says so out loud.
    const { orchestrator, reported } = desktopOrchestrator();
    const deps = depsFor(orchestrator);

    const start = await orchestrator.openRun(SESSION_ID, { ...INTENT });
    expect(start.accepted).toBe(true);
    const runId = start.runId as string;

    normalizeAndObserve(SESSION_ID, { type: 'chat:turn_start', data: {} }, deps);
    normalizeAndObserve(SESSION_ID, { type: 'chat:text', data: 'only legacy' }, deps);
    normalizeAndObserve(SESSION_ID, { type: 'chat:done', reason: 'completed' }, deps);
    await orchestrator.settleSession(SESSION_ID);

    expect(rows('SELECT * FROM run_events WHERE run_id = ?', runId)).toHaveLength(0);
    // The row still settles — and the degradation is NAMED, which is what
    // `run-execution.test.ts` observed on the Host side. Read off the run
    // layer's own log rather than asserted by hand.
    expect(
      reported.some((line) => line.includes('legacy frames') && line.includes('no native run events')),
    ).toBe(true);
  });
});
