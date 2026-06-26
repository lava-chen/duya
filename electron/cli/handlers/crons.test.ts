/**
 * electron/cli/handlers/crons.test.ts
 *
 * Regression tests for the cron CLI handler. Specifically guards:
 *   - handleGetCron wraps the row in `{ cron }` (client expects
 *     `body.cron`, the previous bare DTO caused
 *     "Cannot read properties of undefined (reading 'id')").
 *   - handleDeleteCron does not crash with ReferenceError on the
 *     audit-event path (the `_req`/`req` typo used to throw, the
 *     outer catch turned it into a 500, and the row was already
 *     deleted — so the retry returned 404).
 *   - handleCreateCron surfaces a useful schedule error when the
 *     user supplies the wrong field.
 *
 * Uses an in-memory better-sqlite3 so we don't touch the real
 * userData dir. We override `process.env.DUYA_CLI_USER_DATA_DIR`
 * to a temp dir for the audit log.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => process.env.DUYA_CLI_USER_DATA_DIR ?? tmpdir(),
  },
}));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS automation_crons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  working_directory TEXT NOT NULL DEFAULT '',
  schedule_kind TEXT NOT NULL,
  schedule_at TEXT,
  schedule_every_ms INTEGER,
  schedule_cron_expr TEXT,
  schedule_cron_tz TEXT,
  workflow_id TEXT,
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  input_params TEXT,
  session_target TEXT NOT NULL DEFAULT 'isolated',
  delivery_mode TEXT NOT NULL DEFAULT 'none',
  concurrency_policy TEXT NOT NULL,
  max_retries INTEGER NOT NULL,
  status TEXT NOT NULL,
  last_run_at INTEGER,
  last_error TEXT,
  next_run_at INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS automation_cron_runs (
  id TEXT PRIMARY KEY,
  cron_id TEXT NOT NULL,
  run_status TEXT NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  output TEXT,
  error_message TEXT,
  logs TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL
);
`;

let userDataDir: string;
let db: Database.Database;
let handleGetCron: typeof import('./crons.js').handleGetCron;
let handleDeleteCron: typeof import('./crons.js').handleDeleteCron;
let handleCreateCron: typeof import('./crons.js').handleCreateCron;
let initAutomationScheduler: typeof import('../../automation/Scheduler.js').initAutomationScheduler;
let AutomationScheduler: typeof import('../../automation/Scheduler.js').AutomationScheduler;
let resetAutomationSchedulerForTests: typeof import('../../automation/Scheduler.js').resetAutomationSchedulerForTests;
let activeScheduler: InstanceType<typeof AutomationScheduler> | null = null;

interface CapturedResponse {
  status: number;
  body: unknown;
  headers: Record<string, string | number | undefined>;
}

function makeRes(): { res: ServerResponse; capture: CapturedResponse } {
  const capture: CapturedResponse = { status: 0, body: undefined, headers: {} };
  const res = {
    writeHead(status: number, headers?: Record<string, string | number | undefined>) {
      capture.status = status;
      if (headers) capture.headers = { ...capture.headers, ...headers };
    },
    end(payload?: string | unknown) {
      if (typeof payload === 'string') {
        try { capture.body = JSON.parse(payload); } catch { capture.body = payload; }
      } else {
        capture.body = payload;
      }
    },
  } as unknown as ServerResponse;
  return { res, capture };
}

function makeReq(headers: Record<string, string> = {}, body?: string): IncomingMessage {
  if (body !== undefined) {
    const stream = Readable.from([Buffer.from(body, 'utf-8')]) as unknown as IncomingMessage;
    (stream as IncomingMessage & { headers: Record<string, string> }).headers = headers;
    return stream;
  }
  const req: Record<string, unknown> = { headers };
  return req as unknown as IncomingMessage;
}

beforeEach(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'duya-cron-test-'));
  process.env.DUYA_CLI_USER_DATA_DIR = userDataDir;
  try {
    db = new Database(':memory:');
    db.exec(SCHEMA);
  } catch (err) {
    // better-sqlite3 native binding missing or version-mismatched
    // (NODE_MODULE_VERSION 119 vs 137). Skip these tests in that env
    // — they are regression guards, not core behavior, so failing
    // closed is acceptable when native deps are unbuilt.
    throw new Error(
      `better-sqlite3 unavailable in this Node: ${err instanceof Error ? err.message : String(err)}. ` +
        'Run `npm rebuild better-sqlite3` to enable these tests.',
    );
  }
  const schedulerMod = await import('../../automation/Scheduler.js');
  AutomationScheduler = schedulerMod.AutomationScheduler;
  initAutomationScheduler = schedulerMod.initAutomationScheduler;
  resetAutomationSchedulerForTests = schedulerMod.resetAutomationSchedulerForTests;
  resetAutomationSchedulerForTests();
  activeScheduler = initAutomationScheduler(db);
  const handlers = await import('./crons.js');
  handleGetCron = handlers.handleGetCron;
  handleDeleteCron = handlers.handleDeleteCron;
  handleCreateCron = handlers.handleCreateCron;
});

afterEach(() => {
  if (activeScheduler) {
    activeScheduler.shutdown();
    activeScheduler = null;
  }
  resetAutomationSchedulerForTests?.();
  try { db?.close(); } catch { /* db may be undefined if setup failed */ }
  rmSync(userDataDir, { recursive: true, force: true });
  delete process.env.DUYA_CLI_USER_DATA_DIR;
});

