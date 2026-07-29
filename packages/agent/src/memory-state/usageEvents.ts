/**
 * Memory v2 usage event telemetry (Plan 306 Phase D).
 *
 * Records retrieval / citation / influence feedback for memory entries
 * so the consolidator (Phase B) can score and rank memories by
 * real-world usefulness.
 *
 * Every public function takes the better-sqlite3 handle as its first
 * parameter (packages/agent must not import the Electron DB singleton;
 * the caller wires a concrete handle).
 *
 * Lifecycle:
 *   1. MemoryRecallTool.execute → recordRetrieval(memoryId, sessionId,
 *      retrievalId) inserts a row with retrieved=1, cited=0,
 *      influenced_answer=0, classification_method='pending'.
 *   2. Post-stream classifier (future) → updateClassification(...) sets
 *      cited / influenced_answer / classification_method.
 *   3. consolidateRetrievalOutcome(retrievalId) returns the per-memory
 *      three-state feedback for analysis.
 */

import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RecordRetrievalInput {
  memoryId: string;
  sessionId: string;
  /** UUID per recall tool call; groups all memories returned in one call. */
  retrievalId: string;
  now?: number;
}

export interface UpdateClassificationInput {
  retrievalId: string;
  memoryId: string;
  cited?: boolean;
  influencedAnswer?: boolean;
  method: 'model_citation' | 'parser' | 'classifier';
}

export interface RetrievalOutcome {
  retrieved: number;
  cited: number;
  influencedAnswer: number;
  method: string;
}

// ---------------------------------------------------------------------------
// recordRetrieval
// ---------------------------------------------------------------------------

/**
 * Insert a usage event row marking that `memoryId` was retrieved in the
 * `retrievalId` recall call.
 *
 * Idempotent: a second call with the same (memoryId, retrievalId) is a
 * no-op (the schema has no UNIQUE constraint on the pair, so we guard
 * with a SELECT inside a transaction). This keeps retry-safe callers
 * from minting duplicate telemetry rows.
 */
export function recordRetrieval(db: Database, input: RecordRetrievalInput): void {
  const now = input.now ?? Date.now();

  const txn = db.transaction(() => {
    const existing = db
      .prepare(
        'SELECT 1 FROM memory_usage_events WHERE memory_id = ? AND retrieval_id = ?'
      )
      .get(input.memoryId, input.retrievalId);
    if (existing) {
      return;
    }
    db.prepare(
      `INSERT INTO memory_usage_events
         (memory_id, session_id, retrieval_id, retrieved_at,
          retrieved, cited, influenced_answer, classification_method)
       VALUES (?, ?, ?, ?, 1, 0, 0, 'pending')`
    ).run(input.memoryId, input.sessionId, input.retrievalId, now);
  });

  txn.immediate();
}

// ---------------------------------------------------------------------------
// updateClassification
// ---------------------------------------------------------------------------

/**
 * Backfill citation / influence feedback for a single (memoryId,
 * retrievalId) row. Idempotent: a no-op when no matching row exists
 * (matches the silent no-op pattern used by lease.fail()).
 *
 * `cited` and `influencedAnswer` are optional — undefined fields keep
 * their current value (via SQL COALESCE). `method` is always set so
 * the classifier pipeline can trace which stage wrote the feedback.
 */
export function updateClassification(db: Database, input: UpdateClassificationInput): void {
  const citedValue = input.cited === undefined ? null : input.cited ? 1 : 0;
  const influencedValue =
    input.influencedAnswer === undefined ? null : input.influencedAnswer ? 1 : 0;

  db.prepare(
    `UPDATE memory_usage_events
       SET cited = COALESCE(?, cited),
           influenced_answer = COALESCE(?, influenced_answer),
           classification_method = ?
     WHERE memory_id = ? AND retrieval_id = ?`
  ).run(
    citedValue,
    influencedValue,
    input.method,
    input.memoryId,
    input.retrievalId
  );
}

// ---------------------------------------------------------------------------
// classifyRetrievalOutcome
// ---------------------------------------------------------------------------

/**
 * Return the per-memory three-state feedback for every usage event in
 * the given retrieval group. One row per memory that was retrieved.
 *
 * Three-state feedback:
 *   - retrieved=1, cited=0, influenced=0 → shown but ignored
 *   - retrieved=1, cited=1, influenced=0 → cited but didn't shape answer
 *   - retrieved=1, cited=1, influenced=1 → cited and shaped answer
 *
 * Returns an empty array when the retrieval_id is unknown (no rows).
 */
export function classifyRetrievalOutcome(
  db: Database,
  retrievalId: string
): RetrievalOutcome[] {
  const rows = db
    .prepare(
      `SELECT retrieved, cited, influenced_answer, classification_method
       FROM memory_usage_events
       WHERE retrieval_id = ?`
    )
    .all(retrievalId) as Array<{
    retrieved: number;
    cited: number;
    influenced_answer: number;
    classification_method: string;
  }>;

  return rows.map((r) => ({
    retrieved: r.retrieved,
    cited: r.cited,
    influencedAnswer: r.influenced_answer,
    method: r.classification_method,
  }));
}
