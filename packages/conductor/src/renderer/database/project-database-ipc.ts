import type {
  DatabaseProperty,
  DatabaseQueryResult,
  DatabaseRecordSnapshot,
  DatabaseSource,
  DatabaseSourceSnapshot,
  DatabaseView,
  ProjectDatabaseChangeEvent,
  ProjectDatabaseCommand,
  ProjectDatabaseRequest,
} from "../../database/types";

interface ProjectDatabaseBridge {
  invoke: (request: ProjectDatabaseRequest) => Promise<unknown>;
  onChanged: (callback: (event: ProjectDatabaseChangeEvent) => void) => () => void;
}

interface FailureResult {
  success: false;
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}

function getBridge(): ProjectDatabaseBridge {
  const bridge = (window as unknown as {
    electronAPI?: { projectDatabase?: ProjectDatabaseBridge };
  }).electronAPI?.projectDatabase;
  if (!bridge) throw new Error("Project database IPC is unavailable. Open the project in the DUYA desktop app.");
  return bridge;
}

function isFailure(result: unknown): result is FailureResult {
  return typeof result === "object"
    && result !== null
    && (result as { success?: unknown }).success === false
    && typeof (result as { error?: unknown }).error === "string";
}

export async function invokeProjectDatabase<T>(projectPath: string, command: ProjectDatabaseCommand): Promise<T> {
  let result: unknown;
  try {
    result = await getBridge().invoke({ projectPath, command });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("No handler registered for 'project-database:invoke'")) {
      throw new Error("Project database service was added after this Electron process started. Restart DUYA and try again.");
    }
    throw error;
  }
  if (isFailure(result)) {
    const error = new Error(result.error) as Error & { code?: string; details?: Record<string, unknown> };
    error.code = result.code;
    error.details = result.details;
    throw error;
  }
  return result as T;
}

export function listDatabaseSources(projectPath: string): Promise<DatabaseSource[]> {
  return invokeProjectDatabase(projectPath, { type: "source.list" });
}

export function createDatabaseSource(projectPath: string, name: string): Promise<DatabaseSourceSnapshot> {
  return invokeProjectDatabase(projectPath, { type: "source.create", name });
}

export function getDatabaseSource(projectPath: string, sourceId: string): Promise<DatabaseSourceSnapshot> {
  return invokeProjectDatabase(projectPath, { type: "source.get", sourceId });
}

export function createDatabaseProperty(
  projectPath: string,
  sourceId: string,
  name: string,
  propertyType: Exclude<DatabaseProperty["type"], "title">,
): Promise<DatabaseProperty> {
  return invokeProjectDatabase(projectPath, { type: "property.create", sourceId, name, propertyType });
}

export function createDatabaseRecord(projectPath: string, sourceId: string, title = ""): Promise<DatabaseRecordSnapshot> {
  return invokeProjectDatabase(projectPath, { type: "record.create", sourceId, title });
}

export function updateDatabaseRecord(
  projectPath: string,
  sourceId: string,
  recordId: string,
  expectedRevision: number,
  patch: { title?: string; values?: Record<string, import("../../database/types").DatabaseValue> },
): Promise<DatabaseRecordSnapshot> {
  return invokeProjectDatabase(projectPath, {
    type: "record.update",
    sourceId,
    recordId,
    expectedRevision,
    ...patch,
  });
}

export function queryDatabase(
  projectPath: string,
  sourceId: string,
  viewId: string,
  limit: number,
): Promise<DatabaseQueryResult> {
  return invokeProjectDatabase(projectPath, { type: "query", sourceId, viewId, limit });
}

export function createDatabaseView(
  projectPath: string,
  sourceId: string,
  name: string,
): Promise<DatabaseView> {
  return invokeProjectDatabase(projectPath, { type: "view.create", sourceId, name, viewType: "table" });
}

export function subscribeProjectDatabase(callback: (event: ProjectDatabaseChangeEvent) => void): () => void {
  return getBridge().onChanged(callback);
}
