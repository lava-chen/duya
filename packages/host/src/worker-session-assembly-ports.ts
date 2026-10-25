import type { SubagentRunDeps } from './worker-subagents/run-agent.js';
import type { ToolRegistry } from './worker-tool-registry.js';
/** Caller supplies the existing product tool assembly, including the CLI command port. */
export interface WorkerSessionAssemblyPorts {
  checkoutControl?: (sessionId: string, command: import('@duya/agent-protocol').SessionCheckoutCommand) => Promise<import('@duya/agent-protocol').SessionCheckoutResult>;
  refreshExecutionLocation?: (cwd: string, sessionId?: string) => Promise<void>;
  createRegistry(deps: SubagentRunDeps, options?: { enabledPluginIds?: Set<string> }): ToolRegistry;
}
