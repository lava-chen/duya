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
    // Plan 448 follow-up: bind the session FIRST — it drops read entries a
    // previous session in this worker process left behind (they would vouch
    // for content the next session's model never saw), and clears the previous
    // session's gate switch. The switch is therefore applied AFTER the bind,
    // and is scoped to this session: a process-wide boolean made session B's
    // config silently govern session A's tool calls.
    //
    // Delegated child sessions do not come through this factory: they share
    // the parent's timeline, and clearing on every child spawn would force the
    // parent to re-read its whole working set.
    const readFirstGate = readToolExposureConfig().readFirstGate;
    if (options.sessionId !== undefined) beginFileReadSession(options.sessionId);
    // The no-scope form is the fallback for tool calls whose context carries
    // no session id — including delegated child sessions, which get their own
    // scope for the READ LEDGER but never come through this factory. Keep it
    // equal to the process config so a child cannot be gated more strictly
    // than its parent just because it has no explicit binding.
    setReadFirstGateEnabled(readFirstGate);
    if (options.sessionId !== undefined) setReadFirstGateEnabled(readFirstGate, options.sessionId);
    return new WorkerSession(options, assembly);
  };
}
