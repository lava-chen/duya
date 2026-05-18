/**
 * queries/threads.ts - Session threading queries
 *
 * Threading is implemented via chat_sessions.parent_id field.
 * There is no separate threads table.
 * Functions for parent/child session relationships.
 */

import { getDatabase } from '../connection';

type BetterSqlite3 = InstanceType<typeof import('better-sqlite3')>;

function db(): BetterSqlite3 {
  const d = getDatabase();
  if (!d) throw new Error('Database not initialized');
  return d;
}

export interface SessionThreadRow {
  id: string;
  title: string;
  model: string;
  working_directory: string;
  status: string;
  mode: string;
  parent_id: string | null;
  agent_type: string;
  agent_name: string;
  created_at: number;
  updated_at: number;
}

export function getChildSessions(parentId: string): SessionThreadRow[] {
  return db().prepare(
    `SELECT id, title, model, working_directory, status, mode, parent_id, agent_type, agent_name, created_at, updated_at
     FROM chat_sessions WHERE is_deleted = 0 AND parent_id = ? ORDER BY created_at ASC`
  ).all(parentId) as SessionThreadRow[];
}

export function getConversationThread(sessionId: string): SessionThreadRow[] {
  const session = db().prepare('SELECT parent_id FROM chat_sessions WHERE id = ?').get(sessionId) as { parent_id: string | null } | undefined;
  if (!session) return [];

  const rootId = session.parent_id || sessionId;
  return db().prepare(
    `SELECT id, title, model, working_directory, status, mode, parent_id, agent_type, agent_name, created_at, updated_at
     FROM chat_sessions WHERE is_deleted = 0 AND (id = ? OR parent_id = ?) ORDER BY created_at ASC`
  ).all(rootId, rootId) as SessionThreadRow[];
}