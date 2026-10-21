import { getGoalTools as getHostGoalTools } from '@duya/host/worker-modes/goal/goal-tools';
import type { GoalModeToolPorts } from '@duya/host/worker-modes/tool-ports';
import type { ToolExecutor } from '../../tool/registry.js';
import type { SubagentRunDeps } from '../../tool/SubagentTool/runAgent.js';
import type { Tool } from '../../types.js';
import { createGoalModeToolPorts } from '../worker-mode-adapters.js';

export {
  GOAL_ERROR_CODES,
  GOAL_START_TOOL_NAME,
  GET_GOAL_TOOL_NAME,
  UPDATE_GOAL_TOOL_NAME,
  emitGoalUpdatedEvent,
  planPathFor,
} from '@duya/host/worker-modes/goal/goal-tools';
export type { GoalErrorCode, UpdateGoalInput } from '@duya/host/worker-modes/goal/goal-tools';

/** Compatibility adapter while legacy ModeModifier callers migrate to Host assembly. */
export function getGoalTools(deps: SubagentRunDeps): Array<{ definition: Tool; executor: ToolExecutor }> {
  const ports: GoalModeToolPorts = createGoalModeToolPorts(deps);
  return getHostGoalTools(ports).map(({ definition, executor }) => ({
    definition: definition as Tool,
    executor: executor as unknown as ToolExecutor,
  }));
}
