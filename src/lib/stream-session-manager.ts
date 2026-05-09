// stream-session-manager.ts - Client-side actor manager for chat sessions
//
// This module provides a unified interface for chat streaming.
// It automatically selects between MessagePort (preferred) and SSE (fallback)
// based on what's available in the environment.
//
// MessagePort is used when:
// - Running in Electron (window.electronAPI?.getAgentPort() is available)
// - Provides lower latency and direct IPC communication
//
// SSE is used as fallback when:
// - MessagePort is not available
// - For development or external API access

import type { SessionStreamSnapshot, ToolUseInfo, ToolResultInfo, TokenUsage, ContextUsage, StreamPhase } from '@/types/message';
import type { PermissionRequestEvent } from '@/types/stream';
import { STREAM_IDLE_TIMEOUT_MS } from './constants';
import { showMessageCompletionNotification } from './notification';

const ACTIVE_PHASES: StreamPhase[] = ['starting', 'streaming', 'awaiting_permission', 'persisting'];

interface PersistEvent {
  success: boolean;
  reason?: string;
  generation: number;
  messageCount: number;
  streamId?: string;
}

export interface FileAttachment {
  id: string;
  name: string;
  type: string;
  url: string;
  size: number;
}

interface StartStreamParams {
  sessionId: string;
  content: string;
  model?: string;
  maxTokens?: number;
  systemPrompt?: string;
  initialGeneration?: number;
  permissionMode?: string;
  files?: FileAttachment[];
  agentProfileId?: string | null;
  outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean };
}

interface StartStreamResult {
  streamId: string;
  generation: number;
}

// Field-based listeners for granular subscriptions
type FieldListeners = {
  text: Set<(text: string) => void>;
  thinking: Set<(thinking: string) => void>;
  tools: Set<(tools: { uses: ToolUseInfo[]; results: ToolResultInfo[] }) => void>;
  phase: Set<(phase: StreamPhase) => void>;
  statusText: Set<(statusText: string | undefined) => void>;
  contextUsage: Set<(usage: ContextUsage | null) => void>;
  tokenUsage: Set<(usage: TokenUsage | null) => void>;
  toolOutput: Set<(output: string) => void>;
  toolProgress: Set<(info: { toolName: string; elapsedSeconds: number } | null) => void>;
  toolTimeout: Set<(info: { toolName: string; elapsedSeconds: number } | null) => void>;
  agentProgress: Set<(event: AgentProgressEvent) => void>;
  error: Set<(error: string | null) => void>;
  completedAt: Set<(at: number | null) => void>;
  dbPersisted: Set<(event: SessionStreamSnapshot['dbPersisted']) => void>;
  retry: Set<(info: { attempt: number; maxAttempts: number; delayMs: number; message: string }) => void>;
};

/** Sub-agent progress event */
export interface AgentProgressEvent {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'done' | 'error';
  data?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  duration?: number;
  receivedAt?: number;
  agentId?: string;
  agentType?: string;
  agentName?: string;
  agentDescription?: string;
  sessionId?: string;
}

/** Ordered streaming event for chronological rendering */
export type StreamingEvent =
  | { type: 'text'; content: string; timestamp: number }
  | { type: 'thinking'; content: string; timestamp: number }
  | { type: 'tool_use'; toolUse: ToolUseInfo; timestamp: number }
  | { type: 'tool_result'; toolResult: ToolResultInfo; timestamp: number }
  | { type: 'viz'; content: string; isPartial: boolean; timestamp: number };

interface SessionState {
  sessionId: string;
  currentStreamId: string | null;
  generation: number;
  abortController: AbortController | null;
  // Flattened fields instead of single snapshot
  phase: StreamPhase;
  streamId: string | null;
  streamingText: string;
  streamingThinking: string;
  toolUses: ToolUseInfo[];
  toolResults: ToolResultInfo[];
  streamingToolOutput: string;
  statusText: string | undefined;
  tokenUsage: TokenUsage | null;
  contextUsage: ContextUsage | null;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  finalMessageContent: string | null;
  toolTimeoutInfo: { toolName: string; elapsedSeconds: number } | null;
  toolProgressInfo: { toolName: string; elapsedSeconds: number } | null;
  dbPersisted: SessionStreamSnapshot['dbPersisted'];
  agentProgressEvents: AgentProgressEvent[];
  streamingEvents: StreamingEvent[];
  pendingPermissionRequest: PermissionRequestEvent | null;
  // Listeners
  listeners: Set<(snapshot: SessionStreamSnapshot) => void>;
  fieldListeners: FieldListeners;
  streamingEventsListeners: Set<(events: StreamingEvent[]) => void>;
  permissionListeners: Set<(request: PermissionRequestEvent) => void>;
  dbPersistedListeners: Set<(event: PersistEvent) => void>;
  idleTimeout: ReturnType<typeof setTimeout> | null;
  textEmitTimeout: ReturnType<typeof setTimeout> | number | null;
  pendingTextEmit: string;
  sendRetryMessage: ((content: string) => void) | null;
}

function createInitialState(sessionId: string): Omit<SessionState, 'listeners' | 'fieldListeners' | 'streamingEventsListeners' | 'permissionListeners' | 'dbPersistedListeners' | 'idleTimeout' | 'textEmitTimeout' | 'pendingTextEmit' | 'sendRetryMessage'> {
  return {
    sessionId,
    currentStreamId: null,
    generation: 0,
    abortController: null,
    phase: 'idle',
    streamId: null,
    streamingText: '',
    streamingThinking: '',
    toolUses: [],
    toolResults: [],
    streamingToolOutput: '',
    statusText: undefined,
    tokenUsage: null,
    contextUsage: null,
    startedAt: Date.now(),
    completedAt: null,
    error: null,
    finalMessageContent: null,
    toolTimeoutInfo: null,
    toolProgressInfo: null,
    dbPersisted: undefined,
    agentProgressEvents: [],
    streamingEvents: [],
    pendingPermissionRequest: null,
  };
}

