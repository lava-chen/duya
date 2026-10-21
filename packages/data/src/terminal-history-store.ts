import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from './sqlite-connection.js';

export interface TerminalHistoryQuery {
  prefix: string;
  shell?: string;
  cwd?: string;
  limit?: number;
}

export interface TerminalHistoryRecordInput {
  command: string;
  shell: string;
  cwd: string;
  source?: string;
}

export interface TerminalHistorySuggestion {
  command: string;
  suffix: string;
  useCount: number;
  lastUsedAt: number;
}

interface TerminalHistoryRow {
  command: string;
  useCount: number;
  lastUsedAt: number;
}

/** Data-owned persistence for local terminal command completion history. */
export class TerminalHistoryStore {
  constructor(private readonly db: SqliteDatabase) {}

  suggest(query: TerminalHistoryQuery): TerminalHistorySuggestion[] {
    const prefix = query.prefix.trimStart();
    if (!prefix) return [];

    const params: unknown[] = [`${prefix}%`];
    const where = ['command LIKE ?'];
    if (query.shell) {
      where.push('shell = ?');
      params.push(query.shell);
    }
    if (query.cwd) {
      where.push('cwd = ?');
      params.push(query.cwd);
    }
    const limit = Math.max(1, Math.min(20, Math.floor(query.limit ?? 8)));
    params.push(limit);

    const rows = this.db.prepare(`
      SELECT command, use_count AS useCount, last_used_at AS lastUsedAt
      FROM terminal_command_history
      WHERE ${where.join(' AND ')}
      ORDER BY use_count DESC, last_used_at DESC
      LIMIT ?
    `).all(...params) as TerminalHistoryRow[];

    return rows
      .filter((row) => row.command !== prefix && row.command.startsWith(prefix))
      .map((row) => ({
        command: row.command,
        suffix: row.command.slice(prefix.length),
        useCount: row.useCount,
        lastUsedAt: row.lastUsedAt,
      }));
  }

  record(input: TerminalHistoryRecordInput, now = Date.now()): void {
    const command = input.command.trim();
    if (!command) return;

    this.db.prepare(`
      INSERT INTO terminal_command_history
        (id, command, shell, cwd, source, use_count, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(command, shell, cwd, source)
      DO UPDATE SET
        use_count = use_count + 1,
        last_used_at = excluded.last_used_at
    `).run(randomUUID(), command, input.shell, input.cwd, input.source ?? 'user', now, now);
  }
}
