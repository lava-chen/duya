import type {
  GoalModeToolPorts,
  ResearchModeToolPorts,
  RunWorkerModeSubagent,
  WorkerModeSubagentRequest,
  WorkerModeToolContext,
  WorkerModeEventEmitter,
} from '@duya/host/worker-modes/tool-ports';
import type { AgentDefinition } from '../worker-subagents/definitions.js';
import { SubagentTool } from '../worker-subagents/bound-tool.js';
import type { SubagentRunDeps } from '../worker-subagents/run-agent.js';
import { runAgentSync } from '../worker-subagents/run-agent.js';
import type { Message, ToolUseContext } from '../worker-run-contracts.js';
import { sendEvent } from '../worker-transport.js';

/** Bind Host mode services to the actual worker's verification child path. */
export function createGoalModeToolPorts(
  deps: SubagentRunDeps,
  definitionsOverride?: readonly AgentDefinition[],
): GoalModeToolPorts {
  return {
    runSubagent: createRunWorkerModeSubagent(deps, definitionsOverride),
    emitEvent: sendEvent as WorkerModeEventEmitter,
  };
}

/** Bind Host research fanout to the real SubagentTool child/session pipeline. */
export function createResearchModeToolPorts(deps: SubagentRunDeps): ResearchModeToolPorts {
  const subagentTool = new SubagentTool(deps);
  return {
    emitEvent: sendEvent as WorkerModeEventEmitter,
    runSubagentTool: async ({ input, workingDirectory, context }) => {
      const result = await subagentTool.execute(
        input,
        workingDirectory,
        context as unknown as ToolUseContext | undefined,
      );
      return { result: result.result, ...(result.error === undefined ? {} : { error: result.error }) };
    },
  };
}

export function createRunWorkerModeSubagent(
  deps: SubagentRunDeps,
  definitionsOverride?: readonly AgentDefinition[],
): RunWorkerModeSubagent {
  return async (request: WorkerModeSubagentRequest): Promise<string> => {
    const context = request.context as unknown as ToolUseContext;
    const definitions = definitionsOverride ?? context.options.agentDefinitions?.allAgents;
    const definition = definitions?.find(
      (candidate) => candidate.agentType.toLowerCase() === request.agentType.toLowerCase(),
    );
    if (!definition) {
      throw new Error(`Required ${request.agentType} sub-agent is unavailable.`);
    }

    const promptMessages: Message[] = [
      {
        id: crypto.randomUUID(),
        role: 'user',
        content: request.prompt,
        timestamp: Date.now(),
      },
    ];
    const result = await runAgentSync({
      agentDefinition: definition,
      promptMessages,
      toolUseContext: context,
      isAsync: false,
      ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
      availableTools: context.options.tools,
      ...(request.description === undefined ? {} : { description: request.description }),
      agentId: crypto.randomUUID(),
      createSubAgent: deps.createSubAgent,
      createToolRegistry: deps.createToolRegistry,
    });
    return extractText(result);
  };
}

function extractText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