function buildSnapshot(state: SessionState): SessionStreamSnapshot {
  return {
    sessionId: state.sessionId,
    phase: state.phase,
    streamId: state.streamId,
    generation: state.generation,
    streamingContent: state.streamingText,
    streamingThinkingContent: state.streamingThinking,
    toolUses: state.toolUses,
    toolResults: state.toolResults,
    streamingToolOutput: state.streamingToolOutput,
    statusText: state.statusText,
    tokenUsage: state.tokenUsage,
    contextUsage: state.contextUsage,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    error: state.error,
    finalMessageContent: state.finalMessageContent,
    toolTimeoutInfo: state.toolTimeoutInfo,
    toolProgressInfo: state.toolProgressInfo,
    dbPersisted: state.dbPersisted,
  };
}

function isActivePhase(phase: StreamPhase): boolean {
  return ACTIVE_PHASES.includes(phase);
}

class StreamSessionManager {
  private sessions: Map<string, SessionState> = new Map();
  private textEmitInterval = 300; // Increased from 100ms to reduce UI flickering
  private idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS;
  private debugIpc = typeof process !== 'undefined' && process.env?.DUYA_DEBUG_IPC === 'true';

  private debugLog(...args: unknown[]): void {
    if (this.debugIpc) {
      console.log('[stream-session-manager][DEBUG]', ...args);
    }
  }

  private createFieldListeners(): FieldListeners {
    return {
      text: new Set(),
      thinking: new Set(),
      tools: new Set(),
      phase: new Set(),
      statusText: new Set(),
      contextUsage: new Set(),
      tokenUsage: new Set(),
      toolOutput: new Set(),
      toolProgress: new Set(),
      toolTimeout: new Set(),
      agentProgress: new Set(),
      error: new Set(),
      completedAt: new Set(),
      dbPersisted: new Set(),
      retry: new Set(),
    };
  }

  ensureSession(sessionId: string): SessionStreamSnapshot {
    let state = this.sessions.get(sessionId);
    if (!state) {
      const initialGeneration = 0;
      const base = createInitialState(sessionId);
      state = {
        ...base,
        generation: initialGeneration,
        listeners: new Set(),
        fieldListeners: this.createFieldListeners(),
        streamingEventsListeners: new Set(),
        permissionListeners: new Set(),
        dbPersistedListeners: new Set(),
        idleTimeout: null,
        textEmitTimeout: null,
        pendingTextEmit: '',
        sendRetryMessage: null,
      };
      this.sessions.set(sessionId, state);
    }
    return buildSnapshot(state);
  }

  async startStream(params: StartStreamParams): Promise<StartStreamResult> {
    const { sessionId, content, model, maxTokens, systemPrompt, initialGeneration, permissionMode, files, agentProfileId, outputStyleConfig } = params;
    const state = this.getOrCreateState(sessionId);

    if (state.abortController && isActivePhase(state.phase)) {
      try {
        state.abortController.abort();
      } catch {
        // ignore
      }
    }

    const streamId = crypto.randomUUID();
    const nextGeneration =
      typeof initialGeneration === 'number'
        ? Math.max(initialGeneration, state.generation)
        : state.generation;

    state.currentStreamId = streamId;
    state.generation = nextGeneration;
    state.abortController = new AbortController();
    state.pendingTextEmit = '';
    state.phase = 'starting';
    state.streamId = streamId;
    state.streamingText = '';
    state.streamingThinking = '';
    state.toolUses = [];
    state.toolResults = [];
    state.streamingToolOutput = '';
    state.statusText = undefined;
    state.tokenUsage = null;
    state.contextUsage = null;
    state.startedAt = Date.now();
    state.completedAt = null;
    state.error = null;
    state.finalMessageContent = null;
    state.toolTimeoutInfo = null;
    state.toolProgressInfo = null;
    state.dbPersisted = undefined;
    state.agentProgressEvents = [];
    state.streamingEvents = [];
    state.pendingPermissionRequest = null;

    this.notifyListeners(sessionId);
    this.notifyStreamingEventsListeners(sessionId);
    this.notifyPhaseListeners(sessionId, state.phase);
    this.notifyTextListeners(sessionId, state.streamingText);
    this.notifyThinkingListeners(sessionId, state.streamingThinking);
    this.notifyToolListeners(sessionId);
    this.notifyStatusTextListeners(sessionId, state.statusText);
    this.notifyContextUsageListeners(sessionId, state.contextUsage);
    this.notifyTokenUsageListeners(sessionId, state.tokenUsage);
    this.notifyToolOutputListeners(sessionId, state.streamingToolOutput);
    this.notifyToolProgressListeners(sessionId, state.toolProgressInfo);
    this.notifyToolTimeoutListeners(sessionId, state.toolTimeoutInfo);
    this.notifyErrorListeners(sessionId, state.error);
    this.notifyCompletedAtListeners(sessionId, state.completedAt);
    this.resetIdleTimeout(sessionId);

    // Always use MessagePort for streaming
    void this.startStreamViaMessagePort(
      sessionId,
      streamId,
      { content, model, maxTokens, systemPrompt, permissionMode, files, agentProfileId, outputStyleConfig },
      nextGeneration
    );

    return { streamId, generation: nextGeneration };
  }

