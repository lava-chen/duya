/**
 * AgentSSEClient - Renderer-side SSE client for Agent Server communication
 *
 * Replaces MessagePort with HTTP+SSE transport for agent chat.
 * Uses fetch() with manual SSE parsing (not EventSource, because
 * chat initiation requires POST which EventSource doesn't support).
 *
 * Features:
 * - Auto-reconnect with exponential backoff
 * - Last-Event-ID tracking for gap detection
 * - Event dispatching matching existing callback signatures
 */

const SSE_LINE_REGEX = /^(event|id|data):\s*(.*)$/;

export interface AgentSSEClientOptions {
  onText?: (content: string) => void;
  onThinking?: (content: string) => void;
  onToolUse?: (data: { id: string; name: string; input: unknown }) => void;
  onToolResult?: (data: { id: string; result: unknown; error?: string }) => void;
  onToolProgress?: (data: { toolUseId: string; percent: number; stage: string }) => void;
  onToolOutput?: (data: { toolUseId: string; stream: 'stdout' | 'stderr'; data: string }) => void;
  onAgentProgress?: (data: {
    agentEventType: string;
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
  }) => void;
  onPermission?: (request: { id: string; toolName: string; toolInput: Record<string, unknown> }) => void;
  onContextUsage?: (data: { usedTokens: number; contextWindow: number; percentFull: number }) => void;
  onTokenUsage?: (data: { inputTokens: number; outputTokens: number; cacheHitTokens?: number; cacheCreationTokens?: number }) => void;
  onDone?: () => void;
  onError?: (message: string, retryable?: boolean) => void;
  onStatus?: (message: string) => void;
  onRetry?: (data: { attempt: number; maxAttempts: number; delayMs: number; message: string }) => void;
  onSkillReviewStarted?: () => void;
  onSkillReviewCompleted?: (data: { passed: boolean; score: number; feedback: string; skillName?: string; error?: string; iterations?: number; maxIterations?: number; finalPath?: string }) => void;
}

type EventHandler = (data: unknown) => void;

export class AgentSSEClient {
  private port: number | null = null;
  private sessionId: string | null = null;
  private abortController: AbortController | null = null;
  private lastEventId = 0;
  private handlers = new Map<string, Set<EventHandler>>();
  private isReconnecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private options: AgentSSEClientOptions;
  private streamEnded = false;

  private static readonly INITIAL_RECONNECT_DELAY_MS = 500;
  private static readonly MAX_RECONNECT_DELAY_MS = 8000;
  private static readonly RECONNECT_BACKOFF_MULTIPLIER = 2;

  constructor(options: AgentSSEClientOptions = {}) {
    this.options = options;
  }

  get isConnected(): boolean {
    return this.abortController !== null && !this.abortController.signal.aborted;
  }

  /**
   * Initialize with Agent Server port from Electron main process
   */
  async initialize(): Promise<void> {
    if (this.port !== null) return;

    const api = window.electronAPI;
    if (!api?.getAgentServerPort) {
      throw new Error('Agent server port API not available');
    }

    const port = await api.getAgentServerPort();
    if (port === null) {
      throw new Error('Agent server not running');
    }

    this.port = port;
  }

  /**
   * Start a new chat via POST /sessions/:id/chat with SSE accept header.
   * Parses the SSE response stream and dispatches events to registered handlers.
   */
  async startChat(
    sessionId: string,
    prompt: string,
    chatOptions?: Record<string, unknown>
  ): Promise<void> {
    this.cancelReconnect();
    this.disconnect();
    this.sessionId = sessionId;
    this.lastEventId = 0;
    this.streamEnded = false;

    await this.ensurePort();

    const url = `http://127.0.0.1:${this.port}/sessions/${sessionId}/chat`;
    this.abortController = new AbortController();

    const { providerConfig, ...restOptions } = chatOptions || {};

    const body: Record<string, unknown> = { prompt };
    if (providerConfig) {
      body.providerConfig = providerConfig;
    }
    if (Object.keys(restOptions).length > 0) {
      body.options = restOptions;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      signal: this.abortController.signal,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`Failed to start chat: ${response.status} ${errorBody}`);
    }

