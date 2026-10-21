import { getResearchTools as getHostResearchTools } from '@duya/host/worker-modes/research-mode/research-tools';
import type { ResearchModeToolPorts } from '@duya/host/worker-modes/tool-ports';
import type { ToolExecutor } from '../../tool/registry.js';
import type { SubagentRunDeps } from '../../tool/SubagentTool/runAgent.js';
import type { Tool } from '../../types.js';
import { createResearchModeToolPorts } from '../worker-mode-adapters.js';

export {
  RESEARCH_ADVANCE_TOOL_NAME,
  RESEARCH_CONTINUE_TOOL_NAME,
  RESEARCH_ERROR_CODES,
  RESEARCH_FANOUT_TOOL_NAME,
  RESEARCH_REPORT_TOOL_NAME,
  RESEARCH_START_TOOL_NAME,
  emitResearchUpdated,
} from '@duya/host/worker-modes/research-mode/research-tools';
export type { ResearchErrorCode } from '@duya/host/worker-modes/research-mode/research-tools';

/** Compatibility adapter while legacy ModeModifier callers migrate to Host assembly. */
export function getResearchTools(deps: SubagentRunDeps): Array<{ definition: Tool; executor: ToolExecutor }> {
  const ports: ResearchModeToolPorts = createResearchModeToolPorts(deps);
  return getHostResearchTools(ports).map(({ definition, executor }) => ({
    definition: definition as Tool,
    executor: executor as unknown as ToolExecutor,
  }));
}
