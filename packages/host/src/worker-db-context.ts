import { AsyncLocalStorage } from 'node:async_hooks';

/** Captured at execution entry, never inferred from a later active turn. */
export interface WorkerDbRunContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly epoch: number;
}

const context = new AsyncLocalStorage<WorkerDbRunContext | undefined>();

export function withWorkerDbRunContext<T>(value: WorkerDbRunContext | undefined, action: () => T): T {
  return context.run(value === undefined ? undefined : Object.freeze({ ...value }), action);
}

export function workerDbRunContext(): WorkerDbRunContext | undefined {
  return context.getStore();
}
