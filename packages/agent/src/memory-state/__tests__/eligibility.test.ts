import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import {
  selectEligible,
  DEFAULT_ELIGIBILITY_LIMIT,
  DEFAULT_IDLE_MS,
  DEFAULT_WINDOW_MS,
} from '../eligibility';
import {
  createMemoryStateFixture,
  insertCatalogRow,
  insertStage1Output,
  type MemoryStateFixture,
} from './fixture';

/**
 * Eligibility matrix (Plan 302 Phase C, design v3 Scheduler 决策).
 *
 * Baseline eligible rollout: agent_type='main', no mode, active source,
 * last_message_at 12h ago (past the 6h idle threshold, inside the 30d
 * window), no stage1_outputs row, no lease, not retired.
 */

const T0 = 1_750_000_000_000;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const BASE_LAST_MESSAGE_AT = T0 - 12 * HOUR;

function eligibleIds(db: Database, now = T0): string[] {
  return selectEligible(db, { now }).map((e) => e.rolloutId);
}

/**
 * Insert a failed lease row directly (the shared fixture has no helper
 * for rollout_leases). `nextRetryAt = null` means immediately
 * retryable.
 */
function insertFailedLease(db: Database, rolloutId: string, nextRetryAt: number | null): void {
  db.prepare(
    `INSERT INTO rollout_leases (
       rollout_id, token, acquired_at, heartbeat_at, expires_at,
       attempt_count, next_retry_at, claimed_by, idempotency_token,
       last_error, source_updated_at, source_content_hash, job_status
     ) VALUES (?, ?, ?, ?, ?, 1, ?, 'instA', NULL, 'boom', 0, '', 'failed')`
  ).run(rolloutId, `tok-${rolloutId}`, T0 - HOUR, T0 - HOUR, T0, nextRetryAt);
}

