import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import {
  selectEligible,
  diagnoseEligibility,
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
 * last_message_at 13h ago (past the 12h idle threshold, inside the 30d
 * window), no stage1_outputs row, no lease, not retired.
 */

const T0 = 1_750_000_000_000;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const BASE_LAST_MESSAGE_AT = T0 - 13 * HOUR;

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

  it("2. cron sessions (mode='automation' legacy) are eligible like any other", () => {
    insertCatalogRow(db, { rollout_id: 'plain', last_message_at: BASE_LAST_MESSAGE_AT });
    insertCatalogRow(db, { rollout_id: 'cron', mode: 'automation', last_message_at: BASE_LAST_MESSAGE_AT });

    const ids = eligibleIds(db);
    expect(ids).toContain('plain');
    expect(ids).toContain('cron');
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

  it('10b. never extracted + failed lease in backoff → excluded so it does not starve newer rollouts', () => {
    insertCatalogRow(db, {
      rollout_id: 'never-but-backoff',
      last_message_at: BASE_LAST_MESSAGE_AT - HOUR, // older than the other rollout
      source_fingerprint: 'fp10b',
    });
    insertFailedLease(db, 'never-but-backoff', T0 + HOUR);

    insertCatalogRow(db, {
      rollout_id: 'fresh-never',
      last_message_at: BASE_LAST_MESSAGE_AT,
      source_fingerprint: 'fp10b-fresh',
    });

    const ids = eligibleIds(db);
    expect(ids).not.toContain('never-but-backoff');
    expect(ids).toContain('fresh-never');
  });

  it('10c. never extracted + failed lease with elapsed backoff → eligible', () => {
    insertCatalogRow(db, {
      rollout_id: 'never-retry-now',
      last_message_at: BASE_LAST_MESSAGE_AT,
      source_fingerprint: 'fp10c',
    });
    insertFailedLease(db, 'never-retry-now', T0 - 1);

    expect(eligibleIds(db)).toContain('never-retry-now');
  });

  it("10d. re-extract (source advanced) + failed lease in future backoff → excluded so it does not starve fresh rollouts", () => {
    // A previously-succeeded rollout whose source advanced (so it is due
    // for re-extraction) but whose last attempt failed and is still backing
    // off. It must be excluded while backing off, otherwise it is selected
    // every tick, acquireLease returns busy, and it is skipped as a noop —
    // permanently occupying a concurrency slot and starving the fresh
    // rollout below.
    insertCatalogRow(db, {
      rollout_id: 'rextract-backoff',
      last_message_at: BASE_LAST_MESSAGE_AT - HOUR, // older → would sort first
      source_fingerprint: 'fp-new',
    });
    insertStage1Output(db, {
      rollout_id: 'rextract-backoff',
      content_outcome: 'success',
      source_updated_at: BASE_LAST_MESSAGE_AT - 2 * HOUR,
      source_content_hash: 'fp-old',
    });
    insertFailedLease(db, 'rextract-backoff', T0 + HOUR);

    insertCatalogRow(db, {
      rollout_id: 'fresh-never2',
      last_message_at: BASE_LAST_MESSAGE_AT,
      source_fingerprint: 'fp-fresh2',
    });

    const ids = eligibleIds(db);
    expect(ids).not.toContain('rextract-backoff');
    expect(ids).toContain('fresh-never2');
  });

  it('11. retired rollout is hard-excluded', () => {
    insertCatalogRow(db, { rollout_id: 'retired', last_message_at: BASE_LAST_MESSAGE_AT });
    db.prepare(
      'INSERT INTO rollout_retired (rollout_id, attempt_count, last_error, retired_at) VALUES (?, 10, ?, ?)'
    ).run('retired', 'gave up', T0 - DAY);

    expect(eligibleIds(db)).not.toContain('retired');
  });

  it('12. more eligible rollouts than the limit → returns limit rows, idle-DESC order', () => {
    // 20 rollouts, idle from 7h (least idle) to 26h (most idle). With the
    // 12h idle threshold only 14 (13h..26h idle) qualify.
    for (let i = 0; i < 20; i++) {
      insertCatalogRow(db, {
        rollout_id: `bulk-${String(i).padStart(2, '0')}`,
        last_message_at: T0 - (7 + i) * HOUR,
      });
    }

    const result = selectEligible(db, { now: T0, limit: DEFAULT_ELIGIBILITY_LIMIT });
    expect(result).toHaveLength(14);
    // Longest-idle first: bulk-19 (26h idle) … bulk-06 (13h idle).
    expect(result[0].rolloutId).toBe('bulk-19');
    expect(result[13].rolloutId).toBe('bulk-06');
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

describe('diagnoseEligibility', () => {
  let fixture: MemoryStateFixture;
  let db: Database;

  beforeEach(() => {
    fixture = createMemoryStateFixture();
    db = fixture.db;
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('counts catalog rows bucketed by the selectEligible gates', () => {
    // Eligible: idle 13h, main, active, 10 messages.
    insertCatalogRow(db, { rollout_id: 'ready', last_message_at: BASE_LAST_MESSAGE_AT });
    // Not idle: recent last_message_at.
    insertCatalogRow(db, { rollout_id: 'fresh', last_message_at: T0 - 2 * HOUR });
    // Too few messages.
    insertCatalogRow(db, { rollout_id: 'thin', message_count: 2, last_message_at: BASE_LAST_MESSAGE_AT });
    // Non-main agent.
    insertCatalogRow(db, { rollout_id: 'gw', agent_type: 'gateway', last_message_at: BASE_LAST_MESSAGE_AT });
    // Already extracted (succeeded stage1_outputs).
    const extracted = insertCatalogRow(db, { rollout_id: 'done', last_message_at: BASE_LAST_MESSAGE_AT });
    insertStage1Output(db, { rollout_id: extracted, job_status: 'succeeded' });

    const diag = diagnoseEligibility(db, { now: T0 });

    expect(diag.total).toBe(5);
    expect(diag.activeMain).toBe(4); // ready, fresh, thin, done
    expect(diag.enoughMessages).toBe(3); // ready, fresh, done
    expect(diag.idleReady).toBe(2); // ready + done (both idle & enough, done already extracted)
    expect(diag.alreadyExtracted).toBe(1); // done
  });

  it('returns zeroes on an empty catalog', () => {
    expect(diagnoseEligibility(db, { now: T0 })).toEqual({
      total: 0,
      activeMain: 0,
      enoughMessages: 0,
      idleReady: 0,
      alreadyExtracted: 0,
    });
  });
});
