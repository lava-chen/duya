import type { SqliteDatabase } from './sqlite-connection.js';
import type {
  HostLocalTurnSuggestionRecord,
  TurnSuggestionWriteInput,
} from '@duya/agent-protocol/turn-suggestion';

/**
 * Reads the persisted end-of-turn suggestion for a session from the main database.
 *
 * One row per turn. The latest row is the one a surface shows, so a session
 * that was closed and reopened still offers the suggestion of its last turn.
 */
export class ChatTurnSuggestionStore {
  constructor(private readonly db: SqliteDatabase) {}

  getLatestForSession(sessionId: string): HostLocalTurnSuggestionRecord | null {
    const row = this.db.prepare(`
      SELECT id, session_id, turn_id, suggestion, created_at
      FROM chat_turn_suggestions
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(sessionId) as TurnSuggestionDatabaseRow | undefined;
    return row ? toTurnSuggestionRecord(row) : null;
  }

  getBySessionAndTurnId(sessionId: string, turnId: string): HostLocalTurnSuggestionRecord | null {
    const row = this.db.prepare(`
      SELECT id, session_id, turn_id, suggestion, created_at
      FROM chat_turn_suggestions
      WHERE session_id = ? AND turn_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(sessionId, turnId) as TurnSuggestionDatabaseRow | undefined;
    return row ? toTurnSuggestionRecord(row) : null;
  }

  save(input: TurnSuggestionWriteInput): void {
    this.db.prepare(`
      INSERT INTO chat_turn_suggestions (
        id, session_id, turn_id, suggestion, created_at
      ) VALUES (
        @id, @session_id, @turn_id, @suggestion, @created_at
      )
      ON CONFLICT(session_id, turn_id) DO UPDATE SET
        suggestion = excluded.suggestion,
        created_at = excluded.created_at
    `).run({
      id: input.id,
      session_id: input.sessionId,
      turn_id: input.turnId,
      suggestion: input.suggestion,
      created_at: input.createdAt,
    });
  }
}

interface TurnSuggestionDatabaseRow {
  readonly id: string;
  readonly session_id: string;
  readonly turn_id: string;
  readonly suggestion: string;
  readonly created_at: number;
}

function toTurnSuggestionRecord(row: TurnSuggestionDatabaseRow): HostLocalTurnSuggestionRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    suggestion: row.suggestion,
    createdAt: row.created_at,
  };
}
