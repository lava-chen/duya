/**
 * workbench-service.ts — Canvas Workbench Runtime service (plan 570).
 *
 * Owns the lifecycle of canvas data sources:
 *   - Host API CRUD over `conductor_data_sources`, broadcasting a
 *     `conductor:data:sources` registry sync after each change;
 *   - `refreshSource` — fetch (http) or project-database query snapshot
 *     production, persisted and broadcast as `conductor:data:update` over
 *     the conductor MessagePort channel;
 *   - widget action intake (`refresh`) with per-element rate limiting and
 *     element→canvas ownership validation;
 *   - the refresh scheduler tick (interval-sourced, in-flight dedupe).
 *
 * Fetching and scheduling run in Electron Main; the Host owns persistence.
 * Widget iframes keep
 * `connect-src 'none'` and never touch the network directly. Derived/strategy
 * logic deliberately lives inside the widget iframe (agent-authored scripts) —
 * the main process only fetches data, it never executes widget code.
 */

import { getLogger, LogComponent } from '../logging/logger';
import { getDesktopHostLocalWorkbenchApi } from '../cli/desktop-host-api';
import type { HostLocalWorkbenchApiV1 } from '@duya/agent-protocol/workbench';
import type {
  CreateDataSourceInput,
  DataSourceRow,
  HttpSourceConfig,
  ProjectDbSourceConfig,
  UpdateDataSourceInput,
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
  workbenchApi?: HostLocalWorkbenchApiV1;
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

  private getWorkbenchApi(): HostLocalWorkbenchApiV1 {
    return this.deps.workbenchApi ?? getDesktopHostLocalWorkbenchApi();
  }

  private broadcast(message: WorkbenchBroadcastMessage): void {
    try {
      this.broadcastFn?.(message);
    } catch {
      // Renderer channel failures must never break persistence.
    }
  }

  private async syncCanvas(canvasId: string): Promise<void> {
    this.broadcast({
      type: 'conductor:data:sources',
      canvasId,
      sources: await this.getWorkbenchApi().listDataSourcesByCanvas(canvasId),
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

  async createSource(input: Partial<CreateDataSourceInput>): Promise<WorkbenchResult<DataSourceRow>> {
    const validation = this.validateSourceInput(input);
    if (validation) return validation;
    try {
      const row = await this.getWorkbenchApi().createDataSource(input as CreateDataSourceInput);
      await this.syncCanvas(row.canvasId);
      return { success: true, data: row };
    } catch (err) {
      return { success: false, error: { code: 'INVALID_INPUT', message: errorMessage(err) } };
    }
  }

  async updateSource(id: string, patch: UpdateDataSourceInput): Promise<WorkbenchResult<DataSourceRow>> {
    try {
      const api = this.getWorkbenchApi();
      const row = await api.updateDataSource(id, patch);
      if (!row) return { success: false, error: { code: 'NOT_FOUND', message: `Data source ${id} not found` } };
      await this.syncCanvas(row.canvasId);
      return { success: true, data: row };
    } catch (err) {
      return { success: false, error: { code: 'INVALID_INPUT', message: errorMessage(err) } };
    }
  }

  async deleteSource(id: string): Promise<WorkbenchResult<{ deleted: boolean; canvasId?: string }>> {
    try {
      const api = this.getWorkbenchApi();
      const existing = await api.getDataSource(id);
      if (!existing) return { success: false, error: { code: 'NOT_FOUND', message: `Data source ${id} not found` } };
      if (!(await api.deleteDataSource(id))) {
        return { success: false, error: { code: 'NOT_FOUND', message: `Data source ${id} not found` } };
      }
      await this.syncCanvas(existing.canvasId);
      return { success: true, data: { deleted: true, canvasId: existing.canvasId } };
    } catch (err) {
      return { success: false, error: { code: 'DB_UNAVAILABLE', message: errorMessage(err) } };
    }
  }

  async listSources(canvasId: string): Promise<WorkbenchResult<{ sources: DataSourceRow[] }>> {
    try {
      return { success: true, data: { sources: await this.getWorkbenchApi().listDataSourcesByCanvas(canvasId) } };
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
      const found = await this.getWorkbenchApi().getDataSource(sourceId);
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
        await this.getWorkbenchApi().saveDataSourceRefresh(sourceId, {
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
      const projectPath = await this.getWorkbenchApi().getCanvasProjectPath(row.canvasId);
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
        const belongs = await this.getWorkbenchApi().elementBelongsToCanvas(elementId, canvasId);
        if (!belongs) {
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
      const source = await this.getWorkbenchApi().getDataSource(sourceId);
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
    let due: DataSourceRow[];
    try {
      const now = (this.deps.now ?? Date.now)();
      due = (await this.getWorkbenchApi().listDueDataSources(now, WORKBENCH_MIN_INTERVAL_SEC))
        .filter((row) => !this.inflight.has(row.id))
        .slice(0, MAX_CONCURRENT_REFRESHES);
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
