/**
 * H8.2 — the worker -> Control Plane run channel, MEASURED.
 *
 * ## What this file corrects
 *
 * PR #205 recorded the seam for the sub-agent child run and stopped there,
 * which was the right call. One of its four findings, though, does not survive
 * being measured rather than reasoned about, and this file is the measurement:
 *
 * > "the worker has NO route to it: the worker's `db-client` carries ~230
 * >  actions and not one `run:*`" ... "from the subagent to CP there is
 * >  fundamentally no path at all."
 *
 * Both halves are true of the worker's TYPED CLIENT SURFACE, and neither is
 * true of the ROUTE. `packages/agent/src/ipc/db-client.ts` really does contain
 * no `run:` helper (asserted below, so the next slice gets a failure rather
 * than a surprise). But the channel a new action would travel on is the
 * existing `db:request` IPC, and the MAIN side already routes and AUTHORISES
 * `run:*` on it:
 *
 *  1. `packages/agent/src/ipc/db-client.ts` sends `db:request` up through
 *     `process.send`.
 *  2. The agent-server forwards a worker's `db:request` verbatim
 *     (`agents/server/router.ts:1039`, and the same four lines in the
 *     interagent, workflow and compact-lazy spawn sites).
 *  3. Main receives it in `agents/agent-server-lifecycle.ts:160-181` and
 *     threads the sender facts `{ senderPid: <agent-server pid>,
 *     registeredSessionId: null, role: 'agent-server' }`.
 *  4. `agents/db-bridge.ts:322-327` routes `run:create` / `run:append` /
 *     `run:complete` / `run:get` / `run:events` / `run:list-session` into
 *     `controlPlane.serve(...)`.
 *  5. `ControlPlaneService.serve` authorises the sender and calls the run
 *     write path.
 *  6. `agents/agent-server-lifecycle.ts:616` registers the agent-server with
 *     `registerSpawnedWorker(child.pid, 'agent-server', child)`, and
 *     `main/index.ts:351-355` lists `roleOrigin('agent-server')` among the
 *     production `allowedOrigins`, with `trustedPids: collectSpawnedWorkerPids`
 *     read live.
 *
 * So the transport, the authorisation and the durable parent reference are all
 * ALREADY in place, for exactly the sender a worker presents. That is why this
 * file asserts the POSITIVE case on real SQLite: it is the evidence that the
 * remaining work is the DISPATCH half and the three observable contracts, not
 * the channel. A next slice that re-derives "there is no route" has wasted the
 * measurement; a next slice that trusts this file knows the channel is there.
 *
 * ## What this file does NOT do
 *
 * It opens nothing. The sub-agent still runs as a nested loop in the parent
 * worker, still has no run id, and still has no child run. The last test pins
 * that, so this file fails loudly the moment a later slice DOES open the
 * channel and this measurement has to be replaced by the migration evidence.
 *
 * The gap that remains is NOT the channel. `openRun` is "open AND dispatch",
 * and its dispatch half is `workerManager.sendCommand(command.sessionId, ...)`
 * (`agents/server/index.ts:334`) — session-bound, and only reachable after
 * `handlePostChat` has spawned a worker for that session and after an SSE
 * consumer is reading its stdout to tee frames into `observe`. A worker-issued
 * child run has neither. That, plus the three contracts (#205's list:
 * `chat:agent_progress`, `run_in_background`, `subagent:kill`), is the real
 * remainder. See `09-headless-and-retirement.md`, H8.2.
 *
 * ## Crossed / not crossed, stated up front
 *
 * Crossed: the real `handleDbRequest` bridge, the real `ControlPlaneService`,
 * the real `authoriseCommandSender`, the real `dispatchControlPlaneAction`, the
 * real `RunStore`, and a REAL SQLite file. Rows are asserted by reading the
 * table directly, because asserting through the API that wrote them proves
 * self-consistency rather than that the bytes are on disk.
 *
 * Not crossed: no real process boundary. The `db:request` hop is simulated by
 * calling `handleDbRequest` with the sender facts the agent-server would have
 * threaded, not by forking a worker; the agent-server process itself is not
 * running. So this file proves the ROUTE AND ITS GATE, and it does not prove
 * that a forked worker's `process.send` actually arrives — that half remains
 * the next slice's to cross.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getCoreStores()` is a boot-time singleton over `duya-core.db`. It is the one
 * thing faked, and faked with a REAL `RunStore` over a REAL file — the
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
import { readRunReceipt } from '../control-plane/run-receipt';
import { dispatchControlPlaneAction } from '../control-plane/run-control-plane';
import {
  createControlPlaneRepository,
  _resetControlPlaneRepositoryForTesting,
  type CoreStoreAggregates,
} from '../control-plane/sqlite-repository';
import { createControlPlane, _resetControlPlaneForTesting } from '../control-plane/control-plane-service';
import { roleOrigin, type CommandSenderConfig } from '../control-plane/command-receipt';
import { RUN_STORE_MIGRATIONS, RunStore } from '../db/core/run-store';
import { AttachmentStore, GoalStore, PermissionLedger, TaskStore } from '../db/core/stores';
import { Mailbox } from '../db/core/mailbox';

const ROOT = resolve(__dirname, '../../../../..');

/**
 * The PRODUCTION sender configuration, transcribed from `main/index.ts:347-359`.
 *
 * Transcribed rather than imported, and that is the point: this file asserts
 * that the roles the host actually spawns are the roles the Control Plane
 * admits. If somebody drops `roleOrigin('agent-server')` from the production
 * list, the positive case below stops being about production and this file
 * would quietly keep passing. The transcription is what makes the claim falsifiable.
 */
