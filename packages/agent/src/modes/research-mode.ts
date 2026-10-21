import { researchMode as hostResearchMode } from '@duya/host/worker-modes/modifiers/research-mode';
import { createResearchModeToolPorts } from './worker-mode-adapters.js';
import type { SubagentRunDeps } from '../tool/SubagentTool/runAgent.js';
import type { ModeModifier, ModeModifierContext } from './types.js';

const injectResearchTools = hostResearchMode.tools?.inject;

export const researchMode: ModeModifier = {
  ...hostResearchMode,
  tools: {
    ...hostResearchMode.tools,
    inject: (context: ModeModifierContext) => {
      if (typeof injectResearchTools !== 'function') {
        throw new Error('Host research mode tool injection is not configured.');
      }
      const ports = createResearchModeToolPorts(readSubagentDeps(context.subagentDeps));
      return injectResearchTools({
        ...context,
        workerModeToolPorts: { ...context.workerModeToolPorts, research: ports },
      });
    },
  },
};

function readSubagentDeps(value: unknown): SubagentRunDeps {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Legacy research mode requires worker subagent dependencies.');
  }
  const candidate = value as {
    createSubAgent?: unknown;
    createToolRegistry?: unknown;
  };
  if (
    typeof candidate.createSubAgent !== 'function' ||
    typeof candidate.createToolRegistry !== 'function'
  ) {
    throw new Error('Legacy research mode requires worker subagent dependencies.');
  }
  return value as SubagentRunDeps;
}
