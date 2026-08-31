/**
 * agent-http-client.ts - HTTP Client for Agent Server
 *
 * Connects to Agent Server via HTTP+SSE and converts events to
 * a format compatible with stream-session-manager.
 */

import type { FileAttachment } from '@/types/message';

export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  /**
   * Maximum agentic turns for this run. Forwarded to the worker's
   * `streamChat`; absent → worker falls back to `agent.max_turns` config,
   * then its built-in default (100).
   */
  maxTurns?: number;
  systemPrompt?: string;
  language?: string;
  displayContent?: string;
  /**
   * 显式单次 override (trusted caller only). 类型: agent internal mode.
   * 普通 send payload **不**携带; worker 从 session row.permission_profile 派生默认 mode.
   */
  permissionModeOverride?: 'default' | 'auto' | 'bypassPermissions';
  files?: FileAttachment[];
  agentProfileId?: string | null;
  outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean };
  titleGenerationModel?: string;
  titleGenerationModelConfig?: { provider: string; apiKey: string; baseURL: string; model: string };
  providerConfig?: Record<string, unknown>;
  workingDirectory?: string;
  mode?: string;
  defaultWorkspaceDirectory?: string;
  securityScanEnabled?: boolean;
  /**
   * Anthropic thinking effort level. Forwarded to the agent worker so
   * the LLM client can include `thinking.budget_tokens` in the request.
   * undefined/Auto means no extended thinking.
   */
  effort?: string;
  /**
   * Conductor mode — per-turn trusted override. When true, the agent
   * registers the 5 canvas conductor tools and injects the conductor
   * prompt overlay.
   */
  conductorMode?: boolean;
  /**
   * Conductor canvas ID — durable binding from the session row.
   * Injected into ToolUseContext.conductorCanvasId.
   */
  conductorCanvasId?: string;
  /** Internal background-task follow-up; never supplied by user input. */
  backgroundTaskResume?: boolean;
  /**
   * Plan 450: providers @-mentioned in the composer for this run. Forwarded
   * to the worker so connector tools of these providers skip tool_search.
   */
  mentionedProviders?: string[];
  /**
   * Plan 450 Phase H: skills whose `/name` command the user submitted this
   * run. Forwarded to the worker so the agent injects the SKILL.md body as a
   * `<skill>` fragment instead of relying on the model to load it.
   */
  mentionedSkills?: string[];
}

export interface AgentEvent {
  type: string;
  sessionId?: string;
  data?: unknown;
  id?: string;
  name?: string;
  input?: unknown;
  result?: unknown;
  error?: string;
  content?: string;
  reason?: string;
}

export type EventHandler = (event: AgentEvent) => void;

export class AgentServerClient {
  private baseUrl: string | null = null;
  private abortControllers = new Map<string, AbortController>();
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private receivedMessageIds = new Map<string, Set<string>>();

  async getBaseUrl(forceRefresh = false): Promise<string | null> {
    if (!forceRefresh && this.baseUrl) return this.baseUrl;

    const api = window.electronAPI?.agentServer;
    if (!api) {
      console.warn('[agent-http-client] agentServer API not available');
      return null;
    }

    const url = await api.getUrl();
    if (!url) {
      console.warn('[agent-http-client] Agent Server not running');
      this.baseUrl = null;
      return null;
    }

    this.baseUrl = url;
    console.log('[agent-http-client] Connected to Agent Server:', url);
    return url;
  }

