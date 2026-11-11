import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreDataHost, collectCoreDatabaseMigrations } from '../src/core-data-host.js';
import { CoreDatabase } from '../src/core-database.js';
import { DatabaseHost } from '../src/database-host.js';
import { ProjectStore } from '../src/project-store.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-core-host-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createHost(root: string): CoreDataHost {
  return new CoreDataHost({
    filename: path.join(root, 'duya-core.db'),
    rolloutRoot: path.join(root, 'sessions'),
    attachmentsRoot: path.join(root, 'attachments'),
    messageLogPorts: {
      botSessionIdPrefix: 'bot:',
      parseBotSessionId: () => null,
      getBotSessionLogPath: (agentId, dataRoot) => path.join(dataRoot, 'agents', agentId, 'sessions.jsonl'),
      getBotSessionsDir: (agentId, dataRoot) => path.join(dataRoot, 'agents', agentId, 'sessions'),
    },
  });
}

describe('CoreDataHost', () => {
  it.each([48, 50])('upgrades an existing v%s project database without losing its bindings', (version) => {
    const root = makeTempDirectory();
    const filename = path.join(root, 'duya-core.db');
    const old = new CoreDatabase({ filename, migrations: [
      ...collectCoreDatabaseMigrations().filter((migration) => migration.id <= version),
      { ...ProjectStore.migrations[0]!, id: 18 },
    ] });
    new ProjectStore(old.db).insert({ project_id: 'project-1', canonical_root: root, name: 'Existing project' });
    expect(old.schemaVersion).toBe(version);
    old.close();

    const upgraded = createHost(root);
    try {
      const { projects, sessions, tasks } = upgraded.stores;
      expect(projects.get('project-1')).toMatchObject({ name: 'Existing project', coordinator_session_id: null });
      sessions.create({ id: 'coordinator', agentProfileId: 'project-coordinator' });
      sessions.create({ id: 'worker', parentSessionId: 'coordinator' });
      tasks.create({ id: 'task', sessionId: 'coordinator', subject: 'Existing project work', description: 'Persist across upgrade', status: 'pending' });
      projects.bindCoordinatorSession('project-1', 'coordinator');
      projects.bindTask('project-1', 'task', 'coordinator');
      projects.bindWorkSession('project-1', 'task', 'worker');
    } finally {
      upgraded.close();
    }
    const reopened = createHost(root);
    try {
      expect(reopened.stores.projects.getByCoordinatorSession('coordinator')?.project_id).toBe('project-1');
      expect(reopened.stores.projects.listTaskLinks('project-1')).toMatchObject([
        { task_id: 'task', work_session_id: 'worker' },
      ]);
      reopened.stores.sessions.delete('worker');
      expect(reopened.stores.projects.listTaskLinks('project-1')[0]?.work_session_id).toBeNull();
      reopened.stores.tasks.delete('task');
      expect(reopened.stores.projects.listTaskLinks('project-1')).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it('owns migrations and reopens durable session stores', () => {
    const root = makeTempDirectory();
    const first = createHost(root);

    first.stores.sessions.create({ id: 'session-1', title: 'Persisted from Host' });
    first.close();
    first.close();

    const reopened = createHost(root);
    expect(reopened.stores.sessions.get('session-1')?.title).toBe('Persisted from Host');
    reopened.close();
  });

  it('shares the main connection and imports the previous core database before exposing stores', () => {
    const root = makeTempDirectory();
    const legacyPath = path.join(root, 'duya-core.db');
    const canonicalPath = path.join(root, 'duya-main.db');
    const legacy = createHost(root);
    legacy.stores.sessions.create({ id: 'legacy-session', title: 'Imported core session' });
    legacy.close();

    const host = new DatabaseHost();
    const main = host.openMainDatabase({
      filename: canonicalPath,
      ports: { deriveConnectionSlug: (connectionId) => connectionId },
    });
    try {
      const core = host.openCoreDatabase({
        filename: canonicalPath,
        legacyDatabasePath: legacyPath,
        rolloutRoot: path.join(root, 'sessions'),
        attachmentsRoot: path.join(root, 'attachments'),
        messageLogPorts: {
          botSessionIdPrefix: 'bot:',
          parseBotSessionId: () => null,
          getBotSessionLogPath: (agentId, dataRoot) => path.join(dataRoot, 'agents', agentId, 'sessions.jsonl'),
          getBotSessionsDir: (agentId, dataRoot) => path.join(dataRoot, 'agents', agentId, 'sessions'),
        },
      });
      expect(core.database.db).toBe(main.db);
      expect(core.stores.sessions.get('legacy-session')?.title).toBe('Imported core session');
      expect((main.db.pragma('table_info(permission_requests)') as Array<{ name: string }>).map(({ name }) => name))
        .toEqual(expect.arrayContaining(['mode', 'expires_at', 'reason']));
      expect((main.db.pragma('table_info(session_runtime_locks)') as Array<{ name: string }>).map(({ name }) => name))
        .toContain('origin');
      expect(fs.existsSync(legacyPath)).toBe(false);
      expect(fs.existsSync(`${legacyPath}.pre-unification`)).toBe(true);
    } finally {
      host.close();
    }
  });
});