    await this.parseSSEStream(response);
  }

  /**
   * Reconnect to an active session via GET /sessions/:id/chat.
   * Used when renderer disconnected but agent is still streaming.
   */
  async reconnect(sessionId: string): Promise<void> {
    this.cancelReconnect();
    this.disconnect();
    this.sessionId = sessionId;

    await this.ensurePort();

    const url = `http://127.0.0.1:${this.port}/sessions/${sessionId}/chat`;
    this.abortController = new AbortController();

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'Last-Event-ID': String(this.lastEventId),
      },
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`Failed to reconnect: ${response.status} ${errorBody}`);
    }

    this.isReconnecting = true;
    await this.parseSSEStream(response);
  }

  /**
   * Disconnect from current SSE stream
   */
  disconnect(): void {
    this.cancelReconnect();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Register an event handler for a specific SSE event type.
   * Returns an unsubscribe function.
   *
   * Supported event types:
   * - text, thinking, tool_use, tool_result, tool_progress, tool_output
   * - agent_progress, permission, context_usage, status
   * - done, error, retry, checkpoint, ready
   * - skill_review_started, skill_review_completed
   */
  onEvent(eventType: string, handler: EventHandler): () => void {
    let handlers = this.handlers.get(eventType);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(eventType, handlers);
    }
    handlers.add(handler);

    return () => {
      handlers?.delete(handler);
      if (handlers?.size === 0) {
        this.handlers.delete(eventType);
      }
    };
  }

  /**
   * Destroy the client, cleaning up all resources
   */
  destroy(): void {
    this.disconnect();
    this.handlers.clear();
    this.sessionId = null;
    this.port = null;
    this.reconnectAttempts = 0;
  }

  // ==========================================================================
  // PRIVATE
  // ==========================================================================

  private async ensurePort(): Promise<void> {
    if (this.port === null) {
      await this.initialize();
    }
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async parseSSEStream(response: Response): Promise<void> {
    if (!response.body) {
      this.dispatch('error', { message: 'No response body', retryable: false });
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          console.log('[SSE-Client] Stream done');
          this.handleStreamEnd();
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        console.log('[SSE-Client] Chunk received:', chunk.substring(0, 100));
        buffer += chunk;

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = '';
        let eventId = '';
        let eventData = '';

        for (const rawLine of lines) {
          const line = rawLine.trimEnd();

          if (line === '') {
            if (eventData) {
              this.dispatchSSEEvent(eventType, eventId, eventData);
            }
            eventType = '';
            eventId = '';
            eventData = '';
            continue;
          }

          const match = line.match(SSE_LINE_REGEX);
          if (!match) continue;

          const [, field, value] = match;

          if (field === 'event') {
            eventType = value;
          } else if (field === 'id') {
            eventId = value;
          } else if (field === 'data') {
            eventData += (eventData ? '\n' : '') + value;
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return;
      }
      this.handleStreamError(err as Error);
    } finally {
      reader.releaseLock();
    }
  }

  private dispatchSSEEvent(eventType: string, eventId: string, eventData: string): void {
    this.reconnectAttempts = 0;

    console.log('[SSE-Client] Event received:', eventType, 'id:', eventId, 'data:', eventData.substring(0, 200));

    if (eventId) {
      this.lastEventId = parseInt(eventId, 10) || this.lastEventId;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(eventData);
    } catch {
      parsed = eventData;
    }

    if (this.isReconnecting) {
      this.isReconnecting = false;
    }

    const eventObj = parsed as Record<string, unknown>;

    switch (eventType) {
      case 'text':
        this.dispatch('text', { content: (eventObj.content as string) || '' });
        break;
      case 'thinking':
        this.dispatch('thinking', { content: (eventObj.content as string) || '' });
        break;
      case 'tool_use':
        this.dispatch('tool_use', {
          id: eventObj.id as string,
          name: eventObj.name as string,
          input: eventObj.input,
        });
        break;
      case 'tool_result':
        this.dispatch('tool_result', {
          id: eventObj.id as string,
          result: eventObj.result,
          error: eventObj.error as string | undefined,
        });
        break;
      case 'tool_progress':
        this.dispatch('tool_progress', {
          toolUseId: eventObj.toolUseId as string,
          percent: eventObj.percent as number,
          stage: eventObj.stage as string,
        });
        break;
      case 'tool_output':
        this.dispatch('tool_output', {
          toolUseId: eventObj.toolUseId as string,
          stream: eventObj.stream as 'stdout' | 'stderr',
          data: eventObj.data as string,
        });
        break;
      case 'agent_progress':
        this.dispatch('agent_progress', eventObj);
        break;
      case 'permission':
        this.dispatch('permission', {
          id: eventObj.id as string,
          toolName: eventObj.toolName as string,
          toolInput: eventObj.toolInput as Record<string, unknown>,
        });
        break;
      case 'context_usage':
        this.dispatch('context_usage', {
          usedTokens: eventObj.usedTokens as number,
          contextWindow: eventObj.contextWindow as number,
          percentFull: eventObj.percentFull as number,
        });
        break;
      case 'token_usage':
        this.dispatch('token_usage', {
          inputTokens: eventObj.inputTokens as number,
          outputTokens: eventObj.outputTokens as number,
          cacheHitTokens: eventObj.cacheHitTokens as number | undefined,
          cacheCreationTokens: eventObj.cacheCreationTokens as number | undefined,
        });
        break;
      case 'done':
        this.streamEnded = true;
        this.dispatch('done', {});
        break;
      case 'error':
        this.streamEnded = true;
        this.dispatch('error', {
          message: (eventObj.message as string) || 'Unknown error',
          retryable: Boolean(eventObj.retryable),
        });
        break;
      case 'status':
        this.dispatch('status', { message: (eventObj.message as string) || '' });
        break;
      case 'retry':
        this.dispatch('retry', eventObj);
        break;
      case 'skill_review_started':
        this.dispatch('skill_review_started', {});
        break;
      case 'skill_review_completed':
        this.dispatch('skill_review_completed', eventObj);
        break;
      default:
        this.dispatch(eventType, eventObj);
    }
  }

  private dispatch(eventType: string, data: unknown): void {
    const handlers = this.handlers.get(eventType);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch {
          // Swallow handler errors
        }
      }
    }

    this.dispatchOptionsCallback(eventType, data);
  }

  private dispatchOptionsCallback(eventType: string, data: unknown): void {
    const obj = data as Record<string, unknown>;

    switch (eventType) {
      case 'text':
        this.options.onText?.((obj.content as string) || '');
        break;
      case 'thinking':
        this.options.onThinking?.((obj.content as string) || '');
        break;
      case 'tool_use':
        this.options.onToolUse?.({
          id: obj.id as string,
          name: obj.name as string,
          input: obj.input,
        });
        break;
      case 'tool_result':
        this.options.onToolResult?.({
          id: obj.id as string,
          result: obj.result,
          error: obj.error as string | undefined,
        });
        break;
      case 'tool_progress':
        this.options.onToolProgress?.({
          toolUseId: obj.toolUseId as string,
          percent: obj.percent as number,
          stage: obj.stage as string,
        });
        break;
      case 'tool_output':
        this.options.onToolOutput?.({
          toolUseId: obj.toolUseId as string,
          stream: obj.stream as 'stdout' | 'stderr',
          data: obj.data as string,
        });
        break;
      case 'agent_progress':
        this.options.onAgentProgress?.(data as NonNullable<AgentSSEClientOptions['onAgentProgress']> extends (d: infer D) => void ? D : never);
        break;
      case 'permission':
        this.options.onPermission?.({
          id: obj.id as string,
          toolName: obj.toolName as string,
          toolInput: obj.toolInput as Record<string, unknown>,
        });
        break;
      case 'context_usage':
        this.options.onContextUsage?.({
          usedTokens: obj.usedTokens as number,
          contextWindow: obj.contextWindow as number,
          percentFull: obj.percentFull as number,
        });
        break;
      case 'token_usage':
        this.options.onTokenUsage?.({
          inputTokens: obj.inputTokens as number,
          outputTokens: obj.outputTokens as number,
          cacheHitTokens: obj.cacheHitTokens as number | undefined,
          cacheCreationTokens: obj.cacheCreationTokens as number | undefined,
        });
        break;
      case 'done':
        this.options.onDone?.();
        break;
      case 'error':
        this.options.onError?.(
          (obj.message as string) || 'Unknown error',
          Boolean(obj.retryable)
        );
        break;
      case 'status':
        this.options.onStatus?.((obj.message as string) || '');
        break;
      case 'retry':
        this.options.onRetry?.(data as {
          attempt: number;
          maxAttempts: number;
          delayMs: number;
          message: string;
        });
        break;
      case 'skill_review_started':
        this.options.onSkillReviewStarted?.();
        break;
      case 'skill_review_completed':
        this.options.onSkillReviewCompleted?.(data as {
          passed: boolean;
          score: number;
          feedback: string;
          skillName?: string;
          error?: string;
          iterations?: number;
          maxIterations?: number;
          finalPath?: string;
        });
        break;
    }
  }

  private handleStreamEnd(): void {
    this.abortController = null;

    if (!this.streamEnded && this.options.onDone) {
      this.options.onDone();
    }
  }

  private handleStreamError(error: Error): void {
    this.abortController = null;

    if (this.options.onError) {
      this.options.onError(error.message, true);
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.sessionId || !this.port) return;

    const delay = Math.min(
      AgentSSEClient.INITIAL_RECONNECT_DELAY_MS *
        Math.pow(AgentSSEClient.RECONNECT_BACKOFF_MULTIPLIER, this.reconnectAttempts),
      AgentSSEClient.MAX_RECONNECT_DELAY_MS
    );

    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.reconnect(this.sessionId!);
      } catch {
        if (this.reconnectAttempts < 5) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }
}

