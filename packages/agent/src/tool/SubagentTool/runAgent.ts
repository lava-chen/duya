/** Compatibility path; Host owns sub-agent execution. */
export {
  runAgent,
  runAgentSync,
} from '@duya/host/worker-subagents/run-agent';
export type {
  AgentProgressEvent,
  CacheSafeParams,
  CreateSubAgent,
  CreateToolRegistry,
  RunAgentParams,
  RunAgentResult,
  SubagentRunDeps,
} from '@duya/host/worker-subagents/run-agent';
