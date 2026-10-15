import { getResearchFanoutTool as getHostResearchFanoutTool } from '@duya/host/worker-modes/research-mode/research-fanout';
import type { ToolExecutor } from '../../tool/registry.js';
import type { SubagentRunDeps } from '../../tool/SubagentTool/runAgent.js';
import type { Tool } from '../../types.js';
import { createResearchModeToolPorts } from '../worker-mode-adapters.js';

export {
  RESEARCH_FANOUT_ERROR_CODES,
  RESEARCH_FANOUT_MAX_AGENTS,
  RESEARCH_FANOUT_TOOL_NAME,
} from '@duya/host/worker-modes/research-mode/research-fanout';
export type { ResearchFanoutErrorCode } from '@duya/host/worker-modes/research-mode/research-fanout';

/** Compatibility adapter while the legacy registry still assembles this tool. */
export function getResearchFanoutTool(deps: SubagentRunDeps): { definition: Tool; executor: ToolExecutor } {
  const ports = createResearchModeToolPorts(deps);
  const { definition, executor } = getHostResearchFanoutTool(ports.runSubagentTool, ports.emitEvent);
  return {
    definition: definition as Tool,
    executor: executor as unknown as ToolExecutor,
  };
}