describe('selectEligible', () => {
  let fixture: MemoryStateFixture;
  let db: Database;

  beforeEach(() => {
    fixture = createMemoryStateFixture();
    db = fixture.db;
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("1. agent_type other than 'main' is excluded ('sub-agent' with hyphen, 'gateway')", () => {
    insertCatalogRow(db, { rollout_id: 'main-ok', last_message_at: BASE_LAST_MESSAGE_AT });
    insertCatalogRow(db, { rollout_id: 'sub', agent_type: 'sub-agent', last_message_at: BASE_LAST_MESSAGE_AT });
    insertCatalogRow(db, { rollout_id: 'gw', agent_type: 'gateway', last_message_at: BASE_LAST_MESSAGE_AT });

    const ids = eligibleIds(db);
    expect(ids).toContain('main-ok');
    expect(ids).not.toContain('sub');
    expect(ids).not.toContain('gw');
  });

  it("2. agent_type='main' + mode='automation' is excluded", () => {
    insertCatalogRow(db, { rollout_id: 'plain', last_message_at: BASE_LAST_MESSAGE_AT });
    insertCatalogRow(db, { rollout_id: 'cron', mode: 'automation', last_message_at: BASE_LAST_MESSAGE_AT });

    const ids = eligibleIds(db);
    expect(ids).toContain('plain');
    expect(ids).not.toContain('cron');
  });

  it("3. source_status='deleted' / 'missing' is excluded", () => {
    insertCatalogRow(db, { rollout_id: 'active', last_message_at: BASE_LAST_MESSAGE_AT });
    insertCatalogRow(db, { rollout_id: 'del', source_status: 'deleted', last_message_at: BASE_LAST_MESSAGE_AT });
    insertCatalogRow(db, { rollout_id: 'mis', source_status: 'missing', last_message_at: BASE_LAST_MESSAGE_AT });

    const ids = eligibleIds(db);
    expect(ids).toContain('active');
    expect(ids).not.toContain('del');
    expect(ids).not.toContain('mis');
  });

  it('4. last_message_at within the idle window (< 6h ago) is excluded', () => {
    insertCatalogRow(db, { rollout_id: 'idle-ok', last_message_at: T0 - DEFAULT_IDLE_MS - 1 });
    insertCatalogRow(db, { rollout_id: 'recent', last_message_at: T0 - HOUR });

    const ids = eligibleIds(db);
    expect(ids).toContain('idle-ok');
    expect(ids).not.toContain('recent');
  });

  it('5. last_message_at older than the 30d window is excluded', () => {
    insertCatalogRow(db, { rollout_id: 'in-window', last_message_at: T0 - DEFAULT_WINDOW_MS + HOUR });
    insertCatalogRow(db, { rollout_id: 'ancient', last_message_at: T0 - 31 * DAY });

    const ids = eligibleIds(db);
    expect(ids).toContain('in-window');
    expect(ids).not.toContain('ancient');
  });

  it('6. no stage1_outputs row → eligible', () => {
    insertCatalogRow(db, { rollout_id: 'never', last_message_at: BASE_LAST_MESSAGE_AT });
    expect(eligibleIds(db)).toContain('never');
  });

  it('7. succeeded_no_output row with unchanged source → excluded', () => {
    insertCatalogRow(db, {
      rollout_id: 'no-out',
      last_message_at: BASE_LAST_MESSAGE_AT,
      source_fingerprint: 'fp-no',
    });
    insertStage1Output(db, {
      rollout_id: 'no-out',
      job_status: 'succeeded_no_output',
      content_outcome: null,
      rollout_summary: null,
      source_updated_at: BASE_LAST_MESSAGE_AT,
      source_content_hash: 'fp-no',
    });

    expect(eligibleIds(db)).not.toContain('no-out');
  });

  it('8. succeeded row but source advanced (timestamp or fingerprint) → eligible (D3 re-extract)', () => {
    // Timestamp advanced.
    insertCatalogRow(db, {
      rollout_id: 'time-moved',
      last_message_at: BASE_LAST_MESSAGE_AT,
      source_fingerprint: 'same-fp',
    });
    insertStage1Output(db, {
      rollout_id: 'time-moved',
      source_updated_at: BASE_LAST_MESSAGE_AT - HOUR,
      source_content_hash: 'same-fp',
    });

    // Fingerprint changed (same timestamp).
    insertCatalogRow(db, {
      rollout_id: 'fp-moved',
      last_message_at: BASE_LAST_MESSAGE_AT,
      source_fingerprint: 'new-fp',
    });
    insertStage1Output(db, {
      rollout_id: 'fp-moved',
      source_updated_at: BASE_LAST_MESSAGE_AT,
      source_content_hash: 'old-fp',
    });

    // Unchanged source stays excluded (control).
    insertCatalogRow(db, {
      rollout_id: 'unchanged',
      last_message_at: BASE_LAST_MESSAGE_AT,
      source_fingerprint: 'fp-ctl',
    });
    insertStage1Output(db, {
      rollout_id: 'unchanged',
      source_updated_at: BASE_LAST_MESSAGE_AT,
      source_content_hash: 'fp-ctl',
    });

    const ids = eligibleIds(db);
    expect(ids).toContain('time-moved');
    expect(ids).toContain('fp-moved');
    expect(ids).not.toContain('unchanged');
  });

  it('9. failed lease with elapsed backoff → eligible even with an unchanged success row', () => {
    insertCatalogRow(db, {
      rollout_id: 'retry-ok',
      last_message_at: BASE_LAST_MESSAGE_AT,
      source_fingerprint: 'fp9',
    });
    insertStage1Output(db, {
      rollout_id: 'retry-ok',
      source_updated_at: BASE_LAST_MESSAGE_AT,
      source_content_hash: 'fp9',
    });
    insertFailedLease(db, 'retry-ok', T0 - 1);

    expect(eligibleIds(db)).toContain('retry-ok');
  });

  it('10. failed lease with backoff still in the future → excluded', () => {
    insertCatalogRow(db, {
      rollout_id: 'retry-later',
      last_message_at: BASE_LAST_MESSAGE_AT,
      source_fingerprint: 'fp10',
    });
    insertStage1Output(db, {
      rollout_id: 'retry-later',
      source_updated_at: BASE_LAST_MESSAGE_AT,
      source_content_hash: 'fp10',
    });
    insertFailedLease(db, 'retry-later', T0 + HOUR);

    expect(eligibleIds(db)).not.toContain('retry-later');
  });

  it('11. retired rollout is hard-excluded', () => {
    insertCatalogRow(db, { rollout_id: 'retired', last_message_at: BASE_LAST_MESSAGE_AT });
    db.prepare(
      'INSERT INTO rollout_retired (rollout_id, attempt_count, last_error, retired_at) VALUES (?, 10, ?, ?)'
    ).run('retired', 'gave up', T0 - DAY);

    expect(eligibleIds(db)).not.toContain('retired');
  });

  it('12. more eligible rollouts than the limit → returns limit rows, idle-DESC order', () => {
    // 20 rollouts, idle from 7h (least idle) to 26h (most idle).
    for (let i = 0; i < 20; i++) {
      insertCatalogRow(db, {
        rollout_id: `bulk-${String(i).padStart(2, '0')}`,
        last_message_at: T0 - (7 + i) * HOUR,
      });
    }

    const result = selectEligible(db, { now: T0, limit: DEFAULT_ELIGIBILITY_LIMIT });
    expect(result).toHaveLength(16);
    // Longest-idle first: bulk-19 (26h idle) … bulk-04 (11h idle).
    expect(result[0].rolloutId).toBe('bulk-19');
    expect(result[15].rolloutId).toBe('bulk-04');
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].lastMessageAt).toBeLessThanOrEqual(result[i].lastMessageAt);
    }
  });

  it('result shape maps catalog columns to camelCase fields', () => {
    insertCatalogRow(db, {
      rollout_id: 'shape',
      scope_kind: 'global',
      project_id: null,
      last_message_at: BASE_LAST_MESSAGE_AT,
      source_fingerprint: 'fp-shape',
    });

    const [row] = selectEligible(db, { now: T0 });
    expect(row).toEqual({
      rolloutId: 'shape',
      lastMessageAt: BASE_LAST_MESSAGE_AT,
      sourceFingerprint: 'fp-shape',
    });
  });
});
