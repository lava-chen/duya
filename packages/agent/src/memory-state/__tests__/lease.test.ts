import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import {
  acquireLease,
  heartbeat,
  complete,
  fail,
  backoffMs,
  DEFAULT_LEASE_TTL_MS,
  STALE_WORKER_GRACE_MS,
  MAX_RETRY_ATTEMPTS,
  type AcquireOk,
  type AcquireResult,
  type RolloutLeaseRow,
} from '../lease';
import { selectEligible } from '../eligibility';
import {
  createMemoryStateFixture,
  insertCatalogRow,
  type MemoryStateFixture,
} from './fixture';

/**
 * Lease race-condition scenarios (Plan 302 Phase C, design v3 D4).
 *
 * Time is injected via the `now` parameter on every function so TTL
 * expiry, heartbeat staleness, and backoff elapsing are simulated
 * without real sleeps.
 */

const T0 = 1_750_000_000_000;
const MIN = 60 * 1000;
const HOUR = 3600 * 1000;

function mustAcquire(result: AcquireResult): AcquireOk {
  if (result.status !== 'acquired') {
    throw new Error(`expected acquired, got ${JSON.stringify(result)}`);
  }
  return result;
}

function getLease(db: Database, rolloutId: string): RolloutLeaseRow | undefined {
  return db.prepare('SELECT * FROM rollout_leases WHERE rollout_id = ?').get(rolloutId) as
    | RolloutLeaseRow
    | undefined;
}

function stage1Count(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM stage1_outputs').get() as { n: number }).n;
}

