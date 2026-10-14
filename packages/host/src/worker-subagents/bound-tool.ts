import { SubagentTool as CapabilitySubagentTool } from '@duya/capabilities/SubagentTool';
import type { ToolUseContext, Tool } from '../worker-run-contracts.js';
import { getBuiltInAgents } from './built-in-agents.js';
import { runAgent, runAgentSync } from './run-agent.js';
import type { AgentDefinition } from './definitions.js';
import type { SubagentRunDeps } from './run-agent.js';
import { createWorkerSubagentService } from './service.js';
import type { WorkerSubagentExecutionContext } from './types.js';
import { messageRowToMessage, type WorkerSubagentMessageRow } from './transcript.js';
import { SUBAGENT_TOOL_NAME } from '@duya/capabilities/SubagentTool/constants';
export type { SubagentToolInput } from '@duya/capabilities/SubagentTool';
export {
  LEGACY_SUBAGENT_TOOL_NAME,
  ONE_SHOT_BUILTIN_AGENT_TYPES,
  SUBAGENT_TOOL_NAME,
  VERIFICATION_AGENT_TYPE,
} from '@duya/capabilities/SubagentTool/constants';

function isToolUseContext(value: unknown): value is ToolUseContext {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ToolUseContext>;
  return typeof candidate.toolUseId === 'string'
    && typeof candidate.getAppState === 'function'
    && typeof candidate.options === 'object'
    && candidate.options !== null
    && typeof candidate.abortController?.signal === 'object';
}

function messageRowFromUnknown(row: unknown): WorkerSubagentMessageRow {
  if (typeof row !== 'object' || row === null) {
    throw new Error('Sub-agent transcript row was not an object');
  }
  return row as WorkerSubagentMessageRow;
}

export class SubagentTool extends CapabilitySubagentTool {
  constructor(deps: SubagentRunDeps) {
    const service = createWorkerSubagentService<AgentDefinition, ToolUseContext, Tool>({
      runAgent: (request) => runAgent({ ...request, ...deps }),
      runAgentSync: (request) => runAgentSync({ ...request, ...deps }),
      messageRowToMessage: (row) => messageRowToMessage(messageRowFromUnknown(row)),
    });
    super({
      execute: (input, workingDirectory, context) => {
        if (!isToolUseContext(context)) return service.execute(input, workingDirectory);
        const workerContext: WorkerSubagentExecutionContext<AgentDefinition, ToolUseContext, Tool> = {
          toolUseId: context.toolUseId,
          options: {
            ...(context.options.sessionId === undefined
              ? {}
              : { sessionId: context.options.sessionId }),
            ...(context.options.workingDirectory === undefined
              ? {}
              : { workingDirectory: context.options.workingDirectory }),
            ...(context.options.provider === undefined
              ? {}
              : { provider: context.options.provider }),
            tools: context.options.tools,
            ...(context.options.agentDefinitions
              ? { agentDefinitions: { allAgents: context.options.agentDefinitions.allAgents } }
              : {}),
          },
          agentContext: context,
          ...(context.reportAgentProgress
            ? { reportAgentProgress: context.reportAgentProgress }
            : {}),
        };
        return service.execute(input, workingDirectory, workerContext);
      },
    });
  }
}

export function getAgentDefinitions(): AgentDefinition[] {
  return getBuiltInAgents();
}
