import type { SubagentRunDeps } from './worker-subagents/run-agent.js';
import type { ToolRegistry } from './worker-tool-registry.js';
/** Caller supplies the existing product tool assembly, including the CLI command port. */
export interface WorkerSessionAssemblyPorts {
  createRegistry(deps: SubagentRunDeps, options?: { enabledPluginIds?: Set<string> }): ToolRegistry;
}
