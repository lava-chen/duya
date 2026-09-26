/**
 * workbench-service.ts — Canvas Workbench Runtime service (plan 570).
 *
 * Owns the lifecycle of canvas data sources:
 *   - CRUD over `conductor_data_sources` (main DB), broadcasting a
 *     `conductor:data:sources` registry sync after each change;
 *   - `refreshSource` — fetch (http) or project-database query snapshot
 *     production, persisted and broadcast as `conductor:data:update` over
 *     the conductor MessagePort channel;
 *   - widget action intake (`refresh`) with per-element rate limiting and
 *     element→canvas ownership validation;
 *   - the refresh scheduler tick (interval-sourced, in-flight dedupe).
 *
 * Everything runs in the Electron main process: widget iframes keep
 * `connect-src 'none'` and never touch the network directly. Derived/strategy
 * logic deliberately lives inside the widget iframe (agent-authored scripts) —
 * the main process only fetches data, it never executes widget code.
 */

import { getDatabase } from '../db/connection';
import { getLogger, LogComponent } from '../logging/logger';
import {
  createDataSource,
  deleteDataSource,
  ensureWorkbenchTables,
  getDataSource,
  listDataSourcesByCanvas,
  saveDataSourceRefresh,
  updateDataSource,
  type CreateDataSourceInput,
  type UpdateDataSourceInput,
} from './workbench-store';
import type {
  DataSourceRow,
  HttpSourceConfig,
  ProjectDbSourceConfig,
  WorkbenchBroadcastMessage,
  WorkbenchSourceType,
  WorkbenchWidgetAction,
} from './workbench-types';
import {
  WORKBENCH_ACTION_LIMIT,
  WORKBENCH_ACTION_WINDOW_MS,
  WORKBENCH_MAX_NAME_LEN,
  WORKBENCH_MIN_INTERVAL_SEC,
  WORKBENCH_SOURCE_TYPES,
} from './workbench-types';

const HTTP_TIMEOUT_MS = 10_000;
const SCHEDULER_TICK_MS = 5_000;
const MAX_CONCURRENT_REFRESHES = 6;

export interface FetchDeps {
  fetch?: typeof fetch;
  invokeProjectDb?: (projectPath: string, command: Record<string, unknown>) => Promise<unknown>;
  now?: () => number;
}

export interface WorkbenchError {
  code:
    | 'INVALID_INPUT'
    | 'NOT_FOUND'
    | 'DB_UNAVAILABLE'
    | 'NO_PROJECT_PATH'
    | 'REFRESH_IN_PROGRESS'
    | 'RATE_LIMITED'
    | 'REFRESH_FAILED';
  message: string;
}

export type WorkbenchResult<T> = { success: true; data: T } | { success: false; error: WorkbenchError };

function resolveHeaderValue(value: string): string {
  // "$env:NAME" references may be the whole value or embedded ("Bearer $env:T").
  return value.replace(/\$env:([A-Za-z0-9_]+)/g, (_, name: string) => process.env[name] ?? '');
}

