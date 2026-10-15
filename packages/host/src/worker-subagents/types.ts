import type { Message } from '@duya/agent-core/message';
import type { AgentDefinition } from '@duya/agent-core/subagents/agent-definition';
import type { AgentProgressEvent as WireAgentProgressEvent } from '@duya/ai';
import type {
  SubagentPermissionMode,
  SubagentToolInput,
  SubagentToolResultPayload,
  SubagentToolOverlay,
} from '@duya/capabilities/SubagentTool';

/** Progress emitted by a child run and projected to the parent worker/UI. */
export interface AgentProgressEvent {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'started' | 'heartbeat' | 'done' | 'error';
  data?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  duration?: number;
  agentId?: string;
  agentType?: string;
  agentName?: string;
  agentDescription?: string;
  sessionId?: string;
}

/** Minimum canonical definition data the Host orchestration layer reads. */
export type WorkerSubagentAgentDefinition = Pick<AgentDefinition<unknown>, 'agentType'>;

/** Narrow context projection needed for scheduling and progress routing. */
export interface WorkerSubagentExecutionContext<
  TDefinition extends WorkerSubagentAgentDefinition = WorkerSubagentAgentDefinition,
  TAgentContext = unknown,
  TTool = unknown,
> {
  toolUseId: string;
  options: {
    sessionId?: string;
    workingDirectory?: string;
    provider?: string;
    tools: TTool[];
    agentDefinitions?: { allAgents: TDefinition[] };
  };
  /** Passed unchanged to the injected Agent/session adapter for child execution. */
  agentContext: TAgentContext;
  /** Parent-run callback accepts the shared wire event, which intentionally omits heartbeat. */
  reportAgentProgress?: (event: WireAgentProgressEvent) => void;
}

export interface WorkerSubagentRunRequest<
  TDefinition extends WorkerSubagentAgentDefinition = WorkerSubagentAgentDefinition,
  TAgentContext = unknown,
  TTool = unknown,
> {
  agentDefinition: TDefinition;
  promptMessages: Message[];
  toolUseContext: TAgentContext;
  isAsync: boolean;
  model?: string;
  maxTurns?: number;
  availableTools: TTool[];
  description?: string;
  agentId: string;
  onProgress?: (event: AgentProgressEvent) => void;
  sessionId?: string;
  effort?: string;
  permissionMode?: SubagentPermissionMode;
  toolOverlay?: SubagentToolOverlay;
  workingDirectory?: string;
  abortController?: AbortController;
}

export interface WorkerSubagentServicePorts<
  TDefinition extends WorkerSubagentAgentDefinition = WorkerSubagentAgentDefinition,
  TAgentContext = unknown,
  TTool = unknown,
> {
  runAgent(request: WorkerSubagentRunRequest<TDefinition, TAgentContext, TTool>): AsyncGenerator<Message, void>;
  runAgentSync(request: WorkerSubagentRunRequest<TDefinition, TAgentContext, TTool>): Promise<Message>;
  messageRowToMessage(row: unknown): Message;
}

export type WorkerSubagentToolInput = SubagentToolInput;
export type WorkerSubagentToolResult = SubagentToolResultPayload;