// ============================================================================
// API CLIENT FUNCTIONS
// ============================================================================

let cachedPort: number | null = null;

async function getPort(): Promise<number> {
  if (cachedPort !== null) return cachedPort;

  const api = window.electronAPI;
  if (!api?.getAgentServerPort) {
    throw new Error('Agent server port API not available');
  }

  const port = await api.getAgentServerPort();
  if (port === null) {
    throw new Error('Agent server not running');
  }

  cachedPort = port;
  return port;
}

/**
 * Clear the cached agent server port (call when port may have changed)
 */
export function clearAgentServerPortCache(): void {
  cachedPort = null;
}

/**
 * Start a new chat session and return an AgentSSEClient to consume SSE events.
 *
 * Usage:
 * ```ts
 * const client = await startChat('session-id', 'hello', { model: 'gpt-4' });
 * client.onEvent('text', (data) => console.log(data));
 * ```
 */
export async function startChat(
  sessionId: string,
  prompt: string,
  options?: Record<string, unknown>,
  eventHandlers?: AgentSSEClientOptions
): Promise<AgentSSEClient> {
  const client = new AgentSSEClient(eventHandlers);
  await client.initialize();
  await client.startChat(sessionId, prompt, options);
  return client;
}

/**
 * Interrupt the current chat generation
 */