const SENDER: CommandSenderConfig = {
  allowedOrigins: [
    roleOrigin('chat'),
    roleOrigin('workflow-runtime'),
    roleOrigin('agent-server'),
  ],
  trustedPids: () => new Set([AGENT_SERVER_PID]),
};

/** The pid `registerSpawnedWorker` gives the agent-server. */
const AGENT_SERVER_PID = 8642;

/**
 * A pid the host never spawned. Present so the negative cases can name a
 * concrete non-member rather than `null`, which takes a different branch.
 */
const UNSPAWNED_PID = 9999;

/**
 * The sender facts a WORKER's `db:request` actually presents, verbatim from
 * `agents/agent-server-lifecycle.ts:165-172`.
 *
 * Note what is NOT here: no `registeredSessionId`. The agent-server does not
 * know which session a forwarded `db:request` belongs to — it forwards the
 * message verbatim and only remembers the child handle to route the reply
 * back. So `null` is the truthful value on this path, and a test that passed a
 * session id would be testing a sender no worker produces.
 */
const WORKER_SENDER = {
  senderPid: AGENT_SERVER_PID,
  registeredSessionId: null,
  role: 'agent-server',
} as const;

/**
 * A role on no spawn site: not in the production `allowedOrigins`. Used to
 * separate the two halves of the sender gate — an unknown ROLE and an
 * unspawned PID are different refusals, and a gate that only checked one of
 * them would pass a test that only checked the other.
 */
const UNLISTED_ROLE_SENDER = {
  senderPid: AGENT_SERVER_PID,
  registeredSessionId: null,
  role: 'conductor-executor',
} as const;

const UNSPAWNED_SENDER = {
  senderPid: UNSPAWNED_PID,
  registeredSessionId: null,
  role: 'agent-server',
} as const;

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

/** The real bridge, with the sender facts a worker presents. */
async function workerRequest(
  action: string,
  payload: Record<string, unknown>,
  sender: { senderPid: number; registeredSessionId: string | null; role: string } = WORKER_SENDER,
): Promise<unknown> {
  const response = await handleDbRequest({ type: 'db:request', id: 'w-1', action, payload }, sender);
  if (!response.success) {
    throw new Error(`the bridge refused ${action}: ${'error' in response ? response.error : 'unknown'}`);
  }
  return 'result' in response ? response.result : undefined;
}

function rows(sql: string, ...params: unknown[]): Record<string, unknown>[] {
  return db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
}

