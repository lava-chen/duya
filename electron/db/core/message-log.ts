/**
 * MessageLog — single-class two-layer message storage.
 *
 * Layer 1 (payload): append-only JSONL rollout files, one per session, under
 * `sessions/<YYYY>/<MM>/<DD>/rollout-<stamp>-<sessionId>.jsonl`. Each line
 * is a JSON-serialized `MessageEntry | CompactionEntry`. Line order = seq order.
 *
 * Layer 2 (index): `message_index` SQLite table. Stores id/session/seq/kind/
 * created_at/file_offset/byte_len — NO payload column. `file_offset` + `byte_len`
 * point into the rollout file for exact-line reads.
 *
 * Write path (`appendBatch`): append all payload lines to the rollout file
 * (recording per-line offset/len), then a single transaction INSERTs index rows
 * with `COALESCE(MAX(seq),0)+1` seq allocation and `INSERT OR IGNORE` idempotency.
 * File append and index write are NOT in the same transaction — a crash may leave
 * orphan file lines, reconciled by `scan()` on startup.
 *
 * First append resolves the rollout path and writes it back to `sessions.rollout_path`
 * (the only cross-table write in core store, per design decision 2).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentMessage, MessageEntry, CompactionEntry } from '@duya/agent/message';
import type { Migration, SqliteDatabase } from './database';

// ─── Inline types (no separate types.ts — flat 7-file discipline) ───

export type MessageEventKind = AgentMessage['role'];
export type EventKind = MessageEventKind | 'compaction';

export interface NewEvent {
  /** Deterministic id (= MessageEntry.id / CompactionEntry.id). Never randomUUID(). */
  id: string;
  sessionId: string;
  turnId?: string | null;
  /** Full timeline entry stored verbatim in the rollout file. */
  payload: MessageEntry | CompactionEntry;
  /** ms epoch. */
  createdAt: number;
}

export interface StoredEvent {
  id: string;
  sessionId: string;
  seq: number;
  turnId: string | null;
  kind: EventKind;
  /** Raw JSON read back from the rollout file. */
  payload: string;
  createdAt: number;
}

export interface TimelineEntryRow {
  entry: MessageEntry | CompactionEntry;
  seq: number;
}

export interface SearchTextOptions {
  sessionIds?: string[];
  limit?: number;
  maxFiles?: number;
}

export interface SearchHit {
  sessionId: string;
  messageId: string;
  seq: number;
  snippet: string;
}

// ─── MessageLog ───

export class MessageLog {
  /** Migration id=1: create message_index table + unique constraint + index. */
  static readonly migrations: Migration[] = [
    {
      id: 1,
      name: 'create_message_index',
      up: (db) => {
        db.exec(`
          CREATE TABLE message_index (
            id          TEXT PRIMARY KEY,
            session_id  TEXT NOT NULL,
            seq         INTEGER NOT NULL,
            turn_id     TEXT,
            kind        TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            file_offset INTEGER NOT NULL,
            byte_len    INTEGER NOT NULL,
            UNIQUE (session_id, seq)
          );
          CREATE INDEX idx_index_session ON message_index(session_id, seq);
        `);
      },
    },
  ];

  private readonly db: SqliteDatabase;
  private readonly rootDir: string;
  /** Cache: sessionId → relative rollout path. Avoids repeated sessions-table reads. */
  private readonly pathCache = new Map<string, string>();

  constructor(db: SqliteDatabase, rootDir: string) {
    this.db = db;
    this.rootDir = rootDir;
  }

  // ─── Public API ───

