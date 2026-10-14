export interface WorkerModeAgentDefinition {
  agentType: string;
}

export interface WorkerModeToolContextOptions {
  sessionId?: string | undefined;
  workingDirectory?: string | undefined;
  provider?: string | undefined;
  language?: string | undefined;
  goalVerifierCount?: number | undefined;
  tools?: readonly unknown[];
  agentDefinitions?: {
    allAgents?: readonly WorkerModeAgentDefinition[];
  };
}

/** Structural view of tool context fields used by Host-owned mode services. */
export interface WorkerModeToolContext {
  options: WorkerModeToolContextOptions;
}

export interface WorkerModeSubagentRequest {
  agentType: string;
  prompt: string;
  description: string;
  context: WorkerModeToolContext;
  maxTurns?: number | undefined;
}

/** The Agent adapter resolves and launches the real child agent. */
export type RunWorkerModeSubagent = (request: WorkerModeSubagentRequest) => Promise<string>;

export interface WorkerModeSubagentToolRequest {
  input: Record<string, unknown>;
  workingDirectory?: string | undefined;
  context?: WorkerModeToolContext | undefined;
}

export interface WorkerModeSubagentToolResult {
  result: string;
  error?: boolean;
}

/** The Host never assembles a SubagentTool; the Agent adapter binds the real one. */
export type RunWorkerModeSubagentTool = (
  request: WorkerModeSubagentToolRequest,
) => Promise<WorkerModeSubagentToolResult>;

export type WorkerModeEventEmitter = (event: Record<string, unknown>) => void;

export interface GoalModeToolPorts {
  runSubagent: RunWorkerModeSubagent;
  emitEvent?: WorkerModeEventEmitter;
}

export interface ResearchModeToolPorts {
  runSubagentTool: RunWorkerModeSubagentTool;
  emitEvent?: WorkerModeEventEmitter;
}
