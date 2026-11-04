import { WorkerSession } from '../worker-session-runtime.js';
import type { AgentOptions } from '../worker-run-contracts.js';
import type { WorkerSessionAssemblyPorts } from '../worker-session-assembly-ports.js';
import type { BuiltinRegistryServices } from './services.js';
import { createBuiltinRegistry } from './builtin.js';
import { readToolExposureConfig } from '../worker-config/tool-exposure.js';
import { beginFileReadSession, setReadFirstGateEnabled } from '@duya/capabilities/file-read-state';
/** Assemble each product session using explicit caller-owned command effects. */
export function createWorkerSessionFactory(services: BuiltinRegistryServices) {
  const assembly: WorkerSessionAssemblyPorts = { createRegistry: (...args) => createBuiltinRegistry(services, ...args) };
  return (options: AgentOptions): WorkerSession => {
    // Plan 448 follow-up: the read-first gate is process-wide state inside the
    // tool layer, so it is applied once per product session, before any tool
    // can run. Binding the session here also drops read entries a previous
    // session in this worker process left behind — they would otherwise vouch
    // for content the next session's model never saw.
    //
    // Delegated child sessions do not come through this factory: they share
    // the parent's timeline, and clearing on every child spawn would force the
    // parent to re-read its whole working set.
    setReadFirstGateEnabled(readToolExposureConfig().readFirstGate);
    if (options.sessionId !== undefined) beginFileReadSession(options.sessionId);
    return new WorkerSession(options, assembly);
  };
}
