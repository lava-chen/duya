import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { CoreDatabase } from '../src/core-database.js';
import { collectCoreDatabaseMigrations } from '../src/core-data-host.js';
import { TaskStore } from '../src/core-stores.js';
import { ProjectStore } from '../src/project-store.js';

it('removes the legacy chat-session cascade without losing Tasks, incoming Project links or indexes', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    db.exec(`CREATE TABLE chat_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, subject TEXT NOT NULL, description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', active_form TEXT, owner TEXT, blocks TEXT NOT NULL DEFAULT '[]',
        blocked_by TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      );
      INSERT INTO chat_sessions(id) VALUES ('legacy');
      CREATE INDEX custom_task_subject ON tasks(subject);`);
    const migrations = collectCoreDatabaseMigrations();
    const old = new CoreDatabase({ filename: ':memory:', database: db, migrations: migrations.filter((migration) => migration.id <= 67) });
    const tasks = new TaskStore(db);
    const projects = new ProjectStore(db);
    tasks.create({ id: 'task', sessionId: 'legacy', subject: 'Preserved', description: 'Existing work', status: 'completed', metadata: { evidence: 'kept' } });
    projects.insert({ project_id: 'project', canonical_root: '/legacy' });
    projects.bindCoordinatorSession('project', 'legacy');
    projects.bindTask('project', 'task', 'legacy');
    projects.setTaskAcceptance('project', 'task', 'accepted', 'user_action', 'existing-review');
    const before = tasks.get('task');
    old.close();
    const upgraded = new CoreDatabase({ filename: ':memory:', database: db, migrations });
    expect(tasks.get('task')).toEqual(before);
    expect(projects.getTaskLink('task')).toMatchObject({ project_id: 'project', acceptance_status: 'accepted', revision: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'custom_task_subject'").get()).toBeDefined();
    db.prepare('DELETE FROM chat_sessions WHERE id = ?').run('legacy');
    expect(tasks.get('task')).toEqual(before);
    expect(projects.getTaskLink('task')).not.toBeNull();
    expect(tasks.create({ id: 'new-task', sessionId: 'host-only-coordinator', subject: 'New work', description: 'No legacy mirror required' }).id).toBe('new-task');
    tasks.delete('task');
    expect(projects.getTaskLink('task')).toBeNull();
    upgraded.close();
  } finally {
    db.close();
  }
});

it('rolls back a failed table rebuild and restores foreign-key enforcement', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    expect(() => new CoreDatabase({ filename: ':memory:', database: db, migrations: [{ id: 1, name: 'failed-rebuild', rebuildWithForeignKeysOff: true,
      up: (connection) => {
        expect(connection.pragma('foreign_keys', { simple: true })).toBe(0);
        connection.exec('CREATE TABLE must_rollback (id TEXT PRIMARY KEY)');
        throw new Error('simulated migration failure');
      },
    }] })).toThrow('simulated migration failure');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'must_rollback'").get()).toBeUndefined();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toBeUndefined();
  } finally {
    db.close();
  }
});
