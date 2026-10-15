import { WorkerSession } from '../worker-session-runtime.js';
import type { AgentOptions } from '../worker-run-contracts.js';
import type { WorkerSessionAssemblyPorts } from '../worker-session-assembly-ports.js';
import type { BuiltinRegistryServices } from './services.js';
import { createBuiltinRegistry } from './builtin.js';
/** Assemble each product session using explicit caller-owned command effects. */
export function createWorkerSessionFactory(services: BuiltinRegistryServices) {
  const assembly: WorkerSessionAssemblyPorts = { createRegistry: (...args) => createBuiltinRegistry(services, ...args) };
  return (options: AgentOptions): WorkerSession => new WorkerSession(options, assembly);
}
