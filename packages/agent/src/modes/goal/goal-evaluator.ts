import { verifyGoalCompletion as verifyHostGoalCompletion, runStrategist as runHostStrategist } from '@duya/host/worker-modes/goal/goal-evaluator';
import type {
  GoalVerificationParams as HostGoalVerificationParams,
  GoalVerdict,
  GoalVerificationResult,
} from '@duya/host/worker-modes/goal/goal-evaluator';
import type { AgentDefinition } from '../../tool/SubagentTool/loadAgentsDir.js';
import type { SubagentRunDeps } from '../../tool/SubagentTool/runAgent.js';
import type { ToolUseContext } from '../../types.js';
import type { WorkerModeToolContext } from '@duya/host/worker-modes/tool-ports';
import { createRunWorkerModeSubagent } from '../worker-mode-adapters.js';

export {
  DEFAULT_MAX_NOT_ACHIEVED_ROUNDS,
  DEFAULT_STRATEGIST_EVERY,
  DEFAULT_VERIFIER_COUNT,
  aggregateSkepticVerdicts,
  buildVerifierPrompt,
  findVerificationAgent,
  fingerprintOf,
  mergeGaps,
  parseVerifierReport,
  parseVerdictJson,
  shouldRunVerificationPanel,
} from '@duya/host/worker-modes/goal/goal-evaluator';
export type { GoalVerdict, GoalVerificationResult };

export type GoalVerificationParams = Omit<HostGoalVerificationParams, 'context' | 'runSubagent'> & {
  context: ToolUseContext;
  agentDefinitions?: readonly AgentDefinition[];
  subagentDeps: SubagentRunDeps;
};

export async function verifyGoalCompletion(
  params: GoalVerificationParams,
): Promise<GoalVerificationResult> {
  const { subagentDeps, ...hostParams } = params;
  return verifyHostGoalCompletion({
    ...hostParams,
    context: params.context as unknown as WorkerModeToolContext,
    agentDefinitions: params.agentDefinitions,
    runSubagent: createRunWorkerModeSubagent(subagentDeps, params.agentDefinitions),
  });
}

export type LegacyStrategistParams = Omit<Parameters<typeof runHostStrategist>[0], 'context' | 'runSubagent'> & {
  context: ToolUseContext;
  agentDefinitions?: readonly AgentDefinition[];
  subagentDeps: SubagentRunDeps;
};

export async function runStrategist(params: LegacyStrategistParams): Promise<string | undefined> {
  const { subagentDeps, ...hostParams } = params;
  return runHostStrategist({
    ...hostParams,
    context: params.context as unknown as WorkerModeToolContext,
    agentDefinitions: params.agentDefinitions,
    runSubagent: createRunWorkerModeSubagent(subagentDeps, params.agentDefinitions),
  });
}
