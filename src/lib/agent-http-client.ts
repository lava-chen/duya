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
  systemPrompt?: string;
  permissionMode?: string;
  files?: FileAttachment[];
  agentProfileId?: string | null;
  outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean };
  titleGenerationModel?: string;
  titleGenerationModelConfig?: { provider: string; apiKey: string; baseURL: string; model: string };
  providerConfig?: Record<string, unknown>;
  workingDirectory?: string;
  mode?: string;
  wikiAgentEnabled?: boolean;
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
    });

    let streamEndedCleanly = false;
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
            permissionMode: options?.permissionMode,
            files: options?.files,
            agentProfileId: options?.agentProfileId,
            outputStyleConfig: options?.outputStyleConfig,
            mode: options?.mode,
            titleGenerationModel: options?.titleGenerationModel,
            titleGenerationModelConfig: options?.titleGenerationModelConfig,
            wikiAgentEnabled: options?.wikiAgentEnabled,
          },
          providerConfig: options?.providerConfig,
          workingDirectory: options?.workingDirectory,
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
                // Use event type from SSE event line, fall back to event.type from JSON
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
                  permissionMode: options?.permissionMode,
                  files: options?.files,
                  agentProfileId: options?.agentProfileId,
                  outputStyleConfig: options?.outputStyleConfig,
                  mode: options?.mode,
                  titleGenerationModel: options?.titleGenerationModel,
                  titleGenerationModelConfig: options?.titleGenerationModelConfig,
                },
                providerConfig: options?.providerConfig,
                workingDirectory: options?.workingDirectory,
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
                    };
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
      // If SSE stream ended without a done event (e.g. client disconnect), notify the manager
      // so it can transition the session to error/completed state instead of leaving it STREAMING
      if (streamEndedCleanly) {
        console.log('[agent-http-client] SSE stream ended, emitting stream:end event');
        this.emit(sessionId, {
          type: 'stream:end',
          sessionId,
          data: {},
        });
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

  async getSessionStatus(sessionId: string): Promise<{ state: string; lastEventId: number } | null> {
    const baseUrl = await this.getBaseUrl();
    if (!baseUrl) return null;

    try {
      const response = await fetch(`${baseUrl}/sessions/${sessionId}/status`);
      if (!response.ok) return null;
      return (await response.json()) as { state: string; lastEventId: number };
    } catch {
      return null;
    }
  }

  async resolveResearchClarification(
    sessionId: string,
    requestId: string,
    answers: Record<string, string>,
  ): Promise<void> {
    const baseUrl = await this.getBaseUrl(true);
    if (!baseUrl) {
      throw new Error('Agent Server not available');
    }

    const postResolve = async (url: string): Promise<void> => {
      const endpoint = `${url}/research/clarification`;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      console.log('[agent-http-client] Resolving research request:', {
        sessionId,
        requestId,
        endpoint,
        answers,
      });

      let response: Response;
      try {
        response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId,
          requestId,
          answers,
        }),
          signal: controller.signal,
        });
      } finally {
        window.clearTimeout(timeout);
      }

      console.log('[agent-http-client] Research resolve response:', {
        status: response.status,
        ok: response.ok,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to resolve research request: ${response.status} ${errorText}`);
      }
    };

    try {
      await postResolve(baseUrl);
    } catch (error) {
      const refreshed = await this.getBaseUrl(true);
      if (refreshed && refreshed !== baseUrl) {
        await postResolve(refreshed);
        return;
      }
      throw error;
    }
  }

  async getResearchSnapshot(sessionId: string): Promise<Record<string, unknown> | null> {
    const baseUrl = await this.getBaseUrl();
    if (!baseUrl) return null;

    try {
      const response = await fetch(`${baseUrl}/research/snapshot/${sessionId}`);
      if (!response.ok) return null;
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
