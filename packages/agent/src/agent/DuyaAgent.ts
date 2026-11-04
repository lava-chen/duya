/**
 * Legacy façade over `WorkerSession`.
 *
 * This file used to hold the whole agent implementation; it has since been
 * split across `worker-session-runtime`, `agent-runtime/engine` and
 * `agent-runtime/adapters`. Comments elsewhere in the repo still say
 * "`DuyaAgent`" when they mean that pre-split implementation — those are
 * historical references, not pointers into this file. Any surviving line
 * number next to such a reference is stale by construction.
 */
import { WorkerSession } from '@duya/host/worker-session-runtime';
import type { AgentOptions } from '@duya/host/worker-run-contracts';
import { createBuiltinRegistry } from '../tool/builtin.js';
export * from '@duya/host/worker-session-runtime';
/** Temporary legacy constructor binds the existing product tool assembly. */
export class duyaAgent extends WorkerSession {
  constructor(options: AgentOptions) { super(options, { createRegistry: createBuiltinRegistry }); }
}