  private async startStreamViaMessagePort(
    sessionId: string,
    streamId: string,
    params: {
      content: string;
      model?: string;
      maxTokens?: number;
      systemPrompt?: string;
      permissionMode?: string;
      files?: FileAttachment[];
      agentProfileId?: string | null;
      outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean };
    },
    generation: number
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || !state.abortController) return;

    if (!this.isCurrentStream(sessionId, streamId)) {
      return;
    }

    // Wait for agentPort to be available (with timeout)
    let api = window.electronAPI?.getAgentPort?.();
    const portStatus = window.electronAPI?.portStatus;
    
    if (!api && portStatus) {
      const isReady = portStatus.isAgentPortReady();
      if (!isReady) {
        await portStatus.waitForAgentPort(5000);
      }
    }

    // Final check - call getAgentPort() again after waiting
    api = window.electronAPI?.getAgentPort?.();
    if (!api) {
      console.error('[stream-session-manager] Agent port not available');
      state.phase = 'error';
      state.error = 'Agent port not available';
      state.completedAt = Date.now();
      this.notifyListeners(sessionId);
      this.notifyPhaseListeners(sessionId, state.phase);
      this.notifyErrorListeners(sessionId, state.error);
      this.notifyCompletedAtListeners(sessionId, state.completedAt);
      return;
    }

    // Clean up previous handlers
    const existingCleanup = this.messagePortCleanup.get(sessionId);
    if (existingCleanup) {
      existingCleanup();
    }

    // Register event handlers for MessagePort
    const cleanups: (() => void)[] = [];

    cleanups.push(api.onText((text, eventSessionId) => {
      if (eventSessionId && eventSessionId !== sessionId) return;
      const s = this.sessions.get(sessionId);
      if (!s || !this.isCurrentStream(sessionId, streamId)) return;
      if (s.phase === 'starting') {
        s.phase = 'streaming';
        this.notifyPhaseListeners(sessionId, s.phase);
      } else if (s.phase === 'awaiting_permission') {
        s.phase = 'streaming';
        s.pendingPermissionRequest = null;
        this.notifyPhaseListeners(sessionId, s.phase);
      }
      // Immediate text emission for true character-by-character streaming
      s.streamingText += text;
      s.finalMessageContent = s.streamingText;
      // Append to ordered streaming events
      const lastEvent = s.streamingEvents[s.streamingEvents.length - 1];
      if (lastEvent && lastEvent.type === 'text') {
        lastEvent.content += text;
      } else {
        s.streamingEvents = [...s.streamingEvents, { type: 'text', content: text, timestamp: Date.now() }];
      }
      this.notifyTextListeners(sessionId, s.streamingText);
      this.notifyStreamingEventsListeners(sessionId);
      this.notifyListeners(sessionId);
      this.resetIdleTimeout(sessionId);
    }));

    cleanups.push(api.onThinking((text, eventSessionId) => {
      if (eventSessionId && eventSessionId !== sessionId) return;
      const s = this.sessions.get(sessionId);
      if (!s || !this.isCurrentStream(sessionId, streamId)) return;
      s.streamingThinking = (s.streamingThinking || '') + text;
      // Append to ordered streaming events
      const lastEvent = s.streamingEvents[s.streamingEvents.length - 1];
      if (lastEvent && lastEvent.type === 'thinking') {
        lastEvent.content += text;
      } else {
        s.streamingEvents = [...s.streamingEvents, { type: 'thinking', content: text, timestamp: Date.now() }];
      }
      this.notifyThinkingListeners(sessionId, s.streamingThinking);
      this.notifyStreamingEventsListeners(sessionId);
      this.resetIdleTimeout(sessionId);
    }));

    cleanups.push(api.onToolUse((data, eventSessionId) => {
      if (eventSessionId && eventSessionId !== sessionId) return;
      const s = this.sessions.get(sessionId);
      if (!s || !this.isCurrentStream(sessionId, streamId)) return;
      if (s.phase === 'awaiting_permission') {
        s.phase = 'streaming';
        s.pendingPermissionRequest = null;
        this.notifyPhaseListeners(sessionId, s.phase);
      }
      const toolUse: ToolUseInfo = {
        id: data.id,
        name: data.name,
        input: data.input,
      };
      s.toolUses = [...s.toolUses, toolUse];
      s.streamingEvents = [...s.streamingEvents, { type: 'tool_use', toolUse, timestamp: Date.now() }];

      if (data.name === 'show_widget') {
        const widgetCode = (data.input as Record<string, unknown>)?.widget_code;
        if (typeof widgetCode === 'string') {
          s.streamingEvents = [...s.streamingEvents, {
            type: 'viz',
            content: widgetCode,
            isPartial: true,
            timestamp: Date.now(),
          }];
        }
      }
      this.notifyToolListeners(sessionId);
      this.notifyStreamingEventsListeners(sessionId);
      this.resetIdleTimeout(sessionId);
    }));

    cleanups.push(api.onToolResult((data, eventSessionId) => {
      if (eventSessionId && eventSessionId !== sessionId) return;
      const s = this.sessions.get(sessionId);
      if (!s || !this.isCurrentStream(sessionId, streamId)) return;
      if (s.phase === 'awaiting_permission') {
        s.phase = 'streaming';
        s.pendingPermissionRequest = null;
        this.notifyPhaseListeners(sessionId, s.phase);
      }
      const result: ToolResultInfo = {
        tool_use_id: data.id,
        content: String(data.result),
        is_error: !!data.error,
      };
      s.toolResults = [...s.toolResults, result];
      s.streamingEvents = [...s.streamingEvents, { type: 'tool_result', toolResult: result, timestamp: Date.now() }];
      this.notifyToolListeners(sessionId);
      this.notifyStreamingEventsListeners(sessionId);
      this.resetIdleTimeout(sessionId);
    }));

    cleanups.push(api.onToolProgress((data, eventSessionId) => {
      if (eventSessionId && eventSessionId !== sessionId) return;
      const s = this.sessions.get(sessionId);
      if (!s || !this.isCurrentStream(sessionId, streamId)) return;
      s.toolProgressInfo = { toolName: data.toolUseId, elapsedSeconds: 0 };
      this.notifyToolProgressListeners(sessionId, s.toolProgressInfo);
      this.resetIdleTimeout(sessionId);
    }));

    cleanups.push(api.onToolOutput((data, eventSessionId) => {
      if (eventSessionId && eventSessionId !== sessionId) return;
      const s = this.sessions.get(sessionId);
      if (!s || !this.isCurrentStream(sessionId, streamId)) return;
      s.streamingToolOutput = (s.streamingToolOutput || '') + data.data;
      this.notifyToolOutputListeners(sessionId, s.streamingToolOutput);
      this.resetIdleTimeout(sessionId);
    }));

    cleanups.push(api.onAgentProgress((data, eventSessionId) => {
      if (eventSessionId && eventSessionId !== sessionId) return;
      const s = this.sessions.get(sessionId);
      if (!s || !this.isCurrentStream(sessionId, streamId)) return;
      this.debugLog('agent_progress', {
        sessionId,
        streamId,
        agentEventType: data.agentEventType,
        toolName: data.toolName,
        hasToolInput: !!data.toolInput,
        hasToolResult: !!data.toolResult,
        duration: data.duration,
      });
      const event: AgentProgressEvent = {
        type: (data.agentEventType as AgentProgressEvent['type']) || ('done' as AgentProgressEvent['type']),
        data: data.data,
        toolName: data.toolName,
        toolInput: data.toolInput,
        toolResult: data.toolResult,
        duration: data.duration,
        receivedAt: Date.now(),
        agentId: data.agentId,
        agentType: data.agentType,
        agentName: data.agentName,
        agentDescription: data.agentDescription,
        sessionId: data.agentSessionId,
      };
      s.agentProgressEvents = [...s.agentProgressEvents, event];
      this.notifyAgentProgressListeners(sessionId, event);

      if (data.agentSessionId && data.agentSessionId !== sessionId) {
        const subState = this.getOrCreateState(data.agentSessionId);
        const isNewSubState = subState.agentProgressEvents.length === 0;
        subState.agentProgressEvents = [...subState.agentProgressEvents, event];
        this.notifyAgentProgressListeners(data.agentSessionId, event);

        if (isNewSubState) {
          try {
            const { useConversationStore } = require('@/stores/conversation-store');
            const store = useConversationStore.getState();
            const newExpanded = new Set(store.expandedThreads);
            if (!newExpanded.has(sessionId)) {
              newExpanded.add(sessionId);
              useConversationStore.setState({ expandedThreads: newExpanded });
            }
          } catch {
            // non-critical
          }
        }

        const eventType = data.agentEventType as string;
        if (eventType === 'text' && data.data) {
          subState.streamingText = (subState.streamingText || '') + data.data;
          subState.finalMessageContent = subState.streamingText;
          const lastEvent = subState.streamingEvents[subState.streamingEvents.length - 1];
          if (lastEvent && lastEvent.type === 'text') {
            lastEvent.content += data.data;
          } else {
            subState.streamingEvents = [...subState.streamingEvents, { type: 'text', content: data.data, timestamp: Date.now() }];
          }
          this.notifyTextListeners(data.agentSessionId, subState.streamingText);
          this.notifyStreamingEventsListeners(data.agentSessionId);
        } else if (eventType === 'thinking' && data.data) {
          subState.streamingThinking = (subState.streamingThinking || '') + data.data;
          const lastEvent = subState.streamingEvents[subState.streamingEvents.length - 1];
          if (lastEvent && lastEvent.type === 'thinking') {
            lastEvent.content += data.data;
          } else {
            subState.streamingEvents = [...subState.streamingEvents, { type: 'thinking', content: data.data, timestamp: Date.now() }];
          }
          this.notifyThinkingListeners(data.agentSessionId, subState.streamingThinking);
          this.notifyStreamingEventsListeners(data.agentSessionId);
        } else if (eventType === 'tool_use' && data.toolName) {
          const toolUse: ToolUseInfo = {
            id: crypto.randomUUID(),
            name: data.toolName,
            input: data.toolInput || {},
          };
          subState.toolUses = [...subState.toolUses, toolUse];
          subState.streamingEvents = [...subState.streamingEvents, { type: 'tool_use', toolUse, timestamp: Date.now() }];
          this.notifyToolListeners(data.agentSessionId);
          this.notifyStreamingEventsListeners(data.agentSessionId);
        } else if (eventType === 'tool_result' && data.toolName) {
          const result: ToolResultInfo = {
            tool_use_id: crypto.randomUUID(),
            content: data.toolResult || '',
            is_error: false,
          };
          subState.toolResults = [...subState.toolResults, result];
          subState.streamingEvents = [...subState.streamingEvents, { type: 'tool_result', toolResult: result, timestamp: Date.now() }];
          this.notifyToolListeners(data.agentSessionId);
          this.notifyStreamingEventsListeners(data.agentSessionId);
        } else if (eventType === 'done') {
          subState.phase = 'completed';
          subState.completedAt = Date.now();
          this.notifyPhaseListeners(data.agentSessionId, subState.phase);
          this.notifyCompletedAtListeners(data.agentSessionId, subState.completedAt);
        } else if (eventType === 'error') {
          subState.phase = 'error';
          subState.error = data.data || 'Sub-agent error';
          subState.completedAt = Date.now();
          this.notifyPhaseListeners(data.agentSessionId, subState.phase);
          this.notifyErrorListeners(data.agentSessionId, subState.error);
          this.notifyCompletedAtListeners(data.agentSessionId, subState.completedAt);
        }

        if (subState.phase === 'idle') {
          subState.phase = 'streaming';
          this.notifyPhaseListeners(data.agentSessionId, subState.phase);
        }
      }

      this.resetIdleTimeout(sessionId);
    }));

    cleanups.push(api.onStatus((message, eventSessionId) => {
      if (eventSessionId && eventSessionId !== sessionId) return;
      const s = this.sessions.get(sessionId);
      if (!s || !this.isCurrentStream(sessionId, streamId)) return;
      s.statusText = message;
      this.notifyStatusTextListeners(sessionId, s.statusText);
      this.resetIdleTimeout(sessionId);
    }));

    cleanups.push(api.onPermission((request, eventSessionId) => {
      if (eventSessionId && eventSessionId !== sessionId) return;
      const s = this.sessions.get(sessionId);
      if (!s || !this.isCurrentStream(sessionId, streamId)) return;
      s.phase = 'awaiting_permission';
      this.notifyPhaseListeners(sessionId, s.phase);
      const event: PermissionRequestEvent = {
        ...request,
        mode: 'generic',
        expiresAt: Date.now() + 60000,
      };
      s.pendingPermissionRequest = event;
      s.permissionListeners.forEach((listener) => {
        try {
          listener(event);
        } catch (error) {
          console.error(`[stream-session-manager] Permission listener error for ${sessionId}:`, error);
        }
      });
      this.resetIdleTimeout(sessionId);
    }));

    cleanups.push(api.onContextUsage((data, eventSessionId) => {
      if (eventSessionId && eventSessionId !== sessionId) return;
      const s = this.sessions.get(sessionId);
      if (!s || !this.isCurrentStream(sessionId, streamId)) return;
      const contextUsage: ContextUsage = {
        usedTokens: data.usedTokens,
        contextWindow: data.contextWindow,
        percentFull: data.percentFull,
      };
      s.contextUsage = contextUsage;
      this.notifyContextUsageListeners(sessionId, s.contextUsage);
      this.resetIdleTimeout(sessionId);
    }));

    cleanups.push(api.onDone((eventSessionId) => {
      if (eventSessionId && eventSessionId !== sessionId) return;
      const s = this.sessions.get(sessionId);
      if (!s || !this.isCurrentStream(sessionId, streamId)) return;
      s.phase = 'completed';
      s.pendingPermissionRequest = null;
      s.completedAt = Date.now();
      this.notifyPhaseListeners(sessionId, s.phase);
      this.notifyCompletedAtListeners(sessionId, s.completedAt);
      this.flushPendingText(sessionId, streamId);
      this.clearIdleTimeout(sessionId);
      // Show system notification when message completes
      showMessageCompletionNotification().catch(() => {
        // Ignore notification errors
      });
      setTimeout(() => {
        const s2 = this.sessions.get(sessionId);
        if (s2 && s2.phase === 'completed' && !s2.dbPersisted?.success) {
          s2.phase = 'idle';
          this.notifyPhaseListeners(sessionId, s2.phase);
          this.notifyListeners(sessionId);
        }
        this.cleanupMessagePort(sessionId);
      }, 5000);
    }));

    cleanups.push(api.onError((message, eventSessionId) => {
      if (eventSessionId && eventSessionId !== sessionId) return;
      const s = this.sessions.get(sessionId);
      if (!s || !this.isCurrentStream(sessionId, streamId)) return;
      s.phase = 'error';
      s.pendingPermissionRequest = null;
      s.error = message;
      s.completedAt = Date.now();
      this.notifyPhaseListeners(sessionId, s.phase);
      this.notifyErrorListeners(sessionId, s.error);
      this.notifyCompletedAtListeners(sessionId, s.completedAt);
      this.notifyListeners(sessionId);
      this.clearIdleTimeout(sessionId);
      setTimeout(() => {
        this.cleanupMessagePort(sessionId);
      }, 3000);
    }));

    cleanups.push(api.onDbPersisted((data, eventSessionId) => {
      if (eventSessionId && eventSessionId !== sessionId) return;
      if (data.sessionId && data.sessionId !== sessionId) return;
      const s = this.sessions.get(sessionId);
      if (!s || !this.isCurrentStream(sessionId, streamId)) {
        return;
      }
      const dbPersisted = {
        success: data.success,
        reason: data.reason,
        generation: 0,
        messageCount: data.messageCount,
        streamId,
      };
      s.dbPersisted = dbPersisted;
      if (data.success && s.phase === 'completed') {
        s.phase = 'idle';
        this.notifyPhaseListeners(sessionId, s.phase);
      }
      this.notifyDbPersistedListeners(sessionId, s.dbPersisted);
      this.notifyListeners(sessionId);
      s.dbPersistedListeners.forEach((listener) => {
        try {
          listener({
            success: data.success,
            reason: data.reason,
            generation: 0,
            messageCount: data.messageCount,
            streamId,
          });
        } catch (error) {
          console.error(`[stream-session-manager] dbPersisted listener error for ${sessionId}:`, error);
        }
      });
    }));

    cleanups.push(api.onTokenUsage((data, eventSessionId) => {
      if (eventSessionId && eventSessionId !== sessionId) return;
      const s = this.sessions.get(sessionId);
      if (!s || !this.isCurrentStream(sessionId, streamId)) return;
      s.tokenUsage = {
        input_tokens: data.inputTokens,
        output_tokens: data.outputTokens,
        total_tokens: data.inputTokens + data.outputTokens,
      };
      this.notifyTokenUsageListeners(sessionId, s.tokenUsage);
    }));

    cleanups.push(api.onRetry((data, eventSessionId) => {
      if (eventSessionId && eventSessionId !== sessionId) return;
      const s = this.sessions.get(sessionId);
      if (!s || !this.isCurrentStream(sessionId, streamId)) return;
      this.notifyRetryListeners(sessionId, {
        attempt: data.attempt,
        maxAttempts: data.maxAttempts,
        delayMs: data.delayMs,
        message: data.message,
      });
    }));

    cleanups.push(api.onTitleGenerated((data, eventSessionId) => {
      if (eventSessionId && eventSessionId !== sessionId) return;
      // Update conversation store with generated title
      const { useConversationStore } = require('@/stores/conversation-store');
      const store = useConversationStore.getState();
      if (store.threads.find((t: { id: string }) => t.id === sessionId)) {
        store.updateThreadTitle(sessionId, data.title);
      }
    }));

    // Store cleanup function
    this.messagePortCleanup.set(sessionId, () => {
      cleanups.forEach(cleanup => cleanup());
    });

    // Start chat via MessagePort
    this.debugLog('startChat', { sessionId, streamId, generation, promptLength: params.content.length });
    api.startChat(sessionId, params.content, {
      model: params.model,
      maxTokens: params.maxTokens,
      systemPrompt: params.systemPrompt,
      permissionMode: params.permissionMode,
      files: params.files,
      agentProfileId: params.agentProfileId,
      outputStyleConfig: params.outputStyleConfig,
    });
  }

  private messagePortCleanup: Map<string, () => void> = new Map();

  private cleanupMessagePort(sessionId: string): void {
    const cleanup = this.messagePortCleanup.get(sessionId);
    if (cleanup) {
      cleanup();
      this.messagePortCleanup.delete(sessionId);
    }
  }

  async stopStream(sessionId: string, reason?: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    if (state.abortController) {
      state.abortController.abort();
      state.abortController = null;
    }
    state.phase = 'aborted';
    state.error = reason || null;
    state.completedAt = Date.now();

    // Clean up MessagePort listeners to prevent stale listeners
    this.cleanupMessagePort(sessionId);

    this.clearIdleTimeout(sessionId);
    this.flushPendingText(sessionId, state.currentStreamId || '');
    this.notifyPhaseListeners(sessionId, state.phase);
    this.notifyErrorListeners(sessionId, state.error);
    this.notifyCompletedAtListeners(sessionId, state.completedAt);
    this.notifyListeners(sessionId);
  }

  canSend(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    if (!state) return true;
    return !isActivePhase(state.phase);
  }

  // Legacy full-snapshot subscription (backward compatible)
  subscribe(
    sessionId: string,
    listener: (snapshot: SessionStreamSnapshot) => void
  ): () => void {
    const state = this.getOrCreateState(sessionId);
    state.listeners.add(listener);
    listener(buildSnapshot(state));
    return () => {
      state.listeners.delete(listener);
    };
  }

  subscribeSession(
    sessionId: string,
    listener: (snapshot: SessionStreamSnapshot) => void
  ): () => void {
    return this.subscribe(sessionId, listener);
  }

  // Field-based subscriptions
  subscribeToText(sessionId: string, listener: (text: string) => void): () => void {
    const state = this.getOrCreateState(sessionId);
    state.fieldListeners.text.add(listener);
    listener(state.streamingText);
    return () => { state.fieldListeners.text.delete(listener); };
  }

  subscribeToThinking(sessionId: string, listener: (thinking: string) => void): () => void {
    const state = this.getOrCreateState(sessionId);
    state.fieldListeners.thinking.add(listener);
    listener(state.streamingThinking);
    return () => { state.fieldListeners.thinking.delete(listener); };
  }

  subscribeToTools(
    sessionId: string,
    listener: (tools: { uses: ToolUseInfo[]; results: ToolResultInfo[] }) => void
  ): () => void {
    const state = this.getOrCreateState(sessionId);
    state.fieldListeners.tools.add(listener);
    listener({ uses: state.toolUses, results: state.toolResults });
    return () => { state.fieldListeners.tools.delete(listener); };
  }

  subscribeToPhase(sessionId: string, listener: (phase: StreamPhase) => void): () => void {
    const state = this.getOrCreateState(sessionId);
    state.fieldListeners.phase.add(listener);
    listener(state.phase);
    return () => { state.fieldListeners.phase.delete(listener); };
  }

  subscribeToStatusText(sessionId: string, listener: (statusText: string | undefined) => void): () => void {
    const state = this.getOrCreateState(sessionId);
    state.fieldListeners.statusText.add(listener);
    listener(state.statusText);
    return () => { state.fieldListeners.statusText.delete(listener); };
  }

  subscribeToContextUsage(sessionId: string, listener: (usage: ContextUsage | null) => void): () => void {
    const state = this.getOrCreateState(sessionId);
    state.fieldListeners.contextUsage.add(listener);
    listener(state.contextUsage);
    return () => { state.fieldListeners.contextUsage.delete(listener); };
  }

  subscribeToTokenUsage(sessionId: string, listener: (usage: TokenUsage | null) => void): () => void {
    const state = this.getOrCreateState(sessionId);
    state.fieldListeners.tokenUsage.add(listener);
    listener(state.tokenUsage);
    return () => { state.fieldListeners.tokenUsage.delete(listener); };
  }

  subscribeToToolOutput(sessionId: string, listener: (output: string) => void): () => void {
    const state = this.getOrCreateState(sessionId);
    state.fieldListeners.toolOutput.add(listener);
    listener(state.streamingToolOutput);
    return () => { state.fieldListeners.toolOutput.delete(listener); };
  }

  subscribeToToolProgress(sessionId: string, listener: (info: { toolName: string; elapsedSeconds: number } | null) => void): () => void {
    const state = this.getOrCreateState(sessionId);
    state.fieldListeners.toolProgress.add(listener);
    listener(state.toolProgressInfo);
    return () => { state.fieldListeners.toolProgress.delete(listener); };
  }

  subscribeToToolTimeout(sessionId: string, listener: (info: { toolName: string; elapsedSeconds: number } | null) => void): () => void {
    const state = this.getOrCreateState(sessionId);
    state.fieldListeners.toolTimeout.add(listener);
    listener(state.toolTimeoutInfo);
    return () => { state.fieldListeners.toolTimeout.delete(listener); };
  }

  subscribeToAgentProgress(sessionId: string, listener: (event: AgentProgressEvent) => void): () => void {
    const state = this.getOrCreateState(sessionId);
    state.fieldListeners.agentProgress.add(listener);
    state.agentProgressEvents.forEach((event) => {
      try {
        listener(event);
      } catch (e) {
        console.error(e);
      }
    });
    return () => { state.fieldListeners.agentProgress.delete(listener); };
  }

  getAgentProgressHistory(sessionId: string): AgentProgressEvent[] {
    const state = this.getOrCreateState(sessionId);
    return [...state.agentProgressEvents];
  }

  subscribeToError(sessionId: string, listener: (error: string | null) => void): () => void {
    const state = this.getOrCreateState(sessionId);
    state.fieldListeners.error.add(listener);
    listener(state.error);
    return () => { state.fieldListeners.error.delete(listener); };
  }

  subscribeToCompletedAt(sessionId: string, listener: (at: number | null) => void): () => void {
    const state = this.getOrCreateState(sessionId);
    state.fieldListeners.completedAt.add(listener);
    listener(state.completedAt);
    return () => { state.fieldListeners.completedAt.delete(listener); };
  }

  subscribeToDbPersistedField(sessionId: string, listener: (event: SessionStreamSnapshot['dbPersisted']) => void): () => void {
    const state = this.getOrCreateState(sessionId);
    state.fieldListeners.dbPersisted.add(listener);
    listener(state.dbPersisted);
    return () => { state.fieldListeners.dbPersisted.delete(listener); };
  }

  subscribeToRetry(sessionId: string, listener: (info: { attempt: number; maxAttempts: number; delayMs: number; message: string }) => void): () => void {
    const state = this.getOrCreateState(sessionId);
    state.fieldListeners.retry.add(listener);
    return () => { state.fieldListeners.retry.delete(listener); };
  }

  subscribeToPermissions(
    sessionId: string,
    listener: (request: PermissionRequestEvent) => void
  ): () => void {
    const state = this.getOrCreateState(sessionId);
    state.permissionListeners.add(listener);
    if (state.pendingPermissionRequest) {
      try {
        listener(state.pendingPermissionRequest);
      } catch (error) {
        console.error(`[stream-session-manager] Permission listener immediate replay error for ${sessionId}:`, error);
      }
    }
    return () => {
      state.permissionListeners.delete(listener);
    };
  }

  subscribeToDbPersisted(
    sessionId: string,
    listener: (event: PersistEvent) => void
  ): () => void {
    const state = this.getOrCreateState(sessionId);
    state.dbPersistedListeners.add(listener);
    return () => {
      state.dbPersistedListeners.delete(listener);
    };
  }

  subscribeToStreamingEvents(sessionId: string, listener: (events: StreamingEvent[]) => void): () => void {
    const state = this.getOrCreateState(sessionId);
    state.streamingEventsListeners.add(listener);
    listener(state.streamingEvents);
    return () => { state.streamingEventsListeners.delete(listener); };
  }

  getSnapshot(sessionId: string): SessionStreamSnapshot | null {
    const state = this.sessions.get(sessionId);
    return state ? buildSnapshot(state) : null;
  }

  setToolTimeoutCallback(sessionId: string, callback: (content: string) => void): void {
    const state = this.getOrCreateState(sessionId);
    state.sendRetryMessage = callback;
  }

  private getOrCreateState(sessionId: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const base = createInitialState(sessionId);
    const state: SessionState = {
      ...base,
      listeners: new Set(),
      fieldListeners: this.createFieldListeners(),
      streamingEventsListeners: new Set(),
      permissionListeners: new Set(),
      dbPersistedListeners: new Set(),
      idleTimeout: null,
      textEmitTimeout: null,
      pendingTextEmit: '',
      sendRetryMessage: null,
    };

    this.sessions.set(sessionId, state);
    return state;
  }

  // Legacy full snapshot notification
  private notifyListeners(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const snapshot = buildSnapshot(state);
    state.listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (error) {
        console.error(`[stream-session-manager] Listener error for ${sessionId}:`, error);
      }
    });
  }

  // Field-specific notifications
  private notifyTextListeners(sessionId: string, text: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.fieldListeners.text.forEach((listener) => {
      try { listener(text); } catch (e) { console.error(e); }
    });
  }

  private notifyThinkingListeners(sessionId: string, thinking: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.fieldListeners.thinking.forEach((listener) => {
      try { listener(thinking); } catch (e) { console.error(e); }
    });
  }

  private notifyToolListeners(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const tools = { uses: state.toolUses, results: state.toolResults };
    state.fieldListeners.tools.forEach((listener) => {
      try { listener(tools); } catch (e) { console.error(e); }
    });
  }

  private notifyPhaseListeners(sessionId: string, phase: StreamPhase): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.fieldListeners.phase.forEach((listener) => {
      try { listener(phase); } catch (e) { console.error(e); }
    });
  }

  private notifyStatusTextListeners(sessionId: string, statusText: string | undefined): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.fieldListeners.statusText.forEach((listener) => {
      try { listener(statusText); } catch (e) { console.error(e); }
    });
  }

  private notifyContextUsageListeners(sessionId: string, usage: ContextUsage | null): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.fieldListeners.contextUsage.forEach((listener) => {
      try { listener(usage); } catch (e) { console.error(e); }
    });
  }

  private notifyTokenUsageListeners(sessionId: string, usage: TokenUsage | null): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.fieldListeners.tokenUsage.forEach((listener) => {
      try { listener(usage); } catch (e) { console.error(e); }
    });
  }

  private notifyToolOutputListeners(sessionId: string, output: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.fieldListeners.toolOutput.forEach((listener) => {
      try { listener(output); } catch (e) { console.error(e); }
    });
  }

  private notifyToolProgressListeners(sessionId: string, info: { toolName: string; elapsedSeconds: number } | null): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.fieldListeners.toolProgress.forEach((listener) => {
      try { listener(info); } catch (e) { console.error(e); }
    });
  }

  private notifyStreamingEventsListeners(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const events = state.streamingEvents;
    state.streamingEventsListeners.forEach((listener) => {
      try { listener(events); } catch (e) { console.error(e); }
    });
  }

  private notifyToolTimeoutListeners(sessionId: string, info: { toolName: string; elapsedSeconds: number } | null): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.fieldListeners.toolTimeout.forEach((listener) => {
      try { listener(info); } catch (e) { console.error(e); }
    });
  }

  private notifyAgentProgressListeners(sessionId: string, event: AgentProgressEvent): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.fieldListeners.agentProgress.forEach((listener) => {
      try { listener(event); } catch (e) { console.error(e); }
    });
  }

  private notifyErrorListeners(sessionId: string, error: string | null): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.fieldListeners.error.forEach((listener) => {
      try { listener(error); } catch (e) { console.error(e); }
    });
  }

  private notifyCompletedAtListeners(sessionId: string, at: number | null): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.fieldListeners.completedAt.forEach((listener) => {
      try { listener(at); } catch (e) { console.error(e); }
    });
  }

  private notifyDbPersistedListeners(sessionId: string, event: SessionStreamSnapshot['dbPersisted']): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.fieldListeners.dbPersisted.forEach((listener) => {
      try { listener(event); } catch (e) { console.error(e); }
    });
  }

  private notifyRetryListeners(sessionId: string, info: { attempt: number; maxAttempts: number; delayMs: number; message: string }): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.fieldListeners.retry.forEach((listener) => {
      try { listener(info); } catch (e) { console.error(e); }
    });
  }

  private isCurrentStream(sessionId: string, streamId: string): boolean {
    const state = this.sessions.get(sessionId);
    return !!state && state.currentStreamId === streamId;
  }

  private scheduleTextEmit(sessionId: string, streamId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || !this.isCurrentStream(sessionId, streamId) || state.textEmitTimeout) return;
    // Use requestAnimationFrame for smoother UI updates, synced with browser render cycle
    state.textEmitTimeout = typeof requestAnimationFrame !== 'undefined'
      ? requestAnimationFrame(() => {
          this.flushPendingText(sessionId, streamId);
        }) as unknown as ReturnType<typeof setTimeout>
      : setTimeout(() => {
          this.flushPendingText(sessionId, streamId);
        }, this.textEmitInterval);
  }

  private clearTextEmitTimeout(state: SessionState): void {
    if (state.textEmitTimeout !== null) {
      // Check if it's a RAF id (number in browser) or timeout handle
      if (typeof state.textEmitTimeout === 'number') {
        cancelAnimationFrame(state.textEmitTimeout);
      } else {
        clearTimeout(state.textEmitTimeout);
      }
      state.textEmitTimeout = null;
    }
  }

  private flushPendingText(sessionId: string, streamId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || !this.isCurrentStream(sessionId, streamId)) return;
    if (!state.pendingTextEmit) {
      state.textEmitTimeout = null;
      return;
    }

    state.streamingText += state.pendingTextEmit;
    state.finalMessageContent = state.streamingText;
    const newText = state.streamingText;
    state.pendingTextEmit = '';
    state.textEmitTimeout = null;
    this.notifyTextListeners(sessionId, newText);
    this.notifyListeners(sessionId);
  }

  private clearIdleTimeout(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state?.idleTimeout) {
      clearTimeout(state.idleTimeout);
      state.idleTimeout = null;
    }
  }

  private resetIdleTimeout(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.clearIdleTimeout(sessionId);
    state.idleTimeout = setTimeout(() => {
      void this.stopStream(sessionId, 'Idle timeout exceeded');
    }, this.idleTimeoutMs);
  }
}

