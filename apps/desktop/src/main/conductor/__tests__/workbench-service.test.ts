import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn<() => unknown>(),
}));

vi.mock('../../db/connection', () => ({
  getDatabase: mocks.getDatabase,
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  LogComponent: { Conductor: 'Conductor', DB: 'DB' },
}));

import { WorkbenchService } from '../workbench-service';
import { ensureWorkbenchTables } from '../workbench-store';
import type { WorkbenchBroadcastMessage } from '../workbench-types';

const CANVAS_DDL =
  'CREATE TABLE IF NOT EXISTS conductor_canvases (' +
  'id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, layout_config TEXT NOT NULL DEFAULT "{}",' +
  'sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,' +
  'is_favorite INTEGER NOT NULL DEFAULT 0, group_id TEXT, tags TEXT NOT NULL DEFAULT "[]",' +
  'project_path TEXT)';
const ELEMENT_DDL =
  'CREATE TABLE IF NOT EXISTS conductor_elements (' +
  'id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, element_kind TEXT NOT NULL, native_kind TEXT,' +
  "position TEXT NOT NULL DEFAULT '{}', config TEXT NOT NULL DEFAULT '{}', viz_spec TEXT, source_code TEXT," +
  "state TEXT NOT NULL DEFAULT 'idle', data_version INTEGER NOT NULL DEFAULT 1, permissions TEXT NOT NULL DEFAULT '{}'," +
  "metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)";

let nativeSqliteAvailable = true;
try {
  const probe = new Database(':memory:');
  probe.close();
} catch {
  nativeSqliteAvailable = false;
}

