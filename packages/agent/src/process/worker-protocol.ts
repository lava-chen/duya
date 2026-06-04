import * as readline from 'readline';

export interface InitCommand {
  type: 'init';
  sessionId: string;
  providerConfig: {
    apiKey: string;
    baseURL?: string;
    model: string;
    provider: 'anthropic' | 'openai' | 'ollama';
    authStyle?: 'api_key' | 'auth_token';
    visionConfig?: {
      provider: string;
      model: string;
      baseURL: string;
      apiKey: string;
      enabled: boolean;
    };
  };
  workingDirectory?: string;
  systemPrompt?: string;
  skillPaths?: string[];
  communicationPlatform?: string;
  blockedDomains?: string[];
  language?: string;
  sandboxEnabled?: boolean;
}

export interface ChatStartCommand {
  type: 'chat:start';
  sessionId: string;
  id: string;
  prompt: string;
  options?: {
    messages?: Array<{ role: string; content: string }>;
    systemPrompt?: string;
    language?: string;
    /**
     * @deprecated 由 session row.permission_profile 派生. worker 严格忽略此字段, 防止残留发送路径覆盖 DB 决定.
     */
    permissionMode?: string;
    /**
     * 显式单次 override (trusted caller only). 类型: agent internal mode, 不是 DB profile.
     */
    permissionModeOverride?: 'default' | 'auto' | 'bypassPermissions';
    files?: Array<{
      id: string;
      name: string;
      type: string;
      url: string;
      size: number;
      cacheKey?: string;
      base64?: string;
      images?: string[];
      parsedText?: string;
      storedPath?: string;
    }>;
    agentProfileId?: string | null;
    outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean };
    parsedDocs?: Array<{
      filename: string;
      charCount: number;
      text: string;
      extractMethod?: string;
      imageChunks?: Array<{ base64: string; mediaType: string }>;
      cacheKey?: string;
    }>;
  };
}

export interface ChatInterruptCommand {
  type: 'chat:interrupt';
}

export interface CompactCommand {
  type: 'compact';
  sessionId: string;
}

export interface PermissionResolveCommand {
  type: 'permission:resolve';
  id: string;
  decision: string;
  updatedInput?: Record<string, unknown>;
}

export interface DbResponseCommand {
  type: 'db:response';
  requestId: string;
  response: unknown;
  error?: string;
}

export type WorkerCommand =
  | InitCommand
  | ChatStartCommand
  | ChatInterruptCommand
  | CompactCommand
  | PermissionResolveCommand
  | DbResponseCommand
  | { type: string; [key: string]: unknown };

export interface CheckpointEvent {
  type: 'checkpoint';
  sessionId: string;
  data: {
    messages: Array<Record<string, unknown>>;
    generation: number;
  };
}

export interface AgentTextEvent {
  type: 'chat:text';
  sessionId: string;
  content: string;
}

export interface AgentThinkingEvent {
  type: 'chat:thinking';
  sessionId: string;
  content: string;
}

export interface AgentToolUseEvent {
  type: 'chat:tool_use';
  sessionId: string;
  id: string;
  name: string;
  input: unknown;
}

export interface AgentToolResultEvent {
  type: 'chat:tool_result';
  sessionId: string;
  id: string;
  result: string;
  error?: boolean;
  duration_ms?: number;
}

export interface AgentToolProgressEvent {
  type: 'chat:tool_progress';
  sessionId: string;
  toolUseId: string;
  percent: number;
  stage: string;
}

export interface AgentPermissionEvent {
  type: 'chat:permission';
  sessionId: string;
  request: {
    id: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  };
}

export interface AgentContextUsageEvent {
  type: 'chat:context_usage';
  sessionId: string;
  [key: string]: unknown;
}

export interface AgentDoneEvent {
  type: 'chat:done';
  sessionId: string;
}

export interface AgentErrorEvent {
  type: 'chat:error';
  sessionId: string;
  message: string;
}

export interface AgentTokenUsageEvent {
  type: 'chat:token_usage';
  sessionId: string;
  [key: string]: unknown;
}

export interface AgentStatusEvent {
  type: 'chat:status';
  sessionId: string;
  message: string;
}

export interface AgentRetryEvent {
  type: 'chat:retry';
  sessionId: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  message: string;
}

export interface AgentDbPersistedEvent {
  type: 'chat:db_persisted';
  sessionId: string;
  success: boolean;
  messageCount?: number;
  reason?: string;
}

export interface AgentTitleGeneratedEvent {
  type: 'chat:title_generated';
  sessionId: string;
  title: string;
}

export interface AgentDebugEvent {
  type: 'chat:debug';
  sessionId: string;
  message: string;
}

export interface AgentAgentProgressEvent {
  type: 'chat:agent_progress';
  sessionId: string;
  agentEventType?: string;
  data?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  duration?: number;
  agentId?: string;
  agentType?: string;
  agentName?: string;
  agentDescription?: string;
  agentSessionId?: string;
}

export interface DbRequestEvent {
  type: 'db:request';
  requestId: string;
  action: string;
  params: unknown;
}

export interface MemoryWarningEvent {
  type: 'memory_warning';
  sessionId: string;
  data: {
    heapUsed: number;
    heapTotal: number;
    heapLimit: number;
  };
}

export interface ReadyEvent {
  type: 'ready';
  sessionId: string;
}

export interface PongEvent {
  type: 'pong';
  timestamp: number;
}

export interface SkillsStatusEvent {
  type: 'skills:status';
  synced: boolean;
  added: unknown[];
  updated: unknown[];
  skipped: unknown[];
  removed: unknown[];
  error?: string;
}

export interface CompactDoneEvent {
  type: 'compact:done';
  sessionId: string;
  result: unknown;
}

export interface CompactErrorEvent {
  type: 'compact:error';
  sessionId: string;
  message: string;
}

export type WorkerEvent =
  | CheckpointEvent
  | AgentTextEvent
  | AgentThinkingEvent
  | AgentToolUseEvent
  | AgentToolResultEvent
  | AgentToolProgressEvent
  | AgentPermissionEvent
  | AgentContextUsageEvent
  | AgentDoneEvent
  | AgentErrorEvent
  | AgentTokenUsageEvent
  | AgentStatusEvent
  | AgentRetryEvent
  | AgentDbPersistedEvent
  | AgentTitleGeneratedEvent
  | AgentDebugEvent
  | AgentAgentProgressEvent
  | DbRequestEvent
  | MemoryWarningEvent
  | ReadyEvent
  | PongEvent
  | SkillsStatusEvent
  | CompactDoneEvent
  | CompactErrorEvent;

export function sendEvent(event: Record<string, unknown>): void {
  const payload = JSON.stringify({ ...event, _logger: 'worker' });
  if (payload.includes('\n')) {
    console.error('[worker-protocol] CRITICAL: sendEvent payload contains newline, event type:', event.type);
  }
  process.stdout.write(payload + '\n');
}

export async function* parseStdin(): AsyncGenerator<WorkerCommand> {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const cmd = JSON.parse(line) as WorkerCommand;
      yield cmd;
    } catch {
      console.error('[Worker-Protocol] Failed to parse stdin line:', line.substring(0, 200));
    }
  }
}