const GLOBAL_STREAM_MANAGER_KEY = '__stream_session_manager__';

function getStreamManager(): StreamSessionManager {
  const global = globalThis as typeof globalThis & Record<string, unknown>;
  if (!global[GLOBAL_STREAM_MANAGER_KEY]) {
    global[GLOBAL_STREAM_MANAGER_KEY] = new StreamSessionManager();
  }
  return global[GLOBAL_STREAM_MANAGER_KEY] as StreamSessionManager;
}

export const streamSessionManager = getStreamManager();

export const ensureSession = (sessionId: string) => streamSessionManager.ensureSession(sessionId);
export const startStream = (params: StartStreamParams) => streamSessionManager.startStream(params);
export const stopStream = (sessionId: string, reason?: string) => streamSessionManager.stopStream(sessionId, reason);
export const canSend = (sessionId: string) => streamSessionManager.canSend(sessionId);

// Backward-compatible export names
export const subscribe = (sessionId: string, listener: (snapshot: SessionStreamSnapshot) => void) =>
  streamSessionManager.subscribe(sessionId, listener);
export const subscribeSession = (sessionId: string, listener: (snapshot: SessionStreamSnapshot) => void) =>
  streamSessionManager.subscribeSession(sessionId, listener);
export const subscribeToPermissions = (sessionId: string, listener: (request: PermissionRequestEvent) => void) =>
  streamSessionManager.subscribeToPermissions(sessionId, listener);