describe.skipIf(!nativeSqliteAvailable)('WorkbenchService', () => {
  let tempDir: string;
  let db: Database.Database;
  let service: WorkbenchService;
  let broadcasted: WorkbenchBroadcastMessage[];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-test-'));
    db = new Database(path.join(tempDir, 'main.db'));
    db.pragma('foreign_keys = ON');
    db.exec(CANVAS_DDL);
    db.exec(ELEMENT_DDL);
    ensureWorkbenchTables(db);
    mocks.getDatabase.mockReturnValue(db);

    const now = Date.now();
    db.prepare(
      "INSERT INTO conductor_canvases (id, name, created_at, updated_at, project_path) VALUES ('canvas-1', 'W', ?, ?, '/proj')",
    ).run(now, now);
    db.prepare(
      "INSERT INTO conductor_canvases (id, name, created_at, updated_at, project_path) VALUES ('canvas-2', 'W2', ?, ?, NULL)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO conductor_elements (id, canvas_id, element_kind, created_at, updated_at) VALUES ('el-1', 'canvas-1', 'widget/dynamic', ?, ?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO conductor_elements (id, canvas_id, element_kind, created_at, updated_at) VALUES ('el-2', 'canvas-2', 'widget/dynamic', ?, ?)",
    ).run(now, now);

    broadcasted = [];
    service = new WorkbenchService();
    service.setBroadcastFn((msg) => broadcasted.push(msg));
  });

  afterEach(() => {
    service.stopScheduler();
    try {
      db.close();
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // ============================================================
  // CRUD + validation
  // ============================================================

  it('creates a source and broadcasts a registry sync', () => {
    const result = service.createSource({
      canvasId: 'canvas-1',
      name: 'stock-quote',
      type: 'http',
      config: { url: 'https://example.com/quote' },
      refreshIntervalSec: 30,
    });
    expect(result.success).toBe(true);
    const sync = broadcasted.find((m) => m.type === 'conductor:data:sources');
    expect(sync).toBeTruthy();
    if (sync?.type === 'conductor:data:sources') {
      expect(sync.sources).toHaveLength(1);
      expect(sync.sources[0].name).toBe('stock-quote');
    }
  });

  it('rejects invalid source input', () => {
    expect(service.createSource({ canvasId: 'canvas-1', name: '', type: 'http', config: {} }).success).toBe(false);
    expect(
      service.createSource({ canvasId: 'canvas-1', name: 'x', type: 'ftp' as never, config: {} }).success,
    ).toBe(false);
    expect(
      service.createSource({ canvasId: 'canvas-1', name: 'x', type: 'http', config: { url: 'not a url' } }).success,
    ).toBe(false);
    expect(
      service.createSource({ canvasId: 'canvas-1', name: 'x', type: 'http', config: { url: 'ftp://x' } }).success,
    ).toBe(false);
    expect(service.createSource({ canvasId: 'canvas-1', name: 'x', type: 'project_db', config: {} }).success).toBe(false);
  });

  it('updates and deletes sources with registry sync', () => {
    const created = service.createSource({
      canvasId: 'canvas-1',
      name: 'quote',
      type: 'http',
      config: { url: 'https://example.com/q' },
    });
    const sourceId = (created as { success: true; data: { id: string } }).data.id;

    const updated = service.updateSource(sourceId, { refreshIntervalSec: 60, enabled: false });
    expect(updated.success).toBe(true);
    if (updated.success) {
      expect(updated.data.refreshIntervalSec).toBe(60);
      expect(updated.data.enabled).toBe(false);
    }

    const deleted = service.deleteSource(sourceId);
    expect(deleted.success).toBe(true);
    expect(service.deleteSource(sourceId).success).toBe(false);
  });

  // ============================================================
  // http refresh
  // ============================================================

  it('refreshes an http source with path extraction and $env headers', async () => {
    process.env.WORKBENCH_TEST_TOKEN = 'secret-token-value';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ data: { ticker: { price: 123.45 } } }),
    }));
    service.setDeps({ fetch: fetchMock as unknown as typeof fetch });

    const created = service.createSource({
      canvasId: 'canvas-1',
      name: 'quote',
      type: 'http',
      config: {
        url: 'https://example.com/quote',
        headers: { authorization: 'Bearer $env:WORKBENCH_TEST_TOKEN' },
        path: 'data.ticker',
      },
    });
    expect(created.success).toBe(true);
    const sourceId = (created as { success: true; data: { id: string } }).data.id;

    const result = await service.refreshSource(sourceId);
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('https://example.com/quote');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret-token-value');

    const update = broadcasted.find((m) => m.type === 'conductor:data:update');
    expect(update).toBeTruthy();
    if (update?.type === 'conductor:data:update') {
      expect(update.sourceId).toBe(sourceId);
      expect(update.snapshot).toEqual({ price: 123.45 });
      expect(update.error).toBeNull();
    }
  });

  it('persists and broadcasts http refresh failures', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503, statusText: 'Service Unavailable', text: async () => '' }));
    service.setDeps({ fetch: fetchMock as unknown as typeof fetch });
    const created = service.createSource({
      canvasId: 'canvas-1',
      name: 'down',
      type: 'http',
      config: { url: 'https://example.com/x' },
    });
    const sourceId = (created as { success: true; data: { id: string } }).data.id;

    const result = await service.refreshSource(sourceId);
    expect(result.success).toBe(false);

    const update = broadcasted.find((m) => m.type === 'conductor:data:update');
    expect(update).toBeTruthy();
    if (update?.type === 'conductor:data:update') {
      expect(update.error).toContain('503');
      expect(update.snapshot).toBeNull();
    }
  });

  // ============================================================
  // project_db refresh
  // ============================================================

  it('queries the project database via the injected invoker', async () => {
    const invoke = vi.fn(async () => ({ rows: [{ ticker: 'AAPL' }] }));
    service.setDeps({ invokeProjectDb: invoke });
    const created = service.createSource({
      canvasId: 'canvas-1',
      name: 'positions',
      type: 'project_db',
      config: { command: { type: 'table.list_rows', table: 'positions' } },
    });
    const sourceId = (created as { success: true; data: { id: string } }).data.id;
    const result = await service.refreshSource(sourceId);
    expect(result.success).toBe(true);
    expect(invoke).toHaveBeenCalledWith('/proj', { type: 'table.list_rows', table: 'positions' });
  });

  it('fails a project_db source when the canvas has no project path', async () => {
    const invoke = vi.fn();
    service.setDeps({ invokeProjectDb: invoke });
    const created = service.createSource({
      canvasId: 'canvas-2',
      name: 'orphan',
      type: 'project_db',
      config: { command: { type: 'table.list_rows' } },
    });
    const sourceId = (created as { success: true; data: { id: string } }).data.id;
    const result = await service.refreshSource(sourceId);
    expect(result.success).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  // ============================================================
  // widget actions
  // ============================================================

  it('validates element ownership for widget actions', async () => {
    const result = await service.handleWidgetAction({
      canvasId: 'canvas-1',
      elementId: 'el-2',
      action: { kind: 'refresh', sourceId: 'whatever' },
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
  });

  it('rate limits widget actions per element', async () => {
    const created = service.createSource({
      canvasId: 'canvas-1',
      name: 'rl',
      type: 'http',
      config: { url: 'https://example.com/x' },
    });
    const sourceId = (created as { success: true; data: { id: string } }).data.id;
    service.setDeps({
      fetch: (async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '{}' })) as unknown as typeof fetch,
    });

    for (let i = 0; i < 10; i++) {
      const result = await service.handleWidgetAction({
        canvasId: 'canvas-1',
        elementId: 'el-1',
        action: { kind: 'refresh', sourceId },
      });
      expect(result.success).toBe(true);
    }
    const eleventh = await service.handleWidgetAction({
      canvasId: 'canvas-1',
      elementId: 'el-1',
      action: { kind: 'refresh', sourceId },
    });
    expect(eleventh.success).toBe(false);
    if (!eleventh.success) expect(eleventh.error.code).toBe('RATE_LIMITED');
  });

  it('rejects refresh actions for sources on another canvas', async () => {
    const created = service.createSource({
      canvasId: 'canvas-2',
      name: 'other-canvas-source',
      type: 'http',
      config: { url: 'https://example.com/x' },
    });
    const sourceId = (created as { success: true; data: { id: string } }).data.id;
    const result = await service.handleWidgetAction({
      canvasId: 'canvas-1',
      elementId: 'el-1',
      action: { kind: 'refresh', sourceId },
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
  });

  // ============================================================
  // Scheduler
  // ============================================================

  it('ticks only due interval sources', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '{}' }));
    service.setDeps({ fetch: fetchMock as unknown as typeof fetch });

    service.createSource({
      canvasId: 'canvas-1',
      name: 'due-now',
      type: 'http',
      config: { url: 'https://example.com/a' },
      refreshIntervalSec: 15,
    });
    service.createSource({
      canvasId: 'canvas-1',
      name: 'manual-only',
      type: 'http',
      config: { url: 'https://example.com/b' },
      refreshIntervalSec: 0,
    });
    service.createSource({
      canvasId: 'canvas-1',
      name: 'not-due',
      type: 'http',
      config: { url: 'https://example.com/c' },
      refreshIntervalSec: 15,
    });
    // Mark not-due as freshly refreshed.
    const rows = db.prepare("SELECT id, name FROM conductor_data_sources WHERE canvas_id = 'canvas-1'").all() as Array<{
      id: string;
      name: string;
    }>;
    const notDue = rows.find((r) => r.name === 'not-due');
    db.prepare('UPDATE conductor_data_sources SET last_refreshed_at = ? WHERE id = ?').run(Date.now(), notDue?.id);

    await service.tick();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
