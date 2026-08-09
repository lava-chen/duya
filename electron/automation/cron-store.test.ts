import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// All mock state lives in vi.hoisted so the vi.mock factory closure
// (also hoisted) and the test bodies see the same singleton. The
// in-memory ConfigStore holds a shared `cron.jobs` array; getByPath
// returns it and set replaces its contents.
const mocks = vi.hoisted(() => {
  const jobs: unknown[] = [];
  return {
    jobs,
    store: {
      getByPath: vi.fn((key: string): unknown => {
        if (key === 'cron.jobs') return jobs;
        return undefined;
      }),
      set: vi.fn((key: string, value: unknown): void => {
        if (key === 'cron.jobs') {
          jobs.length = 0;
          jobs.push(...(value as unknown[]));
        }
      }),
      subscribe: vi.fn(() => () => {}),
    },
  };
});

// Test file is at electron/automation/; the store instance is at
// electron/config/store-instance.ts — so the path is '../config/store-instance'.
vi.mock('../config/store-instance', () => ({
  getConfigStore: () => mocks.store,
}));

import { CronStore } from './cron-store';

let db: Database.Database;

beforeEach(() => {
  mocks.jobs.length = 0;
  mocks.store.getByPath.mockClear();
  mocks.store.set.mockClear();
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE automation_cron_state (
      cron_id TEXT PRIMARY KEY,
      status TEXT,
      next_run_at INTEGER,
      last_run_at INTEGER,
      last_error TEXT,
      retry_count INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE automation_cron_runs (
      id TEXT PRIMARY KEY,
      cron_id TEXT,
      run_status TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      output TEXT,
      error_message TEXT,
      logs TEXT,
      session_id TEXT,
      created_at INTEGER
    );
  `);
});

function makeStore(): CronStore {
  return new CronStore(db);
}

describe('CronStore', () => {
  it('createCron writes the definition to cron.jobs and creates a state row', () => {
    const store = makeStore();
    const created = store.createCron({
      name: 'daily report',
      schedule: { kind: 'every', everyMs: 300_000 },
      prompt: 'summarize yesterday',
      model: 'minimax',
      inputParams: { region: 'cn' },
    });

    expect(created.id).toBeTruthy();
    expect(created.status).toBe('enabled');
    expect(created.input_params).toBe(JSON.stringify({ region: 'cn' }));
    expect(created.session_target).toBe('isolated');
    expect(created.delivery_mode).toBe('none');

    // Definition persisted under cron.jobs.
    const defs = mocks.store.getByPath('cron.jobs') as Record<string, unknown>[];
    expect(defs.length).toBe(1);
    expect(defs[0]).toMatchObject({ id: created.id, name: 'daily report' });

    // State row created (status NULL; enabled sets next_run_at).
    const row = db
      .prepare('SELECT * FROM automation_cron_state WHERE cron_id = ?')
      .get(created.id) as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.status).toBeNull();
    expect(row.next_run_at).toBeTypeOf('number');
  });

  it('getCron/listCrons merge runtime state overrides (markScheduleError)', () => {
    const store = makeStore();
    const created = store.createCron({
      name: 'flaky',
      schedule: { kind: 'cron', cronExpr: '0 9 * * *' },
      prompt: 'run task',
      model: 'minimax',
    });

    store.markScheduleError(created.id, 'bad schedule parse');

    const cron = store.getCron(created.id)!;
    expect(cron).not.toBeNull();
    expect(cron.status).toBe('error');
    expect(cron.last_error).toBe('bad schedule parse');
    expect(cron.next_run_at).toBeNull();

    const list = store.listCrons();
    expect(list.length).toBe(1);
    expect(list[0].status).toBe('error');
    expect(list[0].last_error).toBe('bad schedule parse');

    // loadEnabledCrons excludes the errored cron.
    expect(store.loadEnabledCrons().length).toBe(0);
  });

  it('deleteCron removes the definition and state row but keeps runs', () => {
    const store = makeStore();
    const created = store.createCron({
      name: 'temp',
      schedule: { kind: 'at', at: '2099-01-01T00:00:00Z' },
      prompt: 'do thing',
      model: 'minimax',
    });
    const runId = store.insertRun(created.id, 'cancelled by user');

    const result = store.deleteCron(created.id);
    expect(result.success).toBe(true);

    // Definition removed.
    expect((mocks.store.getByPath('cron.jobs') as unknown[]).length).toBe(0);
    expect(store.getCron(created.id)).toBeNull();

    // State row removed.
    const stateRow = db.prepare('SELECT * FROM automation_cron_state WHERE cron_id = ?').get(created.id);
    expect(stateRow).toBeUndefined();

    // Run history preserved.
    const runRow = db.prepare('SELECT * FROM automation_cron_runs WHERE id = ?').get(runId);
    expect(runRow).toBeTruthy();
    expect(store.listCronRuns({ cronId: created.id }).length).toBe(1);
  });
});