describe('lease race conditions (D4)', () => {
  let fixture: MemoryStateFixture;
  let db: Database;

  beforeEach(() => {
    fixture = createMemoryStateFixture();
    db = fixture.db;
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('1. second instance acquire → busy; heartbeat with a wrong token → false', () => {
    insertCatalogRow(db, { rollout_id: 'r1' });

    const a = mustAcquire(acquireLease(db, { rolloutId: 'r1', claimedBy: 'instA', now: T0 }));

    const b = acquireLease(db, { rolloutId: 'r1', claimedBy: 'instB', now: T0 + 1 });
    expect(b.status).toBe('busy');

    // A heartbeat under any token other than the holder's is rejected.
    expect(heartbeat(db, { rolloutId: 'r1', token: 'wrong-token', now: T0 + 2 })).toBe(false);
    // The holder's own heartbeat applies.
    expect(heartbeat(db, { rolloutId: 'r1', token: a.token, now: T0 + 2 })).toBe(true);
  });

  it('2. complete with a source version mismatching the lease snapshot → source_changed, no output', () => {
    insertCatalogRow(db, {
      rollout_id: 'r2',
      last_message_at: 5_000_000,
      source_fingerprint: 'fp1',
    });

    const a = mustAcquire(acquireLease(db, { rolloutId: 'r2', claimedBy: 'instA', now: T0 }));
    expect(getLease(db, 'r2')!.source_updated_at).toBe(5_000_000);
    expect(getLease(db, 'r2')!.source_content_hash).toBe('fp1');

    const status = complete(db, {
      rolloutId: 'r2',
      token: a.token,
      sourceUpdatedAt: 6_000_000, // drifted vs. the acquire-time snapshot
      sourceContentHash: 'fp2',
      outcome: 'succeeded',
      contentOutcome: 'success',
      rolloutSummary: 'summary',
      rawMemoryJson: '{}',
      rolloutSlug: 'slug',
      now: T0 + 1_000,
    });
    expect(status).toBe('source_changed');
    expect(stage1Count(db)).toBe(0);
  });

  it('3. complete after the heartbeat went stale → stale_worker, no output, lease kept', () => {
    insertCatalogRow(db, {
      rollout_id: 'r3',
      last_message_at: 5_000_000,
      source_fingerprint: 'fp3',
    });

    const a = mustAcquire(acquireLease(db, { rolloutId: 'r3', claimedBy: 'instA', now: T0 }));

    const status = complete(db, {
      rolloutId: 'r3',
      token: a.token,
      sourceUpdatedAt: 5_000_000,
      sourceContentHash: 'fp3',
      outcome: 'succeeded',
      contentOutcome: 'success',
      rolloutSummary: 'summary',
      rawMemoryJson: '{}',
      rolloutSlug: 'slug',
      now: T0 + STALE_WORKER_GRACE_MS + 1, // no heartbeat in between
    });
    expect(status).toBe('stale_worker');
    expect(stage1Count(db)).toBe(0);
    // The lease row is NOT deleted on stale_worker.
    expect(getLease(db, 'r3')).toBeDefined();
  });

  it('4. same claimedBy + idempotencyToken returns the prior token, not a fresh uuid', () => {
    insertCatalogRow(db, { rollout_id: 'r4' });

    const first = mustAcquire(
      acquireLease(db, { rolloutId: 'r4', claimedBy: 'instA', idempotencyToken: 'foo', now: T0 })
    );
    const second = mustAcquire(
      acquireLease(db, { rolloutId: 'r4', claimedBy: 'instA', idempotencyToken: 'foo', now: T0 + 1_000 })
    );
    expect(second.token).toBe(first.token);
    expect(second.expiresAt).toBe(first.expiresAt);
  });

  it('5. acquire by another instance while running → busy with holder + expiresAt', () => {
    insertCatalogRow(db, { rollout_id: 'r5' });

    const a = mustAcquire(acquireLease(db, { rolloutId: 'r5', claimedBy: 'instA', now: T0 }));

    const b = acquireLease(db, { rolloutId: 'r5', claimedBy: 'instB', now: T0 + 1 });
    expect(b).toEqual({ status: 'busy', holder: 'instA', expiresAt: a.expiresAt });
  });

  it('6. repeated fail() advances next_retry_at through the backoff schedule', () => {
    insertCatalogRow(db, { rollout_id: 'r6' });
    let now = T0;

    const expected = [5 * MIN, 15 * MIN, 60 * MIN];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = mustAcquire(acquireLease(db, { rolloutId: 'r6', claimedBy: 'instA', now }));
      expect(getLease(db, 'r6')!.attempt_count).toBe(attempt);

      fail(db, { rolloutId: 'r6', token: res.token, error: `boom-${attempt}`, now });
      const lease = getLease(db, 'r6')!;
      expect(lease.job_status).toBe('failed');
      expect(lease.last_error).toBe(`boom-${attempt}`);
      const delta = lease.next_retry_at! - now;
      expect(Math.abs(delta - expected[attempt - 1])).toBeLessThanOrEqual(1_000);

      // Not acquirable while backing off.
      expect(acquireLease(db, { rolloutId: 'r6', claimedBy: 'instA', now: now + 1 }).status).toBe('busy');

      // Advance the clock to the retry time for the next attempt.
      now = lease.next_retry_at!;
    }
  });

  it('7. failing at MAX attempts retires the rollout; further acquire → busy(retired)', () => {
    insertCatalogRow(db, { rollout_id: 'r7' });
    let now = T0;

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      const res = mustAcquire(acquireLease(db, { rolloutId: 'r7', claimedBy: 'instA', now }));
      expect(getLease(db, 'r7')!.attempt_count).toBe(attempt);

      fail(db, { rolloutId: 'r7', token: res.token, error: `boom-${attempt}`, now });

      if (attempt < MAX_RETRY_ATTEMPTS) {
        now = getLease(db, 'r7')!.next_retry_at!;
      }
    }

    // Lease row deleted; failure history survives in rollout_retired.
    expect(getLease(db, 'r7')).toBeUndefined();
    const retired = db
      .prepare('SELECT attempt_count, last_error FROM rollout_retired WHERE rollout_id = ?')
      .get('r7') as { attempt_count: number; last_error: string };
    expect(retired.attempt_count).toBe(MAX_RETRY_ATTEMPTS);
    expect(retired.last_error).toBe(`boom-${MAX_RETRY_ATTEMPTS}`);

    const after = acquireLease(db, { rolloutId: 'r7', claimedBy: 'instA', now: now + 100 * HOUR });
    expect(after).toEqual({ status: 'busy', holder: 'retired', expiresAt: 0 });
  });

  it('8. two handles on the same DB file — first come, first served', () => {
    insertCatalogRow(db, { rollout_id: 'r8' });

    const dbB = new BetterSqlite3(path.join(fixture.dbDir, 'memory-state.db'));
    dbB.pragma('busy_timeout = 5000');
    try {
      // Synchronous execution: BEGIN IMMEDIATE serializes the two
      // acquires; the first commits before the second reads.
      const a = acquireLease(db, { rolloutId: 'r8', claimedBy: 'procA', now: T0 });
      const b = acquireLease(dbB, { rolloutId: 'r8', claimedBy: 'procB', now: T0 });
      expect(a.status).toBe('acquired');
      expect(b.status).toBe('busy');
      if (b.status === 'busy') {
        expect(b.holder).toBe('procA');
      }
    } finally {
      dbB.close();
    }
  });

  it('9. expired TTL re-acquired by another instance; old holder complete → stale_lease', () => {
    insertCatalogRow(db, {
      rollout_id: 'r9',
      last_message_at: 7_000_000,
      source_fingerprint: 'fp9',
    });

    const a = mustAcquire(acquireLease(db, { rolloutId: 'r9', claimedBy: 'instA', now: T0 }));

    const b = mustAcquire(
      acquireLease(db, { rolloutId: 'r9', claimedBy: 'instB', now: T0 + DEFAULT_LEASE_TTL_MS + 1 })
    );
    expect(b.token).not.toBe(a.token);
    expect(getLease(db, 'r9')!.attempt_count).toBe(2);

    const status = complete(db, {
      rolloutId: 'r9',
      token: a.token,
      sourceUpdatedAt: 7_000_000,
      sourceContentHash: 'fp9',
      outcome: 'succeeded',
      contentOutcome: 'success',
      rolloutSummary: 'summary',
      rawMemoryJson: '{}',
      rolloutSlug: 'slug',
      now: T0 + DEFAULT_LEASE_TTL_MS + 2,
    });
    expect(status).toBe('stale_lease');
    expect(stage1Count(db)).toBe(0);
  });

  it('10. complete(succeeded_no_output) writes a NULL content row and blocks re-extraction', () => {
    const lastMessageAt = T0 - 12 * HOUR;
    insertCatalogRow(db, {
      rollout_id: 'r10',
      last_message_at: lastMessageAt,
      source_fingerprint: 'fp10',
    });

    // Sanity: the rollout is eligible before completion.
    expect(selectEligible(db, { now: T0 }).map((e) => e.rolloutId)).toContain('r10');

    const a = mustAcquire(acquireLease(db, { rolloutId: 'r10', claimedBy: 'instA', now: T0 }));

    const status = complete(db, {
      rolloutId: 'r10',
      token: a.token,
      sourceUpdatedAt: lastMessageAt,
      sourceContentHash: 'fp10',
      outcome: 'succeeded_no_output',
      contentOutcome: null,
      rolloutSummary: null,
      rawMemoryJson: null,
      rolloutSlug: 'slug-r10',
      now: T0 + 60_000,
    });
    expect(status).toBe('committed');

    const row = db.prepare('SELECT * FROM stage1_outputs WHERE rollout_id = ?').get('r10') as {
      job_status: string;
      content_outcome: string | null;
      rollout_summary: string | null;
      raw_memory: string | null;
      rollout_slug: string;
      extracted_through_seq: number | null;
      schema_version: number;
    };
    expect(row.job_status).toBe('succeeded_no_output');
    expect(row.content_outcome).toBeNull();
    expect(row.rollout_summary).toBeNull();
    expect(row.raw_memory).toBeNull();
    expect(row.rollout_slug).toBe('slug-r10');
    expect(row.extracted_through_seq).toBeNull();
    expect(row.schema_version).toBe(2);

    // Lease consumed.
    expect(getLease(db, 'r10')).toBeUndefined();

    // D2: the persisted terminal state excludes the rollout from
    // further eligibility while the source is unchanged.
    expect(selectEligible(db, { now: T0 + HOUR }).map((e) => e.rolloutId)).not.toContain('r10');
  });
});