function extractPath(payload: unknown, dotPath: string | undefined): unknown {
  if (!dotPath || typeof dotPath !== 'string') return payload;
  let current: unknown = payload;
  for (const segment of dotPath.split('.')) {
    if (current === null || current === undefined) return null;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return null;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return current ?? null;
}

export class WorkbenchService {
  private broadcastFn: ((message: WorkbenchBroadcastMessage) => void) | null = null;
  private deps: FetchDeps = {};
  private inflight = new Set<string>();
  private actionTimestamps = new Map<string, number[]>();
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps?: FetchDeps) {
    if (deps) this.deps = deps;
  }

  setBroadcastFn(fn: (message: WorkbenchBroadcastMessage) => void): void {
    this.broadcastFn = fn;
  }

  setDeps(deps: FetchDeps): void {
    this.deps = { ...this.deps, ...deps };
  }

  private getDb(): import('better-sqlite3').Database {
    const db = getDatabase();
    if (!db) throw new Error('Database not initialized');
    ensureWorkbenchTables(db);
    return db;
  }

  private broadcast(message: WorkbenchBroadcastMessage): void {
    try {
      this.broadcastFn?.(message);
    } catch {
      // Renderer channel failures must never break persistence.
    }
  }

  private syncCanvas(canvasId: string, db: import('better-sqlite3').Database): void {
    this.broadcast({
      type: 'conductor:data:sources',
      canvasId,
      sources: listDataSourcesByCanvas(db, canvasId),
    });
  }

  // ============================================================
  // Data source CRUD
  // ============================================================

  /** Returns a failure result when invalid, or null when the input is usable. */
  private validateSourceInput(input: Partial<CreateDataSourceInput>): WorkbenchResult<never> | null {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > WORKBENCH_MAX_NAME_LEN) {
      return { success: false, error: { code: 'INVALID_INPUT', message: `name must be 1..${WORKBENCH_MAX_NAME_LEN} chars` } };
    }
    const type = input.type;
    if (!type || !(WORKBENCH_SOURCE_TYPES as readonly string[]).includes(type)) {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: `type must be one of: ${WORKBENCH_SOURCE_TYPES.join(', ')}` },
      };
    }
    const config = (input.config ?? {}) as Record<string, unknown>;
    if (type === 'http') {
      const url = typeof config.url === 'string' ? config.url.trim() : '';
      if (!url) return { success: false, error: { code: 'INVALID_INPUT', message: 'http source requires config.url' } };
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          return { success: false, error: { code: 'INVALID_INPUT', message: 'config.url must be http/https' } };
        }
      } catch {
        return { success: false, error: { code: 'INVALID_INPUT', message: 'config.url is not a valid URL' } };
      }
    } else if (type === 'project_db') {
      if (!config.command || typeof config.command !== 'object' || Array.isArray(config.command)) {
        return { success: false, error: { code: 'INVALID_INPUT', message: 'project_db source requires config.command object' } };
      }
    }
    if (input.refreshIntervalSec !== undefined) {
      const interval = Number(input.refreshIntervalSec);
      if (!Number.isFinite(interval) || interval < 0) {
        return { success: false, error: { code: 'INVALID_INPUT', message: 'refreshIntervalSec must be >= 0 (0 = manual)' } };
      }
    }
    return null;
  }

  createSource(input: Partial<CreateDataSourceInput>): WorkbenchResult<DataSourceRow> {
    const validation = this.validateSourceInput(input);
    if (validation) return validation;
    try {
      const db = this.getDb();
      const row = createDataSource(db, input as CreateDataSourceInput);
      this.syncCanvas(row.canvasId, db);
      return { success: true, data: row };
    } catch (err) {
      return { success: false, error: { code: 'INVALID_INPUT', message: errorMessage(err) } };
    }
  }

  updateSource(id: string, patch: UpdateDataSourceInput): WorkbenchResult<DataSourceRow> {
    try {
      const db = this.getDb();
      const row = updateDataSource(db, id, patch);
      if (!row) return { success: false, error: { code: 'NOT_FOUND', message: `Data source ${id} not found` } };
      this.syncCanvas(row.canvasId, db);
      return { success: true, data: row };
    } catch (err) {
      return { success: false, error: { code: 'INVALID_INPUT', message: errorMessage(err) } };
    }
  }

  deleteSource(id: string): WorkbenchResult<{ deleted: boolean; canvasId?: string }> {
    try {
      const db = this.getDb();
      const existing = getDataSource(db, id);
      if (!existing) return { success: false, error: { code: 'NOT_FOUND', message: `Data source ${id} not found` } };
      deleteDataSource(db, id);
      this.syncCanvas(existing.canvasId, db);
      return { success: true, data: { deleted: true, canvasId: existing.canvasId } };
    } catch (err) {
      return { success: false, error: { code: 'DB_UNAVAILABLE', message: errorMessage(err) } };
    }
  }

  listSources(canvasId: string): WorkbenchResult<{ sources: DataSourceRow[] }> {
    try {
      const db = this.getDb();
      return { success: true, data: { sources: listDataSourcesByCanvas(db, canvasId) } };
    } catch (err) {
      return { success: false, error: { code: 'DB_UNAVAILABLE', message: errorMessage(err) } };
    }
  }

  // ============================================================
  // Refresh
  // ============================================================

  async refreshSource(sourceId: string, opts?: { actor?: string }): Promise<WorkbenchResult<{ snapshot: unknown | null; error: string | null }>> {
    let row: DataSourceRow;
    try {
      const db = this.getDb();
      const found = getDataSource(db, sourceId);
      if (!found) return { success: false, error: { code: 'NOT_FOUND', message: `Data source ${sourceId} not found` } };
      row = found;
    } catch (err) {
      return { success: false, error: { code: 'DB_UNAVAILABLE', message: errorMessage(err) } };
    }
    if (this.inflight.has(sourceId)) {
      return { success: false, error: { code: 'REFRESH_IN_PROGRESS', message: `Source ${row.name} is already refreshing` } };
    }
    this.inflight.add(sourceId);
    try {
      const outcome = await this.produceSnapshot(row);
      try {
        const db = this.getDb();
        saveDataSourceRefresh(db, sourceId, {
          snapshot: outcome.snapshot ?? null,
          error: outcome.error ?? null,
        });
      } catch (err) {
        getLogger().warn(
          `Failed to persist workbench snapshot for ${row.name}`,
          { error: errorMessage(err) },
          LogComponent.Conductor,
        );
      }
      this.broadcast({
        type: 'conductor:data:update',
        canvasId: row.canvasId,
        sourceId,
        snapshot: outcome.snapshot ?? null,
        error: outcome.error ?? null,
        refreshedAt: (this.deps.now ?? Date.now)(),
      });
      if (outcome.error) {
        return { success: false, error: { code: 'REFRESH_FAILED', message: outcome.error } };
      }
      return { success: true, data: { snapshot: outcome.snapshot ?? null, error: null } };
    } finally {
      this.inflight.delete(sourceId);
    }
  }

  private async produceSnapshot(row: DataSourceRow): Promise<{ snapshot?: unknown; error?: string }> {
    switch (row.type) {
      case 'http':
        return this.fetchHttp(row.config as HttpSourceConfig);
      case 'project_db':
        return this.queryProjectDb(row, row.config as ProjectDbSourceConfig);
      default:
        return { error: `Unknown source type: ${String((row as { type?: string }).type)}` };
    }
  }

  private async fetchHttp(config: HttpSourceConfig): Promise<{ snapshot?: unknown; error?: string }> {
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      return { error: 'Invalid source URL' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { error: 'Only http/https source URLs are allowed' };
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.headers ?? {})) {
      const resolved = resolveHeaderValue(String(value));
      if (resolved) headers[key] = resolved;
    }
    try {
      const fetchFn = this.deps.fetch ?? fetch;
      const response = await fetchFn(url, {
        method: config.method === 'POST' ? 'POST' : 'GET',
        headers: { accept: 'application/json', ...headers },
        body: config.method === 'POST' ? config.body ?? '' : undefined,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { error: `HTTP ${response.status} ${response.statusText}`.trim() };
      }
      const text = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
      return { snapshot: extractPath(payload, config.path) };
    } catch (err) {
      return { error: `Fetch failed: ${errorMessage(err)}` };
    }
  }

  private async queryProjectDb(
    row: DataSourceRow,
    config: ProjectDbSourceConfig,
  ): Promise<{ snapshot?: unknown; error?: string }> {
    try {
      const db = this.getDb();
      const canvas = db
        .prepare('SELECT project_path FROM conductor_canvases WHERE id = ?')
        .get(row.canvasId) as { project_path: string | null } | undefined;
      const projectPath = canvas?.project_path ?? null;
      if (!projectPath) {
        return { error: 'Canvas is not bound to a project folder (NO_PROJECT_PATH)' };
      }
      const invoke =
        this.deps.invokeProjectDb ??
        (async (projectPathInner: string, command: Record<string, unknown>) => {
          const { getProjectDatabaseService } = await import('../project-database/service');
          return getProjectDatabaseService().invoke({ projectPath: projectPathInner, command: command as never });
        });
      const snapshot = await invoke(projectPath, config.command ?? {});
      return { snapshot };
    } catch (err) {
      return { error: `Project database query failed: ${errorMessage(err)}` };
    }
  }

  // ============================================================
  // Widget actions
  // ============================================================

  async handleWidgetAction(params: {
    canvasId: string;
    elementId: string;
    action: WorkbenchWidgetAction;
    /** 'widget' validates element→canvas ownership; 'agent' runs are pre-authorized. */
    via?: 'widget' | 'agent';
  }): Promise<WorkbenchResult<{ sourceId?: string; snapshot?: unknown }>> {
    const { canvasId, elementId, action, via = 'widget' } = params;
    if (!action || action.kind !== 'refresh') {
      return { success: false, error: { code: 'INVALID_INPUT', message: 'action.kind must be "refresh"' } };
    }

    // Ownership: the element must exist on the canvas that hosts the widget.
    // Agent-initiated runs (executor RPC) skip this check — they are already
    // inside the tool-permission boundary and address sources directly.
    if (via === 'widget') {
      try {
        const db = this.getDb();
        const element = db
          .prepare('SELECT canvas_id FROM conductor_elements WHERE id = ?')
          .get(elementId) as { canvas_id: string } | undefined;
        if (!element || element.canvas_id !== canvasId) {
          return { success: false, error: { code: 'NOT_FOUND', message: 'Element does not belong to this canvas' } };
        }
      } catch (err) {
        return { success: false, error: { code: 'DB_UNAVAILABLE', message: errorMessage(err) } };
      }
    }

    if (!this.consumeActionBudget(elementId)) {
      return { success: false, error: { code: 'RATE_LIMITED', message: 'Too many widget actions; slow down' } };
    }

    const sourceId = typeof action.sourceId === 'string' ? action.sourceId : '';
    if (!sourceId) {
      return { success: false, error: { code: 'INVALID_INPUT', message: 'refresh requires sourceId' } };
    }
    if (via === 'widget') {
      const source = getDataSource(this.getDb(), sourceId);
      if (!source || source.canvasId !== canvasId) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'Source does not belong to this canvas' } };
      }
    }
    const result = await this.refreshSource(sourceId, { actor: via === 'agent' ? 'agent' : 'widget' });
    if (!result.success) return result;
    return { success: true, data: { sourceId, snapshot: result.data.snapshot } };
  }

  private consumeActionBudget(elementId: string): boolean {
    const now = (this.deps.now ?? Date.now)();
    const timestamps = (this.actionTimestamps.get(elementId) ?? []).filter(
      (ts) => now - ts < WORKBENCH_ACTION_WINDOW_MS,
    );
    if (timestamps.length >= WORKBENCH_ACTION_LIMIT) {
      this.actionTimestamps.set(elementId, timestamps);
      return false;
    }
    timestamps.push(now);
    this.actionTimestamps.set(elementId, timestamps);
    return true;
  }

  // ============================================================
  // Scheduler
  // ============================================================

  startScheduler(): void {
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => {
      void this.tick();
    }, SCHEDULER_TICK_MS);
  }

  stopScheduler(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  async tick(): Promise<void> {
    let db: import('better-sqlite3').Database;
    try {
      db = this.getDb();
    } catch {
      return;
    }
    let due: Array<{ id: string; name: string; interval: number }>;
    try {
      const now = (this.deps.now ?? Date.now)();
      due = (
        db.prepare(
          "SELECT id, name, refresh_interval_sec, last_refreshed_at FROM conductor_data_sources " +
            'WHERE enabled = 1 AND refresh_interval_sec >= ?',
        ).all(WORKBENCH_MIN_INTERVAL_SEC) as Array<{
          id: string;
          name: string;
          refresh_interval_sec: number;
          last_refreshed_at: number | null;
        }>
      )
        .filter((row) => {
          if (this.inflight.has(row.id)) return false;
          const dueAt = (row.last_refreshed_at ?? 0) + row.refresh_interval_sec * 1000;
          return dueAt <= now;
        })
        .slice(0, MAX_CONCURRENT_REFRESHES)
        .map((row) => ({ id: row.id, name: row.name, interval: row.refresh_interval_sec }));
    } catch {
      return;
    }
    for (const source of due) {
      this.refreshSource(source.id, { actor: 'scheduler' }).catch(() => {
        // Refresh failures are persisted on the row and broadcast; nothing to do here.
      });
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
}

/** Singleton shared by the executor proxy, the widget-action IPC handler and main.ts. */
export const workbenchService = new WorkbenchService();

export type { WorkbenchSourceType };
