/**
 * MessageLog — single-class two-layer message storage.
 *
 * Layer 1 (payload): append-only JSONL rollout files, one per session, under
 * `sessions/<YYYY>/<MM>/<DD>/rollout-<stamp>-<sessionId>.jsonl`. Each line is
 * a JSON-serialized `RolloutLine` (MessageEntry | CompactionEntry |
 * RolloutEvent). Line order = seq order. Rollout events (`reasoning`,
 * `tool_call`, `turn_started`, `system_context`, `rebase`) live alongside
 * messages so the rollout file is self-describing — plan 333 + plan 441.
 *
 * Layer 2 (index): `message_index` SQLite table. Stores id/session/seq/kind/
 * created_at/file_offset/byte_len — NO payload column. `file_offset` + `byte_len`
 * point into the rollout file for exact-line reads. Event kinds populate
 * `kind` from their `type` discriminator (plan 333).
 *
 * Write path (`appendBatch`): append all payload lines to the rollout file
 * (recording per-line offset/len), then a single transaction INSERTs index rows
 * with `COALESCE(MAX(seq),0)+1` seq allocation and `INSERT OR IGNORE` idempotency.
 * File append and index write are NOT in the same transaction — a crash may leave
 * orphan file lines, reconciled by `scan()` on startup.
 *
 * First append resolves the rollout path and writes it back to `sessions.rollout_path`
 * (the only cross-table write in core store, per design decision 2).
 *
 * Projection: `project()` returns the LLM-visible message timeline (skips event
 * rows, applies `rebase` events to filter superseded messages). `timeline()`
 * returns the full ordered trace including events for audit/replay.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger, LogComponent } from '../../logging/logger';
import { THREAD_METADATA_KEY, type AgentMessage, type MessageEntry, type CompactionEntry } from '@duya/agent/message';
import type { Migration, SqliteDatabase } from './database';
import {
  isRolloutEvent,
  rolloutLineTimestamp,
  type RebaseEvent,
  type RolloutEvent,
  type RolloutProcessEvent,
  type RotationEvent,
} from './rollout-events';
import { repairInterruptedToolCalls } from './message-repair';
import { BOT_SESSION_ID_PREFIX, parseAgentIdFromBotSession } from '../../wake/bot-session-id';
import { getBotSessionLogPath } from '../../config/agent-paths';

const logger = getLogger();

// ─── Inline types (no separate types.ts — flat 7-file discipline) ───

/** A single JSONL line in the rollout file. The discriminator `type` is required. */
export type RolloutLine = MessageEntry | CompactionEntry | RolloutEvent;

export type MessageEventKind = AgentMessage['role'];
export type EventKind = MessageEventKind | 'compaction' | 'reasoning' | 'tool_call' | 'turn_started' | 'system_context' | 'rebase' | 'rotation';

export interface NewEvent {
  /** Deterministic id (= entry.id). Never randomUUID(). */
  id: string;
  sessionId: string;
  turnId?: string | null;
  /** Full timeline entry stored verbatim in the rollout file. */
  payload: RolloutLine;
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
  /** Any rollout line — message, compaction, or rollout event. */
  entry: RolloutLine;
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

/**
 * Plan 506 (C1): options for `rotateArchive`. Bot sessions ignore these
 * (they rotate unconditionally on compaction); non-bot sessions honor the
 * size gate — `force` bypasses it, `thresholdBytes` overrides the default.
 */
export interface RotationOptions {
  force?: boolean;
  thresholdBytes?: number;
}

/**
 * Plan 506 (C1): a non-bot session's rollout must exceed this size before a
 * compaction-triggered rotation kicks in. Keeps ordinary sessions on the
 * single-file behavior byte-for-byte; only genuinely long sessions get the
 * generation layout.
 */
export const NON_BOT_ROTATION_THRESHOLD_BYTES = 4 * 1024 * 1024;

/**
 * Archive segments per session above which the discovery logs a one-time
 * operational warning. Not a truncation bound — the directory scan finds
 * every generation — just a heads-up that a session is accumulating an
 * unusual amount of rotated history (bot sessions rotate per compaction).
 */
const ARCHIVE_DISCOVERY_WARN_COUNT = 50;

const archiveCountWarned = new Set<string>();

function warnArchiveCountOnce(sessionsDir: string, count: number): void {
  if (archiveCountWarned.has(sessionsDir)) return;
  archiveCountWarned.add(sessionsDir);
  logger.warn(
    `Session rollout dir has ${count} archive segments — rotated history is piling up ` +
      `(bot sessions rotate per compaction). History is still fully readable; consider ` +
      `archiving the session or pruning old segments.`,
    { sessionsDir, count },
    LogComponent.AgentProcess,
  );
}

/** Plan 506 (A1): export result for one session's portable rollout file. */
export interface RolloutExportResult {
  absolutePath: string;
  lines: number;
  bytes: number;
}

/** Plan 506 (A3): whole-store reconcile statistics. */
export interface ReconcileStats {
  sessionsScanned: number;
  rowsAdded: number;
  missingFiles: string[];
  orphanFiles: string[];
}

/**
 * Plan 506 (A2): import outcome for both modes. `linesSkipped` counts
 * duplicates already indexed for the target session (continue mode);
 * `remapped` is true when ids were re-minted to avoid global
 * message_index PK collisions.
 */
export interface ImportResult {
  sessionId: string;
  linesImported: number;
  linesSkipped: number;
  remapped: boolean;
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
          CREATE TABLE IF NOT EXISTS message_index (
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
          CREATE INDEX IF NOT EXISTS idx_index_session ON message_index(session_id, seq);
        `);
      },
    },
    {
      // Plan 493 (Phase A): bots own sessions by `agent_id`. Pre-existing
      // rows get NULL (human sessions — never owned by a bot); new bot
      // sessions stamp `agent_id = '<botId>'` on first append. Idempotent —
      // uses PRAGMA table_info like the legacy chat_sessions column bump
      // migration, so re-running this migration on an already-bumped DB is
      // a no-op. Runs after SessionStore.create_sessions (id=2) so the
      // sessions table exists; skips branches when a table is absent (test
      // fixtures may create the tables AFTER running MessageLog.migrations).
      id: 13,
      name: 'add_agent_id_to_sessions',
      up: (db) => {
        // message_index.generation — Phase B aligns message_index.generation
        // with chat_sessions.generation. Detect via sqlite_master and bail
        // gracefully when the table is not present yet.
        const indexExists = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='message_index'",
          )
          .get();
        if (indexExists) {
          const indexInfo = db
            .prepare('PRAGMA table_info(message_index)')
            .all() as Array<{ name: string }>;
          const indexCols = new Set(indexInfo.map((c) => c.name));
          if (!indexCols.has('generation')) {
            db.exec(
              'ALTER TABLE message_index ADD COLUMN generation INTEGER NOT NULL DEFAULT 0',
            );
          }
        }

        // sessions.agent_id — same idempotent guard. SessionStore.migrations
        // owns the table in production; if it has not been created yet, the
        // second pass (after SessionStore.migrations) will run this branch.
        const sessionsExists = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'",
          )
          .get();
        if (!sessionsExists) return;

        const tableInfo = db
          .prepare('PRAGMA table_info(sessions)')
          .all() as Array<{ name: string }>;
        const cols = new Set(tableInfo.map((c) => c.name));
        if (!cols.has('agent_id')) {
          db.exec('ALTER TABLE sessions ADD COLUMN agent_id TEXT DEFAULT NULL');
        }
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON sessions(agent_id) WHERE agent_id IS NOT NULL',
        );
      },
    },
    {
      // Plan 493 (Phase B) repair — id=13 was edited AFTER some dev DBs had
      // already recorded schema_version=13 (CoreDatabase skips migrations
      // with `id <= current`), so `message_index.generation` and
      // `sessions.agent_id` never landed on those DBs and the first
      // `listBySessionMultiFile` / bot append died with SQLITE_ERROR
      // "no such column: generation". This migration re-applies the same
      // idempotent blocks under a fresh id. On fresh installs every guard
      // is a no-op; on affected DBs it repairs the missing columns.
      id: 14,
      name: 'repair_plan493_generation_and_agent_id',
      up: (db) => {
        // message_index.generation
        const indexExists = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='message_index'",
          )
          .get();
        if (indexExists) {
          const indexInfo = db
            .prepare('PRAGMA table_info(message_index)')
            .all() as Array<{ name: string }>;
          const indexCols = new Set(indexInfo.map((c) => c.name));
          if (!indexCols.has('generation')) {
            db.exec(
              'ALTER TABLE message_index ADD COLUMN generation INTEGER NOT NULL DEFAULT 0',
            );
          }
        }

        // sessions.agent_id (skip gracefully when the table is absent).
        const sessionsExists = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'",
          )
          .get();
        if (!sessionsExists) return;

        const tableInfo = db
          .prepare('PRAGMA table_info(sessions)')
          .all() as Array<{ name: string }>;
        const cols = new Set(tableInfo.map((c) => c.name));
        if (!cols.has('agent_id')) {
          db.exec('ALTER TABLE sessions ADD COLUMN agent_id TEXT DEFAULT NULL');
        }
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON sessions(agent_id) WHERE agent_id IS NOT NULL',
        );
      },
    },
    {
      // Unified space search (rakazo-inspired) incremental text index.
      // One row per message carrying the searchable text (concatenated text
      // blocks). Maintained alongside message_index; the table holds the
      // EFFECTIVE message set once a session is indexed (first append triggers
      // a full rebuild from the projected timeline; rebase triggers a rebuild
      // too). Keyed by message_id so rebase rebuilds can reconcile by id.
      // id 16 (NOT 15): this migration was introduced after the core DB had
      // already recorded schema_version >= 15 via Mailbox's id-15
      // (`mailbox_items_agent_dm_kind`), so `runMigrations`'s `id <= current`
      // guard skipped it and `message_search` was never created — every
      // appendBatch then logged "no such table: message_search". A fresh id
      // above the core max makes it run once on existing DBs and on fresh
      // installs (id 15 also collided with Mailbox's 15).
      id: 16,
      name: 'create_message_search',
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS message_search (
            message_id     TEXT PRIMARY KEY,
            session_id     TEXT NOT NULL,
            seq            INTEGER NOT NULL,
            searchable_text TEXT NOT NULL,
            text_len       INTEGER NOT NULL,
            updated_at     INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_msgsearch_session ON message_search(session_id, seq);
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
      // File-level idempotency: skip events whose id is already indexed so the
      // rollout file never accumulates duplicate lines. appendLines below writes
      // unconditionally, so without this filter the INSERT OR IGNORE on the index
      // alone would still bloat the file when callers re-send the full message
      // list (e.g. after compaction, onMessagesCompacted re-appends the entire
      // currentMessages). Keep first occurrence within the batch too.
      const indexedIds = this.getIndexedIds(sessionId);
      const seenIds = new Set<string>();
      const freshEvents: NewEvent[] = [];
      for (const ev of sessionEvents) {
        if (indexedIds.has(ev.id) || seenIds.has(ev.id)) continue;
        seenIds.add(ev.id);
        freshEvents.push(ev);
      }
      if (freshEvents.length === 0) continue;

      // Bucket by the session's last activity (newest event in this batch) so a
      // cross-midnight session's rollout lives under the day it was last active.
      const lastActivity = freshEvents.reduce((max, ev) => (ev.createdAt > max ? ev.createdAt : max), 0);

      // Plan 501 L4 (plan 493 Phase B trigger): a compaction landing on a bot
      // session rotates the rollout file, so the compacted summary becomes the
      // first data entry of a fresh generation ("each compaction = one epoch =
      // one new session"). Fail-open: a rotation error (crash-recovery archive
      // collision) must never block the message append itself.
      //
      // The trigger was `payload.type === 'compaction'`, but Plan 441 unified
      // compaction and edit-resend onto the `rebase` RolloutEvent and nothing
      // in the production path emits `type: 'compaction'` anymore. Distinguish
      // the two by the event's `reason` field — `compaction` (or omitted for
      // backward compatibility with pre-fix rebase events) rotates; `edit_resend`
      // does not, because it is an inline mutation, not an epoch boundary.
      const hasCompactionRebase = freshEvents.some((ev) => {
        const p = ev.payload as { type?: string; reason?: string };
        return p.type === 'rebase' && (p.reason === undefined || p.reason === 'compaction');
      });
      if (hasCompactionRebase) {
        try {
          this.rotateArchive(sessionId, 'compaction', lastActivity);
        } catch (err) {
          logger.warn(
            'appendBatch: rotateArchive failed; appending without rotation',
            {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }

      const relativePath = this.getOrCreateRolloutPath(sessionId, lastActivity);
      const absolutePath = this.resolvePathOnDisk(relativePath);

      // Append all payload lines to the rollout file, recording per-line offset/len.
      // Cast keeps the old signature happy; RolloutLine is JSON.stringify-able
      // with no further handling because the wire shape is the JSON of the union.
      const payloads = freshEvents.map((ev) => ev.payload);
      const lineMeta = this.appendLines(absolutePath, payloads);

      // Single transaction: INSERT OR IGNORE index rows. Plan 493 (Phase B):
      // also stamp `generation` — for bot sessions this is the rotation
      // counter (0, 1, 2, …); for shared-tree sessions it stays 0. New rows
      // inherit the current generation from the most recent rotation event
      // for the session, or 0 if no rotation has happened. The COALESCE in
      // the seq allocator still produces monotonic seqs across rotations
      // because rotation creates a fresh active file but reuses the same
      // message_index row space.
      const generation = this.getCurrentGeneration(sessionId);
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO message_index
          (id, session_id, seq, turn_id, kind, created_at, file_offset, byte_len, generation)
        VALUES
          (?, ?, COALESCE((SELECT MAX(seq) FROM message_index WHERE session_id = ?), 0) + 1, ?, ?, ?, ?, ?, ?)
      `);
      const txn = this.db.transaction(() => {
        for (let i = 0; i < freshEvents.length; i++) {
          const ev = freshEvents[i];
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
            generation,
          );
        }
      });
      txn();

