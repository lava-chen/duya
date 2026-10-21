import { goalMode as hostGoalMode } from '@duya/host/worker-modes/modifiers/goal/goal-mode';
import { createGoalModeToolPorts } from '../worker-mode-adapters.js';
import type { SubagentRunDeps } from '../../tool/SubagentTool/runAgent.js';
import type { ModeModifier, ModeModifierContext } from '../types.js';

const injectGoalTools = hostGoalMode.tools?.inject;

export const goalMode: ModeModifier = {
  ...hostGoalMode,
  tools: {
    ...hostGoalMode.tools,
    inject: (context: ModeModifierContext) => {
      if (typeof injectGoalTools !== 'function') {
        throw new Error('Host goal mode tool injection is not configured.');
      }
      const ports = createGoalModeToolPorts(readSubagentDeps(context.subagentDeps));
      return injectGoalTools({
        ...context,
        workerModeToolPorts: { ...context.workerModeToolPorts, goal: ports },
      });
    },
  },
};

function readSubagentDeps(value: unknown): SubagentRunDeps {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Legacy goal mode requires worker subagent dependencies.');
  }
  const candidate = value as {
    createSubAgent?: unknown;
    createToolRegistry?: unknown;
  };
  if (
    typeof candidate.createSubAgent !== 'function' ||
    typeof candidate.createToolRegistry !== 'function'
  ) {
    throw new Error('Legacy goal mode requires worker subagent dependencies.');
  }
  return value as SubagentRunDeps;
}