  async startChat(
    sessionId: string,
    prompt: string,
    options?: ChatOptions
  ): Promise<void> {
    const baseUrl = await this.getBaseUrl(true);
    if (!baseUrl) {
      throw new Error('Agent Server not available');
    }

    // Cancel any existing stream for this session
    this.cancelStream(sessionId);
    // Clear deduplication state for new stream
    this.clearMessageIds(sessionId);

    const abortController = new AbortController();
    this.abortControllers.set(sessionId, abortController);

    console.log('[agent-http-client] Starting chat:', {
      sessionId,
      promptLength: prompt.length,
      filesCount: options?.files?.length,
      baseUrl,
      options: {
        agentProfileId: options?.agentProfileId,
        mode: options?.mode,
        conductorMode: options?.conductorMode,
        conductorCanvasId: options?.conductorCanvasId,
        effort: options?.effort,
      },
    });

    let streamEndedCleanly = false;
    // Track whether a terminal `done` / `error` event was already emitted on this
    // stream. SSE streams emit `stream:end` from the post-read finally block on
    // every clean close, but only one of those should reach
    // stream-session-manager when the worker already declared the turn terminal.
    // Without this flag, a late chunk loss on the final `event: done` frame
    // (Electron IPC, server keep-alive, packaged renderer buffers) drops the
    // terminal marker and the manager flips an otherwise-completed turn into
    // `phase = 'error'` with `Stream ended unexpectedly`.
    let terminalEventReceived = false;
    let response = null;
    try {
      console.log('[agent-http-client] Making POST request to:', `${baseUrl}/sessions/${sessionId}/chat`);
      const fetchPromise = fetch(`${baseUrl}/sessions/${sessionId}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({
          prompt,
          options: {
            messages: undefined, // Not used, messages come from DB
            systemPrompt: options?.systemPrompt,
            language: options?.language,
            permissionModeOverride: options?.permissionModeOverride,
            files: options?.files,
            agentProfileId: options?.agentProfileId,
            outputStyleConfig: options?.outputStyleConfig,
            displayContent: options?.displayContent,
            mode: options?.mode,
            // Plan 450: mention lists for per-turn activation (app connectors)
            // and skill-fragment injection. These MUST be forwarded explicitly —
            // this body is a whitelist; anything omitted never reaches the
            // worker's chat:start options.
            mentionedProviders: options?.mentionedProviders,
            mentionedSkills: options?.mentionedSkills,
            maxTurns: options?.maxTurns,
            titleGenerationModel: options?.titleGenerationModel,
            titleGenerationModelConfig: options?.titleGenerationModelConfig,
            securityScanEnabled: options?.securityScanEnabled,
            effort: options?.effort,
            conductorMode: options?.conductorMode,
            conductorCanvasId: options?.conductorCanvasId,
            backgroundTaskResume: options?.backgroundTaskResume,
          },
          providerConfig: options?.providerConfig,
          workingDirectory: options?.workingDirectory,
          defaultWorkspaceDirectory: options?.defaultWorkspaceDirectory,
        }),
        signal: abortController.signal,
      });

      // The first SSE chunk can be delayed by image preprocessing + vision analysis.
      // Use a much longer startup timeout for image turns to avoid false timeout errors.
      const hasImageAttachments = !!options?.files?.some(
        (file) => file.type.startsWith('image/') || file.type.startsWith('img/'),
      );
      const timeoutMs = hasImageAttachments ? 5 * 60 * 1000 : 60 * 1000;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<Response>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs);
      });

      console.log('[agent-http-client] Waiting for response...');
      response = await Promise.race([fetchPromise, timeoutPromise]);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (!response) {
        throw new Error('Request timed out or returned null response');
      }
      console.log('[agent-http-client] Response received, status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[agent-http-client] HTTP error response:', errorText);
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Response body is not readable');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let eventCount = 0;

      console.log('[agent-http-client] SSE stream started, waiting for events...');

      // Process SSE stream
      let currentEventType = 'message';
      while (true) {
        const readResult = await reader.read();
        const { done, value } = readResult;

        // Log raw chunk info
        if (value) {
          const chunkStr = decoder.decode(value, { stream: false });
          console.log('[agent-http-client] Raw chunk, bytes:', value.byteLength, 'string:', chunkStr.substring(0, 200));
        } else {
          console.log('[agent-http-client] read() returned no value, done:', done);
        }

        if (done) {
          console.log('[agent-http-client] SSE stream completed, total events:', eventCount);
          streamEndedCleanly = true;
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        console.log('[agent-http-client] Decoded chunk length:', chunk.length, 'value byteLength:', value?.byteLength ?? 0);
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEventType = line.slice(6).trim();
            console.log('[agent-http-client] Received event type:', currentEventType);
            continue;
          }

          if (line.startsWith('data:')) {
            const dataStr = line.slice(5).trim();
            try {
              const event = JSON.parse(dataStr);
              eventCount++;
              console.log('[agent-http-client] Received event #', eventCount, 'type:', currentEventType, 'data:', JSON.stringify(event).substring(0, 300));
              const mappedEvent: AgentEvent = {
                type: currentEventType || event.type || 'unknown',
                sessionId: event.sessionId || sessionId,
                data: event.data,
                id: (event.data as Record<string, unknown>)?.id as string,
                name: (event.data as Record<string, unknown>)?.name as string,
                input: (event.data as Record<string, unknown>)?.input,
                result: (event.data as Record<string, unknown>)?.result,
                error: (event.data as Record<string, unknown>)?.error as string,
                content: (event.data as Record<string, unknown>)?.content as string,
                reason: (event.data as Record<string, unknown>)?.reason as string | undefined,
              };
              if (mappedEvent.type === 'done' || mappedEvent.type === 'chat:done' || mappedEvent.type === 'error' || mappedEvent.type === 'chat:error') {
                terminalEventReceived = true;
              }
              this.emit(sessionId, mappedEvent);
              // Reset event type after processing
              currentEventType = 'message';
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }
    } catch (error) {
      // Retry once with a fresh Agent Server URL in case port changed after server restart.
      const firstMessage = error instanceof Error ? error.message : String(error);
      const shouldRetry =
        firstMessage.includes('Failed to fetch') ||
        firstMessage.includes('ECONNREFUSED') ||
        firstMessage.includes('ERR_CONNECTION_REFUSED') ||
        firstMessage.includes('NetworkError');

      if (shouldRetry) {
        try {
          const freshBaseUrl = await this.getBaseUrl(true);
          if (freshBaseUrl && freshBaseUrl !== baseUrl) {
            console.warn('[agent-http-client] Retrying chat with refreshed Agent Server URL:', freshBaseUrl);
            const retryResponse = await fetch(`${freshBaseUrl}/sessions/${sessionId}/chat`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream',
              },
              body: JSON.stringify({
                prompt,
                options: {
                  messages: undefined,
                  systemPrompt: options?.systemPrompt,
                  language: options?.language,
                  permissionModeOverride: options?.permissionModeOverride,
                  files: options?.files,
                  agentProfileId: options?.agentProfileId,
                  outputStyleConfig: options?.outputStyleConfig,
                  displayContent: options?.displayContent,
                  mode: options?.mode,
                  maxTurns: options?.maxTurns,
                  titleGenerationModel: options?.titleGenerationModel,
                  titleGenerationModelConfig: options?.titleGenerationModelConfig,
                  securityScanEnabled: options?.securityScanEnabled,
                },
                providerConfig: options?.providerConfig,
                workingDirectory: options?.workingDirectory,
                defaultWorkspaceDirectory: options?.defaultWorkspaceDirectory,
              }),
              signal: abortController.signal,
            });

            if (!retryResponse.ok) {
              const retryErrorText = await retryResponse.text();
              throw new Error(`Retry HTTP ${retryResponse.status}: ${retryErrorText}`);
            }

            const reader = retryResponse.body?.getReader();
            if (!reader) {
              throw new Error('Retry response body is not readable');
            }

            const decoder = new TextDecoder();
            let buffer = '';
            let currentEventType = 'message';

            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                streamEndedCleanly = true;
                break;
              }

              const chunk = decoder.decode(value, { stream: true });
              buffer += chunk;
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (line.startsWith('event:')) {
                  currentEventType = line.slice(6).trim();
                  continue;
                }
                if (line.startsWith('data:')) {
                  const dataStr = line.slice(5).trim();
                  try {
                    const event = JSON.parse(dataStr);
                    const mappedEvent: AgentEvent = {
                      type: currentEventType || event.type || 'unknown',
                      sessionId: event.sessionId || sessionId,
                      data: event.data,
                      id: (event.data as Record<string, unknown>)?.id as string,
                      name: (event.data as Record<string, unknown>)?.name as string,
                      input: (event.data as Record<string, unknown>)?.input,
                      result: (event.data as Record<string, unknown>)?.result,
                      error: (event.data as Record<string, unknown>)?.error as string,
                      content: (event.data as Record<string, unknown>)?.content as string,
                      reason: (event.data as Record<string, unknown>)?.reason as string | undefined,
                    };
                    if (mappedEvent.type === 'done' || mappedEvent.type === 'chat:done' || mappedEvent.type === 'error' || mappedEvent.type === 'chat:error') {
                      terminalEventReceived = true;
                    }
                    this.emit(sessionId, mappedEvent);
                    currentEventType = 'message';
                  } catch {
                    // skip invalid JSON
                  }
                }
              }
            }
            return;
          }
        } catch (retryError) {
          console.error('[agent-http-client] Retry failed:', retryError);
        }
      }

      if (error instanceof Error && error.name === 'AbortError') {
        console.log('[agent-http-client] Stream cancelled:', sessionId);
        streamEndedCleanly = false;
      } else {
        console.error('[agent-http-client] Stream error:', error);
        this.emit(sessionId, {
          type: 'chat:error',
          sessionId,
          data: { message: error instanceof Error ? error.message : String(error) },
        });
        streamEndedCleanly = false;
      }
    } finally {
      this.abortControllers.delete(sessionId);
      // Emit `stream:end` only when the stream closed without a terminal
      // `done`/`error` event. When the worker already declared the turn
      // terminal, the manager has all it needs and re-firing here would let
      // a mid-phase reset (or a stale stream:end event from a previous
      // streamId that the manager still considers current) flip an
      // otherwise-completed turn into `phase = 'error'`.
      if (streamEndedCleanly && !terminalEventReceived) {
        console.log('[agent-http-client] SSE stream ended without terminal event, emitting stream:end event');
        this.emit(sessionId, {
          type: 'stream:end',
          sessionId,
          data: {},
        });
      } else if (streamEndedCleanly && terminalEventReceived) {
        console.log('[agent-http-client] SSE stream ended cleanly after terminal event, skipping stream:end');
      }
    }
  }

  cancelStream(sessionId: string): void {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }
  }

  /**
   * Attach to an in-progress session's live SSE stream via GET /chat (the same
   * endpoint the renderer uses to reconnect). Unlike `startChat`, this does NOT
   * start a new turn — it subscribes to the existing worker's output for a
   * session that was initiated outside the renderer (e.g. a cron run in the
   * main process). Emits a `stream:end` event on clean stream close. When the
   * session is no longer STREAMING (finished / 409), callers should fall back
   * to reading the persisted transcript.
   */
  async attachToLiveStream(sessionId: string, lastEventId = 0): Promise<void> {
    const baseUrl = await this.getBaseUrl(true);
    if (!baseUrl) {
      throw new Error('Agent Server not available');
    }

    const abortController = new AbortController();
    this.abortControllers.set(sessionId, abortController);

    let streamEndedCleanly = false;
    // Same flag as startChat — emit `stream:end` only when no terminal
    // `done`/`error` was observed. Without this, an attach that ends cleanly
    // after a terminal event would re-fire `stream:end` into the manager
    // and risk the same false-positive error transition.
    let terminalEventReceived = false;
    try {
      const response = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/chat`, {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          'Last-Event-ID': String(lastEventId),
        },
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 200)}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Response body is not readable');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let currentEventType = 'message';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          streamEndedCleanly = true;
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEventType = line.slice(6).trim();
            continue;
          }
          if (line.startsWith('data:')) {
            const dataStr = line.slice(5).trim();
            try {
              const event = JSON.parse(dataStr);
              const mappedEvent: AgentEvent = {
                type: currentEventType || event.type || 'unknown',
                sessionId: event.sessionId || sessionId,
                data: event.data,
                id: (event.data as Record<string, unknown>)?.id as string,
                name: (event.data as Record<string, unknown>)?.name as string,
                input: (event.data as Record<string, unknown>)?.input,
                result: (event.data as Record<string, unknown>)?.result,
                error: (event.data as Record<string, unknown>)?.error as string,
                content: (event.data as Record<string, unknown>)?.content as string,
              };
              if (mappedEvent.type === 'done' || mappedEvent.type === 'chat:done' || mappedEvent.type === 'error' || mappedEvent.type === 'chat:error') {
                terminalEventReceived = true;
              }
              this.emit(sessionId, mappedEvent);
              currentEventType = 'message';
            } catch {
              // skip invalid JSON
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('[agent-http-client] Attach cancelled:', sessionId);
      } else {
        console.error('[agent-http-client] Attach stream error:', error);
        this.emit(sessionId, {
          type: 'chat:error',
          sessionId,
          data: { message: error instanceof Error ? error.message : String(error) },
        });
      }
    } finally {
      this.abortControllers.delete(sessionId);
      if (streamEndedCleanly && !terminalEventReceived) {
        this.emit(sessionId, { type: 'stream:end', sessionId, data: {} });
      }
    }
  }

  /**
   * Query the agent server's session state. The server's `/status` endpoint
   * reports the state under `status` (see SessionStatus in agent-sse-client.ts;
   * the values are the uppercase SessionState strings, e.g. 'STREAMING').
   * Consumers compare it against 'STREAMING' to detect an in-flight run
   * started outside the renderer (e.g. a cron run kicked off by the
   * main-process scheduler) so they can attach to the live SSE stream
   * instead of showing a blank view.
   */
  async getSessionStatus(sessionId: string): Promise<{ status: string; lastEventId: number } | null> {
    const baseUrl = await this.getBaseUrl();
    if (!baseUrl) return null;

    try {
      const response = await fetch(`${baseUrl}/sessions/${sessionId}/status`);
      if (!response.ok) return null;
      const data = (await response.json()) as { status?: string; lastEventId?: number };
      if (typeof data.status !== 'string') return null;
      return { status: data.status, lastEventId: data.lastEventId ?? 0 };
    } catch {
      return null;
    }
  }

  /**
   * Fetches the persisted research snapshot row for a session.
   * Returns null when no research run exists for the session (HTTP 204)
   * or when the backend is unreachable.
   */
  async getResearchSnapshot(sessionId: string): Promise<Record<string, unknown> | null> {
    const baseUrl = await this.getBaseUrl();
    if (!baseUrl) return null;

    try {
      const response = await fetch(`${baseUrl}/api/research/snapshot/${encodeURIComponent(sessionId)}`);
      if (!response.ok || response.status === 204) return null;
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  onEvent(sessionId: string, handler: EventHandler): () => void {
    let handlers = this.eventHandlers.get(sessionId);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(sessionId, handlers);
    }
    handlers.add(handler);

    return () => {
      const h = this.eventHandlers.get(sessionId);
      if (h) {
        h.delete(handler);
        if (h.size === 0) {
          this.eventHandlers.delete(sessionId);
        }
      }
    };
  }

  private emit(sessionId: string, event: AgentEvent): void {
    // Deduplicate by (eventType + id) to avoid duplicates when SSE replays events.
    // Using id alone is incorrect: tool_use and tool_result share the same id
    // (the tool_use_id), so a tool_result would be falsely dropped as duplicate.
    const eventData = event.data as Record<string, unknown> | undefined;
    const rawId = eventData?.id as string | undefined;
    if (rawId) {
      const dedupKey = `${event.type}:${rawId}`;
      let ids = this.receivedMessageIds.get(sessionId);
      if (!ids) {
        ids = new Set();
        this.receivedMessageIds.set(sessionId, ids);
      }
      if (ids.has(dedupKey)) {
        console.log('[agent-http-client] Skipping duplicate event:', dedupKey);
        return;
      }
      ids.add(dedupKey);
    }

    const handlers = this.eventHandlers.get(sessionId);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          console.error('[agent-http-client] Handler error:', err);
        }
      }
    }
  }

  private clearMessageIds(sessionId: string): void {
    this.receivedMessageIds.delete(sessionId);
  }
}

// Singleton instance
let instance: AgentServerClient | null = null;

export function getAgentServerClient(): AgentServerClient {
  if (!instance) {
    instance = new AgentServerClient();
  }
  return instance;
}
