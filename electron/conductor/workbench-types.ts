/**
 * workbench-types.ts — Shared types for the Canvas Workbench Runtime (plan 570).
 *
 * A "workbench" is a canvas that runs: it has named data sources refreshed by
 * the main process, and dynamic widgets that bind to source snapshots and
 * dispatch actions back to the main process. This file carries the persisted
 * row shapes and the wire messages broadcast to the renderer over the
 * conductor MessagePort channel.
 *
 * Note: strategy/derived logic lives INSIDE the widget iframe (agent-authored
 * scripts, same trust level as the widget HTML itself) — the main process only
 * fetches data. `conductor_handlers` exists in the schema as a forward-looking
 * table for server-side handler execution; it is intentionally unused in v1.
 */

export type WorkbenchSourceType = 'http' | 'project_db';

export const WORKBENCH_SOURCE_TYPES: readonly WorkbenchSourceType[] = ['http', 'project_db'];

/** `headers` values may reference environment variables via "$env:NAME". */
export interface HttpSourceConfig {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Dot path into the JSON response (e.g. "data.ticker.price"); omitted = whole payload. */
  path?: string;
}

export interface ProjectDbSourceConfig {
  /** Passthrough command object for ProjectDatabaseService.invoke (parameterized). */
  command: Record<string, unknown>;
}

export type WorkbenchSourceConfig = HttpSourceConfig | ProjectDbSourceConfig;

export interface DataSourceRow {
  id: string;
  canvasId: string;
  name: string;
  type: WorkbenchSourceType;
  config: WorkbenchSourceConfig;
  /** 0 = manual only; scheduler refreshes at >= WORKBENCH_MIN_INTERVAL_SEC otherwise. */
  refreshIntervalSec: number;
  lastSnapshot: unknown | null;
  lastRefreshedAt: number | null;
  lastError: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Widget action dispatched from a widget iframe via the host renderer. */
export interface WorkbenchWidgetAction {
  kind: 'refresh';
  sourceId?: string;
}

/** Pushed after every successful or failed source refresh. */
export interface WorkbenchDataUpdate {
  type: 'conductor:data:update';
  canvasId: string;
  sourceId: string;
  snapshot: unknown | null;
  error: string | null;
  refreshedAt: number;
}

/** Pushed whenever the source registry of a canvas changes. */
export interface WorkbenchSourcesSync {
  type: 'conductor:data:sources';
  canvasId: string;
  sources: DataSourceRow[];
}

export type WorkbenchBroadcastMessage = WorkbenchDataUpdate | WorkbenchSourcesSync;

export const WORKBENCH_MIN_INTERVAL_SEC = 15;
export const WORKBENCH_MAX_NAME_LEN = 64;
/** Widget action rate limit, per element. */
export const WORKBENCH_ACTION_LIMIT = 10;
export const WORKBENCH_ACTION_WINDOW_MS = 60_000;
