import { summarizeGoalCompletion as summarizeHostGoalCompletion } from '@duya/host/worker-modes/goal/goal-summarizer';
import type { GoalSummaryParams as HostGoalSummaryParams } from '@duya/host/worker-modes/goal/goal-summarizer';
import type { AgentDefinition } from '../../tool/SubagentTool/loadAgentsDir.js';
import type { SubagentRunDeps } from '../../tool/SubagentTool/runAgent.js';
import type { ToolUseContext } from '../../types.js';
import type { WorkerModeToolContext } from '@duya/host/worker-modes/tool-ports';
import { createRunWorkerModeSubagent } from '../worker-mode-adapters.js';

export { SUMMARY_MAX_CHARS } from '@duya/host/worker-modes/goal/goal-summarizer';
export type GoalSummaryParams = Omit<HostGoalSummaryParams, 'context' | 'runSubagent'> & {
  context: ToolUseContext;
  agentDefinitions?: readonly AgentDefinition[];
  subagentDeps: SubagentRunDeps;
};

export async function summarizeGoalCompletion(params: GoalSummaryParams): Promise<string | undefined> {
  const { subagentDeps, ...hostParams } = params;
  return summarizeHostGoalCompletion({
    ...hostParams,
    context: params.context as unknown as WorkerModeToolContext,
    agentDefinitions: params.agentDefinitions,
    runSubagent: createRunWorkerModeSubagent(subagentDeps, params.agentDefinitions),
  });
}