export const subscribeToDbPersisted = (sessionId: string, listener: (event: PersistEvent) => void) =>
  streamSessionManager.subscribeToDbPersisted(sessionId, listener);
export const getSnapshot = (sessionId: string) => streamSessionManager.getSnapshot(sessionId);
export const setToolTimeoutCallback = (sessionId: string, callback: (content: string) => void) =>
  streamSessionManager.setToolTimeoutCallback(sessionId, callback);

// New field-based subscriptions
export const subscribeToText = (sessionId: string, listener: (text: string) => void) =>
  streamSessionManager.subscribeToText(sessionId, listener);
export const subscribeToThinking = (sessionId: string, listener: (thinking: string) => void) =>
  streamSessionManager.subscribeToThinking(sessionId, listener);
export const subscribeToTools = (sessionId: string, listener: (tools: { uses: ToolUseInfo[]; results: ToolResultInfo[] }) => void) =>
  streamSessionManager.subscribeToTools(sessionId, listener);
export const subscribeToPhase = (sessionId: string, listener: (phase: StreamPhase) => void) =>
  streamSessionManager.subscribeToPhase(sessionId, listener);
export const subscribeToStatusText = (sessionId: string, listener: (statusText: string | undefined) => void) =>
  streamSessionManager.subscribeToStatusText(sessionId, listener);
