/**
 * The Host's Session input service (R1.2).
 *
 * ## What this pins
 *
 * Three clauses the rest of R1.2 rests on:
 *
 *  - the RECEIPT is durable and echoes the identity the Host DERIVED. A
 *    caller that lost the response asks again with the same request id and
 *    gets the same answer, not a second input and not an error.
 *  - the LEASE decides who may direct the session, and it is checked BEFORE
 *    the instruction is handed over. A refused instruction is recorded as
 *    refused, with the reason — the refusal is a fact about the session.
 *  - a takeover BUMPS the revision, so the holder that lost the lease cannot
 *    extend it and be believed.
 *
 * ## Why the delivery is a stub
 *
 * The service does not know how a turn starts; the Host fills that in. These
 * cases are about the service's own contract — what it records, what it
 * refuses and what it hands over — so the delivery is a stub that records
 * what it was asked to deliver. The real delivery is wired in the Host.
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
} from '@duya/data';
import {
  createHostSessionInputApi,
  type SessionInputDelivery,
} from '../src/session-input-api.js';

let db: Database.Database;
let inputs: SessionInputStore;
let leases: SessionControlLeaseStore;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'duya-session-input-api-'));
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

const REQUEST = {
  sessionId: 'session-1',
  requestId: 'req-1',
  intent: 'enqueue' as const,
  content: 'Do the thing.',
};

function service(
  actor: { kind: 'user' | 'bot' | 'plugin' | 'channel' | 'system'; id?: string },
  delivery?: (input: typeof REQUEST) => Promise<SessionInputDelivery>,
): ReturnType<typeof createHostSessionInputApi> {
  return createHostSessionInputApi({
    stores: { sessionInputs: inputs, sessionControlLeases: leases },
    actor,
    ...(delivery ? { delivery: { deliver: delivery } } : {}),
  });
}

describe('submitting an input', () => {
  it('records it durably and echoes the identity the Host derived', async () => {
    const receipt = await service({ kind: 'user', id: 'user-1' }, async () => ({
      state: 'delivered',
      runId: 'run-7',
    })).submitInput(REQUEST);

    expect(receipt.inputId).toBeTruthy();
    expect(receipt.requestId).toBe('req-1');
    expect(receipt.sessionId).toBe('session-1');
    // The actor is the one the Host bound, not one the request could have
    // carried: `SessionInputRequest` has no actor field at all.
    expect(receipt.actor).toEqual({ kind: 'user', id: 'user-1' });
    expect(receipt.stage).toBe('delivered');
    expect(receipt.runId).toBe('run-7');
  });

  it('returns the original receipt when the same request id is submitted again', async () => {
    let deliveries = 0;
    const api = service({ kind: 'user', id: 'user-1' }, async () => {
      deliveries += 1;
      return { state: 'delivered', runId: 'run-7' };
    });

    const first = await api.submitInput(REQUEST);
    const second = await api.submitInput(REQUEST);

    expect(second.inputId).toBe(first.inputId);
    expect(second.stage).toBe('delivered');
    // The retry found the record, so it did not hand the instruction over a
    // second time.
    expect(deliveries).toBe(1);
    expect(inputs.listForSession('session-1')).toHaveLength(1);
  });

  it('records a refusal from the delivery with its reason', async () => {
    const receipt = await service({ kind: 'user', id: 'user-1' }, async () => ({
      state: 'rejected',
      reason: 'session_busy',
    })).submitInput(REQUEST);

    expect(receipt.stage).toBe('rejected');
    expect(receipt.reason).toBe('session_busy');
  });

  it('records a refused input even when the delivery throws', async () => {
    const receipt = await service({ kind: 'user', id: 'user-1' }, async () => {
      throw new Error('the worker was gone');
    }).submitInput(REQUEST);

    expect(receipt.stage).toBe('rejected');
    expect(receipt.reason).toContain('the worker was gone');
  });

  it('leaves the input persisted when there is nothing to deliver it', async () => {
    const receipt = await service({ kind: 'user', id: 'user-1' }).submitInput(REQUEST);

    expect(receipt.stage).toBe('persisted');
  });

  it('refuses a request without a session or a request id', async () => {
    const api = service({ kind: 'user', id: 'user-1' });

    await expect(api.submitInput({ ...REQUEST, sessionId: '' })).rejects.toThrow(/sessionId/);
    await expect(api.submitInput({ ...REQUEST, requestId: ' ' })).rejects.toThrow(/requestId/);
  });
});

describe('the control lease', () => {
  it('stops an input while somebody else holds the session', async () => {
    const bot = service({ kind: 'bot', id: 'bot-1' });
    await bot.acquireControlLease({ sessionId: 'session-1', requestId: 'lease-req-1', ttlMs: 60_000 });

    let deliveries = 0;
    const receipt = await service({ kind: 'user', id: 'user-1' }, async () => {
      deliveries += 1;
      return { state: 'delivered' };
    }).submitInput(REQUEST);

    // The instruction was refused BEFORE it was handed over, and the refusal
    // is on the record.
    expect(receipt.stage).toBe('rejected');
    expect(receipt.reason).toBe('control_lease_held');
    expect(deliveries).toBe(0);
  });

  it('does not stop the holder itself', async () => {
    const user = service({ kind: 'user', id: 'user-1' }, async () => ({ state: 'delivered' }));
    await user.acquireControlLease({ sessionId: 'session-1', requestId: 'lease-req-1', ttlMs: 60_000 });

    const receipt = await user.submitInput(REQUEST);

    expect(receipt.stage).toBe('delivered');
  });

  it('bumps the revision on a takeover and invalidates the old holder', async () => {
    const user = service({ kind: 'user', id: 'user-1' });
    const bot = service({ kind: 'bot', id: 'bot-1' });

    const first = await user.acquireControlLease({ sessionId: 'session-1', requestId: 'lease-req-1', ttlMs: 60_000 });
    expect(first?.revision).toBe(1);

    const takeover = await bot.acquireControlLease({ sessionId: 'session-1', requestId: 'lease-req-2', ttlMs: 60_000 });
    expect(takeover?.revision).toBe(2);
    expect(takeover?.holder).toEqual({ kind: 'bot', id: 'bot-1' });

    // The previous holder's revision is stale, so it cannot extend the lease
    // it lost.
    const stale = await user.acquireControlLease({
      sessionId: 'session-1',
      requestId: 'lease-req-3',
      expectedRevision: 1,
      ttlMs: 60_000,
    });
    expect(stale).toBeNull();
  });

  it('refuses a stale extension and grants a current one', async () => {
    const user = service({ kind: 'user', id: 'user-1' });
    const granted = await user.acquireControlLease({ sessionId: 'session-1', requestId: 'lease-req-1', ttlMs: 60_000 });

    const stale = await user.acquireControlLease({
      sessionId: 'session-1',
      requestId: 'lease-req-2',
      expectedRevision: 99,
      ttlMs: 60_000,
    });
    expect(stale).toBeNull();

    const extended = await user.acquireControlLease({
      sessionId: 'session-1',
      requestId: 'lease-req-3',
      expectedRevision: granted?.revision,
      ttlMs: 60_000,
    });
    expect(extended?.revision).toBe(2);
  });

  it('shortens a lease that asks for too long', async () => {
    const lease = await service({ kind: 'user', id: 'user-1' }, undefined).acquireControlLease({
      sessionId: 'session-1',
      requestId: 'lease-req-1',
      ttlMs: 24 * 60 * 60_000,
    });

    const lifetime = (lease?.expiresAt ?? 0) - Date.now();
    expect(lifetime).toBeLessThanOrEqual(15 * 60_000);
  });

  it('gives the lease back only for the revision the holder was given', async () => {
    const user = service({ kind: 'user', id: 'user-1' });
    const lease = await user.acquireControlLease({ sessionId: 'session-1', requestId: 'lease-req-1', ttlMs: 60_000 });

    expect(await user.releaseControlLease('session-1', 99)).toBe(false);
    expect(await user.readControlLease('session-1')).not.toBeNull();

    expect(await user.releaseControlLease('session-1', lease?.revision ?? 0)).toBe(true);
    expect(await user.readControlLease('session-1')).toBeNull();
  });

  it('reads nothing for a session nobody holds', async () => {
    expect(await service({ kind: 'user', id: 'user-1' }).readControlLease('session-9')).toBeNull();
  });

  it('is not held by an actor that has no holder kind', async () => {
    const lease = await service({ kind: 'channel', id: 'thread-1' }).acquireControlLease({
      sessionId: 'session-1',
      requestId: 'lease-req-1',
      ttlMs: 60_000,
    });

    expect(lease).toBeNull();
  });
});
