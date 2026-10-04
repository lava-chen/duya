/**
 * C6.1 — the repository port, the Control Plane service, and the command
 * receipt.
 *
 * ## What each test is for
 *
 *  - **The port binds, it does not open.** A port that opened its own database
 *    would satisfy every type in this file while creating exactly the second
 *    owner the slice forbids. So the binding is asserted against REAL
 *    `better-sqlite3` stores: if the adapter issued DDL or constructed a
 *    connection, the fixture's tables would not be the ones it wrote.
 *  - **Ownership is data, and it is plural.** The approval surface's decision
 *    genuinely lives on a second connection. A test that asserted a single
 *    owner would be asserting something false, so the test pins the real two
 *    and names which is the finding.
 *  - **The host map refuses an unrecorded run.** A worker handle for a run with
 *    no row is process memory pretending to be a fact.
 *  - **The command receipt refuses before it dispatches.** The sender check has
 *    to happen before the action reaches anything, or it documents rather than
 *    controls.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RUN_STORE_MIGRATIONS, RunStore, type RunRow } from '../../db/core/run-store';
import { GoalStore, PermissionLedger, TaskStore } from '../../db/core/stores';
import { Mailbox } from '../../db/core/mailbox';
import { AttachmentStore } from '../../db/core/stores';
import {
  createControlPlaneRepository,
  _resetControlPlaneRepositoryForTesting,
  type CoreStoreAggregates,
} from '../sqlite-repository';
import {
  ControlPlaneService,
  HostMap,
  _resetControlPlaneForTesting,
  type WorkerBinding,
} from '../control-plane-service';
import {
  assertCommandAccepted,
  authoriseCommandSender,
  COMMAND_SCHEMA_VERSION,
  isCommandDurable,
  readCommandEnvelope,
  rejectCommand,
  roleOrigin,
  type CommandEnvelope,
  type CommandSenderConfig,
} from '../command-receipt';
import type { ControlPlaneRepository } from '../repository-port';

// ── fixture ───────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
let aggregates: CoreStoreAggregates;
let repository: ControlPlaneRepository;

/** Minimal DDL for the aggregates the port reads, so no store is half-built. */
function applyFixtureSchema(handle: Database.Database): void {
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

beforeEach(() => {
  _resetControlPlaneRepositoryForTesting();
  _resetControlPlaneForTesting();
  dir = mkdtempSync(join(tmpdir(), 'duya-c6-1-'));
  db = new Database(join(dir, 'core.db'));
  applyFixtureSchema(db);
  aggregates = {
    runs: new RunStore(db),
    attachments: new AttachmentStore(db, dir),
    permissions: new PermissionLedger(db),
    goals: new GoalStore(db),
    tasks: new TaskStore(db),
    mailbox: new Mailbox(db),
  };
  repository = createControlPlaneRepository({ stores: aggregates, legacyDatabase: () => null });
});

afterEach(() => {
  _resetControlPlaneRepositoryForTesting();
  _resetControlPlaneForTesting();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function openRun(runId: string, sessionId: string): RunRow {
  const outcome = repository.runs.createRun({
    runId,
    sessionId,
    manifest: { roots: [dir] },
    manifestHash: `hash-${runId}`,
    inputHash: `input-${runId}`,
  });
  expect(outcome.state).toBe('created');
  const row = repository.runs.getRun(runId);
  if (row === null) throw new Error('fixture run was not persisted');
  return row;
}

// ── 1. the port ───────────────────────────────────────────────────────────

describe('the repository port reuses the existing connection and migration owner', () => {
  it('writes through the stores the host already opened, creating no schema of its own', () => {
    // A table the port names in `ownership.tables` but the FIXTURE did not
    // create. If the adapter ran DDL of its own, this would exist afterwards.
    // The fixture's migrations are the only thing that made any schema.
    const tableExists = (name: string): boolean =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== undefined);

    openRun('r-port-1', 's-port');
    repository.goalsAndTasks.createGoal({ sessionId: 's-port', objective: 'own one fact' } as never);

    expect(repository.runs.getRun('r-port-1')).not.toBeNull();
    expect(repository.goalsAndTasks.getGoal('s-port')).not.toBeNull();
    // The run table exists because RUN_STORE_MIGRATIONS made it, which is the
    // migration owner the port claims and does not duplicate.
    expect(tableExists('runs')).toBe(true);
    expect(tableExists('control_plane_runs')).toBe(false);
  });

  it('names the connection owners it actually reaches, and the approval split is visible', () => {
    const owners = repository.ownership.connections.map((c) => c.owner);
    // Two, not one. The legacy connection is where the first-wins
    // authorisation CAS lives; collapsing this to a single owner would hide the
    // finding C6.1 exists to produce.
    expect(new Set(owners)).toEqual(new Set(['initCoreDatabase', 'initDatabaseFromBoot']));
    const core = repository.ownership.connections.find((c) => c.owner === 'initCoreDatabase');
    expect(core?.aggregates).toContain('RunStore');
    const legacy = repository.ownership.connections.find((c) => c.owner === 'initDatabaseFromBoot');
    expect(legacy?.aggregates).toContain('tool_approval_state');
    expect(repository.ownership.executingProcess).toBe('electron-main');
  });

  it('reports the same repository on a second create, so there is one owner', () => {
    const again = createControlPlaneRepository({ stores: aggregates, legacyDatabase: () => null });
    expect(again).toBe(repository);
  });
});

// ── 2. the host map ───────────────────────────────────────────────────────

function bindingFor(runId: string, sessionId: string): WorkerBinding {
  return {
    runId,
    sessionId,
    handle: { runId, sessionId } as WorkerBinding['handle'],
    abort: new AbortController(),
    workerId: 'worker-1',
  };
}

const TRUSTED: CommandSenderConfig = {
  allowedOrigins: [roleOrigin('chat'), roleOrigin('workflow-runtime')],
  trustedPids: () => new Set([4321]),
};

function newService(overrides: Partial<Parameters<typeof ControlPlaneService.prototype.constructor>[0]> = {}): ControlPlaneService {
  return new ControlPlaneService({
    repository,
    senderConfig: TRUSTED,
    request: async () => ({ ok: true, state: 'applied', runId: 'r-1', applied: true }),
    ...overrides,
  } as ConstructorParameters<typeof ControlPlaneService>[0]);
}

describe('one owner of cross-run start/terminal state', () => {
  it('refuses to hold a worker handle for a run with no durable record', () => {
    const service = newService();
    const outcome = service.retain(bindingFor('r-never-opened', 's-1'));
    expect(outcome.ok).toBe(false);
    // Nothing retained: a handle in the map for a run nobody recorded is the
    // only evidence the run existed, and process memory is not evidence.
    expect(service.hosts.has('r-never-opened')).toBe(false);
  });

  it('refuses a binding filed under a session the run does not belong to', () => {
    openRun('r-2', 's-right');
    const service = newService();
    const outcome = service.retain(bindingFor('r-2', 's-wrong'));
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.reason).toContain('s-right');
    expect(service.hosts.has('r-2')).toBe(false);
  });

  it('holds a handle for a recorded run, and keeps the map bounded', () => {
    openRun('r-3', 's-3');
    const service = newService({ hostMap: new HostMap(2) });
    expect(service.retain(bindingFor('r-3', 's-3')).ok).toBe(true);
    expect(service.hosts.get('r-3')?.workerId).toBe('worker-1');

    // Two more recorded runs, capacity two: the oldest retained goes first.
    openRun('r-4', 's-3');
    openRun('r-5', 's-3');
    expect(service.retain(bindingFor('r-4', 's-3')).ok).toBe(true);
    expect(service.retain(bindingFor('r-5', 's-3')).ok).toBe(true);
    expect(service.hosts.size).toBe(2);
    expect(service.hosts.has('r-3')).toBe(false);
  });

  it('aborts through the host binding, and says so when there is none', () => {
    openRun('r-6', 's-6');
    const service = newService();
    service.retain(bindingFor('r-6', 's-6'));
    const binding = service.hosts.get('r-6');
    expect(service.abortRun('r-6', 'user stopped it').ok).toBe(true);
    expect(binding?.abort.signal.aborted).toBe(true);
    expect(service.abortRun('r-6', 'again').ok).toBe(false);
  });
});

// ── 3. the command receipt ────────────────────────────────────────────────

const HOST_SENDER = { senderPid: null, registeredSessionId: null, role: null };
const WORKER_SENDER = { senderPid: 4321, registeredSessionId: 's-1', role: 'chat' };

function envelope(action: string, payload: Record<string, unknown> = {}): CommandEnvelope {
  return { schema: COMMAND_SCHEMA_VERSION, action, payload };
}

describe('a command receipt carries a schema, a sender, and a typed failure', () => {
  it('refuses a schema it does not speak, before it looks at the action', () => {
    const read = readCommandEnvelope({ schema: 99, action: 'run:create', payload: {} });
    expect(read).toHaveProperty('refusal', 'schema_mismatch');
    if ('refusal' in read) {
      // The reason must name the version, or a stale producer goes looking for
      // a missing verb instead of a version mismatch.
      expect(read.reason).toContain(String(COMMAND_SCHEMA_VERSION));
      expect(read.reason).toContain('99');
    }
  });

  it('accepts a well-formed envelope', () => {
    const read = readCommandEnvelope({ schema: COMMAND_SCHEMA_VERSION, action: 'run:create', payload: { runId: 'r' } });
    expect(read).toHaveProperty('envelope');
  });

  it('refuses a sender this host did not spawn, using the shared trusted-sender decision', () => {
    const verdict = authoriseCommandSender(
      { senderPid: 9999, registeredSessionId: 's-1', role: 'chat' },
      TRUSTED,
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      // The same refusal a renderer from an auxiliary window gets — the reused
      // decision, not a second check with its own vocabulary.
      expect(verdict.reason).toBe('unknown_window');
    }
  });

  it('refuses a trusted pid on a role outside the allowed origins', () => {
    const verdict = authoriseCommandSender(
      { senderPid: 4321, registeredSessionId: 's-1', role: 'somewhere-else' },
      TRUSTED,
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) expect(verdict.reason).toBe('foreign_origin');
  });

  it('accepts the host itself and a registered worker', () => {
    expect(authoriseCommandSender(HOST_SENDER, TRUSTED).ok).toBe(true);
    expect(authoriseCommandSender(WORKER_SENDER, TRUSTED).ok).toBe(true);
  });

  it('never dispatches a command from an untrusted sender', async () => {
    const request = vi.fn(async () => ({ ok: true, state: 'applied', runId: 'r-1', applied: true }));
    const service = newService({ request });
    const receipt = await service.serve(envelope('run:create', { runId: 'r-1' }), {
      senderPid: 9999,
      registeredSessionId: 's-1',
      role: 'chat',
    });
    expect(receipt.outcome).toBe('rejected');
    if (receipt.outcome === 'rejected') expect(receipt.refusal).toBe('untrusted_sender');
    // The load-bearing assertion: nothing was dispatched, not merely refused
    // afterwards.
    expect(request).not.toHaveBeenCalled();
  });

  it('reports an action the Control Plane does not own as unknown_action', async () => {
    const service = newService({ request: async () => undefined });
    const receipt = await service.serve(envelope('not:a:real:action'), HOST_SENDER);
    expect(receipt.outcome).toBe('rejected');
    if (receipt.outcome === 'rejected') expect(receipt.refusal).toBe('unknown_action');
  });

  it('carries a typed storage failure through a rejection instead of flattening it', () => {
    // `busy` is retryable and `unavailable` is not. A rejected command that
    // reached storage must not lose which one it was.
    const receipt = rejectCommand('run:append', 'invalid_payload', 'events must be an array', COMMAND_SCHEMA_VERSION, {
      state: 'busy',
      runId: 'r-1',
      reason: 'database is locked',
    });
    expect(receipt.write).toEqual({ state: 'busy', runId: 'r-1', reason: 'database is locked' });
    if (receipt.outcome === 'rejected') expect(receipt.refusal).toBe('invalid_payload');
  });

  it('does not let a post-ack failure be swallowed', () => {
    // A non-durable write receipt is a failure, and the single choke point
    // throws for it rather than trusting each caller to notice.
    const receipt = rejectCommand('run:complete', 'invalid_payload', 'terminal required', COMMAND_SCHEMA_VERSION, {
      state: 'unavailable',
      runId: 'r-1',
      reason: 'the database file is gone',
    });
    expect(isCommandDurable(receipt)).toBe(false);
    expect(() => assertCommandAccepted(receipt)).toThrow(/unavailable/);
  });

  it('treats a defer as a real answer rather than a failure', () => {
    const receipt = rejectCommand('permission:resolve', 'deferred', 'the host deferred', COMMAND_SCHEMA_VERSION);
    expect(() => assertCommandAccepted(receipt)).toThrow();
    // A defer decides nothing, so aborting a turn over it would be wrong — but
    // it must be opted into, never the default.
    expect(() => assertCommandAccepted(receipt, true)).not.toThrow();
  });

  it('accepts a receipt whose write actually landed', async () => {
    const service = newService();
    const receipt = await service.serve(envelope('run:complete', { runId: 'r-1' }), WORKER_SENDER);
    expect(isCommandDurable(receipt)).toBe(true);
    expect(() => assertCommandAccepted(receipt)).not.toThrow();
  });

  it('treats a lost CAS that another writer agreed with as durable', async () => {
    // R1.3's `reconciled`: the run IS settled as asked. Reporting it as a
    // failure tells a host its run failed when its run succeeded.
    const service = newService({
      request: async () => ({
        ok: true,
        state: 'reconciled',
        runId: 'r-1',
        committed: { status: 'completed', stopReason: 'done' },
      }),
    });
    const receipt = await service.serve(envelope('run:complete', { runId: 'r-1' }), WORKER_SENDER);
    expect(isCommandDurable(receipt)).toBe(true);
  });
});
