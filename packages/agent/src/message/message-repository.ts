/**
 * message-repository.ts - Entry-level append-only persistence for
 * MessageTimelineEntry (MessageEntry, CompactionEntry, ModelChangeEntry,
 * ModeChangeEntry, BranchEntry, CustomStateEntry).
 *
 * The legacy DB layer (db.ts) persists Message[] rows. This repository adds
 * entry-level append-only persistence so that CompactionEntry checkpoints and
 * other timeline entries survive across process restarts. The DB handle is
 * abstracted via RepositoryDatabase so the Agent subprocess can use it through
 * an IPC proxy and tests can mock it without better-sqlite3.
 *
 * @deprecated Plan 317: this `conversation_entries` persistence is NOT wired
 * into the runtime and is sealed. All runtime message persistence uses the
 * `messages` table via `appendMessages` in session/db.ts. Do not wire this
 * repository into the process entry path.
 */

import type {
  BranchEntry,
  CompactionEntry,
  CustomStateEntry,
  MessageEntry,
  MessageTimelineEntry,
  ModelChangeEntry,
  ModeChangeEntry,
} from './message-framework.js';

// =============================================================================
// DB Row Format
// =============================================================================

/**
 * Row format for the conversation_entries table. One row per timeline entry.
 * Entry-specific fields are serialized to JSON in `payload`. The `entry_type`
 * union mirrors the `type` discriminator of MessageTimelineEntry.
 */
export interface ConversationEntryRow {
  id: string;
  session_id: string;
  entry_type:
    | 'message'
    | 'compaction'
    | 'model_change'
    | 'mode_change'
    | 'branch'
    | 'custom_state';
  parent_id: string | null;
  created_at: number;
  seq_index: number;
  status: 'active' | 'superseded' | 'purged';
  /** Entry-specific payload (JSON). */
  payload: string;
}

// =============================================================================
// Database Abstraction
// =============================================================================

/**
 * Minimal prepared-statement interface mirroring the subset of better-sqlite3's
 * Statement API that SqliteMessageRepository needs. Return types are `unknown`
 * (not ConversationEntryRow) so the same statement can serve non-entry queries
 * such as MAX(seq_index); callers cast as needed.
 */
export interface RepositoryStatement {
  run(...params: unknown[]): void;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown | undefined;
}

/**
 * Minimal database interface used by SqliteMessageRepository. This abstracts
 * away better-sqlite3 so the repository can run in the Agent subprocess via an
 * IPC proxy and in tests via a mock. The shape matches better-sqlite3's
 * Database API (prepare, exec, transaction).
 */
export interface RepositoryDatabase {
  prepare(sql: string): RepositoryStatement;
  exec(sql: string): void;
  /**
   * Wrap a function in a transaction (better-sqlite3's `db.transaction()`
   * semantics). The returned function executes the callback atomically.
   */
  transaction<T>(fn: () => T): () => T;
}

// =============================================================================
// Schema
// =============================================================================

/**
 * SQL to create the conversation_entries table and its indexes.
 * Safe to call multiple times (uses IF NOT EXISTS).
 */
export function createConversationEntriesTable(): string {
  return `
    CREATE TABLE IF NOT EXISTS conversation_entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      parent_id TEXT,
      created_at INTEGER NOT NULL,
      seq_index INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_entries_session
      ON conversation_entries(session_id, seq_index);
    CREATE INDEX IF NOT EXISTS idx_conversation_entries_status
      ON conversation_entries(session_id, status);
  `;
}

// =============================================================================
// Serialization
// =============================================================================

/**
 * Serialize a MessageTimelineEntry into a ConversationEntryRow for storage.
 * Entry-specific fields are JSON-encoded into `payload`.
 *
 * `readonly` arrays (e.g. compactedMessageIds, reinjectedSystemMessages) are
 * preserved by JSON.stringify — readonly is a TypeScript type-level constraint,
 * not a runtime property, so no explicit conversion is needed.
 */