      // Unified search index (Plan: message_search). Fail-open: a text-index
      // error must never block the append itself (same posture as rotateArchive).
      // First append for a session triggers a full rebuild so historical
      // messages get indexed; a rebase event rebuilds to drop superseded rows.
      try {
        this.syncSearchIndex(sessionId, freshEvents);
      } catch (err) {
        logger.warn('appendBatch: syncSearchIndex failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * List all events for a session, ordered by seq. Payload is raw JSON.
   *
   * Plan 489 P0.3: `options.source` narrows the projection to message
   * entries whose `entry.source` is in the allowlist (e.g.
   * `['send_message', 'user']` for the bot-direct transcript). Message
   * entries WITHOUT a source (legacy rows) are dropped when a filter is
   * active — pre-P0.1 data stays bot-direct hidden. Non-message entries
   * (compaction / rebase / rotation audit rows) bypass the filter.
   *
   * Plan 548: `options.includeSuperseded` controls whether compaction /
   * edit-resend rebases fold superseded raw messages out of the
   * projection (default `false`, current LLM-visible behavior).
   *
   *   `false` (default): runs `applyRebases` so the projection matches
   *     the agent core's view — superseded messages drop, rebase
   *     newMessages (compaction summary + retained tail) appear in
   *     place. LLM context consumers, CLI, recap, next-step, and most
   *     IPC handlers stay here.
   *
   *   `true`: keeps every raw message row (including the originals that
   *     a later rebase superseded) so the chat UI can render the full
   *     pre-compaction history. Rebase events are still consulted so
   *     their newMessages — chiefly the compaction summary with
   *     `isCompactSummary: true` — are inserted at the rebase point,
   *     producing the visual break that separates historical turns
   *     from the retained tail. Duplicate-id dedup still applies (first
   *     emission wins), so rebase-emitted tails that share an id with
   *     an original row do not double-render.
   *
   * This is purely a read-side projection split. Compaction strategy,
   * the compaction controller, and the append-only rollout file are
   * untouched — LLM context semantics do not change.
   */
  listBySession(
    sessionId: string,
    options?: { source?: readonly string[]; includeSuperseded?: boolean },
  ): StoredEvent[] {
    let relativePath = this.getRolloutPath(sessionId);
    if (!relativePath) return [];

    // Plan 493 (Phase B): bot sessions have a multi-file layout
    // (`active.jsonl` + `archive-<g>.jsonl`). Each `file_offset/byte_len`
    // pair in message_index references a SPECIFIC file, so we must look
    // up the file by generation, not by the single rollout_path column.
    // Plan 506 (C1): non-bot sessions that have rotated into the same
    // generation layout read the identical way — single-file resolution
    // would misread archive offsets against active.jsonl alone.
    const botAgentId = parseAgentIdFromBotSession(sessionId);
    if (botAgentId) {
      return this.listBySessionMultiFile(
        sessionId,
        path.join(this.rootDir, 'agents', botAgentId, 'sessions'),
        options,
      );
    }

    let absolutePath = this.resolvePathOnDisk(relativePath);

    // The DB-recorded rollout file may be missing on disk for two reasons we
    // must not conflate:
    //   (a) moveRollout renamed the file to a new date bucket but the UPDATE
    //       to `sessions.rollout_path` failed (silent catch before this
    //       fix) so the DB still points at the old date dir — the actual
    //       file lives under a later stamp;
    //   (b) the file was lost/cleaned up externally (operator action, disk
    //       failure, legacy orphaned path).
    //
    // The historical fix was to DELETE the session's index rows and return
    // []. That was destructive: index rows carry file_offset/byte_len into
    // the *previous* file and are recoverable via scan(), but dropping them
    // silently corrupts the session — the very next /compact immediately
    // throws "Compaction failed: conversation is empty". Recovery now: look
    // for the actual current rollout file by sessionId pattern, adopt it,
    // rebuild the index. Only when no candidate exists do we fall back to
    // empty (still never DELETE — the user can run scan() against a
    // restored file to recover).
    if (!fs.existsSync(absolutePath)) {
      const recordedPath = relativePath;
      const recovered = this.findRolloutFileBySessionId(sessionId);
      if (recovered) {
        this.adoptRolloutPath(sessionId, recovered);
        this.rebuildIndexFromRollout(sessionId, this.resolvePathOnDisk(recovered));
        relativePath = recovered;
        absolutePath = this.resolvePathOnDisk(recovered);
        logger.info(
          'Recovered session from drifted rollout_path',
          { sessionId, from: recordedPath, to: recovered },
          LogComponent.DB,
        );
      } else {
        logger.warn(
          'Rollout file missing; returning empty without dropping index',
          { sessionId, recordedPath },
          LogComponent.DB,
        );
        return [];
      }
    }

    // Plan 506 (C1): a rotated non-bot session reads across its archive
    // segments + active.jsonl exactly like a bot session — the single-file
    // resolution below would read every generation's byte ranges out of
    // active.jsonl alone and corrupt the projection.
    if (path.basename(relativePath) === 'active.jsonl') {
      return this.listBySessionMultiFile(
        sessionId,
        path.dirname(absolutePath),
        options,
      );
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

    // Plan 441: production read path applies the rebase projection and the
    // crash repair so EVERY consumer (renderer history, agent resume via
    // session:loadMessages, CLI) sees the same folded timeline:
    //   - superseded raw messages are dropped, rebase newMessages inserted,
    //   - interrupted tool_uses get a synthesized tool_result, orphan
    //     tool_results are dropped.
    // Before this wiring the rebase/repair layers existed but were dead
    // code: compaction silently regressed on reload and crashed turns fed
    // providers dangling tool_use blocks.
    const timelineRows: TimelineEntryRow[] = [];
    /** Index metadata by entry id, for turnId/createdAt fallbacks below. */
    const metaById = new Map<string, { turnId: string | null; createdAt: number }>();
    for (const row of rows) {
      let entry: RolloutLine;
      try {
        entry = JSON.parse(this.readRange(absolutePath, row.file_offset, row.byte_len)) as RolloutLine;
      } catch {
        // Corrupt line: scan() reconciles partial tails at startup; here we
        // surface the row as an opaque compaction-kind payload would break
        // consumers, so skip it. The file byte range stays intact for audit.
        logger.warn(
          'Unparseable rollout line skipped in projection',
          { sessionId, seq: row.seq },
          LogComponent.DB,
        );
        continue;
      }
      metaById.set(entry.id ?? '', { turnId: row.turn_id, createdAt: row.created_at });
      timelineRows.push({ entry, seq: row.seq });
    }

    const projected = options?.includeSuperseded
      ? repairInterruptedToolCalls(emitRebaseNewMessages(timelineRows))
      : repairInterruptedToolCalls(applyRebases(timelineRows));

    return this.applySourceFilter(projected, options?.source).map((projectedRow) => {
      const entry = projectedRow.entry;
      const meta = metaById.get(entry.id ?? '');
      return {
        id: entry.id ?? `seq:${projectedRow.seq}`,
        sessionId,
        seq: projectedRow.seq,
        turnId: meta?.turnId ?? null,
        kind: deriveKind(entry),
        payload: JSON.stringify(entry),
        createdAt: rolloutLineTimestamp(entry) || meta?.createdAt || 0,
      };
    });
  }

  /**
   * Plan 493 (Phase B): list events for a session that may span multiple
   * rollout files (`active.jsonl` + `archive-<g>.jsonl`). Plan 506 (C1):
   * generalized beyond bot sessions — any session in the generation layout
   * passes its own sessions dir (bot dir or the session-private dated dir).
   *
   * `message_index` rows carry `file_offset/byte_len` into the SPECIFIC
   * file that owns the line. We resolve the right file per row from the
   * row's `generation` column: generation `g` lives in
   * `archive-<g>.jsonl` if it exists, else `active.jsonl` (which is the
   * current generation, no rotation yet, or the file we just opened).
   *
   * Output ordering is `(generation ASC, seq ASC)` — generations never
   * overlap and seq is monotonic within a generation. After reading we
   * pipeline through `applyRebases` so a compaction rebase emitted
   * mid-rotation still folds superseded messages.
   */
  private listBySessionMultiFile(
    sessionId: string,
    sessionsDir: string,
    options?: { source?: readonly string[]; includeSuperseded?: boolean },
  ): StoredEvent[] {
    const activeAbs = path.join(sessionsDir, 'active.jsonl');
    const activeExists = fs.existsSync(activeAbs);

    const rows = this.db
      .prepare(
        'SELECT id, session_id, seq, turn_id, kind, created_at, file_offset, byte_len, generation FROM message_index WHERE session_id = ? ORDER BY generation ASC, seq ASC',
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
        generation: number;
      }>;

    if (rows.length === 0) return [];

    // Resolve each row's source file based on its generation. Rotated
    // generations live in `archive-<g>.jsonl`; the highest generation
    // (the open active one) lives in `active.jsonl`. We assume that for
    // every generation `g` that has at least one row, the corresponding
    // file exists. Missing files are logged at WARN and the rows are
    // skipped — the projection layer never DELETEs so a future
    // operator-level recovery (recreate the file from backup) restores
    // visibility without a re-index.
    const fileByGeneration = new Map<number, string>();
    const resolveFile = (generation: number): string | null => {
      const cached = fileByGeneration.get(generation);
      if (cached) return cached;
      // Active file holds the highest generation that has rows; lower
      // generations must live in archive-<g>.jsonl.
      const archiveAbs = path.join(
        sessionsDir,
        `archive-${generation}.jsonl`,
      );
      if (fs.existsSync(archiveAbs)) {
        fileByGeneration.set(generation, archiveAbs);
        return archiveAbs;
      }
      // The active file is a fallback for the highest generation only —
      // it is the file that the highest-generation rows were just written
      // to. Older generations that lack an archive would indicate a
      // half-completed rotation; we surface them as warnings below.
      if (activeExists) {
        const maxGen = rows.reduce(
          (max, r) => (r.generation > max ? r.generation : max),
          0,
        );
        if (generation === maxGen) {
          fileByGeneration.set(generation, activeAbs);
          return activeAbs;
        }
      }
      return null;
    };

    /**
     * Plan: self-heal a single-file (never-rotated) bot session whose
     * message_index offsets drifted from `active.jsonl`. This happens when the
     * active file is rewritten in place (a crash mid-`rewriteSession`, or a bot
     * rebuild) without rotating: `file_offset`/`byte_len` still point at the OLD
     * bytes, so every `readRange` here fails `JSON.parse` — one WARN per row
     * ("Unparseable rollout line skipped in projection" spam) and the bot's
     * history becomes invisible. When no `archive-<g>.jsonl` exists, the active
     * file is the single authoritative source, so `rebuildIndexFromRollout`
     * restores correct offsets and the projection self-heals on the next read.
     *
     * Multi-segment sessions are NOT touched: a corrupt row inside one archive
     * cannot be safely rebuilt from the active tail alone (we'd silently drop
     * the healthy segments). Those keep skipping with a WARN for operator
     * recovery, matching the non-bot drift-recovery policy.
     */
    let reconciled = false;
    const reconcileIndex = (): boolean => {
      if (reconciled) return false;
      reconciled = true;
      let hasArchive = false;
      try {
        hasArchive = fs
          .readdirSync(sessionsDir)
          .some((f) => f.startsWith('archive-'));
      } catch {
        // Cannot inspect the directory — play it safe, do not rebuild.
        return false;
      }
      if (hasArchive || !fs.existsSync(activeAbs)) return false;
      this.rebuildIndexFromRollout(sessionId, activeAbs);
      fileByGeneration.clear();
      // Re-fetch rows with re-numbered seqs and fresh offsets.
      const refreshed = this.db
        .prepare(
          'SELECT id, session_id, seq, turn_id, kind, created_at, file_offset, byte_len, generation FROM message_index WHERE session_id = ? ORDER BY generation ASC, seq ASC',
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
        generation: number;
      }>;
      rows.length = 0;
      rows.push(...refreshed);
      return true;
    };

    const timelineRows: TimelineEntryRow[] = [];
    const metaById = new Map<string, { turnId: string | null; createdAt: number }>();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const filePath = resolveFile(row.generation);
      if (!filePath) {
        logger.warn(
          'Bot session archive missing; row skipped',
          { sessionId, generation: row.generation, seq: row.seq },
          LogComponent.DB,
        );
        continue;
      }
      let entry: RolloutLine;
      try {
        entry = JSON.parse(
          this.readRange(filePath, row.file_offset, row.byte_len),
        ) as RolloutLine;
      } catch {
        if (reconcileIndex()) {
          // Index rebuilt from the current active file — restarting the loop
          // re-reads every row with fresh offsets, so partial results collected
          // before the rebuild must be discarded.
          metaById.clear();
          timelineRows.length = 0;
          i = -1;
          continue;
        }
        logger.warn(
          'Unparseable rollout line skipped in projection',
          { sessionId, generation: row.generation, seq: row.seq },
          LogComponent.DB,
        );
        continue;
      }
      metaById.set(entry.id ?? '', {
        turnId: row.turn_id,
        createdAt: row.created_at,
      });
      timelineRows.push({ entry, seq: row.seq });
    }

    // Rotation events are internal audit markers — they live in
    // message_index for crash-recovery purposes but they are not
    // user-visible. Strip them BEFORE applyRebases so a reader does
    // not see a rotation marker between two adjacent turns. Rebase
    // events are KEPT so applyRebases can supersede earlier messages
    // and emit the compacted survivors; applyRebases itself drops the
    // rebase row from the projection (it emits its newMessages instead).
    const filtered = timelineRows.filter(
      (r) => r.entry.type !== 'rotation',
    );

    const projected = options?.includeSuperseded
      ? repairInterruptedToolCalls(emitRebaseNewMessages(filtered))
      : repairInterruptedToolCalls(applyRebases(filtered));

    // applyRebases preserves the rebase rows in its output so audit
    // consumers (timeline()) can still see them. listBySession is the
    // LLM-visible projection — rebase rows are not user-visible, so
    // strip them at the boundary. We do this AFTER repair because the
    // repair pass needs to see the rebase event's `turnId` indirectly
    // via the timeline order; in practice repair only touches
    // message-kind rows, so stripping rebase here is safe.
    return this.applySourceFilter(projected, options?.source)
      .filter((r) => r.entry.type !== 'rebase')
      .map((projectedRow) => {
        const entry = projectedRow.entry;
        const meta = metaById.get(entry.id ?? '');
        return {
          id: entry.id ?? `seq:${projectedRow.seq}`,
          sessionId,
          seq: projectedRow.seq,
          turnId: meta?.turnId ?? null,
          kind: deriveKind(entry),
          payload: JSON.stringify(entry),
          createdAt: rolloutLineTimestamp(entry) || meta?.createdAt || 0,
        };
      });
  }

  /**
   * Plan 489 P0.3: bot-direct source allowlist filter. Drops message-kind
   * entries whose `entry.source` is missing or outside the allowlist;
   * compaction / rebase / rotation audit entries bypass (they carry no
   * user-visible bubble and the IPC adapter maps them to null / drops them).
   * Undefined allowlist → no filtering (all rows).
   */
  private applySourceFilter(
    rows: TimelineEntryRow[],
    allowlist?: readonly string[],
  ): TimelineEntryRow[] {
    if (!allowlist) return rows;
    const allowed = new Set(allowlist);
    return rows.filter((r) => {
      if (r.entry.type !== 'message') return true;
      // Source lives on the MessageEntry (IPC write path) or on the
      // AgentMessage itself (worker journal path / direct fixtures).
      const entry = r.entry as { source?: string; message?: { source?: string } };
      const source = entry.source ?? entry.message?.source;
      return source !== undefined && allowed.has(source);
    });
  }

  /**
   * Project the full timeline for a session by reading the entire rollout file.
   * Seq is assigned as the 1-based line number. Assumes `scan()` has reconciled
   * any orphan lines (no duplicates / partial tail).
   *
   * Returns the full ordered trace including event rows. Callers that need
   * only the LLM-visible message timeline should pipe this through
   * `applyRebases` + a filter for `MessageEntry`/`CompactionEntry`. The
   * legacy `project()` consumers (subagent message rebuild, etc.) expect
   * the raw projection — apply rebases at the boundary where the consumer
   * is known to be rebased-aware.
   *
   * Plan 493 (Phase B): for bot sessions, reads all archive segments
   * (`archive-<g>.jsonl` for g in 0..maxGen) followed by `active.jsonl`,
   * concatenating their contents in generation order. The returned seq
   * values remain monotonic across files so applyRebases still produces
   * a sensible projection.
   */
  project(sessionId: string): TimelineEntryRow[] {
    const botAgentId = parseAgentIdFromBotSession(sessionId);
    if (botAgentId) {
      return this.projectMultiFile(
        path.join(this.rootDir, 'agents', botAgentId, 'sessions'),
      );
    }

    const relativePath = this.getRolloutPath(sessionId);
    if (!relativePath) return [];
    const absolutePath = this.resolvePathOnDisk(relativePath);

    // Plan 506 (C1): a rotated non-bot session projects across its archive
    // segments + active.jsonl, same as a bot session.
    if (path.basename(relativePath) === 'active.jsonl' && fs.existsSync(absolutePath)) {
      return this.projectMultiFile(path.dirname(absolutePath));
    }

    const lines = this.readAll(absolutePath);
    const result: TimelineEntryRow[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length === 0) continue;
      try {
        const entry = JSON.parse(line) as RolloutLine;
        result.push({ entry, seq: i + 1 });
      } catch {
        // Skip unparseable lines (crash-damaged tail).
      }
    }
    return result;
  }

  /**
   * Plan 493 (Phase B): generation-layout projection that reads every
   * archive segment + the active file. Plan 506 (C1): generalized beyond
   * bot sessions to any rotated session's dir. Seq is assigned as a
   * monotonic counter across all files in generation order; applyRebases
   * operates on this flat seq axis.
   */
  private projectMultiFile(sessionsDir: string): TimelineEntryRow[] {
    const files = this.collectSessionGenerationFiles(sessionsDir);

    const result: TimelineEntryRow[] = [];
    let seq = 0;
    for (const file of files) {
      const lines = this.readAll(file);
      for (const line of lines) {
        if (line.length === 0) continue;
        try {
          const entry = JSON.parse(line) as RolloutLine;
          seq += 1;
          result.push({ entry, seq });
        } catch {
          // Skip unparseable lines (crash-damaged tail).
        }
      }
    }
    return result;
  }

  /**
   * Ordered source files for a session in the generation layout: every
   * dense archive segment (`archive-0.jsonl`, `archive-1.jsonl`, …)
   * followed by `active.jsonl`. Shared by the projection, export, and
   * archive listing paths.
   *
   * Discovery lists the sessions directory instead of probing a bounded
   * range: the old `0..50` probe silently truncated history for long-lived
   * bot sessions, which rotate on EVERY compaction and outlive 50
   * generations easily. A directory scan finds all generations (numeric
   * order, gaps tolerated) and logs a one-time operational warning when a
   * session accumulates an unusual number of them.
   */
  private collectSessionGenerationFiles(sessionsDir: string): string[] {
    const files: string[] = [];
    if (fs.existsSync(sessionsDir)) {
      const archives: Array<{ generation: number; abs: string }> = [];
      try {
        for (const entry of fs.readdirSync(sessionsDir)) {
          const match = entry.match(/^archive-(\d+)\.jsonl$/);
          if (match) {
            archives.push({ generation: Number(match[1]), abs: path.join(sessionsDir, entry) });
          }
        }
      } catch {
        // Unreadable directory — fall back to the active file below.
      }
      archives.sort((a, b) => a.generation - b.generation);
      if (archives.length > ARCHIVE_DISCOVERY_WARN_COUNT) {
        warnArchiveCountOnce(sessionsDir, archives.length);
      }
      for (const archive of archives) files.push(archive.abs);
    }
    const activeAbs = path.join(sessionsDir, 'active.jsonl');
    if (fs.existsSync(activeAbs)) files.push(activeAbs);
    return files;
  }

  /**
   * Read the full timeline trace for a session, including rollout events.
   * Useful for audit/replay/UI history. Returns rows in seq order; the
   * projection filter (events vs messages) is the caller's responsibility.
   *
   * Companion to `project()` (which is the message-only projection used by
   * the agent core). This method exists because plan 333+441 want the
   * rollout file to be self-describing — a reader without access to the
   * agent core's view should still be able to reconstruct the turn flow.
   */
  timeline(sessionId: string): TimelineEntryRow[] {
    // Same shape as project() — events are included in the file scan. The
    // split between the two methods is about intent: callers asking for
    // `project()` want the agent's LLM-visible view; callers asking for
    // `timeline()` want the audit/replay view.
    return this.project(sessionId);
  }

  /**
   * Plan 441: read-side repair. Applies `repairInterruptedToolCalls` to
   * `project()` output so a hard crash mid-turn (which leaves a tool_use
   * without a matching tool_result) does not surface as an invalid history.
   *
   * The rebase projection layer is applied first (so we don't synthesize
   * tool_results for messages that are already superseded), then the repair
   * runs over the effective message set. Rebase + compaction entries are
   * excluded from the repair scope — they are audit artifacts, not
   * provider messages.
   *
   * Returns rows that the agent core can directly consume as a provider-
   * acceptable history (every tool_use has a matching tool_result, no
   * orphan tool_results). Callers should still pipe through
   * `effectiveMessageTimeline` if they need only the LLM-visible subset.
   */
  repairedProject(sessionId: string): TimelineEntryRow[] {
    const projected = this.project(sessionId);
    const rebased = applyRebases(projected);
    const messageOnly = rebased.filter((r) => r.entry.type === 'message');
    return repairInterruptedToolCalls(messageOnly);
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
          const entry = JSON.parse(line) as RolloutLine;
          if (!indexedIds.has(entry.id)) {
            insert.run(
              entry.id,
              sessionId,
              sessionId,
              null,
              deriveKind(entry),
              rolloutLineTimestamp(entry),
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
   * Keep `message_search` consistent for a session after an append.
   *
   * - First append for a session → full rebuild from the projected timeline so
   *   pre-existing (pre-upgrade) messages get indexed too.
   * - Rebase in the batch → full rebuild (superseded messages dropped, survivors
   *   kept at their projected seq).
   * - Otherwise → incremental upsert of the batch's new message entries.
   */
  private syncSearchIndex(sessionId: string, freshEvents: NewEvent[]): void {
    const hasRebase = freshEvents.some((ev) => ev.payload.type === 'rebase');
    const isFirstAppend = !this.hasSearchIndexForSession(sessionId);
    if (hasRebase || isFirstAppend) {
      this.rebuildSearchForSession(sessionId);
      return;
    }

    const txn = this.db.transaction(() => {
      for (const ev of freshEvents) {
        const text = extractSearchableText(ev.payload);
        if (!text) continue;
        const row = this.db
          .prepare('SELECT seq FROM message_index WHERE id = ?')
          .get(ev.id) as { seq: number } | undefined;
        this.upsertSearchRow(sessionId, ev.id, row?.seq ?? 0, text, ev.createdAt);
      }
    });
    txn();
  }

  /**
   * Rebuild a session's `message_search` rows from the projected
   * (rebase-applied) effective timeline. Fully reconciles supersessions —
   * deleted messages vanish, survivors are re-indexed at their projected seq.
   */
  private rebuildSearchForSession(sessionId: string): void {
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM message_search WHERE session_id = ?').run(sessionId);
      for (const { entry, seq } of this.repairedProject(sessionId)) {
        const text = extractSearchableText(entry);
        if (!text) continue;
        this.upsertSearchRow(sessionId, entry.id, seq, text, rolloutLineTimestamp(entry));
      }
    });
    txn();
  }

  /** True when the session already has at least one `message_search` row. */
  private hasSearchIndexForSession(sessionId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM message_search WHERE session_id = ? LIMIT 1')
      .get(sessionId);
    return row !== undefined;
  }

  /** Insert-or-replace a single search row (keyed by message_id). */
  private upsertSearchRow(
    sessionId: string,
    id: string,
    seq: number,
    text: string,
    updatedAt: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO message_search (message_id, session_id, seq, searchable_text, text_len, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET
           seq = excluded.seq,
           searchable_text = excluded.searchable_text,
           text_len = excluded.text_len,
           updated_at = excluded.updated_at`,
      )
      .run(id, sessionId, seq, text, text.length, updatedAt);
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
        let entry: RolloutLine;
        try {
          entry = JSON.parse(line) as RolloutLine;
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
    this.db.prepare('DELETE FROM message_search WHERE session_id = ?').run(sessionId);
    this.pathCache.delete(sessionId);
  }

  /**
   * Plan 441: append a rebase record. Preferred over `rewriteSession` for
   * all production callers — the rollout file is never mutated, only the
   * projection layer changes via `applyRebases` at read time.
   *
   * `supersededUpToSeq` is the highest raw seq whose line should be
   * replaced by `newMessages` in the projection; pass `null` to supersede
   * ALL prior messages (the compaction form — callers without a reliable
   * view of DB-assigned seqs should always use null and rely on id
   * matching in newMessages to keep survivors). `newMessages` may be
   * empty (true truncation) or contain the kept raw messages (replay).
   *
   * `turnId` ties the rebase to a specific turn for turn-scoped queries.
   * It defaults to `null` when the rebase is a session-level edit (e.g.
   * edit-resend that is not turn-aligned).
   *
   * The rebase event goes through the same `appendBatch` path as message
   * rows — same INSERT OR IGNORE idempotency, same file_offset/byte_len
   * index columns, same crash recovery via `scan()`.
   */
  appendRebase(
    sessionId: string,
    turnId: string | null,
    supersededUpToSeq: number | null,
    newMessages: NewEvent[],
    createdAt: number = Date.now(),
    reason: 'compaction' | 'edit_resend' = 'compaction',
  ): void {
    if (newMessages.length === 0 && (supersededUpToSeq == null || supersededUpToSeq <= 0)) return;
    const event: RebaseEvent = {
      type: 'rebase',
      id: `rebase:${sessionId}:${supersededUpToSeq ?? 'all'}:${createdAt}`,
      turnId: turnId ?? null,
      supersededUpToSeq,
      reason,
      newMessages: newMessages.map((e) => e.payload as MessageEntry),
      createdAt,
    };
    this.appendBatch([
      {
        id: event.id,
        sessionId,
        turnId,
        payload: event,
        createdAt,
      },
    ]);
  }

  /**
   * Plan 493 (Phase B): rotate a bot session's active JSONL into an
   * archive segment and start a fresh active JSONL with an incremented
   * `generation` value. Idempotent on crash: a partial rotation
   * (archive renamed, new active not yet created) is detected by the
   * `active.jsonl exists?` check in step 1.
   *
   * Sequence:
   *   1. Resolve the current `active.jsonl` path. If it does not exist,
   *      this is a no-op (the bot session has never written a message).
   *   2. Compute `prevGeneration = getCurrentGeneration(sessionId)`.
   *   3. Move `active.jsonl` to `archive-<prevGeneration>.jsonl`. A
   *      collision at the destination means an earlier crash recovery
   *      left an orphan archive; the move fails loudly rather than
   *      silently overwriting.
   *   4. Write a `rotation` event as the FIRST line of the new
   *      `active.jsonl`. The event is the audit marker that bridges
   *      the archive and the new active segment.
   *   5. Bump `chat_sessions.generation` so external readers see the
   *      new value.
   *
   * Plan 506 (C1): non-bot sessions rotate too, into the same
   * `active.jsonl + archive-<g>.jsonl` generation layout — but only
   * once their rollout exceeds `NON_BOT_ROTATION_THRESHOLD_BYTES` (or
   * when `opts.force` is set), so ordinary sessions keep today's
   * single-file behavior byte-for-byte.
   *
   * Returns the new generation number. Returns 0 when there was
   * nothing to rotate (no active file yet, or a non-bot session under
   * the size threshold).
   */
  rotateArchive(
    sessionId: string,
    reason: 'compaction' | 'manual' = 'compaction',
    createdAt: number = Date.now(),
    opts: RotationOptions = {},
  ): number {
    const agentId = parseAgentIdFromBotSession(sessionId);
    if (!agentId) {
      // Plan 506 C1: non-bot sessions rotate under a size gate (see
      // rotateNonBotArchive). Bot sessions rotate unconditionally.
      return this.rotateNonBotArchive(sessionId, reason, createdAt, opts);
    }

    // Step 1: ensure the bot's sessions dir + active.jsonl exist.
    const activePath = getBotSessionLogPath(agentId, this.rootDir);
    if (!fs.existsSync(activePath)) {
      return 0;
    }

    // Step 2: compute prev generation.
    const prevGeneration = this.getCurrentGeneration(sessionId);

    // Step 3: rename active -> archive-<prevGeneration>.
    const archiveRel = path.join(
      'agents',
      agentId,
      'sessions',
      `archive-${prevGeneration}.jsonl`,
    );
    const archiveAbs = path.join(this.rootDir, archiveRel);
    if (fs.existsSync(archiveAbs)) {
      throw new Error(
        `rotateArchive: archive file already exists at ${archiveAbs} — refuse to overwrite. ` +
          `sessionId=${sessionId} prevGeneration=${prevGeneration}`,
      );
    }
    fs.mkdirSync(path.dirname(archiveAbs), { recursive: true });
    fs.renameSync(activePath, archiveAbs);

    // Step 4: invalidate the path cache. The next getRolloutPath call
    // re-resolves from the sessions table.
    this.pathCache.delete(sessionId);

    // Step 5: write the rotation event into the new active file.
    const newGeneration = prevGeneration + 1;
    this.commitRotationMarker(
      sessionId,
      activePath,
      archiveRel,
      newGeneration,
      reason,
      createdAt,
    );

    return newGeneration;
  }

  /**
   * Shared rotation tail (Plan 506 C1 extraction): ensure the fresh
   * `active.jsonl` exists at `activeAbs`, append the `rotation` audit
   * event as its first line, index it with the new generation stamped
   * explicitly, and bump `chat_sessions.generation`.
   *
   * The append goes through the file helper directly (NOT appendBatch) so
   * the row can stamp `generation` with the new value — appendBatch would
   * call getCurrentGeneration which is still prevGeneration at this point.
   */
  private commitRotationMarker(
    sessionId: string,
    activeAbs: string,
    archiveRel: string,
    newGeneration: number,
    reason: 'compaction' | 'manual',
    createdAt: number,
  ): void {
    // Capture the highest seq BEFORE the rotation insert so the audit
    // event can record how many rows the archive contained.
    const maxBefore = this.db
      .prepare(
        'SELECT COALESCE(MAX(seq), 0) AS m FROM message_index WHERE session_id = ?',
      )
      .get(sessionId) as { m: number };

    const event: RotationEvent = {
      type: 'rotation',
      id: `rotation:${sessionId}:${newGeneration}:${createdAt}`,
      archiveFile: archiveRel,
      newGeneration,
      reason,
      seqBeforeRotation: maxBefore.m,
      createdAt,
    };

    const txn = this.db.transaction(() => {
      this.ensureFile(activeAbs);
      const lineMeta = this.appendLines(activeAbs, [event]);

      // Insert the message_index row for the rotation event with the
      // new generation stamped explicitly.
      this.db
        .prepare(
          `INSERT OR IGNORE INTO message_index
             (id, session_id, seq, turn_id, kind, created_at, file_offset, byte_len, generation)
           VALUES
             (?, ?, COALESCE((SELECT MAX(seq) FROM message_index WHERE session_id = ?), 0) + 1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          sessionId,
          sessionId,
          null,
          'rotation',
          createdAt,
          lineMeta[0].fileOffset,
          lineMeta[0].byteLen,
          newGeneration,
        );

      // Bump chat_sessions.generation so external readers see the new
      // value. The column was added in schema.ts ensureChatSessionsColumns;
      // old DBs may not have it yet, so wrap in try/catch.
      try {
        this.db
          .prepare('UPDATE chat_sessions SET generation = ? WHERE id = ?')
          .run(newGeneration, sessionId);
      } catch (err) {
        logger.warn(
          'rotateArchive: chat_sessions.generation bump failed (column missing?)',
          { sessionId, newGeneration, error: err instanceof Error ? err.message : String(err) },
          LogComponent.DB,
        );
      }
    });
    txn();
  }

  /**
   * Plan 506 (C1): rotate a non-bot (human/cron) session's dated-tree rollout
   * into the generation layout. The first rotation moves the single
   * `rollout-<stamp>-<id>.jsonl` into a session-private directory
   * `sessions/<YYYY>/<MM>/<DD>/<sanitized-id>/archive-<g>.jsonl` and starts
   * `<dir>/active.jsonl`; subsequent rotations reuse that directory.
   *
   * Size gate: single-file sessions only rotate once their rollout is at
   * least `NON_BOT_ROTATION_THRESHOLD_BYTES` (default 4 MB) — ordinary
   * sessions keep the single-file behavior byte-for-byte. Already-rotated
   * sessions always rotate when asked (their active segment is bounded by
   * each compaction epoch). `opts.force` bypasses the gate.
   */
  private rotateNonBotArchive(
    sessionId: string,
    reason: 'compaction' | 'manual',
    createdAt: number,
    opts: RotationOptions,
  ): number {
    const rel = this.getRolloutPath(sessionId);
    if (!rel) return 0;
    const currentAbs = this.resolvePathOnDisk(rel);
    if (!fs.existsSync(currentAbs)) return 0;

    const alreadyMultiGen = path.basename(rel) === 'active.jsonl';
    if (!alreadyMultiGen && !opts.force) {
      const threshold = opts.thresholdBytes ?? NON_BOT_ROTATION_THRESHOLD_BYTES;
      if (fs.statSync(currentAbs).size < threshold) return 0;
    }

    const prevGeneration = this.getCurrentGeneration(sessionId);
    const sessionsDir = alreadyMultiGen
      ? path.dirname(currentAbs)
      : path.join(path.dirname(currentAbs), sanitizeFilenameSegment(sessionId));
    const archiveAbs = path.join(sessionsDir, `archive-${prevGeneration}.jsonl`);
    if (fs.existsSync(archiveAbs)) {
      throw new Error(
        `rotateArchive: archive file already exists at ${archiveAbs} — refuse to overwrite. ` +
          `sessionId=${sessionId} prevGeneration=${prevGeneration}`,
      );
    }
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.renameSync(currentAbs, archiveAbs);

    const activeAbs = path.join(sessionsDir, 'active.jsonl');
    const activeRel = path.relative(this.rootDir, activeAbs).split(path.sep).join('/');
    // Point the session at the new active file BEFORE writing the marker so
    // a crash in between leaves the DB referencing an existing (empty) file
    // rather than one that was renamed away.
    this.pathCache.delete(sessionId);
    this.adoptRolloutPath(sessionId, activeRel);

    const newGeneration = prevGeneration + 1;
    this.commitRotationMarker(
      sessionId,
      activeAbs,
      activeRel,
      newGeneration,
      reason,
      createdAt,
    );
    return newGeneration;
  }

  // ─── Plan 506 Track A: rollout portability ───

  /**
   * Plan 506 (A1): export a session's complete rollout as ONE portable
   * JSONL file — "one file is one session". Bot sessions and rotated
   * non-bot sessions concatenate every archive segment in generation
   * order followed by `active.jsonl`; single-file sessions are copied
   * verbatim. Read-only: source files and the DB are never touched.
   *
   * The export lands in `<rootDir>/exports/rollout-<sanitizedId>.jsonl`
   * (or `destDir` when given) and overwrites any previous export of the
   * same session — an export is a deterministic snapshot, not a
   * versioned artifact. Empty sessions produce an empty file; an empty
   * rollout is a valid session representation.
   */
  exportRollout(sessionId: string, destDir?: string): RolloutExportResult {
    if (!this.sessionRowExists(sessionId)) {
      throw new Error(`exportRollout: session not found: ${sessionId}`);
    }

    const files: string[] = [];
    const botAgentId = parseAgentIdFromBotSession(sessionId);
    if (botAgentId) {
      files.push(
        ...this.collectSessionGenerationFiles(
          path.join(this.rootDir, 'agents', botAgentId, 'sessions'),
        ),
      );
    } else {
      const rel = this.getRolloutPath(sessionId);
      if (rel) {
        const abs = this.resolvePathOnDisk(rel);
        if (path.basename(rel) === 'active.jsonl') {
          files.push(...this.collectSessionGenerationFiles(path.dirname(abs)));
        } else if (fs.existsSync(abs)) {
          files.push(abs);
        }
      }
    }

    const exportDir = destDir ?? path.join(this.rootDir, 'exports');
    fs.mkdirSync(exportDir, { recursive: true });
    const destAbs = path.join(
      exportDir,
      `rollout-${sanitizeFilenameSegment(sessionId)}.jsonl`,
    );

    let bytes = 0;
    let lines = 0;
    const fd = fs.openSync(destAbs, 'w');
    try {
      for (const src of files) {
        let buf = fs.readFileSync(src);
        if (buf.length === 0) continue;
        // A crash-truncated tail can lack the trailing newline; add one so
        // the next segment's first line does not merge into the last line.
        if (buf[buf.length - 1] !== 0x0a) {
          buf = Buffer.concat([buf, Buffer.from('\n', 'utf8')]);
        }
        fs.writeSync(fd, buf);
        bytes += buf.length;
        for (const line of buf.toString('utf8').split('\n')) {
          if (line.length > 0) lines += 1;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    return { absolutePath: destAbs, lines, bytes };
  }

  /**
   * Plan 506 (A3): whole-store reconcile. Promotes the startup `scan()`
   * from a passive crash-recovery hook into an explicit, user-triggerable
   * promise: "the rollout files are the truth; the index is a rebuildable
   * projection".
   *
   * For every session with a recorded rollout_path: re-scan the file and
   * back-fill missing message_index rows (no full delete — INSERT OR
   * IGNORE idempotency). Sessions whose file is missing on disk are
   * reported, never deleted. Additionally sweeps the rollout root for
   * .jsonl files no session references (orphans) and reports them without
   * touching them. Archive segments are exempt — they are managed by
   * rotation and referenced via the generation column, not rollout_path.
   */
  reconcileAll(): ReconcileStats {
    const stats: ReconcileStats = {
      sessionsScanned: 0,
      rowsAdded: 0,
      missingFiles: [],
      orphanFiles: [],
    };

    let rows: Array<{ id: string; rollout_path: string | null }> = [];
    try {
      rows = this.db.prepare('SELECT id, rollout_path FROM sessions').all() as Array<{
        id: string;
        rollout_path: string | null;
      }>;
    } catch {
      return stats; // no sessions table (isolated fixtures) — nothing to do
    }

    const referenced = new Set<string>();
    for (const row of rows) {
      if (!row.rollout_path) continue;
      const abs = this.resolvePathOnDisk(row.rollout_path);
      referenced.add(path.resolve(abs));
      if (!fs.existsSync(abs)) {
        stats.missingFiles.push(row.id);
        continue;
      }
      const before = this.getCount(row.id);
      this.scan(row.id);
      stats.rowsAdded += this.getCount(row.id) - before;
      stats.sessionsScanned += 1;
    }

    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          if (entry.name.startsWith('archive-')) continue;
          if (!referenced.has(path.resolve(p))) stats.orphanFiles.push(p);
        }
      }
    };
    walk(path.join(this.rootDir, 'sessions'));
    walk(path.join(this.rootDir, 'agents'));

    return stats;
  }

  /**
   * Plan 506 (A2) restore mode: rebuild a NEW session from an external
   * rollout file. The session row must already exist (the caller creates
   * it via SessionStore so the session is immediately listable); this
   * method validates every line, writes the payload into the dated
   * rollout tree, points `sessions.rollout_path` at the copy, and
   * rebuilds message_index + message_search via `scan()`.
   *
   * Id collisions: `message_index.id` is a GLOBAL primary key. When the
   * file's ids already exist anywhere in the DB (re-importing an export
   * while the original session still lives there) `INSERT OR IGNORE`
   * would silently drop every colliding row. Every colliding id is remapped
   * onto the `import:<sessionId>:<oldId>` namespace — cross-references
   * included — so the restored session is complete instead of empty.
   * Non-colliding ids keep their original identity.
   */
  importRestoreFromFile(sessionId: string, sourcePath: string): ImportResult {
    if (!this.sessionRowExists(sessionId)) {
      throw new Error(
        `importRestoreFromFile: session row missing — create it before import: ${sessionId}`,
      );
    }
    const rawLines = this.readImportSource(sourcePath);
    const lines = validateImportLines(rawLines);

    const colliding = this.findIdsOwnedByOthers(collectTopLevelIds(lines), null);
    const remapped = colliding.size > 0;
    const finalLines = remapped
      ? remapImportNamespace(lines, sessionId, 'import', colliding)
      : lines;

    // The dated bucket derives from now — an import is a new session's
    // first write. getOrCreateRolloutPath creates the file and records
    // sessions.rollout_path.
    const relativePath = this.getOrCreateRolloutPath(sessionId, Date.now());
    const absolutePath = this.resolvePathOnDisk(relativePath);
    this.ensureFile(absolutePath);
    const content =
      finalLines.map((l) => JSON.stringify(l)).join('\n') +
      (finalLines.length > 0 ? '\n' : '');
    fs.writeFileSync(absolutePath, content, 'utf8');

    this.scan(sessionId);
    this.rebuildSearchForSession(sessionId);

    return {
      sessionId,
      linesImported: finalLines.length,
      linesSkipped: 0,
      remapped,
    };
  }

  /**
   * Plan 506 (A2) continue mode: append an external rollout file's lines
   * onto an EXISTING session's tail. Idempotent for re-imports — ids
   * already indexed for the target session are skipped by appendBatch's
   * file-level dedup and counted in `linesSkipped`. Ids owned by a
   * DIFFERENT session are remapped onto the `import:<sessionId>:<oldId>`
   * namespace first: message_index.id is a global PK, so a verbatim
   * append would be silently dropped.
   *
   * Rebase lines get their numeric `supersededUpToSeq` bound shifted by
   * the target's current line count — the bound refers to positions in
   * the source file, and after the append those rows live `offset` lines
   * later in the merged trace. Null bounds (the compaction form) are
   * position-independent and pass through untouched.
   */
  importContinueFromFile(sessionId: string, sourcePath: string): ImportResult {
    if (!this.sessionRowExists(sessionId)) {
      throw new Error(`importContinueFromFile: session not found: ${sessionId}`);
    }
    const rawLines = this.readImportSource(sourcePath);
    const lines = validateImportLines(rawLines);

    const ownedByOthers = this.findIdsOwnedByOthers(
      collectTopLevelIds(lines),
      sessionId,
    );
    const remapped = ownedByOthers.size > 0;
    const finalLines = remapped
      ? remapImportNamespace(lines, sessionId, 'import', ownedByOthers)
      : lines;

    // Ids already indexed for the target are true duplicates — appendBatch
    // filters them from the file write; count them as skipped.
    const existing = this.getIndexedIds(sessionId);
    const fresh = finalLines.filter((l) => !existing.has(l.id));

    // Shift numeric rebase bounds past the existing tail (see docblock).
    const offset = this.getSessionLineCount(sessionId);
    const shifted = shiftRebaseBounds(fresh, offset);

    this.appendBatch(
      shifted.map((l) => ({
        id: l.id,
        sessionId,
        turnId: null,
        payload: l,
        createdAt: rolloutLineTimestamp(l),
      })),
    );

    const importedIds = new Set(fresh.map((l) => l.id));
    return {
      sessionId,
      linesImported: importedIds.size,
      linesSkipped: finalLines.length - importedIds.size,
      remapped,
    };
  }

  /** Read an external rollout file for import; throws when it is absent. */
  private readImportSource(sourcePath: string): string[] {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`importRollout: source file not found: ${sourcePath}`);
    }
    const content = fs.readFileSync(sourcePath, 'utf8');
    if (content.length === 0) return [];
    return content.split('\n').filter((l) => l.length > 0);
  }

  /** True when the sessions table has a row for `sessionId`. */
  private sessionRowExists(sessionId: string): boolean {
    try {
      return (
        this.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId) !==
        undefined
      );
    } catch {
      // sessions table absent in isolated fixtures — do not block the call.
      return true;
    }
  }

  /**
   * Which of `ids` already exist in message_index owned by a session
   * OTHER than `excludeSessionId` (null = any owner counts). Chunked to
   * stay under SQLite's variable limit. Used by the import paths to
   * decide when the global id PK would silently drop rows.
   */
  private findIdsOwnedByOthers(
    ids: string[],
    excludeSessionId: string | null,
  ): Set<string> {
    const out = new Set<string>();
    if (ids.length === 0) return out;
    const CHUNK = 400;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const sql = excludeSessionId
        ? `SELECT id FROM message_index WHERE id IN (${placeholders}) AND session_id != ?`
        : `SELECT id FROM message_index WHERE id IN (${placeholders})`;
      const args = excludeSessionId ? [...chunk, excludeSessionId] : chunk;
      for (const row of this.db.prepare(sql).all(...args) as Array<{ id: string }>) {
        out.add(row.id);
      }
    }
    return out;
  }

  /** Highest assigned seq for a session = number of indexed rollout lines. */
  private getSessionLineCount(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM message_index WHERE session_id = ?')
      .get(sessionId) as { m: number };
    return row.m;
  }

  /**
   * Rewrite a session's rollout file and index with a new event sequence.
   * @deprecated plan 441 — production paths use `appendRebase` instead. This
   * method is kept for test rollback paths and emergency recovery. Will be
   * removed once the IPC `db:message:truncateAfter` / `truncateFromInclusive`
   * handlers migrate to rebase events.
   *
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
   *
   * Plan 493 (Phase A): bot persistent sessions (`bot:<agentId>`) write
   * to `<agentDir>/sessions/active.jsonl` so a bot's history travels with
   * the bot directory and is purged atomically when the bot is deleted
   * (490+493). Non-bot (human/cron) sessions keep the canonical dated
   * layout `sessions/<YYYY>/<MM>/<DD>/rollout-<stamp>-<sessionId>.jsonl`,
   * where `<stamp>` is the session's `createdAt` as an ISO timestamp with
   * `:` and `.` replaced by `-` (e.g. `2026-08-06T12-00-00-000Z`). Uses UTC
   * for consistent date bucketing across timezones.
   *
   * Bot sessions are NOT date-bucketed — a single bot directory owns one
   * active JSONL, rotated on compaction (Phase B). The `createdAt`
   * parameter is preserved in the signature so callers don't branch, but
   * it is unused for the bot path.
   */
  private resolvePath(sessionId: string, createdAt: number): string {
    if (sessionId.startsWith(BOT_SESSION_ID_PREFIX)) {
      const agentId = parseAgentIdFromBotSession(sessionId);
      if (agentId) {
        // Return the ABSOLUTE path here — bot sessions live under the
        // agent dir and skip the `rootDir` join inside resolvePathOnDisk.
        // resolvePathOnDisk distinguishes bot-vs-shared by inspecting for
        // an absolute path.
        return getBotSessionLogPath(agentId, this.rootDir);
      }
    }
    const date = new Date(createdAt);
    const yyyy = String(date.getUTCFullYear()).padStart(4, '0');
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const stamp = date.toISOString().replace(/[:.]/g, '-');
    // Legacy session IDs can contain Windows-invalid filename chars (e.g.
    // `cron:<uuid>:<ts>:<uuid>` from the WeChat/cron bridge). Sanitize the
    // segment so the rollout file can be created on every platform; the
    // sanitization is deterministic so derived and stored paths stay aligned.
    return path.join('sessions', yyyy, mm, dd, `rollout-${stamp}-${sanitizeFilenameSegment(sessionId)}.jsonl`);
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
    payloads: RolloutLine[],
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
   *
   * Plan 493 (Phase A): when `relativePath` is absolute (the bot path
   * returned by `resolvePath` for `bot:<agentId>` sessions) it is returned
   * verbatim — those files live under the agent directory, not under
   * `<rootDir>/sessions/`. The legacy-doubled-tree fallback only applies to
   * relative paths.
   */
  private resolvePathOnDisk(relativePath: string): string {
    if (path.isAbsolute(relativePath)) return relativePath;
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

  /** Ids already indexed for a session — used to make file writes idempotent. */
  private getIndexedIds(sessionId: string): Set<string> {
    return new Set(
      (this.db
        .prepare('SELECT id FROM message_index WHERE session_id = ?')
        .all(sessionId) as Array<{ id: string }>).map((r) => r.id),
    );
  }

  /**
   * Current generation for a session (Plan 493, Phase B). Returns the
   * `generation` value to stamp on new message_index rows. Defaults to 0
   * for non-bot sessions or before any rotation has happened for a bot
   * session.
   *
   * Reads from the message_index row with the highest seq — the rotation
   * event itself uses kind='rotation' and is written to message_index just
   * like any other row (only the read path skips it). After a rotation the
   * highest-seq row has the new generation; before any rotation the row
   * carries generation=0 (the migration id=13 default).
   */
  private getCurrentGeneration(sessionId: string): number {
    try {
      const row = this.db
        .prepare(
          'SELECT generation FROM message_index WHERE session_id = ? ORDER BY seq DESC LIMIT 1',
        )
        .get(sessionId) as { generation: number } | undefined;
      return row?.generation ?? 0;
    } catch {
      return 0;
    }
  }

  /** Get the cached rollout path, or resolve + write back + cache on first access. */
  private getOrCreateRolloutPath(sessionId: string, createdAt: number): string {
    const desired = this.resolvePath(sessionId, createdAt);
    const existing = this.getRolloutPath(sessionId);
    if (existing && existing !== desired) {
      // Plan 506 (C1): the generation layout is sticky — the active file
      // must stay beside its archive segments, so never re-bucket it into
      // a new date directory. Only legacy single files move.
      if (path.basename(existing) === 'active.jsonl') return existing;
      // Date bucket changed (cross-midnight session) — move the file.
      this.moveRollout(sessionId, existing, desired);
      return desired;
    }
    if (existing) return existing;

    const absolutePath = this.resolvePathOnDisk(desired);
    this.ensureFile(absolutePath);

    // Write back to sessions table (only if not already set — races are safe).
    // Plan 493 (Phase A): bot sessions also stamp `agent_type = 'bot'` and
    // `agent_id = '<botId>'` on first append so a soft-deleted bot can find
    // every session that belonged to it without an extra join table. The
    // columns are added in migration id=13 (493 schema bump); old rows that
    // pre-date the column get `agent_id = NULL` which `agent_type = 'bot'`
    // queries filter out (only bot sessions are owned by a bot).
    const botAgentId = parseAgentIdFromBotSession(sessionId);
    const botSet = botAgentId
      ? ', agent_type = COALESCE(agent_type, ?), agent_id = COALESCE(agent_id, ?)'
      : '';
    try {
      const stmt = botAgentId
        ? this.db.prepare(
            'UPDATE sessions SET rollout_path = ?' +
              botSet +
              ' WHERE id = ? AND rollout_path IS NULL',
          )
        : this.db.prepare(
            'UPDATE sessions SET rollout_path = ? WHERE id = ? AND rollout_path IS NULL',
          );
      if (botAgentId) {
        stmt.run(desired, 'bot', botAgentId, sessionId);
      } else {
        stmt.run(desired, sessionId);
      }
    } catch (err) {
      // Don't swallow silently in production — see S3 in the compaction bug
      // investigation. The catch was hiding real UPDATE failures (disk
      // full, FK violation, DB lock) that left sessions.rollout_path out
      // of sync with the on-disk file. Test fixtures without a `sessions`
      // table still hit this branch; we log at WARN so production sees it
      // but it's not a crash.
      logger.warn(
        'Failed to write back sessions.rollout_path on first append',
        { sessionId, desired, error: err instanceof Error ? err.message : String(err) },
        LogComponent.DB,
      );
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
    } catch (err) {
      // This is the canonical S3 swallow: rename succeeded (file moved to
      // `dst`) but the DB still points at `fromRel`. Subsequent reads will
      // fail with "file missing" until listBySession's recovery path picks
      // up the drift — but only if the read goes through that path. Log
      // loudly so operators can spot drift before users hit /compact.
      logger.warn(
        'moveRollout: rename succeeded but sessions.rollout_path UPDATE failed',
        { sessionId, from: fromRel, to: toRel, error: err instanceof Error ? err.message : String(err) },
        LogComponent.DB,
      );
    }
    this.pathCache.set(sessionId, toRel);
  }

  /**
   * Adopt a recovered rollout path: persist to `sessions.rollout_path` and
   * refresh the in-process path cache. Used by `listBySession`'s recovery
   * path when the DB-recorded file is missing but a later-date candidate
   * exists under `<rootDir>/sessions/**`.
   */
  private adoptRolloutPath(sessionId: string, relativePath: string): void {
    this.pathCache.set(sessionId, relativePath);
    try {
      this.db.prepare('UPDATE sessions SET rollout_path = ? WHERE id = ?').run(relativePath, sessionId);
    } catch (err) {
      logger.warn(
        'Failed to adopt recovered rollout_path',
        { sessionId, relativePath, error: err instanceof Error ? err.message : String(err) },
        LogComponent.DB,
      );
    }
  }

  /**
   * Search `<rootDir>/sessions/**` for the current rollout file matching
   * `sessionId`. Filename pattern is `rollout-<isoStamp>-<sanitizedSessionId>.jsonl`.
   * Multiple candidates can exist after repeated cross-midnight moves; the
   * newest ISO-8601 stamp (lex-comparable chronologically) wins.
   Returns `null` when no candidate is found.
   */
  private findRolloutFileBySessionId(sessionId: string): string | null {
    const sessionsRoot = path.join(this.rootDir, 'sessions');
    if (!fs.existsSync(sessionsRoot)) return null;

    const safeSegment = sanitizeFilenameSegment(sessionId);
    const targetSuffix = `-${safeSegment}.jsonl`;
    const candidates: Array<{ rel: string; stamp: string }> = [];

    // sessions/<YYYY>/<MM>/<DD>/<file> is 4 levels below rootDir; cap at 6
    // to be tolerant of legacy layouts without walking the whole disk.
    const walk = (dir: string, depth: number): void => {
      if (depth > 6) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (
          entry.isFile() &&
          entry.name.startsWith('rollout-') &&
          entry.name.endsWith(targetSuffix)
        ) {
          // entry.name = `rollout-<stamp>-<sanitizedId>.jsonl`. Slice off
          // the fixed prefix/suffix to recover the stamp for sorting; ISO
          // timestamps are lex-comparable chronologically so a string sort
          // matches the chronological order we want.
          const stamp = entry.name.slice(
            'rollout-'.length,
            -targetSuffix.length,
          );
          if (!stamp) continue;
          const rel = path.relative(this.rootDir, full).split(path.sep).join('/');
          candidates.push({ rel, stamp });
        }
      }
    };

    walk(sessionsRoot, 0);
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
    return candidates[0].rel;
  }

  /**
   * Rebuild the session's index from the rollout file. Used after
   * `findRolloutFileBySessionId` recovers a drifted path: the existing
   * index rows reference file_offset/byte_len against the OLD physical
   * file, so we DELETE all rows and re-INSERT in a single transaction
   * with fresh offsets/seqs from the recovered file.
   *
   * Idempotent on file contents (a second call produces the same state).
   * Seq is assigned as the 1-based line number — matches `project()` and
   * avoids racing with appendBatch's `COALESCE(MAX(seq),0)+1` allocator
   * (we hold an exclusive delete-then-insert transaction).
   */
  private rebuildIndexFromRollout(sessionId: string, absolutePath: string): void {
    const lines = this.readAll(absolutePath);
    const deleteStmt = this.db.prepare('DELETE FROM message_index WHERE session_id = ?');
    const insertStmt = this.db.prepare(`
      INSERT INTO message_index
        (id, session_id, seq, turn_id, kind, created_at, file_offset, byte_len)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const txn = this.db.transaction(() => {
      deleteStmt.run(sessionId);
      let offset = 0;
      let seq = 0;
      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line + '\n', 'utf8');
        const contentLen = Buffer.byteLength(line, 'utf8');
        try {
          const entry = JSON.parse(line) as RolloutLine;
          seq += 1;
          insertStmt.run(
            entry.id,
            sessionId,
            seq,
            null,
            deriveKind(entry),
            rolloutLineTimestamp(entry),
            offset,
            contentLen,
          );
        } catch {
          // Skip unparseable lines (crash-damaged tail).
        }
        offset += lineBytes;
      }
    });
    txn();
  }
}

// ─── Helpers ───

/** Replace characters invalid in Windows filenames so session IDs stay safe on disk. */
function sanitizeFilenameSegment(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-');
}

function deriveKind(payload: RolloutLine): EventKind {
  if (payload.type === 'compaction') return 'compaction';
  if (isRolloutEvent(payload)) return payload.type;
  return payload.message.role;
}

/** Extract searchable text from a timeline entry for searchText. */
function extractSearchableText(entry: RolloutLine): string {
  if (entry.type === 'compaction') {
    return entry.summary;
  }
  if (isRolloutEvent(entry)) {
    // Rollout events are internal — not part of user-visible search hits.
    // Including them would surface tool internals, thinking traces, and
    // rebase bookkeeping as search results. Keep them hidden by returning
    // an empty string. Add an opt-in flag here later if audit/replay tools
    // need to search across event payloads.
    return '';
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

/**
 * Apply `rebase` events to a raw timeline trace (`project()` output). Each
 * rebase supersedes every MessageEntry with `seq <= supersededUpToSeq` (or
 * ALL prior messages when the bound is null/undefined) that appears strictly
 * before the rebase in seq order, replacing them with the rebase's
 * `newMessages`. Rebases themselves, compaction entries, and rollout-process
 * events are preserved verbatim — they are audit artifacts.
 *
 * Supersession rule (simplified — see plan 441 follow-up): ANY message row
 * covered by a later in-scope rebase is dropped, whether it is a raw row or
 * an earlier rebase's emission. A message carried forward inside a rebase's
 * `newMessages` is represented by that rebase's own emission; keeping the
 * original row too would duplicate it (this bit the truncate and compaction
 * callers, which pass all survivors as newMessages with a null bound).
 *
 * Why forward-pass semantics: a rebase refers to `seq` values from the raw
 * file, not from any intermediate projected state. Walking the raw trace
 * once is sufficient because each raw row has exactly one final disposition
 * (kept / superseded / rebase-emitted) under the rule above.
 *
 * Edge case: if a rebase's `newMessages` contains a message whose `id` also
 * appears as a later raw row, the rebase-emitted copy wins (the later raw
 * row is dropped). In practice this does not arise — `appendBatch` filters
 * already-indexed ids from the file write so a compaction rebase always
 * carries fresh ids — but the rule is documented for callers that hand-roll.
 *
 * Output `seq` for newMessages rows: the rebase event's own seq, so the
 * inserted rows occupy the rebase's slot in the trace. Gaps in the seq
 * axis after supersession are expected and informative — they show where
 * the projection collapsed history.
 */
export function applyRebases(rows: TimelineEntryRow[]): TimelineEntryRow[] {
  // Collect rebase events in seq order.
  const rebases: Array<{ seq: number; entry: RebaseEvent }> = [];
  for (const row of rows) {
    if (row.entry.type === 'rebase') {
      rebases.push({ seq: row.seq, entry: row.entry });
    }
  }
  if (rebases.length === 0) return rows;

  /**
   * True iff some rebase that appears strictly LATER in the trace supersedes
   * this row. Applies uniformly to raw messages and rebase-emitted messages:
   * carried-forward messages are represented by the carrying rebase's own
   * emission, so no kept-by-id exemption is needed (and allowing one would
   * duplicate every survivor of truncate and compaction rebases).
   */
  const supersededByLaterRebase = (msgSeq: number): boolean => {
    for (let i = rebases.length - 1; i >= 0; i--) {
      const rb = rebases[i];
      const bound = rb.entry.supersededUpToSeq;
      // null/undefined bound = "supersede ALL prior messages" (compaction form).
      const inScope = bound == null || bound < 0 || msgSeq <= bound;
      if (rb.seq > msgSeq && inScope) return true;
    }
    return false;
  };

  // Forward pass: compute disposition per row.
  const result: TimelineEntryRow[] = [];
  // Dedup guard: one message id must appear at most once in the projection.
  // A rebase-emitted survivor and a later standalone raw row can share an id
  // (the re-emitted compaction checkpoint uses a bare `<entryId>:checkpoint`
  // id that is never indexed under the rebase event, so a load→replace repair
  // cycle used to persist it again as a plain user row). First emission wins:
  // the rebase-emitted copy is authoritative, later duplicates are dropped.
  const emittedMessageIds = new Set<string>();
  for (const row of rows) {
    const entry = row.entry;

    if (entry.type === 'message') {
      if (supersededByLaterRebase(row.seq)) continue;
      if (emittedMessageIds.has(entry.id)) continue;
      emittedMessageIds.add(entry.id);
      result.push(row);
      continue;
    }

    if (entry.type === 'rebase') {
      // Emit the rebase event itself.
      result.push(row);
      // Emit its newMessages, each placed at the rebase's seq. They are
      // ALSO subject to later-rebase supersession — a rebase-emitted row is
      // no more durable than a raw row with the same seq.
      for (const m of entry.newMessages) {
        if (supersededByLaterRebase(row.seq)) continue;
        emittedMessageIds.add(m.id);
        result.push({ entry: m, seq: row.seq });
      }
      continue;
    }

    // Compaction + RolloutProcessEvent pass through untouched.
    result.push(row);
  }

  return result;
}

/**
 * Plan 548: read-side projection used when the caller wants the full
 * raw timeline PLUS the visual summary markers at each rebase point —
 * i.e. the chat UI history view.
 *
 * `applyRebases` drops every raw message a later rebase superseded, so
 * the renderer loses the pre-compaction turns. `emitRebaseNewMessages`
 * instead:
 *   - emits every raw message row verbatim (no supersede check),
 *   - still emits each rebase event's `newMessages` so the compaction
 *     summary with `isCompactSummary: true` becomes a visual break in
 *     the timeline,
 *   - drops the rebase event rows themselves (they are not user-visible),
 *   - dedups by id with first-emission-wins so rebase-emitted tails that
 *     share an id with an already-seen raw row do not double-render.
 *
 * The summary has a deterministic id (`journal-rebase:<session>:<turn>:0:<ts>`,
 * see `Journal.toMessageEntries`) that never collides with the original
 * raw row ids, so the summary itself always survives the dedup pass and
 * reaches the IPC adapter. Tail entries that share an id with a raw
 * row are dropped because the raw row was emitted first (lower seq).
 *
 * Companion to `applyRebases`; both are pure projection transforms and
 * share the same `emittedMessageIds` first-wins contract.
 */
export function emitRebaseNewMessages(rows: TimelineEntryRow[]): TimelineEntryRow[] {
  const result: TimelineEntryRow[] = [];
  const emittedMessageIds = new Set<string>();
  for (const row of rows) {
    const entry = row.entry;

    if (entry.type === 'message') {
      if (emittedMessageIds.has(entry.id)) continue;
      emittedMessageIds.add(entry.id);
      result.push(row);
      continue;
    }

    if (entry.type === 'rebase') {
      // Do NOT emit the rebase event row itself — it is an internal
      // audit marker, not a user-visible turn. Its `newMessages` carry
      // the compaction summary + retained tail, which we DO want to
      // surface so the renderer can show the CompactSummary card and
      // the post-compaction tail.
      for (const m of entry.newMessages) {
        if (emittedMessageIds.has(m.id)) continue;
        emittedMessageIds.add(m.id);
        result.push({ entry: m, seq: row.seq });
      }
      continue;
    }

    // Compaction + RolloutProcessEvent pass through untouched.
    result.push(row);
  }

  return result;
}

/**
 * The LLM-visible message timeline: applies rebases, drops event rows.
 * Consumers that need the audit trail use `MessageLog.timeline()`; consumers
 * that need the agent's view use this.
 */
export function effectiveMessageTimeline(rows: TimelineEntryRow[]): TimelineEntryRow[] {
  const rebased = applyRebases(rows);
  return rebased.filter((r) => r.entry.type === 'message' || r.entry.type === 'compaction');
}

// ─── Plan 506 Track A2: import validation + id remapping (pure helpers) ───

/** Import validation error carrying the 1-based source line number. */
export class ImportValidationError extends Error {
  readonly lineNumber: number;
  constructor(lineNumber: number, reason: string) {
    super(`Invalid rollout line ${lineNumber}: ${reason}`);
    this.name = 'ImportValidationError';
    this.lineNumber = lineNumber;
  }
}

/**
 * Validate raw JSONL lines from an external rollout file. Every line must
 * parse and carry a known `type` discriminator ('message', 'compaction',
 * or one of the six rollout event types) plus a non-empty string `id` —
 * the message_index primary key. Throws `ImportValidationError` with the
 * 1-based line number on the first violation: import is all-or-nothing,
 * a partial import would leave a misleading half-session.
 */
export function validateImportLines(rawLines: string[]): RolloutLine[] {
  const lines: RolloutLine[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ImportValidationError(i + 1, 'not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ImportValidationError(i + 1, 'not a JSON object');
    }
    const type = (parsed as { type?: unknown }).type;
    if (typeof type !== 'string') {
      throw new ImportValidationError(i + 1, 'missing "type" discriminator');
    }
    if (type !== 'message' && type !== 'compaction' && !isRolloutEvent(parsed)) {
      throw new ImportValidationError(i + 1, `unknown rollout line type "${type}"`);
    }
    const id = (parsed as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new ImportValidationError(i + 1, 'missing non-empty string "id"');
    }
    lines.push(parsed as RolloutLine);
  }
  return lines;
}

/** Top-level ids of validated lines (the message_index PK domain). */
function collectTopLevelIds(lines: RolloutLine[]): string[] {
  return lines.map((l) => l.id);
}

/**
 * Remap the ids in `remapIds` onto the `<prefix>:<sessionId>:<oldId>`
 * namespace, updating every occurrence that points at a remapped id:
 * top-level line ids, message identity fields (entry parentId, inner
 * message.id, plan-486 threadMeta.replyToId), CompactionEntry references
 * (firstKeptMessageId, compactedMessageIds, previousCompactionId), and
 * RebaseEvent newMessages. Ids outside `remapIds` — and references to ids
 * that are not being remapped — stay verbatim, so non-colliding content
 * keeps its original identity. Returns fresh deep copies; the input is
 * never mutated.
 */
export function remapImportNamespace(
  lines: RolloutLine[],
  sessionId: string,
  prefix: string,
  remapIds: ReadonlySet<string>,
): RolloutLine[] {
  if (remapIds.size === 0) return lines;

  const mint = (oldId: string): string => `${prefix}:${sessionId}:${oldId}`;
  // Mint every colliding id upfront: an id in `remapIds` may appear as a
  // top-level line id OR only as a cross-reference (parentId / replyToId /
  // compaction refs) — both occurrences must land on the same new id.
  const idMap = new Map<string, string>();
  for (const id of remapIds) idMap.set(id, mint(id));

  return lines.map((line) => {
    const copy = JSON.parse(JSON.stringify(line)) as RolloutLine;
    copy.id = idMap.get(copy.id) ?? copy.id;
    remapLineReferences(copy, idMap);
    return copy;
  });
}

/** In-place reference remap on one deep-copied line (never the original). */
function remapLineReferences(line: RolloutLine, idMap: Map<string, string>): void {
  switch (line.type) {
    case 'message': {
      if (typeof line.parentId === 'string') {
        line.parentId = idMap.get(line.parentId) ?? line.parentId;
      }
      remapMessageIdentity(line.message, idMap);
      break;
    }
    case 'compaction': {
      line.firstKeptMessageId = idMap.get(line.firstKeptMessageId) ?? line.firstKeptMessageId;
      line.compactedMessageIds = line.compactedMessageIds.map(
        (id) => idMap.get(id) ?? id,
      );
      if (typeof line.previousCompactionId === 'string') {
        line.previousCompactionId = idMap.get(line.previousCompactionId) ?? line.previousCompactionId;
      }
      break;
    }
    case 'rebase': {
      for (const m of line.newMessages) {
        if (typeof m.parentId === 'string') {
          m.parentId = idMap.get(m.parentId) ?? m.parentId;
        }
        remapMessageIdentity(m.message, idMap);
      }
      break;
    }
    default:
      // reasoning/tool_call/turn_started/system_context/rotation carry no
      // message-id references.
      break;
  }
}

/** Remap `id` + threadMeta.replyToId on one AgentMessage (deep-copied). */
function remapMessageIdentity(message: unknown, idMap: Map<string, string>): void {
  if (typeof message !== 'object' || message === null) return;
  const rec = message as { id?: unknown; metadata?: unknown };
  if (typeof rec.id === 'string') {
    rec.id = idMap.get(rec.id) ?? rec.id;
  }
  const metadata = rec.metadata as Record<string, unknown> | undefined;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return;
  const threadMeta = metadata[THREAD_METADATA_KEY] as
    | Record<string, unknown>
    | undefined;
  if (!threadMeta || typeof threadMeta !== 'object' || Array.isArray(threadMeta)) {
    return;
  }
  if (typeof threadMeta.replyToId === 'string') {
    threadMeta.replyToId = idMap.get(threadMeta.replyToId) ?? threadMeta.replyToId;
  }
}

/**
 * Shift numeric `supersededUpToSeq` bounds by `offset` (continue-mode
 * import): the bound refers to line positions in the source file, and
 * after the append those rows sit `offset` lines later in the merged
 * trace. Null/negative bounds are position-independent and untouched.
 * Returns fresh copies only for modified lines.
 */
export function shiftRebaseBounds(
  lines: RolloutLine[],
  offset: number,
): RolloutLine[] {
  if (offset === 0) return lines;
  return lines.map((line) => {
    if (line.type !== 'rebase') return line;
    const bound = line.supersededUpToSeq;
    if (typeof bound !== 'number' || bound < 0) return line;
    const copy = JSON.parse(JSON.stringify(line)) as RolloutLine;
    (copy as { supersededUpToSeq?: number | null }).supersededUpToSeq = bound + offset;
    return copy;
  });
}
