import { createWorkerSessionFactory } from './worker-tools/assembly.js';
import { createBuiltinRegistry } from './worker-tools/builtin.js';
import { createWorkerWorkflowExecutionPorts } from './worker-workflows/execution-binding.js';
import type { WorkerWorkflowAssembly, WorkerWorkflowExecutionOptions } from './worker-workflows/execution-binding.js';
import type { BuiltinRegistryServices } from './worker-tools/services.js';
import type { WorkflowExecutionPorts } from './worker-workflows/runner.js';
export interface WorkerProcessAssembly extends WorkerWorkflowAssembly {
  createWorkflowExecutionPorts(options: Omit<WorkerWorkflowExecutionOptions, 'assembly'>): WorkflowExecutionPorts;
}
/** Actual Host product assembly; the outer bootstrap supplies command dispatch. */
export function createWorkerProcessAssembly(services: BuiltinRegistryServices): WorkerProcessAssembly {
  const assembly: WorkerProcessAssembly = {
    createSession: createWorkerSessionFactory(services),
    createRegistry: (...args) => createBuiltinRegistry(services, ...args),
    createWorkflowExecutionPorts: (options) => createWorkerWorkflowExecutionPorts({ ...options, assembly }),
  };
  return assembly;
}
