/**
 * Durable Session inputs and the per-session control lease (R1.2).
 *
 * ## What this pins
 *
 * Two clauses that the rest of R1.2 rests on:
 *
 *  - the DEDUP is atomic and per session. A retried submit with the same
 *    `requestId` returns the ORIGINAL record — not a second one, and not an
 *    error — because a caller that lost the response has to be able to retry
 *    safely.
 *  - the lease is a REVISION CAS. A holder proves it still holds the lease by
 *    presenting its revision, and a takeover invalidates the previous
 *    holder's revision so its next instruction fails the check instead of
 *    racing the new holder.
 *
 * ## Why the expiry is applied by the READERS
 *
 * An expired lease grants no rights. A lease that is never swept still stops
 * granting rights the moment it expires, so the sweep is an optimisation and
 * not a correctness requirement — and a test that depends on a sweep would
 * be testing the wrong thing.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_CONTROL_LEASE_MIGRATIONS,
  SESSION_INPUT_MIGRATIONS,
  SessionControlLeaseStore,
  SessionInputStore,
} from '../src/session-inputs.js';

let db: Database.Database;
let inputs: SessionInputStore;
let leases: SessionControlLeaseStore;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'duya-session-inputs-'));
  db = new Database(join(dir, 'core.db'));
  for (const migration of [...SESSION_INPUT_MIGRATIONS, ...SESSION_CONTROL_LEASE_MIGRATIONS].sort((a, b) => a.id - b.id)) {
    migration.up(db);
  }
  inputs = new SessionInputStore(db);
  leases = new SessionControlLeaseStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const SUBMIT = {
  inputId: 'input-1',
  sessionId: 'session-1',
  requestId: 'req-1',
  intent: 'steer' as const,
  actorKind: 'user' as const,
};

describe('the input record', () => {
  it('is durable and carries the derived actor', () => {
    const record = inputs.accept({ ...SUBMIT, actorId: 'user-1' });

    expect(record.inputId).toBe('input-1');
    expect(record.requestId).toBe('req-1');
    expect(record.actorKind).toBe('user');
    expect(record.actorId).toBe('user-1');
    expect(record.stage).toBe('persisted');
    expect(inputs.get('session-1', 'req-1')).toEqual(record);
  });

  it('is deduplicated by (session, requestId)', () => {
    const first = inputs.accept(SUBMIT);
    // A DIFFERENT host-minted id, same request: the retry must not create a
    // second input.
    const second = inputs.accept({ ...SUBMIT, inputId: 'input-2' });

    expect(second.inputId).toBe(first.inputId);
    expect(inputs.listForSession('session-1')).toHaveLength(1);
  });

  it('scopes the dedup key to the session', () => {
    inputs.accept(SUBMIT);
    const other = inputs.accept({ ...SUBMIT, sessionId: 'session-2', inputId: 'input-2' });

    expect(other.inputId).toBe('input-2');
    expect(inputs.listForSession('session-1')).toHaveLength(1);
    expect(inputs.listForSession('session-2')).toHaveLength(1);
  });

  it('numbers the inputs in the order they arrived', () => {
    const first = inputs.accept(SUBMIT);
    const second = inputs.accept({ ...SUBMIT, requestId: 'req-2', inputId: 'input-2' });
    const third = inputs.accept({ ...SUBMIT, requestId: 'req-3', inputId: 'input-3' });

    expect([first.inputSeq, second.inputSeq, third.inputSeq]).toEqual([1, 2, 3]);
  });

  it('lets exactly one caller claim a pending input', () => {
    inputs.accept(SUBMIT);

    // Two callers can submit the same request id at once and share ONE
    // record, so exactly one of them may deliver it.
    expect(inputs.claimPending('session-1', 'req-1')).toBe(true);
    expect(inputs.claimPending('session-1', 'req-1')).toBe(false);
    expect(inputs.get('session-1', 'req-1')?.stage).toBe('queued');
  });

  it('moves an input through its stages', () => {
    inputs.accept(SUBMIT);

    expect(inputs.advanceStage('session-1', 'req-1', 'delivered', { runId: 'run-7' })).toBe(true);
    const record = inputs.get('session-1', 'req-1');
    expect(record?.stage).toBe('delivered');
    expect(record?.runId).toBe('run-7');
  });

  it('reports a rejection with its reason', () => {
    inputs.accept(SUBMIT);

    inputs.advanceStage('session-1', 'req-1', 'rejected', { reason: 'stale_turn' });
    const record = inputs.get('session-1', 'req-1');
    expect(record?.stage).toBe('rejected');
    expect(record?.reason).toBe('stale_turn');
  });

  it('reports nothing for an unknown request', () => {
    expect(inputs.get('session-1', 'nope')).toBeNull();
  });
});

describe('the control lease', () => {
  const GRANT = {
    sessionId: 'session-1',
    leaseId: 'lease-1',
    holderKind: 'user' as const,
    holderId: 'user-1',
    requestId: 'req-1',
    ttlMs: 60_000,
  };

  it('grants the lease and names the holder it granted it to', () => {
    const lease = leases.acquire(GRANT);

    expect(lease).not.toBeNull();
    expect(lease?.holderKind).toBe('user');
    expect(lease?.holderId).toBe('user-1');
    expect(lease?.revision).toBe(1);
    expect(lease?.leaseId).toBe('lease-1');
  });

  it('bumps the revision on every grant', () => {
    const first = leases.acquire(GRANT);
    const second = leases.acquire({ ...GRANT, leaseId: 'lease-2', requestId: 'req-2' });

    expect(first?.revision).toBe(1);
    expect(second?.revision).toBe(2);
  });

  it('refuses an extension whose expected revision is stale', () => {
    leases.acquire(GRANT);
    // Someone else took it in the meantime.
    leases.acquire({ ...GRANT, leaseId: 'lease-2', requestId: 'req-2' });

    const stale = leases.acquire({ ...GRANT, leaseId: 'lease-3', requestId: 'req-3', expectedRevision: 1 });

    expect(stale).toBeNull();
    expect(leases.read('session-1')?.revision).toBe(2);
  });

  it('grants an extension whose expected revision is current', () => {
    const first = leases.acquire(GRANT);
    const extended = leases.acquire({ ...GRANT, leaseId: 'lease-2', requestId: 'req-2', expectedRevision: first?.revision });

    expect(extended?.revision).toBe(2);
  });

  it('refuses an extension when there is no lease at all', () => {
    const lease = leases.acquire({ ...GRANT, expectedRevision: 1 });

    expect(lease).toBeNull();
  });

  it('releases only for the revision the holder was given', () => {
    const lease = leases.acquire(GRANT);
    expect(lease).not.toBeNull();

    expect(leases.release('session-1', 99)).toBe(false);
    expect(leases.read('session-1')).not.toBeNull();

    expect(leases.release('session-1', lease?.revision ?? 0)).toBe(true);
    expect(leases.read('session-1')).toBeNull();
  });

  it('grants no rights once it has expired', () => {
    const now = 1_000_000;
    leases.acquire({ ...GRANT, ttlMs: 1000, nowMs: now });

    expect(leases.read('session-1', now + 500)).not.toBeNull();
    expect(leases.read('session-1', now + 1001)).toBeNull();
  });

  it('lets a new holder take an expired lease', () => {
    const now = 1_000_000;
    leases.acquire({ ...GRANT, ttlMs: 1000, nowMs: now });

    const takeover = leases.acquire({
      ...GRANT,
      leaseId: 'lease-2',
      holderKind: 'bot',
      holderId: 'bot-1',
      requestId: 'req-2',
      nowMs: now + 2000,
    });

    expect(takeover?.revision).toBe(2);
    expect(takeover?.holderKind).toBe('bot');
    expect(takeover?.holderId).toBe('bot-1');
  });

  it('lets a new holder take a live lease and invalidates the old revision', () => {
    leases.acquire(GRANT);
    const takeover = leases.acquire({
      ...GRANT,
      leaseId: 'lease-2',
      holderKind: 'bot',
      holderId: 'bot-1',
      requestId: 'req-2',
    });

    expect(takeover?.revision).toBe(2);
    // The previous holder's revision is now stale, so it cannot extend.
    expect(leases.acquire({ ...GRANT, leaseId: 'lease-3', expectedRevision: 1 })).toBeNull();
  });

  it('reads nothing for a session that has no lease', () => {
    expect(leases.read('session-9')).toBeNull();
  });
});
