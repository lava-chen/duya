/**
 * @deprecated Re-export for backward compatibility.
 *
 * Phase 6 migration: agent-process-pool logic moved to agents/process-pool/.
 * Use `import { ... } from './agents/process-pool/'` for new code.
 */

export { AgentProcessPool, getAgentProcessPool, initAgentProcessPool } from './agent-process-pool.js';
export type { AgentProcessConfig, ProcessMessage, QueueItem } from './agent-process-pool.js';