describe('complete happy path + acquire guards', () => {
  let fixture: MemoryStateFixture;
  let db: Database;

  beforeEach(() => {
    fixture = createMemoryStateFixture();
    db = fixture.db;
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('11. complete(succeeded) upserts the full stage1 row and deletes the lease', () => {
    const lastMessageAt = T0 - 12 * HOUR;
    insertCatalogRow(db, {
      rollout_id: 'ok1',
      last_message_at: lastMessageAt,
      source_fingerprint: 'fp-ok',
      working_directory: '/tmp/ws',
    });

    const a = mustAcquire(acquireLease(db, { rolloutId: 'ok1', claimedBy: 'instA', now: T0 }));

    const status = complete(db, {
      rolloutId: 'ok1',
      token: a.token,
      sourceUpdatedAt: lastMessageAt,
      sourceContentHash: 'fp-ok',
      outcome: 'succeeded',
      contentOutcome: 'partial',
      rolloutSummary: '# Summary',
      rawMemoryJson: '{"k":1}',
      rolloutSlug: 'ok-slug',
      now: T0 + 30_000,
    });
    expect(status).toBe('committed');

    const row = db.prepare('SELECT * FROM stage1_outputs WHERE rollout_id = ?').get('ok1') as Record<
      string,
      unknown
    >;
    expect(row.thread_id).toBe('ok1');
    expect(row.cwd).toBe('/tmp/ws');
    expect(row.project_id).toBe('global'); // global-scope catalog row → sentinel
    expect(row.git_branch).toBeNull();
    expect(row.job_status).toBe('succeeded');
    expect(row.content_outcome).toBe('partial');
    expect(row.rollout_summary).toBe('# Summary');
    expect(row.raw_memory).toBe('{"k":1}');
    expect(row.rollout_slug).toBe('ok-slug');
    expect(row.generated_at).toBe(T0 + 30_000);
    expect(row.source_updated_at).toBe(lastMessageAt);
    expect(row.source_content_hash).toBe('fp-ok');
    expect(row.extracted_through_seq).toBeNull();
    expect(row.output_updated_at).toBe(T0 + 30_000);
    expect(row.schema_version).toBe(2);
    expect(row.content_hash_at_write).toBeNull(); // Plan 303 owns this column

    expect(getLease(db, 'ok1')).toBeUndefined();
  });

  it('12. complete always writes the global sentinel for project_id', () => {
    const lastMessageAt = T0 - 12 * HOUR;
    db.prepare(
      'INSERT INTO projects (project_id, canonical_root, created_at, last_seen_at) VALUES (?, ?, ?, ?)'
    ).run('proj-1', '/tmp/proj-1', T0, T0);
    insertCatalogRow(db, {
      rollout_id: 'ok2',
      scope_kind: 'project',
      project_id: 'proj-1',
      last_message_at: lastMessageAt,
      source_fingerprint: 'fp-p',
    });

    const a = mustAcquire(acquireLease(db, { rolloutId: 'ok2', claimedBy: 'instA', now: T0 }));

    const status = complete(db, {
      rolloutId: 'ok2',
      token: a.token,
      sourceUpdatedAt: lastMessageAt,
      sourceContentHash: 'fp-p',
      outcome: 'succeeded',
      contentOutcome: 'success',
      rolloutSummary: 's',
      rawMemoryJson: '{}',
      rolloutSlug: 'proj-slug',
      now: T0 + 30_000,
    });
    expect(status).toBe('committed');

    const row = db
      .prepare('SELECT project_id FROM stage1_outputs WHERE rollout_id = ?')
      .get('ok2') as { project_id: string };
    expect(row.project_id).toBe('global');
  });

  it('13. acquire without a rollout_catalog row throws', () => {
    expect(() => acquireLease(db, { rolloutId: 'ghost', claimedBy: 'instA', now: T0 })).toThrow(
      'rollout not in catalog: ghost'
    );
  });
});

describe('backoffMs matrix', () => {
  it('attempts 1..9 follow the minute schedule', () => {
    const expectedMinutes = [5, 15, 60, 360, 360, 360, 1440, 1440, 1440];
    expectedMinutes.forEach((minutes, i) => {
      expect(backoffMs(i + 1)).toBe(minutes * 60 * 1000);
    });
  });

  it('attempt >= 10 → null (permanent retire)', () => {
    expect(backoffMs(10)).toBeNull();
  });
});
