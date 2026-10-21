import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';

/**
 * Source fingerprint for a chat session.
 *
 * `source_fingerprint` is the canonical SHA-256 of a session's contents
 * as seen by the future Stage 1 extractor (Plan 304). Two sessions with
 * the same fingerprint produce identical extraction inputs; a change to
 * the fingerprint signals that the session has new content and the
 * `generation` counter on `rollout_catalog` should be bumped.
 *
 * Plan 328 decision 10: the fingerprint input changed from full message
 * rows (12 columns from the legacy `messages` table) to `message_index`
 * rows (id + seq + created_at) from the core database. Any append or
 * rewrite changes this sequence, so change detection is semantically
 * equivalent without reading payload bytes. The switch invalidates all
 * previously-computed fingerprints once (memory catalog rebuilds on
 * first sync after upgrade).
 *
 * Determinism contract:
 *   - Stable key order: alphabetic (a-z) per message object.
 *   - No whitespace in JSON output (compact serialization).
 *   - UTF-8 bytes are hashed.
 *   - Order of messages matters: `ORDER BY seq ASC` matches the
 *     canonical rollout file order (message_index.seq is the 1-based
 *     line number in the rollout file).
 */

export interface MessageForHash {
  id: string;
  seq: number;
  created_at: number;
}

/**
 * Alphabetic key order for stable serialization. DO NOT reorder —
 * changing this array invalidates every previously-computed fingerprint
 * and forces every rollout's `generation` to bump on the next sync.
 *
 * `JSON.stringify` is used per-value so escaping of strings and
 * null/number serialization match canonical JSON exactly.
 */
const MESSAGE_KEYS_IN_ORDER: ReadonlyArray<keyof MessageForHash> = [
  'created_at',
  'id',
  'seq',
];

function serializeMessage(msg: MessageForHash): string {
  const parts: string[] = [];
  for (const key of MESSAGE_KEYS_IN_ORDER) {
    const value = msg[key];
    parts.push(`"${key}":${JSON.stringify(value)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Compute the canonical SHA-256 fingerprint for a list of message index
 * rows.
 *
 * Empty input returns SHA-256 of the UTF-8 bytes of `[]` (the empty
 * JSON array) — i.e. a fixed, deterministic hash.
 */
export function computeSourceFingerprint(messages: MessageForHash[]): string {
  const serialized = `[${messages.map(serializeMessage).join(',')}]`;
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * Read message index rows from the core database and project them into
 * the `MessageForHash` shape for fingerprinting.
 *
 * Plan 328 decision 10: reads from `message_index` (id, seq, created_at)
 * instead of the legacy `messages` table. The `message_index` table
 * contains only live rows (no `status` column — superseded/purged
 * messages are physically removed by `rewriteSession`), so no status
 * filter is needed. Order is `seq ASC` (deterministic rollout line
 * order).
 */
export function readMessagesForFingerprint(coreDb: Database, sessionId: string): MessageForHash[] {
  const rows = coreDb
    .prepare(
      `SELECT id, seq, created_at
       FROM message_index
       WHERE session_id = ?
       ORDER BY seq ASC`
    )
    .all(sessionId) as MessageForHash[];
  return rows;
}
