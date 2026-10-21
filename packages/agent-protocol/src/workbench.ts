export type WorkbenchSourceType = 'http' | 'project_db';

/** `headers` values may reference environment variables via "$env:NAME". */
export interface HttpSourceConfig {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Dot path into the JSON response; omitted means the whole payload. */
  path?: string;
}

export interface ProjectDbSourceConfig {
  /** Parameterized command passed to ProjectDatabaseService.invoke. */
  command: Record<string, unknown>;
}

export type WorkbenchSourceConfig = HttpSourceConfig | ProjectDbSourceConfig;

export interface DataSourceRow {
  id: string;
  canvasId: string;
  name: string;
  type: WorkbenchSourceType;
  config: WorkbenchSourceConfig;
  /** 0 = manual only; the scheduler refreshes intervals above its minimum. */
  refreshIntervalSec: number;
  lastSnapshot: unknown | null;
  lastRefreshedAt: number | null;
  lastError: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateDataSourceInput {
  canvasId: string;
  name: string;
  type: WorkbenchSourceType;
  config: WorkbenchSourceConfig;
  refreshIntervalSec?: number;
  enabled?: boolean;
}

export interface UpdateDataSourceInput {
  name?: string;
  config?: WorkbenchSourceConfig;
  refreshIntervalSec?: number;
  enabled?: boolean;
}

export interface DataSourceRefreshOutcome {
  snapshot?: unknown;
  error?: string | null;
}

/** Local authenticated API; source configs may contain credentials. */
export interface HostLocalWorkbenchApiV1 {
  createDataSource(input: CreateDataSourceInput): Promise<DataSourceRow>;
  updateDataSource(id: string, patch: UpdateDataSourceInput): Promise<DataSourceRow | null>;
  deleteDataSource(id: string): Promise<boolean>;
  getDataSource(id: string): Promise<DataSourceRow | null>;
  listDataSourcesByCanvas(canvasId: string): Promise<DataSourceRow[]>;
  getCanvasProjectPath(canvasId: string): Promise<string | null>;
  elementBelongsToCanvas(elementId: string, canvasId: string): Promise<boolean>;
  listDueDataSources(now: number, minimumIntervalSec: number): Promise<DataSourceRow[]>;
  saveDataSourceRefresh(id: string, outcome: DataSourceRefreshOutcome): Promise<void>;
}
