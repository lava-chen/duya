import { WorkerSession } from '@duya/host/worker-session-runtime';
import type { AgentOptions } from '@duya/host/worker-run-contracts';
import { createBuiltinRegistry } from '../tool/builtin.js';
export * from '@duya/host/worker-session-runtime';
/** Temporary legacy constructor binds the existing product tool assembly. */
export class duyaAgent extends WorkerSession {
  constructor(options: AgentOptions) { super(options, { createRegistry: createBuiltinRegistry }); }
}
