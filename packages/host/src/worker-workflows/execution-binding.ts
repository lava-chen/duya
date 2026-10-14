import type { AgentOptions } from '../worker-run-contracts.js';
import type { WorkerSession } from '../worker-session-runtime.js';
import type { WorkerSessionAssemblyPorts } from '../worker-session-assembly-ports.js';
export interface WorkerWorkflowAssembly extends WorkerSessionAssemblyPorts {
  createSession(options: AgentOptions): WorkerSession;
}
/**
 * Compatibility adapter for the legacy Agent worker while its entry point
 * still assembles built-in tools. Host workflow code receives only the
 * narrow execution ports and never imports this module.
 */

import { randomUUID } from 'node:crypto';


import { SUBAGENT_TOOL_NAME } from '@duya/capabilities/SubagentTool/constants';
import type { SubagentRunDeps } from '../worker-subagents/run-agent.js';
import { getAgentDefinitions } from '../worker-subagents/built-in-agents.js';
import type { ToolUseContext } from '../worker-run-contracts.js';
import type {
  WorkflowExecutionPorts,
  WorkflowRunnerLlmConfig,
  WorkflowToolCallResult,
} from '@duya/host/worker-workflows/runner';

export interface WorkerWorkflowExecutionOptions {
  sessionId: string;
  llm: WorkflowRunnerLlmConfig;
  workingDirectory: string;
  assembly: WorkerWorkflowAssembly;
}

export function createWorkerWorkflowExecutionPorts(
  options: WorkerWorkflowExecutionOptions,
): WorkflowExecutionPorts {
  const subagentDeps: SubagentRunDeps = {
    createSubAgent: (subAgentOptions) => options.assembly.createSession(subAgentOptions),
    createToolRegistry: () => options.assembly.createRegistry(subagentDeps),
  };
  const registry = options.assembly.createRegistry(subagentDeps);
  const definitions = getAgentDefinitions();
  let appState: Record<string, unknown> = {};
  const context: ToolUseContext = {
    toolUseId: randomUUID(),
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: (updater) => {
      appState = updater(appState) as Record<string, unknown>;
    },
    options: {
      recentImageAttachments: [],
      tools: registry.getAllTools(),
      commands: [],
      mainLoopModel: options.llm.model,
      mcpClients: [],
      apiKey: options.llm.apiKey,
      ...(options.llm.baseURL === undefined ? {} : { baseURL: options.llm.baseURL }),
      ...(options.llm.authStyle === undefined ? {} : { authStyle: options.llm.authStyle }),
      ...(options.llm.provider === undefined ? {} : { provider: options.llm.provider }),
      sessionId: options.sessionId,
      agentProfileId: null,
      workingDirectory: options.workingDirectory,
      agentDefinitions: {
        activeAgents: definitions,
        allAgents: definitions,
      },
    },
  };

  const execute = registry.execute.bind(registry);
  return {
    async runTool(tool, input, call): Promise<WorkflowToolCallResult | undefined> {
      const result = await execute(tool, input, options.workingDirectory, {
        ...context,
        toolUseId: call.toolUseId,
      });
      return result ?? undefined;
    },

    async runAgent(spec, call) {
      const result = await execute(
        SUBAGENT_TOOL_NAME,
        {
          prompt: spec.prompt,
          subagent_type: spec.agent,
          run_in_background: false,
          ...(spec.model !== undefined ? { model: spec.model } : {}),
        },
        options.workingDirectory,
        { ...context, toolUseId: call.toolUseId },
      );
      if (!result) {
        return { ok: false, error: `subagent tool "${SUBAGENT_TOOL_NAME}" not registered` };
      }

      let parsed: { error?: string; content?: unknown; sessionId?: string };
      try {
        parsed = JSON.parse(result.result) as typeof parsed;
      } catch {
        parsed = { content: result.result };
      }

      if (result.error || parsed.error) {
        return {
          ok: false,
          error: parsed.error ?? result.result,
          ...(parsed.sessionId !== undefined ? { childSessionId: parsed.sessionId } : {}),
        };
      }
      return {
        ok: true,
        output: parsed.content ?? '',
        ...(parsed.sessionId !== undefined ? { childSessionId: parsed.sessionId } : {}),
      };
    },
  };
}