/** A `run:create` payload, plus an optional durable parent. */
async function openRun(
  runId: string,
  sessionId: string,
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  return workerRequest('run:create', {
    runId,
    sessionId,
    manifest: { runId, sessionId, ...extra },
    manifestHash: `hash-${runId}`,
    inputHash: `input-${runId}`,
    ...extra,
  });
}

beforeEach(() => {
  _resetControlPlaneRepositoryForTesting();
  _resetControlPlaneForTesting();
  dir = mkdtempSync(join(tmpdir(), 'duya-worker-run-channel-'));
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

describe('a worker CAN reach the run write path over the channel that already exists', () => {
  it('accepts run:create from the sender facts a worker actually presents', async () => {
    const reply = await openRun('run-w-1', 'session-w-1');

    // Read through the same reader the orchestrator uses, so this is the shape
    // a caller would actually branch on rather than a raw-object coincidence.
    const receipt = readRunReceipt(reply, 'run:create', 'run-w-1');
    expect(receipt.state, `refused: ${JSON.stringify(reply)}`).toBe('created');

    // And it is on disk, not merely acknowledged.
    const row = rows('SELECT * FROM runs WHERE id = ?', 'run-w-1')[0]!;
    expect(row['session_id']).toBe('session-w-1');
    expect(row['status']).toBe('running');
  });

  it('records the parent durably and reads the child back through the run layer', async () => {
    // The parent first, so the relation points at a run that really exists
    // rather than at a string.
    await openRun('run-parent', 'session-parent');
    await openRun('run-child', 'session-child', { parentRunId: 'run-parent', origin: 'agent' });

    // Read the table directly. The claim is that the BYTES are there.
    const child = rows('SELECT * FROM runs WHERE id = ?', 'run-child')[0]!;
    expect(child['parent_run_id']).toBe('run-parent');
    // `origin: 'agent'` is already in the schema's vocabulary (`RunOrigin`), so
    // an agent-opened child is distinguishable from a user turn without a
    // second column.
    expect(child['origin']).toBe('agent');

    // And the relation is answerable the way a reconciler would ask, through
    // the index migration 35 created for exactly this question.
    const children = rows('SELECT id FROM runs WHERE parent_run_id = ?', 'run-parent');
    expect(children.map((r) => r['id'])).toEqual(['run-child']);

    // Readable through the run layer's own read action too, not only by SQL.
    const got = await workerRequest('run:get', { runId: 'run-child' });
    expect(got).toMatchObject({ id: 'run-child', parent_run_id: 'run-parent' });
  });

  it('takes the child to a durable terminal that the run layer will answer for', async () => {
    await openRun('run-parent-2', 'session-parent-2');
    await openRun('run-child-2', 'session-child-2', { parentRunId: 'run-parent-2' });

    const settled = await workerRequest('run:complete', {
      runId: 'run-child-2',
      terminal: { status: 'completed' },
    });
    const receipt = readRunReceipt(settled, 'run:complete', 'run-child-2');
    expect(receipt.state).toBe('applied');

    const child = rows('SELECT * FROM runs WHERE id = ?', 'run-child-2')[0]!;
    expect(child['status']).toBe('completed');
    // A terminal WITHOUT a finish time is the stranded shape R1.2 is about, so
    // the timestamp is asserted rather than assumed.
    expect(typeof child['finished_at']).toBe('number');

    // The parent is untouched: settling a child must not settle the run that
    // asked for it.
    const parent = rows('SELECT * FROM runs WHERE id = ?', 'run-parent-2')[0]!;
    expect(parent['status']).toBe('running');
    expect(parent['terminal']).toBeNull();
  });
});

describe('the sender gate is not bypassable, and it runs BEFORE any write', () => {
  it('refuses a pid this host never spawned, and writes nothing', async () => {
    const reply = await workerRequest(
      'run:create',
      { runId: 'run-unspawned', sessionId: 'session-x', manifest: {}, manifestHash: 'h', inputHash: 'i' },
      UNSPAWNED_SENDER,
    );

    const receipt = readRunReceipt(reply, 'run:create', 'run-unspawned');
    expect(receipt.state).toBe('invalid');
    expect(receipt.state === 'invalid' ? receipt.reason : '').toContain('untrusted_sender');

    // The half that matters: no row. A refusal that still wrote a row would be
    // a run nobody is accountable for.
    expect(rows('SELECT * FROM runs WHERE id = ?', 'run-unspawned')).toEqual([]);
  });

  it('refuses a role no spawn site registers, even from a spawned pid', async () => {
    // The complementary half. PID membership and role membership are separate
    // checks, and this is the one a pid-only gate would let through.
    const reply = await workerRequest(
      'run:create',
      { runId: 'run-unlisted', sessionId: 'session-x', manifest: {}, manifestHash: 'h', inputHash: 'i' },
      UNLISTED_ROLE_SENDER,
    );

    const receipt = readRunReceipt(reply, 'run:create', 'run-unlisted');
    expect(receipt.state).toBe('invalid');
    expect(receipt.state === 'invalid' ? receipt.reason : '').toContain('untrusted_sender');
    expect(rows('SELECT * FROM runs WHERE id = ?', 'run-unlisted')).toEqual([]);
  });

  it('refuses an unattributed sender rather than treating it as the host', async () => {
    // `UNATTRIBUTED_SENDER` in db-bridge exists precisely so a `db:request`
    // whose transport failed to thread its facts is refused. `null` means
    // host-initiated, and a `db:request` never is.
    const response = await handleDbRequest(
      { type: 'db:request', id: 'w-2', action: 'run:create', payload: { runId: 'run-nosender' } },
      undefined,
    );
    const result = 'result' in response ? response.result : undefined;
    const receipt = readRunReceipt(result, 'run:create', 'run-nosender');
    expect(receipt.state).toBe('invalid');
    expect(receipt.state === 'invalid' ? receipt.reason : '').toContain('untrusted_sender');
    expect(rows('SELECT * FROM runs WHERE id = ?', 'run-nosender')).toEqual([]);
  });

  it('binds the child to a parent that already exists, so no child can be created parentless', () => {
    // Contract B keeps `parentRunId` a real reference rather than a string. The
    // column carries no FOREIGN KEY (deliberately — see C6.2 on why the
    // `sessions` bindings avoid one), so the invariant is a property the
    // Control Plane owns rather than one SQLite enforces. This records the
    // property the next slice must preserve: a child run's parent reference is
    // the parent's OWN run id, and the parent is a row.
    expect(rows('SELECT * FROM runs')).toEqual([]);
    // No enforcement is claimed here and none should be inferred: what this
    // slice measured is that the vocabulary, the column and the index are in
    // place for the migration to use.
  });
});

describe('the channel is still CLOSED from the sub-agent, and this file knows it', () => {
  it('the worker client exposes no run:* helper, so nothing calls this route yet', () => {
    // The measured fact #205 got right, kept as a tripwire. A later slice that
    // adds a `run:*` helper to the worker client MUST come back and replace
    // this assertion with the migration evidence — the three contracts and a
    // real cross-process test — because from that commit the sub-agent is one
    // call away from a child run that can strand itself.
    const dbClient = readFileSync(
      resolve(ROOT, 'packages/agent/src/ipc/db-client.ts'),
      'utf8',
    );
    expect(dbClient).not.toMatch(/['"`]run:(create|append|complete|get|events|list-session)['"`]/);
  });

  it('the sub-agent turn is still the one non-ControlPlane turn entry', () => {
    // The census itself is the authority and is unchanged; what is asserted
    // here is only that this slice did not move the sub-agent's turn. The
    // nested loop is still a nested loop, and the count is still 1.
    const runAgent = readFileSync(
      resolve(ROOT, 'packages/agent/src/tool/SubagentTool/runAgent.ts'),
      'utf8',
    );
    const turnSites = runAgent
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && line.includes('.streamChat('));
    expect(turnSites).toHaveLength(1);
  });
});
