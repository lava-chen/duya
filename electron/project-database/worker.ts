import { parentPort } from 'worker_threads';
import { ProjectDatabaseEngine, ProjectDatabaseError } from './engine';

interface WorkerRequest {
  id: string;
  type: 'invoke' | 'close-all';
  dbPath?: string;
  command?: unknown;
}

interface WorkerResponse {
  id: string;
  result?: unknown;
  error?: {
    message: string;
    code?: string;
    details?: Record<string, unknown>;
  };
}

if (!parentPort) {
  throw new Error('Project database worker requires a parent port');
}

const engine = new ProjectDatabaseEngine();

parentPort.on('message', (request: WorkerRequest) => {
  const response: WorkerResponse = { id: request.id };
  try {
    if (request.type === 'close-all') {
      engine.closeAll();
      response.result = { success: true };
    } else if (request.type === 'invoke' && request.dbPath) {
      response.result = engine.invoke(request.dbPath, request.command);
    } else {
      throw new Error(`Unsupported project database worker request: ${request.type}`);
    }
  } catch (error) {
    response.error = {
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof ProjectDatabaseError
        ? { code: error.code, details: error.details }
        : {}),
    };
  }
  parentPort!.postMessage(response);
});

parentPort.on('close', () => {
  engine.closeAll();
});