export async function interruptChat(sessionId: string): Promise<void> {
  const port = await getPort();
  const url = `http://127.0.0.1:${port}/sessions/${sessionId}/chat`;

  const response = await fetch(url, { method: 'DELETE' });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Failed to interrupt chat: ${response.status} ${errorBody}`);
  }
}

export interface CompactResult {
  success: boolean;
  removedCount?: number;
  remainingCount?: number;
  tokenReduction?: number;
}

export interface CompactCallbacks {
  onDone?: (result: CompactResult) => void;
  onError?: (error: string) => void;
}

/**
 * Compact (compress) context for a session
 */
export async function compactContext(
  sessionId: string,
  callbacks?: CompactCallbacks
): Promise<void> {
  const port = await getPort();
  const url = `http://127.0.0.1:${port}/sessions/${sessionId}/compact`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Failed to compact context: ${response.status} ${errorBody}`);
  }

  if (!response.body) {
    throw new Error('No response body for compact request');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('event:')) continue;

        const eventMatch = trimmed.match(/^event: (\S+)\ndata: (.+)$/);
        if (!eventMatch) continue;

        const eventType = eventMatch[1];
        const eventData = JSON.parse(eventMatch[2]);

        if (eventType === 'compact:done') {
          callbacks?.onDone?.({
            success: true,
            removedCount: (eventData as { removedCount?: number }).removedCount,
            remainingCount: (eventData as { remainingCount?: number }).remainingCount,
            tokenReduction: (eventData as { tokenReduction?: number }).tokenReduction,
          });
          return;
        }

        if (eventType === 'compact:error') {
          const errorMsg = (eventData as { message?: string }).message || 'Unknown error';
          callbacks?.onError?.(errorMsg);
          return;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface SessionStatus {
  status: string;
  sessionId: string;
  createdAt: number;
  turnCount: number;
  lastEventId: number;
  lastCheckpointTime?: number;
  hasWorker: boolean;
  messages?: unknown;
  usage?: Record<string, unknown>;
  exitCode?: number;
  exitSignal?: string;
  lastCheckpoint?: unknown;
  errorMessage?: string;
  errorRetryable?: boolean;
}

export interface SessionHistoryEvent {
  eventId: number;
  eventType: string;
  data: unknown;
  timestamp: number;
}

export interface SessionHistory {
  sessionId: string;
  events: SessionHistoryEvent[];
  sinceEventId: number;
}

/**
 * Query the current status of a session
 */
export async function queryStatus(sessionId: string): Promise<SessionStatus> {
  const port = await getPort();
  const url = `http://127.0.0.1:${port}/sessions/${sessionId}/status`;

  const response = await fetch(url);

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Failed to query status: ${response.status} ${errorBody}`);
  }

  return response.json();
}

/**
 * Fetch session event history since a specific event ID.
 * Used for recovery after reconnection to replay missed events.
 */
export async function fetchHistory(sessionId: string, sinceEventId: number = 0): Promise<SessionHistory> {
  const port = await getPort();
  const url = `http://127.0.0.1:${port}/sessions/${sessionId}/history?since=${sinceEventId}`;

  const response = await fetch(url);

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Failed to fetch history: ${response.status} ${errorBody}`);
  }

  return response.json();
}

/**
 * Get the list of interrupted sessions from the main process.
 */
export async function getInterruptedSessions(): Promise<unknown[]> {
  const api = window.electronAPI;
  if (!api?.getInterruptedSessions) {
    return [];
  }
  return api.getInterruptedSessions();
}

/**
 * Resolve a pending permission request
 */
export async function resolvePermission(
  sessionId: string,
  permissionId: string,
  decision: 'allow' | 'deny' | 'allow_once' | 'allow_for_session'
): Promise<void> {
  const port = await getPort();
  const url = `http://127.0.0.1:${port}/sessions/${sessionId}/permission`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: permissionId, decision }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Failed to resolve permission: ${response.status} ${errorBody}`);
  }
}