export const subscribeToContextUsage = (sessionId: string, listener: (usage: ContextUsage | null) => void) =>
  streamSessionManager.subscribeToContextUsage(sessionId, listener);
export const subscribeToTokenUsage = (sessionId: string, listener: (usage: TokenUsage | null) => void) =>
  streamSessionManager.subscribeToTokenUsage(sessionId, listener);
export const subscribeToToolOutput = (sessionId: string, listener: (output: string) => void) =>
  streamSessionManager.subscribeToToolOutput(sessionId, listener);
export const subscribeToToolProgress = (sessionId: string, listener: (info: { toolName: string; elapsedSeconds: number } | null) => void) =>
  streamSessionManager.subscribeToToolProgress(sessionId, listener);
export const subscribeToToolTimeout = (sessionId: string, listener: (info: { toolName: string; elapsedSeconds: number } | null) => void) =>
  streamSessionManager.subscribeToToolTimeout(sessionId, listener);
export const subscribeToError = (sessionId: string, listener: (error: string | null) => void) =>
  streamSessionManager.subscribeToError(sessionId, listener);
export const subscribeToRetry = (sessionId: string, listener: (info: { attempt: number; maxAttempts: number; delayMs: number; message: string }) => void) =>
  streamSessionManager.subscribeToRetry(sessionId, listener);
export const subscribeToStreamingEvents = (sessionId: string, listener: (events: StreamingEvent[]) => void) =>
  streamSessionManager.subscribeToStreamingEvents(sessionId, listener);
