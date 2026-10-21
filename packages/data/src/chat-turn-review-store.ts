import type { SqliteDatabase } from './sqlite-connection.js';
import type {
  HostLocalTurnReviewRecord,
  HostLocalTurnReviewSummary,
  TurnReviewWriteInput,
} from '@duya/agent-protocol/turn-review';

export interface SessionChangeStats {
  readonly filesChanged: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

/** Reads the persisted diff summary for a session from the main database. */
export class ChatTurnReviewStore {
  constructor(private readonly db: SqliteDatabase) {}

  getLatestForSession(sessionId: string): HostLocalTurnReviewRecord | null {
    const row = this.db.prepare(`
      SELECT id, session_id, turn_id, working_directory, files_json, patch,
             additions, removals, truncated, binary, captured_at
      FROM chat_turn_reviews
      WHERE session_id = ?
      ORDER BY captured_at DESC
      LIMIT 1
    `).get(sessionId) as TurnReviewDatabaseRow | undefined;
    return row ? toTurnReviewRecord(row) : null;
  }

  listForSession(sessionId: string, limit: number): readonly HostLocalTurnReviewSummary[] {
    const rows = this.db.prepare(`
      SELECT id, turn_id, files_json, additions, removals, captured_at
      FROM chat_turn_reviews
      WHERE session_id = ?
      ORDER BY captured_at DESC
      LIMIT ?
    `).all(sessionId, limit) as TurnReviewSummaryDatabaseRow[];
    return rows.map((row) => ({
      id: row.id,
      turnId: row.turn_id,
      filesJson: row.files_json,
      additions: row.additions,
      removals: row.removals,
      capturedAt: row.captured_at,
    }));
  }

  getById(reviewId: string): HostLocalTurnReviewRecord | null {
    const row = this.db.prepare(`
      SELECT id, session_id, turn_id, working_directory, files_json, patch,
             additions, removals, truncated, binary, captured_at
      FROM chat_turn_reviews
      WHERE id = ?
    `).get(reviewId) as TurnReviewDatabaseRow | undefined;
    return row ? toTurnReviewRecord(row) : null;
  }

  getBySessionAndTurnId(sessionId: string, turnId: string): HostLocalTurnReviewRecord | null {
    const row = this.db.prepare(`
      SELECT id, session_id, turn_id, working_directory, files_json, patch,
             additions, removals, truncated, binary, captured_at
      FROM chat_turn_reviews
      WHERE session_id = ? AND turn_id = ?
      ORDER BY captured_at DESC
      LIMIT 1
    `).get(sessionId, turnId) as TurnReviewDatabaseRow | undefined;
    return row ? toTurnReviewRecord(row) : null;
  }

  save(input: TurnReviewWriteInput): void {
    this.db.prepare(`
      INSERT INTO chat_turn_reviews (
        id, session_id, turn_id, working_directory, files_json, patch,
        additions, removals, truncated, binary, captured_at
      ) VALUES (
        @id, @session_id, @turn_id, @working_directory, @files_json, @patch,
        @additions, @removals, @truncated, @binary, @captured_at
      )
      ON CONFLICT(session_id, turn_id) DO UPDATE SET
        files_json = excluded.files_json,
        patch = excluded.patch,
        additions = excluded.additions,
        removals = excluded.removals,
        truncated = excluded.truncated,
        binary = excluded.binary,
        captured_at = excluded.captured_at
    `).run({
      id: input.id,
      session_id: input.sessionId,
      turn_id: input.turnId,
      working_directory: input.workingDirectory,
      files_json: JSON.stringify(input.files),
      patch: input.patch,
      additions: input.additions,
      removals: input.removals,
      truncated: input.truncated ? 1 : 0,
      binary: input.binary ? 1 : 0,
      captured_at: input.capturedAt,
    });
  }

  getSessionStats(sessionId: string): SessionChangeStats {
    const reviews = this.db
      .prepare('SELECT additions, removals, files_json FROM chat_turn_reviews WHERE session_id = ?')
      .all(sessionId) as Array<{
        additions: number | null;
        removals: number | null;
        files_json: string | null;
      }>;
    let linesAdded = 0;
    let linesRemoved = 0;
    const files = new Set<string>();

    for (const review of reviews) {
      linesAdded += Number(review.additions) || 0;
      linesRemoved += Number(review.removals) || 0;
      try {
        const parsed: unknown = JSON.parse(review.files_json ?? '[]');
        if (!Array.isArray(parsed)) continue;
        for (const item of parsed) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          const filePath = (item as { path?: unknown }).path;
          if (typeof filePath === 'string' && filePath.length > 0) files.add(filePath);
        }
      } catch {
        // Ignore malformed file lists while retaining the numeric review totals.
      }
    }

    return { filesChanged: files.size, linesAdded, linesRemoved };
  }
}

interface TurnReviewDatabaseRow {
  readonly id: string;
  readonly session_id: string;
  readonly turn_id: string;
  readonly working_directory: string;
  readonly files_json: string;
  readonly patch: string;
  readonly additions: number;
  readonly removals: number;
  readonly truncated: number;
  readonly binary: number;
  readonly captured_at: number;
}

interface TurnReviewSummaryDatabaseRow {
  readonly id: string;
  readonly turn_id: string;
  readonly files_json: string;
  readonly additions: number;
  readonly removals: number;
  readonly captured_at: number;
}

function toTurnReviewRecord(row: TurnReviewDatabaseRow): HostLocalTurnReviewRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    workingDirectory: row.working_directory,
    filesJson: row.files_json,
    patch: row.patch,
    additions: row.additions,
    removals: row.removals,
    truncated: row.truncated,
    binary: row.binary,
    capturedAt: row.captured_at,
  };
}
