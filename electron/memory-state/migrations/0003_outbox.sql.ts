import * as crypto from 'crypto';

/**
 * Migration 0003: Projection outbox + write-time content fingerprint
 * (Memory v2 Phase 1A.3, design D12).
 *
 * Creates:
 *   - projection_outbox  (DB ↔ file atomicity queue)
 *
 * Alters:
 *   - stage1_outputs ADD COLUMN content_hash_at_write
 *     (sha256 of the file content at write time; reconcile compares the
 *     on-disk file against this fingerprint. NULL for rows written
 *     before this migration.)
 *
 * Requires migration 0002 (stage1_outputs) to be applied first — the
 * ALTER targets a 0002 table.
 *
 * Contract (see Plan 303):
 *   1. Every DB INSERT into stage1_outputs also writes an outbox row in
 *      the SAME transaction.
 *   2. A sweeper drains pending rows; failures go through exponential
 *      backoff and retire after MAX_ATTEMPTS.
 *   3. DB is the source of truth; files are always rebuildable from DB.
 *
 * Timestamps are INTEGER ms (matches the rest of the control plane).
 */
const SQL = `
CREATE TABLE projection_outbox (
  projection_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  target_path           TEXT NOT NULL,
  operation             TEXT NOT NULL CHECK (operation IN ('write','delete')),
  content               TEXT,
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at       INTEGER,
  last_error            TEXT,
  enqueued_at           INTEGER NOT NULL,
  completed_at          INTEGER
);
CREATE INDEX idx_outbox_pending ON projection_outbox(completed_at, next_attempt_at);

ALTER TABLE stage1_outputs ADD COLUMN content_hash_at_write TEXT;
`;

export const migration0003 = {
  version: 3,
  name: 'projection_outbox',
  sql: SQL,
  sha256: crypto.createHash('sha256').update(SQL).digest('hex'),
};
