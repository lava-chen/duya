import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Worker } from 'worker_threads';
import {
  ProjectDatabaseRequestSchema,
  type ProjectDatabaseChangeEvent,
  type ProjectDatabaseRequest,
} from '../../packages/conductor/src/database/types';
import { getLogger, LogComponent } from '../logging/logger';

interface WorkerResponse {
  id: string;
  result?: unknown;
  error?: {
    message: string;
    code?: string;
    details?: Record<string, unknown>;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class ProjectDatabaseServiceError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ProjectDatabaseServiceError';
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function resolveProjectDatabasePath(projectPath: string): string {
  const resolvedProject = path.resolve(projectPath);
  const stat = fs.statSync(resolvedProject);
  if (!stat.isDirectory()) throw new Error('Project path must be a directory');
  const canonicalProject = fs.realpathSync.native(resolvedProject);
  const duyaPath = path.join(canonicalProject, '.duya');
  fs.mkdirSync(duyaPath, { recursive: true });
  const canonicalDuya = fs.realpathSync.native(duyaPath);
  if (!isInside(canonicalProject, canonicalDuya)) {
    throw new Error('Project .duya directory resolves outside the project');
  }
  const databasePath = path.join(canonicalDuya, 'database.sqlite');
  let databaseEntryExists = false;
  try {
    fs.lstatSync(databasePath);
    databaseEntryExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (databaseEntryExists) {
    const canonicalDatabase = fs.realpathSync.native(databasePath);
    if (!isInside(canonicalDuya, canonicalDatabase)) {
      throw new Error('Project database resolves outside the project .duya directory');
    }
  }
  return databasePath;
}

const MUTATING_COMMANDS = new Set([
  'source.create',
  'source.archive',
  'property.create',
  'record.create',
  'record.update',
  'record.archive',
  'view.create',
  'view.update',
]);

export class ProjectDatabaseService extends EventEmitter {
  private worker: Worker | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private stopping = false;

  async invoke(rawRequest: ProjectDatabaseRequest): Promise<unknown> {
    const request = ProjectDatabaseRequestSchema.parse(rawRequest);
    const dbPath = resolveProjectDatabasePath(request.projectPath);
    const result = await this.send({ type: 'invoke', dbPath, command: request.command });
    if (MUTATING_COMMANDS.has(request.command.type)) {
      const event: ProjectDatabaseChangeEvent = {
        operation: request.command.type,
        ...('sourceId' in request.command ? { sourceId: request.command.sourceId } : {}),
        ...('recordId' in request.command ? { recordId: request.command.recordId } : {}),
        ...('viewId' in request.command ? { viewId: request.command.viewId } : {}),
      };
      if (request.command.type === 'source.create') {
        const snapshot = result as { source?: { id?: unknown }; views?: Array<{ id?: unknown }> };
        if (typeof snapshot.source?.id === 'string') event.sourceId = snapshot.source.id;
        if (typeof snapshot.views?.[0]?.id === 'string') event.viewId = snapshot.views[0].id;
      }
      this.emit('change', event);
    }
    return result;
  }

  async shutdown(): Promise<void> {
    if (!this.worker || this.stopping) return;
    this.stopping = true;
    try {
      await this.send({ type: 'close-all' }, 5_000);
    } catch {
      // Termination below is authoritative during shutdown.
    }
    const worker = this.worker;
    this.worker = null;
    await worker.terminate();
    this.stopping = false;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const workerPath = path.join(__dirname, 'project-database-worker.js');
    const worker = new Worker(workerPath);
    worker.on('message', (response: WorkerResponse) => this.handleResponse(response));
    worker.on('error', (error) => this.handleFailure(error));
    worker.on('exit', (code) => {
      if (!this.stopping && code !== 0) {
        this.handleFailure(new Error(`Project database worker exited with code ${code}`));
      }
      if (this.worker === worker) this.worker = null;
    });
    this.worker = worker;
    return worker;
  }

  private send(message: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    const id = randomUUID();
    const worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProjectDatabaseServiceError('Project database request timed out', 'TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, ...message });
    });
  }

  private handleResponse(response: WorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) {
      pending.reject(new ProjectDatabaseServiceError(response.error.message, response.error.code, response.error.details));
    } else {
      pending.resolve(response.result);
    }
  }

  private handleFailure(error: Error): void {
    const logger = getLogger();
    logger.error('Project database worker failed', error, undefined, LogComponent.DB);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ProjectDatabaseServiceError('Project database worker failed', 'WORKER_FAILURE'));
    }
    this.pending.clear();
    this.worker = null;
  }
}

let projectDatabaseService: ProjectDatabaseService | null = null;

export function getProjectDatabaseService(): ProjectDatabaseService {
  projectDatabaseService ??= new ProjectDatabaseService();
  return projectDatabaseService;
}

export async function shutdownProjectDatabaseService(): Promise<void> {
  await projectDatabaseService?.shutdown();
  projectDatabaseService = null;
}
