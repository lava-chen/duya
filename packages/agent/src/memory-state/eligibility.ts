import type { Database } from 'better-sqlite3';

/**
 * Memory v2 eligibility query (Plan 302 Phase B, design v3 Scheduler 决策).
 *
 * Picks rollouts that are due for Stage 1 extraction. The SQL below is
 * the design doc's authoritative query verbatim:
 *   - only `agent_type='main'` rollouts; automation sessions carry
 *     `agent_type='main' + mode='automation'` and are excluded HERE
 *     (the catalog sync copies values verbatim, it does not filter)
 *   - only active sources within the idle/window bounds
 *   - eligible when: never successfully extracted, OR the source
 *     advanced since the last success (D3 re-extract), OR a previous
 *     attempt failed and its backoff elapsed
 *   - permanently retired rollouts are hard-excluded
 *   - ordered by idle time DESC (longest-idle first)
 *
 * The DB handle is injected as the first parameter (packages/agent
 * must not import the Electron DB singleton; Plan 305 wires it).
 *
 * Shadow mode: no production caller until Plan 305 wires the worker.
 */

export const DEFAULT_ELIGIBILITY_LIMIT = 16;
export const DEFAULT_IDLE_MS = 6 * 3600 * 1000; // 6h
export const DEFAULT_WINDOW_MS = 30 * 86400 * 1000; // 30d
/** Minimum message count for a session to be eligible for extraction. Filters out thin sessions. */
export const DEFAULT_MIN_MESSAGE_COUNT = 6;

export interface EligibleRollout {
  rolloutId: string;
  lastMessageAt: number; // ms
  sourceFingerprint: string;
}

const SELECT_ELIGIBLE_SQL = `
SELECT r.rollout_id, r.last_message_at, r.source_fingerprint
FROM rollout_catalog r
WHERE r.agent_type = 'main'
  AND (r.mode IS NULL OR r.mode != 'automation')
  AND r.source_status = 'active'
  AND r.message_count >= :minMessageCount
  AND r.last_message_at < :now - :idleMs
  AND r.last_message_at > :now - :windowMs
  AND (
    NOT EXISTS (
      SELECT 1 FROM stage1_outputs s
      WHERE s.rollout_id = r.rollout_id
        AND s.job_status IN ('succeeded','succeeded_no_output'))
    OR EXISTS (
      SELECT 1 FROM stage1_outputs s
      WHERE s.rollout_id = r.rollout_id
        AND s.job_status IN ('succeeded','succeeded_no_output')
        AND (s.source_updated_at < r.last_message_at
             OR s.source_content_hash != r.source_fingerprint))
    OR EXISTS (
      SELECT 1 FROM rollout_leases l
      WHERE l.rollout_id = r.rollout_id
        AND l.job_status = 'failed'
        AND (l.next_retry_at IS NULL OR l.next_retry_at <= :now))
  )
  AND NOT EXISTS (SELECT 1 FROM rollout_retired t WHERE t.rollout_id = r.rollout_id)
ORDER BY (:now - r.last_message_at) DESC
LIMIT :limit
`;

interface EligibleRow {
  rollout_id: string;
  last_message_at: number;
  source_fingerprint: string | null;
}

export function selectEligible(
  db: Database,
  input: {
    now: number; // ms
    limit?: number; // default 16
    idleMs?: number; // default 6h
    windowMs?: number; // default 30d
    minMessageCount?: number; // default 6
  }
): EligibleRollout[] {
  const rows = db
    .prepare(SELECT_ELIGIBLE_SQL)
    .all({
      now: input.now,
      limit: input.limit ?? DEFAULT_ELIGIBILITY_LIMIT,
      idleMs: input.idleMs ?? DEFAULT_IDLE_MS,
      windowMs: input.windowMs ?? DEFAULT_WINDOW_MS,
      minMessageCount: input.minMessageCount ?? DEFAULT_MIN_MESSAGE_COUNT,
    }) as EligibleRow[];

  return rows.map((row) => ({
    rolloutId: row.rollout_id,
    lastMessageAt: row.last_message_at,
    sourceFingerprint: row.source_fingerprint ?? '',
  }));
}