  /**
   * Append a batch of events to the session's rollout file and index.
   * First append resolves the rollout path and writes it back to
   * `sessions.rollout_path`. Idempotent via `INSERT OR IGNORE` on id.
   */
  appendBatch(events: NewEvent[]): void {
    if (events.length === 0) return;

    // Group by session — each session has its own rollout file.
    const bySession = new Map<string, NewEvent[]>();
    for (const ev of events) {
      const arr = bySession.get(ev.sessionId);
      if (arr) arr.push(ev);
      else bySession.set(ev.sessionId, [ev]);
    }

    for (const [sessionId, sessionEvents] of bySession) {
      // Bucket by the session's last activity (newest event in this batch) so a
      // cross-midnight session's rollout lives under the day it was last active.
      const lastActivity = sessionEvents.reduce((max, ev) => (ev.createdAt > max ? ev.createdAt : max), 0);
      const relativePath = this.getOrCreateRolloutPath(sessionId, lastActivity);
      const absolutePath = this.resolvePathOnDisk(relativePath);

      // Append all payload lines to the rollout file, recording per-line offset/len.
      const payloads = sessionEvents.map((ev) => ev.payload);
      const lineMeta = this.appendLines(absolutePath, payloads);

      // Single transaction: INSERT OR IGNORE index rows.
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO message_index
          (id, session_id, seq, turn_id, kind, created_at, file_offset, byte_len)
        VALUES
          (?, ?, COALESCE((SELECT MAX(seq) FROM message_index WHERE session_id = ?), 0) + 1, ?, ?, ?, ?, ?)
      `);
      const txn = this.db.transaction(() => {
        for (let i = 0; i < sessionEvents.length; i++) {
          const ev = sessionEvents[i];
          const meta = lineMeta[i];
          insert.run(
            ev.id,
            ev.sessionId,
            ev.sessionId,
            ev.turnId ?? null,
            deriveKind(ev.payload),
            ev.createdAt,
            meta.fileOffset,
            meta.byteLen,
          );
        }
      });
      txn();
    }
  }

  /** List all events for a session, ordered by seq. Payload is raw JSON. */
  listBySession(sessionId: string): StoredEvent[] {
    const relativePath = this.getRolloutPath(sessionId);
    if (!relativePath) return [];
    const absolutePath = this.resolvePathOnDisk(relativePath);

    // A session may reference a rollout file that is missing on disk (e.g. a
    // legacy/orphaned path, or a file cleaned up externally). The index rows
    // are then stale garbage — drop them and report the session as empty
    // rather than throwing ENOENT and crashing the whole read path.
    if (!fs.existsSync(absolutePath)) {
      this.db.prepare('DELETE FROM message_index WHERE session_id = ?').run(sessionId);
      this.pathCache.delete(sessionId);
      return [];
    }

    const rows = this.db
      .prepare(
        'SELECT id, session_id, seq, turn_id, kind, created_at, file_offset, byte_len FROM message_index WHERE session_id = ? ORDER BY seq',
      )
      .all(sessionId) as Array<{
        id: string;
        session_id: string;
        seq: number;
        turn_id: string | null;
        kind: string;
        created_at: number;
        file_offset: number;
        byte_len: number;
      }>;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      seq: row.seq,
      turnId: row.turn_id,
      kind: row.kind as EventKind,
      payload: this.readRange(absolutePath, row.file_offset, row.byte_len),
      createdAt: row.created_at,
    }));
  }

  /**
   * Project the full timeline for a session by reading the entire rollout file.
   * Seq is assigned as the 1-based line number. Assumes `scan()` has reconciled
   * any orphan lines (no duplicates / partial tail).
   */
  project(sessionId: string): TimelineEntryRow[] {
    const relativePath = this.getRolloutPath(sessionId);
    if (!relativePath) return [];
    const absolutePath = this.resolvePathOnDisk(relativePath);
    const lines = this.readAll(absolutePath);
    const result: TimelineEntryRow[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length === 0) continue;
      try {
        const entry = JSON.parse(line) as MessageEntry | CompactionEntry;
        result.push({ entry, seq: i + 1 });
      } catch {
        // Skip unparseable lines (crash-damaged tail).
      }
    }
    return result;
  }

  /** Count indexed events for a session. */
  getCount(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as c FROM message_index WHERE session_id = ?')
      .get(sessionId) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  /**
   * Count indexed events for a session filtered by `kind` (message role
   * or 'compaction'). The `kind` column is derived from the payload's
   * `message.role` (see `deriveKind`), so this is the equivalent of the
   * legacy `SELECT COUNT(*) FROM messages WHERE session_id=? AND role=?`
   * without reading payload bytes.
   */
  getCountByKind(sessionId: string, kind: string): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) as c FROM message_index WHERE session_id = ? AND kind = ?',
      )
      .get(sessionId, kind) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  /**
   * Crash recovery: compare file line count with index row count. For each file
   * line whose id is not in the index, INSERT OR IGNORE with MAX(seq)+1.
   * Handles both crash-during-index-write (missing tail) and idempotent re-append
   * (duplicate file lines, INSERT OR IGNORE skips).
   */
  scan(sessionId: string): void {
    const relativePath = this.getRolloutPath(sessionId);
    if (!relativePath) return;
    const absolutePath = this.resolvePathOnDisk(relativePath);
    const lines = this.readAll(absolutePath);

    const indexedIds = new Set(
      (this.db
        .prepare('SELECT id FROM message_index WHERE session_id = ?')
        .all(sessionId) as Array<{ id: string }>).map((r) => r.id),
    );

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO message_index
        (id, session_id, seq, turn_id, kind, created_at, file_offset, byte_len)
      VALUES
        (?, ?, COALESCE((SELECT MAX(seq) FROM message_index WHERE session_id = ?), 0) + 1, ?, ?, ?, ?, ?)
    `);

    // Track offset as we iterate lines to backfill file_offset/byte_len.
    let offset = 0;
    const txn = this.db.transaction(() => {
      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line + '\n', 'utf8');
        const contentLen = Buffer.byteLength(line, 'utf8');
        try {
          const entry = JSON.parse(line) as MessageEntry | CompactionEntry;
          if (!indexedIds.has(entry.id)) {
            insert.run(
              entry.id,
              sessionId,
              sessionId,
              null,
              deriveKind(entry),
              entry.createdAt,
              offset,
              contentLen,
            );
            indexedIds.add(entry.id);
          }
        } catch {
          // Skip unparseable lines (crash-damaged tail).
        }
        offset += lineBytes;
      }
    });
    txn();
  }

  /**
   * Full-text search over rollout payloads. Scans up to `maxFiles` (default 200)
   * most-recently-updated sessions, case-insensitive substring match, snippet
   * ±120 chars around hit (capped at 300). `limit` (default 20) early exit.
   */
  searchText(query: string, opts: SearchTextOptions = {}): SearchHit[] {
    if (!query) return [];
    const limit = opts.limit ?? 20;
    const maxFiles = opts.maxFiles ?? 200;
    const lowerQuery = query.toLowerCase();

    let candidates: Array<{ id: string; rolloutPath: string }>;
    if (opts.sessionIds && opts.sessionIds.length > 0) {
      const placeholders = opts.sessionIds.map(() => '?').join(',');
      candidates = (this.db
        .prepare(
          `SELECT id, rollout_path as rolloutPath FROM sessions WHERE id IN (${placeholders}) AND rollout_path IS NOT NULL`,
        )
        .all(...opts.sessionIds) as Array<{ id: string; rolloutPath: string }>);
    } else {
      candidates = (this.db
        .prepare(
          `SELECT id, rollout_path as rolloutPath FROM sessions WHERE status != 'deleted' AND rollout_path IS NOT NULL ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(maxFiles) as Array<{ id: string; rolloutPath: string }>);
    }

    const hits: SearchHit[] = [];
    outer: for (const candidate of candidates) {
      const absolutePath = this.resolvePathOnDisk(candidate.rolloutPath);
      const lines = this.readAll(absolutePath);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length === 0) continue;
        let entry: MessageEntry | CompactionEntry;
        try {
          entry = JSON.parse(line) as MessageEntry | CompactionEntry;
        } catch {
          continue;
        }
        const text = extractSearchableText(entry).toLowerCase();
        const matchIdx = text.indexOf(lowerQuery);
        if (matchIdx >= 0) {
          const fullText = extractSearchableText(entry);
          hits.push({
            sessionId: candidate.id,
            messageId: entry.id,
            seq: i + 1,
            snippet: makeSnippet(fullText, matchIdx, query.length),
          });
          if (hits.length >= limit) break outer;
        }
      }
    }
    return hits;
  }

  /** Delete all index rows for a session. File is preserved. Test/rollback only. */
  deleteBySession(sessionId: string): void {
    this.db.prepare('DELETE FROM message_index WHERE session_id = ?').run(sessionId);
    this.pathCache.delete(sessionId);
  }

  /**
   * Rewrite a session's rollout file and index with a new event sequence.
   * Used by `message:truncateAfter` / `message:truncateFromInclusive` (rewind /
   * edit-resend, plan 75) — the ONLY append-only-discipline exception. The
   * adapter computes the kept events via `project()` and passes them here.
   *
   * Semantics:
   *   1. Resolve the rollout path (existing or fresh).
   *   2. Write the kept payloads to a sibling `.tmp` file, fsync, then
   *      atomically rename over the original (POSIX atomic-rename semantics
   *      on Windows is best-effort via `fs.renameSync`).
   *   3. DELETE all `message_index` rows for the session, then INSERT fresh
   *      rows with `seq = 1..N` (deterministic, no `MAX(seq)+1`).
   *
   * Crash safety: if the rename succeeds but the index transaction fails, a
   * subsequent `scan(sessionId)` reconciles the index from the new file. If
   * the rename fails, the original file is intact.
   *
   * Returns the number of events written. Empty `events` truncates the
   * session to zero (file becomes empty, index rows deleted).
   */
  rewriteSession(sessionId: string, events: NewEvent[]): number {
    if (events.length === 0) {
      // Truncate-to-empty path: clear the file and the index.
      const relativePath = this.getOrCreateRolloutPath(sessionId, Date.now());
      const absolutePath = path.join(this.rootDir, relativePath);
      this.ensureFile(absolutePath);
      fs.writeFileSync(absolutePath, '', 'utf8');
      this.db.prepare('DELETE FROM message_index WHERE session_id = ?').run(sessionId);
      this.pathCache.delete(sessionId);
      return 0;
    }

    const maxCreatedAt = events.reduce((max, ev) => (ev.createdAt > max ? ev.createdAt : max), events[0].createdAt);
    const relativePath = this.getOrCreateRolloutPath(sessionId, maxCreatedAt);
    const absolutePath = path.join(this.rootDir, relativePath);
    this.ensureFile(absolutePath);

    // Write all payloads to a sibling temp file, then atomically rename.
    const tmpPath = absolutePath + '.rewrite.tmp';
    const lines = events.map((ev) => JSON.stringify(ev.payload));
    const content = lines.join('\n') + (lines.length > 0 ? '\n' : '');
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, absolutePath);

    // Rebuild the index: DELETE then INSERT in a single transaction.
    const deleteStmt = this.db.prepare('DELETE FROM message_index WHERE session_id = ?');
    const insertStmt = this.db.prepare(
      `INSERT INTO message_index
        (id, session_id, seq, turn_id, kind, created_at, file_offset, byte_len)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // Compute file_offset / byte_len for each line (matching appendLines layout).
    const lineMeta: Array<{ fileOffset: number; byteLen: number }> = [];
    let offset = 0;
    for (const line of lines) {
      const contentBytes = Buffer.byteLength(line, 'utf8');
      lineMeta.push({ fileOffset: offset, byteLen: contentBytes });
      offset += contentBytes + 1; // +1 for newline
    }

    const txn = this.db.transaction(() => {
      deleteStmt.run(sessionId);
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const meta = lineMeta[i];
        insertStmt.run(
          ev.id,
          ev.sessionId,
          i + 1, // deterministic seq starting at 1
          ev.turnId ?? null,
          deriveKind(ev.payload),
          ev.createdAt,
          meta.fileOffset,
          meta.byteLen,
        );
      }
    });
    txn();

    return events.length;
  }

  // ─── Private file helpers ───

  /**
   * Resolve the rollout file relative path for a session.
   * Layout: `sessions/<YYYY>/<MM>/<DD>/rollout-<stamp>-<sessionId>.jsonl`,
   * where `<stamp>` is the session's `createdAt` as an ISO timestamp with
   * `:` and `.` replaced by `-` (e.g. `2026-08-06T12-00-00-000Z`). Uses UTC
   * for consistent date bucketing across timezones.
   */
  private resolvePath(sessionId: string, createdAt: number): string {
    const date = new Date(createdAt);
    const yyyy = String(date.getUTCFullYear()).padStart(4, '0');
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const stamp = date.toISOString().replace(/[:.]/g, '-');
    return path.join('sessions', yyyy, mm, dd, `rollout-${stamp}-${sessionId}.jsonl`);
  }

  /** Create the file (and parent directories) if it does not exist. */
  private ensureFile(absolutePath: string): void {
    const dir = path.dirname(absolutePath);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(absolutePath)) {
      fs.writeFileSync(absolutePath, '', 'utf8');
    }
  }

  /**
   * Append payload lines to the rollout file. Returns per-line {fileOffset, byteLen}
   * where fileOffset is the byte offset of the JSON content start, byteLen is the
   * byte length of the JSON content (excluding the trailing newline).
   */
  private appendLines(
    absolutePath: string,
    payloads: (MessageEntry | CompactionEntry)[],
  ): Array<{ fileOffset: number; byteLen: number }> {
    this.ensureFile(absolutePath);
    const lines = payloads.map((p) => JSON.stringify(p));
    let offset = fs.statSync(absolutePath).size;
    const results: Array<{ fileOffset: number; byteLen: number }> = [];
    const chunks: string[] = [];
    for (const line of lines) {
      const contentBytes = Buffer.byteLength(line, 'utf8');
      results.push({ fileOffset: offset, byteLen: contentBytes });
      chunks.push(line, '\n');
      offset += contentBytes + 1; // +1 for newline
    }
    fs.appendFileSync(absolutePath, chunks.join(''), 'utf8');
    return results;
  }

  /** Read all non-empty lines from the rollout file. */
  private readAll(absolutePath: string): string[] {
    if (!fs.existsSync(absolutePath)) return [];
    const content = fs.readFileSync(absolutePath, 'utf8');
    if (content.length === 0) return [];
    return content.split('\n').filter((l) => l.length > 0);
  }

  /** Read exactly `len` bytes starting at `offset` from the file. */
  private readRange(absolutePath: string, offset: number, len: number): string {
    const fd = fs.openSync(absolutePath, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Resolve the absolute path for a rollout file. Prefers the canonical
   * `<rootDir>/<relativePath>` location; when absent, falls back to the legacy
   * doubled-tree layout `<rootDir>/sessions/<relativePath>` written by an
   * earlier dev build (plan 328). Reads and appends both use it so a legacy
   * session keeps reading and writing the same physical file until it is
   * migrated to the canonical location. `rootDir` is the Codex-style
   * `~/.duya` (see `resolveRolloutRoot`), so the canonical tree is
   * `~/.duya/sessions/<YYYY>/<MM>/<DD>/...`.
   */
  private resolvePathOnDisk(relativePath: string): string {
    const canonical = path.join(this.rootDir, relativePath);
    if (fs.existsSync(canonical)) return canonical;
    const legacy = path.join(this.rootDir, 'sessions', relativePath);
    return fs.existsSync(legacy) ? legacy : canonical;
  }

  // ─── Private session helpers ───

  /** Read rollout_path from the sessions table. Returns null if not set or table missing. */
  private getRolloutPath(sessionId: string): string | null {
    const cached = this.pathCache.get(sessionId);
    if (cached) return cached;
    try {
      const row = this.db
        .prepare('SELECT rollout_path FROM sessions WHERE id = ?')
        .get(sessionId) as { rollout_path: string | null } | undefined;
      const p = row?.rollout_path ?? null;
      if (p) this.pathCache.set(sessionId, p);
      return p;
    } catch {
      // sessions table might not exist in isolated tests
      return null;
    }
  }

  /** Get the cached rollout path, or resolve + write back + cache on first access. */
  private getOrCreateRolloutPath(sessionId: string, createdAt: number): string {
    const desired = this.resolvePath(sessionId, createdAt);
    const existing = this.getRolloutPath(sessionId);
    if (existing && existing !== desired) {
      // Date bucket changed (cross-midnight session) — move the file.
      this.moveRollout(sessionId, existing, desired);
      return desired;
    }
    if (existing) return existing;

    const absolutePath = path.join(this.rootDir, desired);
    this.ensureFile(absolutePath);

    // Write back to sessions table (only if not already set — races are safe).
    try {
      this.db
        .prepare('UPDATE sessions SET rollout_path = ? WHERE id = ? AND rollout_path IS NULL')
        .run(desired, sessionId);
    } catch {
      // sessions table might not exist in isolated tests — file still works.
    }

    this.pathCache.set(sessionId, desired);
    return desired;
  }

  /** Move a session's rollout file to a new date bucket and update rollout_path. */
  private moveRollout(sessionId: string, fromRel: string, toRel: string): void {
    const src = this.resolvePathOnDisk(fromRel);
    const dst = this.resolvePathOnDisk(toRel);
    if (src !== dst && fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
    }
    try {
      this.db.prepare('UPDATE sessions SET rollout_path = ? WHERE id = ?').run(toRel, sessionId);
    } catch {
      // sessions table might not exist in isolated tests — file still works.
    }
    this.pathCache.set(sessionId, toRel);
  }
}

// ─── Helpers ───

function deriveKind(payload: MessageEntry | CompactionEntry): EventKind {
  if (payload.type === 'compaction') return 'compaction';
  return payload.message.role;
}

/** Extract searchable text from a timeline entry for searchText. */
function extractSearchableText(entry: MessageEntry | CompactionEntry): string {
  if (entry.type === 'compaction') {
    return entry.summary;
  }
  const msg = entry.message;
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (block.type === 'text') {
        if (block.text) parts.push(block.text);
      } else if (block.type === 'tool_result') {
        if (typeof block.content === 'string') {
          parts.push(block.content);
        } else if (Array.isArray(block.content)) {
          for (const c of block.content) {
            if (typeof c === 'string') parts.push(c);
            else if (typeof c.text === 'string') parts.push(c.text);
          }
        }
      }
    }
    return parts.join(' ');
  }
  return '';
}

/** Build a snippet around the match position: ±120 chars, capped at 300 total. */
function makeSnippet(text: string, matchIndex: number, queryLen: number): string {
  const context = 120;
  const start = Math.max(0, matchIndex - context);
  const end = Math.min(text.length, matchIndex + queryLen + context);
  let snippet = text.slice(start, end);
  if (snippet.length > 300) snippet = snippet.slice(0, 300);
  return snippet;
}
