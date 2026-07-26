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
 * Determinism contract:
 *   - Stable key order: alphabetic (a-z) per message object.
 *   - No whitespace in JSON output (compact serialization).
 *   - UTF-8 bytes are hashed.
 *   - Excluded fields (UI-only or internal-only): `token_usage`,
 *     `viz_spec`, `sub_agent_id`, `display_content`.
 *   - Order of messages matters: `ORDER BY created_at ASC, rowid ASC`
 *     matches the canonical read path used everywhere else in the
 *     codebase (`electron/db/queries/messages.ts:getMessagesBySession`).
 *   - Message status filter: `NOT IN ('superseded', 'purged')` — same
 *     as the live read path. The plan originally said
 *     `IN ('done','in_progress')` but the actual codebase uses the
 *     negative filter; we match the codebase.
 */

export interface MessageForHash {
  id: string;
  role: string;
  content: string;
  msg_type: string;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_input: string | null;
  thinking: string | null;
  parent_tool_call_id: string | null;
  name: string | null;
  seq_index: number | null;
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
  'content',
  'created_at',
  'id',
  'msg_type',
  'name',
  'parent_tool_call_id',
  'role',
  'seq_index',
  'thinking',
  'tool_call_id',
  'tool_input',
  'tool_name',
];

function serializeMessage(msg: MessageForHash): string {
  const parts: string[] = [];
  for (const key of MESSAGE_KEYS_IN_ORDER) {
    const value = msg[key];
    // JSON.stringify(string) -> "..." (escaped)
    // JSON.stringify(number) -> "123"
    // JSON.stringify(null)   -> "null"
    parts.push(`"${key}":${JSON.stringify(value)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Compute the canonical SHA-256 fingerprint for a list of messages.
 *
 * Empty input returns SHA-256 of the UTF-8 bytes of `[]` (the empty
 * JSON array) — i.e. a fixed, deterministic hash.
 */
export function computeSourceFingerprint(messages: MessageForHash[]): string {
  const serialized = `[${messages.map(serializeMessage).join(',')}]`;
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * Read messages from the main DB and project them into the
 * `MessageForHash` shape for fingerprinting.
 *
 * Excludes the columns the fingerprint must NOT depend on:
 * `token_usage`, `viz_spec`, `sub_agent_id`, `display_content`.
 *
 * Uses the same status filter and ORDER BY as the canonical read path
 * in `electron/db/queries/messages.ts:getMessagesBySession` so the
 * fingerprint matches what users actually see.
 */
export function readMessagesForFingerprint(mainDb: Database, sessionId: string): MessageForHash[] {
  const rows = mainDb
    .prepare(
      `SELECT id, role, content, msg_type, tool_call_id, tool_name, tool_input,
              thinking, parent_tool_call_id, name, seq_index, created_at
       FROM messages
       WHERE session_id = ? AND status NOT IN ('superseded', 'purged')
       ORDER BY created_at ASC, rowid ASC`
    )
    .all(sessionId) as MessageForHash[];
  return rows;
}
