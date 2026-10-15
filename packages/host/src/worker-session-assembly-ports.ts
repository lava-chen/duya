import type { SubagentRunDeps } from './worker-subagents/run-agent.js';
import type { ToolRegistry } from './worker-tool-registry.js';
import type { DomainBlockerConfig } from '@duya/capabilities/BrowserTool/DomainBlocker';
import type { BrowserBackendMode } from '@duya/capabilities/BrowserTool/backend-resolver';
/** Caller supplies the existing product tool assembly, including the CLI command port. */
export interface WorkerSessionAssemblyPorts {
  createRegistry(deps: SubagentRunDeps, domains?: DomainBlockerConfig, options?: { enabledPluginIds?: Set<string>; browserBackendMode?: BrowserBackendMode }): ToolRegistry;
}