export function serializeEntry(
  entry: MessageTimelineEntry,
  sessionId: string,
  seqIndex: number,
): ConversationEntryRow {
  const base = {
    id: entry.id,
    session_id: sessionId,
    parent_id: entry.parentId,
    created_at: entry.createdAt,
    seq_index: seqIndex,
    status: 'active' as const,
  };

  switch (entry.type) {
    case 'message':
      return {
        ...base,
        entry_type: 'message',
        payload: JSON.stringify({ message: entry.message }),
      };
    case 'compaction':
      return {
        ...base,
        entry_type: 'compaction',
        payload: JSON.stringify({
          summary: entry.summary,
          firstKeptMessageId: entry.firstKeptMessageId,
          compactedMessageIds: entry.compactedMessageIds,
          tokensBefore: entry.tokensBefore,
          tokensAfter: entry.tokensAfter,
          strategy: entry.strategy,
          previousCompactionId: entry.previousCompactionId,
          reinjectedSystemMessages: entry.reinjectedSystemMessages,
        }),
      };
    case 'model_change':
      return {
        ...base,
        entry_type: 'model_change',
        payload: JSON.stringify({
          fromModel: entry.fromModel,
          toModel: entry.toModel,
          fromProvider: entry.fromProvider,
          toProvider: entry.toProvider,
          reason: entry.reason,
        }),
      };
    case 'mode_change':
      return {
        ...base,
        entry_type: 'mode_change',
        payload: JSON.stringify({
          fromMode: entry.fromMode,
          toMode: entry.toMode,
          reason: entry.reason,
          source: entry.source,
        }),
      };
    case 'branch':
      return {
        ...base,
        entry_type: 'branch',
        payload: JSON.stringify({
          branchId: entry.branchId,
          fromEntryId: entry.fromEntryId,
          label: entry.label,
        }),
      };
    case 'custom_state':
      return {
        ...base,
        entry_type: 'custom_state',
        payload: JSON.stringify({
          stateKind: entry.stateKind,
          payload: entry.payload,
        }),
      };
    default: {
      // Exhaustiveness check: if a new entry type is added to the union
      // without a corresponding case above, this assignment fails at compile
      // time.
      const exhaustive: never = entry;
      throw new Error(`Unhandled entry type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Deserialize a ConversationEntryRow back into a MessageTimelineEntry.
 * Restores `readonly` array types via type assertions on the parsed JSON.
 *
 * Throws on unknown entry_type values so a corrupted or forward-incompatible
 * row fails loudly rather than silently dropping data.
 */
export function deserializeEntry(row: ConversationEntryRow): MessageTimelineEntry {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;

  switch (row.entry_type) {
    case 'message':
      return {
        type: 'message',
        id: row.id,
        parentId: row.parent_id,
        createdAt: row.created_at,
        message: payload.message,
      } as MessageEntry;
    case 'compaction':
      return {
        type: 'compaction',
        id: row.id,
        parentId: row.parent_id,
        createdAt: row.created_at,
        summary: payload.summary,
        firstKeptMessageId: payload.firstKeptMessageId,
        compactedMessageIds: payload.compactedMessageIds,
        tokensBefore: payload.tokensBefore,
        tokensAfter: payload.tokensAfter,
        strategy: payload.strategy,
        previousCompactionId: payload.previousCompactionId,
        reinjectedSystemMessages: payload.reinjectedSystemMessages,
      } as CompactionEntry;
    case 'model_change':
      return {
        type: 'model_change',
        id: row.id,
        parentId: row.parent_id,
        createdAt: row.created_at,
        fromModel: payload.fromModel,
        toModel: payload.toModel,
        fromProvider: payload.fromProvider,
        toProvider: payload.toProvider,
        reason: payload.reason,
      } as ModelChangeEntry;
    case 'mode_change':
      return {
        type: 'mode_change',
        id: row.id,
        parentId: row.parent_id,
        createdAt: row.created_at,
        fromMode: payload.fromMode,
        toMode: payload.toMode,
        reason: payload.reason,
        source: payload.source,
      } as ModeChangeEntry;
    case 'branch':
      return {
        type: 'branch',
        id: row.id,
        parentId: row.parent_id,
        createdAt: row.created_at,
        branchId: payload.branchId,
        fromEntryId: payload.fromEntryId,
        label: payload.label,
      } as BranchEntry;
    case 'custom_state':
      return {
        type: 'custom_state',
        id: row.id,
        parentId: row.parent_id,
        createdAt: row.created_at,
        stateKind: payload.stateKind,
        payload: payload.payload,
      } as CustomStateEntry;
    default:
      throw new Error(`Unknown entry type: ${row.entry_type}`);
  }
}

// =============================================================================
// Repository Interface
// =============================================================================

/**
 * Append-only entry-level persistence for conversation timelines.
 *
 * Each method is async to allow IPC-proxyable implementations in the Agent
 * subprocess. The SqliteMessageRepository implementation is synchronous under
 * the hood (better-sqlite3 is sync), but the async signature keeps the door
 * open for IPC-backed implementations.
 */
export interface MessageRepository {
  /**
   * Append entries to a session's timeline. Uses INSERT OR IGNORE so
   * re-appending the same entry (by id) is a no-op. `seq_index` is assigned
   * monotonically based on the current max for the session.
   */
  append(sessionId: string, entries: readonly MessageTimelineEntry[]): Promise<void>;

  /** Load all active entries for a session, ordered by seq_index. */
  loadSession(sessionId: string): Promise<MessageTimelineEntry[]>;

  /**
   * Load a branch of the timeline. When `leafId` is omitted, loads all active
   * entries (same as loadSession). When `leafId` is provided, walks the
   * parentId chain from the leaf back to the root and returns those entries
   * ordered by seq_index.
   */
  loadBranch(sessionId: string, leafId?: string): Promise<MessageTimelineEntry[]>;

  /**
   * Mark entries as superseded (soft-delete). Superseded entries are excluded
   * from loadSession and loadBranch results.
   */
  markSuperseded(ids: readonly string[]): Promise<void>;

  /** Append a single CompactionEntry. Equivalent to append([entry]). */
  appendCompaction(sessionId: string, entry: CompactionEntry): Promise<void>;

  /** Delete all entries for a session (hard delete). */
  clearSession(sessionId: string): Promise<void>;
}

// =============================================================================
// SqliteMessageRepository
// =============================================================================

/**
 * SQLite-backed implementation of MessageRepository.
 *
 * The repository does NOT own the DB connection — it receives a
 * RepositoryDatabase handle (which may be a direct better-sqlite3 instance or
 * an IPC proxy) and uses it for all operations. Schema creation is the
 * caller's responsibility (see createConversationEntriesTable).
 */
export class SqliteMessageRepository implements MessageRepository {
  constructor(private readonly db: RepositoryDatabase) {}

  async append(
    sessionId: string,
    entries: readonly MessageTimelineEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;

    const maxSeqStmt = this.db.prepare(
      'SELECT COALESCE(MAX(seq_index), -1) AS max_seq FROM conversation_entries WHERE session_id = ?',
    );
    const insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO conversation_entries
        (id, session_id, entry_type, parent_id, created_at, seq_index, status, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const txn = this.db.transaction(() => {
      const row = maxSeqStmt.get(sessionId) as { max_seq: number } | undefined;
      const baseSeq = row?.max_seq ?? -1;

      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        if (!entry) continue;
        const serialized = serializeEntry(entry, sessionId, baseSeq + 1 + i);
        insertStmt.run(
          serialized.id,
          serialized.session_id,
          serialized.entry_type,
          serialized.parent_id,
          serialized.created_at,
          serialized.seq_index,
          serialized.status,
          serialized.payload,
        );
      }
    });

    txn();
  }

  async loadSession(sessionId: string): Promise<MessageTimelineEntry[]> {
    const stmt = this.db.prepare(
      `SELECT * FROM conversation_entries
       WHERE session_id = ? AND status = 'active'
       ORDER BY seq_index ASC`,
    );
    const rows = stmt.all(sessionId) as ConversationEntryRow[];
    return rows.map(deserializeEntry);
  }

  async loadBranch(
    sessionId: string,
    leafId?: string,
  ): Promise<MessageTimelineEntry[]> {
    if (!leafId) {
      return this.loadSession(sessionId);
    }

    const stmt = this.db.prepare(
      `WITH RECURSIVE branch AS (
         SELECT * FROM conversation_entries
         WHERE id = ? AND session_id = ? AND status = 'active'
         UNION ALL
         SELECT e.* FROM conversation_entries e
         JOIN branch b ON e.id = b.parent_id
         WHERE e.session_id = ? AND e.status = 'active'
       )
       SELECT * FROM branch ORDER BY seq_index ASC`,
    );
    const rows = stmt.all(leafId, sessionId, sessionId) as ConversationEntryRow[];
    return rows.map(deserializeEntry);
  }

  async markSuperseded(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;

    const placeholders = ids.map(() => '?').join(', ');
    const stmt = this.db.prepare(
      `UPDATE conversation_entries
       SET status = 'superseded'
       WHERE id IN (${placeholders}) AND status = 'active'`,
    );
    stmt.run(...ids);
  }

  async appendCompaction(sessionId: string, entry: CompactionEntry): Promise<void> {
    await this.append(sessionId, [entry]);
  }

  async clearSession(sessionId: string): Promise<void> {
    const stmt = this.db.prepare(
      'DELETE FROM conversation_entries WHERE session_id = ?',
    );
    stmt.run(sessionId);
  }
}
