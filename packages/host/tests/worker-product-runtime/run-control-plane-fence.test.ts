/**
 * Plan 610 S1 follow-up: the `db:request` execution write path REFUSES a write
 * that presents no attempt.
 *
 * ## The hole this closes
 *
 * `createRunControlPlaneActions` is the execution write path for BOTH hosts —
 * the standalone Host (`run-execution.ts`) and Desktop
 * (`worker-db-bridge.ts`). Both of its `run:append` / `run:complete` handlers
 * read the attempt with a helper that returned `undefined` for a missing or
 * malformed value, and storage reads `undefined` as a DELIBERATE unfenced write.
 *
 * That collapsed two different things into one value. A caller who deliberately
 * chose an unfenced maintenance write and a caller who simply FORGOT the epoch
 * arrived at the repository identically — and the second one wrote straight
 * through the attempt fence while looking exactly like the first. On the path
 * that serves production execution, a forgetful caller was unfenced.
 *
 * So `undefined` is no longer reachable by omission. It is reachable only by
 * naming an explicit authorization, which is a decision on the record.
 *
 * ## What is REAL here
 *
 * Real: `createRunControlPlaneActions`, a real SQLite `RunStore` with the real
 * migrations behind it, and the real receipt vocabulary. Asserted by reading the
 * ROWS back, because asserting through the API that wrote them would prove
 * self-consistency rather than that the write was or was not fenced.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunEventEnvelope } from '@duya/agent-protocol';

const { createRunControlPlaneActions } = await import('@duya/host/run-control-plane');
const { RunStore, RUN_STORE_MIGRATIONS } = await import('@duya/data/run-store');

const SESSION_ID = 's-fence-required';
const RUN_ID = 'run-fence-required';
const EPOCH = 0;

let dir: string;
let db: Database.Database;
let store: RunStore;
let actions: ReturnType<typeof createRunControlPlaneActions>;
const reported: string[] = [];

const ENVELOPE: RunEventEnvelope = {
  runId: RUN_ID,
  sessionId: SESSION_ID,
  seq: 2,
  payload: { type: 'turn.started' },
} as RunEventEnvelope;

beforeEach(() => {
  reported.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'duya-run-fence-'));
  db = new Database(join(dir, 'core.db'));
  for (const migration of [...RUN_STORE_MIGRATIONS].sort((a, b) => a.id - b.id)) {
    migration.up(db);
  }
  store = new RunStore(db);
  actions = createRunControlPlaneActions({
    runs: store as never,
    logger: {
      info: () => undefined,
      warn: (message: string, context?: Record<string, unknown>) => reported.push(`${message} ${JSON.stringify(context ?? {})}`),
      error: () => undefined,
    },
  });
  store.createRun({
    runId: RUN_ID,
    sessionId: SESSION_ID,
    manifest: { runId: RUN_ID, sessionId: SESSION_ID },
    manifestHash: 'hash-fence',
    inputHash: 'input-fence',
  } as never);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The receipt as the orchestrator's `readRunReceipt` would read it. */
async function receipt(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reply = await actions.dispatchControlPlaneAction(action, payload);
  return reply as Record<string, unknown>;
}

describe('the execution write path refuses a write that presents no attempt', () => {
  it('refuses run:append with no epoch, and writes nothing', async () => {
    const reply = await receipt('run:append', { runId: RUN_ID, events: [ENVELOPE] });

    expect(reply['state']).toBe('invalid');
    // A refusal a caller can act on: it names the writer, the action, and what
    // was missing.
    expect(String(reply['reason'])).toContain('host/run-control-plane');
    expect(String(reply['reason'])).toContain('run:append');
    expect(String(reply['reason'])).toContain('no epoch');
    // And, the actual point: the row is untouched.
    expect(store.listEvents(RUN_ID, 0)).toHaveLength(0);
  });

  it('refuses run:complete with no epoch, and leaves the run row running', async () => {
    const reply = await receipt('run:complete', {
      runId: RUN_ID,
      terminal: { status: 'failed', error: { code: 'internal', message: 'abandoned' } },
    });

    expect(reply['state']).toBe('invalid');
    expect(String(reply['reason'])).toContain('host/run-control-plane');
    expect(String(reply['reason'])).toContain('run:complete');
    // Named on the log as well as the receipt: a refusal that only the caller
    // knows about is a refusal nobody investigates.
    expect(reported.some((line) => line.includes('run:complete refused'))).toBe(true);
    expect(store.getRun(RUN_ID)?.status).toBe('running');
  });

  it('refuses a MALFORMED epoch too, rather than reading it as no attempt at all', async () => {
    // `0` is a real attempt and must be accepted; `1.5`, `-1` and `'0'` are not
    // attempts. Reading any of them as "no attempt, so unfenced" would be the
    // same hole with extra steps.
    for (const epoch of [1.5, -1, '0', null]) {
      const reply = await receipt('run:append', { runId: RUN_ID, epoch, events: [ENVELOPE] });
      expect({ epoch, state: reply['state'] }).toEqual({ epoch, state: 'invalid' });
    }
    expect(store.listEvents(RUN_ID, 0)).toHaveLength(0);
  });

  it('accepts attempt 0, which is what a run created moments ago IS', async () => {
    const reply = await receipt('run:append', { runId: RUN_ID, epoch: EPOCH, events: [ENVELOPE] });
    expect(reply['state']).toBe('applied');
    expect(store.listEvents(RUN_ID, 0).map((row) => row.event_type)).toEqual(['turn.started']);
  });
});

describe('a deliberately unfenced write stays reachable, but only by naming it', () => {
  it('lands when the caller names a reason and an author, and says so out loud', async () => {
    const reply = await receipt('run:append', {
      runId: RUN_ID,
      events: [ENVELOPE],
      unfenced: { reason: 'repairing a run whose attempt history is gone', authorizedBy: 'ops@example' },
    });

    expect(reply['state']).toBe('applied');
    expect(store.listEvents(RUN_ID, 0)).toHaveLength(1);
    // An unfenced write is allowed through and is never quiet about it.
    expect(reported.some((line) => line.includes('landing UNFENCED'))).toBe(true);
    expect(reported.some((line) => line.includes('ops@example'))).toBe(true);
  });

  it('refuses an authorization that cannot be read, and does NOT fall back to unfenced', async () => {
    // The dangerous shape: a caller tried to authorize the write and got the
    // field wrong. Falling through to `undefined` here would be the original
    // hole wearing a new hat.
    const malformed = [{ reason: 'no author' }, { authorizedBy: 'no reason' }, { reason: '  ', authorizedBy: 'x' }, 'yes'];
    for (const unfenced of malformed) {
      const reply = await receipt('run:append', { runId: RUN_ID, events: [ENVELOPE], unfenced });
      expect({ unfenced, state: reply['state'] }).toEqual({ unfenced, state: 'invalid' });
    }
    expect(store.listEvents(RUN_ID, 0)).toHaveLength(0);
  });
});

describe('a superseded attempt is still refused on the execution path', () => {
  it('reports the fence rather than letting the stale attempt write', async () => {
    store.beginAttempt(RUN_ID);

    const reply = await receipt('run:append', { runId: RUN_ID, epoch: 0, events: [ENVELOPE] });

    expect(reply['state']).toBe('fenced');
    expect(store.listEvents(RUN_ID, 0)).toHaveLength(0);
  });
});
