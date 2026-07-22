import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DatabaseProperty,
  DatabaseQueryResult,
  DatabaseRecordSnapshot,
  DatabaseSourceSnapshot,
} from '../../../packages/conductor/src/database/types';
import { ProjectDatabaseEngine, ProjectDatabaseError } from '../engine';
import { resolveProjectDatabasePath } from '../service';

const tempDirectories: string[] = [];

function tempProject(): { projectPath: string; dbPath: string } {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-project-db-'));
  tempDirectories.push(projectPath);
  return { projectPath, dbPath: resolveProjectDatabasePath(projectPath) };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('ProjectDatabaseEngine', () => {
  it('creates the project database under .duya with a title property and table view', () => {
    const { dbPath } = tempProject();
    const engine = new ProjectDatabaseEngine();

    const snapshot = engine.invoke(dbPath, {
      type: 'source.create',
      name: 'Tasks',
    }) as DatabaseSourceSnapshot;

    expect(dbPath).toMatch(/[\\/]\.duya[\\/]database\.sqlite$/);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(snapshot.source.name).toBe('Tasks');
    expect(snapshot.properties).toEqual([
      expect.objectContaining({ name: 'Name', type: 'title' }),
    ]);
    expect(snapshot.views).toEqual([
      expect.objectContaining({ name: 'Table', type: 'table' }),
    ]);

    engine.closeAll();
  });

  it('stores typed values, filters by stable option ID, and sorts records', () => {
    const { dbPath } = tempProject();
    const engine = new ProjectDatabaseEngine();
    const source = engine.invoke(dbPath, { type: 'source.create', name: 'Tasks' }) as DatabaseSourceSnapshot;

    const status = engine.invoke(dbPath, {
      type: 'property.create',
      sourceId: source.source.id,
      name: 'Status',
      propertyType: 'status',
      options: [{ name: 'Todo' }, { name: 'Doing' }, { name: 'Done' }],
    }) as DatabaseProperty;
    const priority = engine.invoke(dbPath, {
      type: 'property.create',
      sourceId: source.source.id,
      name: 'Priority',
      propertyType: 'number',
    }) as DatabaseProperty;
    const doingId = status.options.find((option) => option.name === 'Doing')!.id;

    engine.invoke(dbPath, {
      type: 'record.create',
      sourceId: source.source.id,
      title: 'Second',
      values: { [status.id]: doingId, [priority.id]: 2 },
    });
    engine.invoke(dbPath, {
      type: 'record.create',
      sourceId: source.source.id,
      title: 'First',
      values: { [status.id]: doingId, [priority.id]: 1 },
    });
    engine.invoke(dbPath, {
      type: 'record.create',
      sourceId: source.source.id,
      title: 'Excluded',
      values: { [status.id]: status.options[0].id, [priority.id]: 0 },
    });

    const result = engine.invoke(dbPath, {
      type: 'query',
      sourceId: source.source.id,
      filter: { propertyId: status.id, operator: 'equals', value: doingId },
      sorts: [{ propertyId: priority.id, direction: 'asc' }],
      limit: 50,
    }) as DatabaseQueryResult;

    expect(result.records.map((record) => record.record.title)).toEqual(['First', 'Second']);
    expect(result.records[0].values[status.id]).toBe(doingId);
    expect(result.nextCursor).toBeNull();

    engine.closeAll();
  });

  it('rejects stale updates and excludes archived records by default', () => {
    const { dbPath } = tempProject();
    const engine = new ProjectDatabaseEngine();
    const source = engine.invoke(dbPath, { type: 'source.create', name: 'Tasks' }) as DatabaseSourceSnapshot;
    const created = engine.invoke(dbPath, {
      type: 'record.create',
      sourceId: source.source.id,
      title: 'Draft',
    }) as DatabaseRecordSnapshot;

    const updated = engine.invoke(dbPath, {
      type: 'record.update',
      sourceId: source.source.id,
      recordId: created.record.id,
      expectedRevision: 1,
      title: 'Ready',
    }) as DatabaseRecordSnapshot;
    expect(updated.record.revision).toBe(2);

    try {
      engine.invoke(dbPath, {
        type: 'record.update',
        sourceId: source.source.id,
        recordId: created.record.id,
        expectedRevision: 1,
        title: 'Stale overwrite',
      });
      throw new Error('Expected a revision conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectDatabaseError);
      expect((error as ProjectDatabaseError).code).toBe('CONFLICT');
    }

    engine.invoke(dbPath, {
      type: 'record.archive',
      sourceId: source.source.id,
      recordId: created.record.id,
      expectedRevision: 2,
      archived: true,
    });
    const visible = engine.invoke(dbPath, {
      type: 'query',
      sourceId: source.source.id,
      limit: 50,
    }) as DatabaseQueryResult;
    const all = engine.invoke(dbPath, {
      type: 'query',
      sourceId: source.source.id,
      limit: 50,
      includeArchived: true,
    }) as DatabaseQueryResult;

    expect(visible.records).toHaveLength(0);
    expect(all.records).toHaveLength(1);
    expect(all.records[0].record.archivedAt).not.toBeNull();

    engine.closeAll();
  });
});