describe('handleGetCron', () => {
  it('returns the row wrapped in `{ cron }` (client reads `body.cron`)', () => {
    activeScheduler!.createCron({
      name: 'test-cron',
      schedule: { kind: 'cron', cronExpr: '0 9 * * *' },
      prompt: 'hello',
      model: 'minimax',
      enabled: true,
    });
    const created = activeScheduler!.listCrons()[0];

    const { res, capture } = makeRes();
    handleGetCron(makeReq(), res, created.id);

    expect(capture.status).toBe(200);
    const body = capture.body as { cron: { id: string; name: string } };
    expect(body.cron).toBeDefined();
    expect(body.cron.id).toBe(created.id);
    expect(body.cron.name).toBe('test-cron');
  });

  it('includes the stored working directory in the info DTO', () => {
    activeScheduler!.createCron({
      name: 'repo-cron',
      workingDirectory: 'E:\\Projects\\duya',
      schedule: { kind: 'cron', cronExpr: '0 9 * * *' },
      prompt: 'hello',
      model: 'minimax',
      enabled: true,
    });
    const created = activeScheduler!.listCrons()[0];

    const { res, capture } = makeRes();
    handleGetCron(makeReq(), res, created.id);

    expect(capture.status).toBe(200);
    const body = capture.body as { cron: { workingDirectory?: string } };
    expect(body.cron.workingDirectory).toBe('E:\\Projects\\duya');
  });

  it('returns 404 with cron_not_found for missing id', () => {
    const { res, capture } = makeRes();
    handleGetCron(makeReq(), res, 'does-not-exist');
    expect(capture.status).toBe(404);
    expect((capture.body as { error: { code: string } }).error.code).toBe('cron_not_found');
  });

  it('rejects empty id with 400', () => {
    const { res, capture } = makeRes();
    handleGetCron(makeReq(), res, '   ');
    expect(capture.status).toBe(400);
  });
});

describe('handleDeleteCron', () => {
  it('deletes successfully and does not crash with ReferenceError', async () => {
    activeScheduler!.createCron({
      name: 'to-delete',
      schedule: { kind: 'cron', cronExpr: '0 9 * * *' },
      prompt: 'hi',
      model: 'minimax',
      enabled: true,
    });
    const id = activeScheduler!.listCrons()[0].id;

    const { res, capture } = makeRes();
    await handleDeleteCron(
      makeReq({ 'x-correlation-id': 'test-corr-1' }),
      res,
      id,
      'test-corr-1',
    );

    expect(capture.status).toBe(200);
    expect((capture.body as { ok: boolean }).ok).toBe(true);
    expect(activeScheduler!.listCrons().find((c: { id: string }) => c.id === id)).toBeUndefined();
  });

  it('returns 404 when cron is already gone (no 500 ReferenceError on second call)', async () => {
    const { res, capture } = makeRes();
    await handleDeleteCron(makeReq(), res, 'never-existed', undefined);
    expect(capture.status).toBe(404);
    expect((capture.body as { error: { code: string } }).error.code).toBe('cron_not_found');
  });
});

describe('handleCreateCron error messages', () => {
  it('returns 400 with a useful hint when schedule.kind is missing', async () => {
    const { res, capture } = makeRes();
    await handleCreateCron(
      makeReq({}, JSON.stringify({ name: 'x', prompt: 'y', model: 'minimax', schedule: {} })),
      res,
      undefined,
    );
    expect(capture.status).toBe(400);
    const err = (capture.body as { error: { code: string; message: string } }).error;
    expect(err.code).toBe('invalid_body');
    expect(err.message).toMatch(/kind/i);
  });

  it('returns 400 with kind=cron hint when cronExpr is missing', async () => {
    const { res, capture } = makeRes();
    await handleCreateCron(
      makeReq(
        {},
        JSON.stringify({
          name: 'x',
          prompt: 'y',
          model: 'minimax',
          schedule: { kind: 'cron' },
        }),
      ),
      res,
      undefined,
    );
    expect(capture.status).toBe(400);
    const err = (capture.body as { error: { code: string; message: string } }).error;
    expect(err.code).toBe('invalid_body');
    expect(err.message).toMatch(/cronExpr/);
    expect(err.message).toMatch(/kind="cron"/);
  });
});
