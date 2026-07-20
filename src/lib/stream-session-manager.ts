// stream-session-manager.ts - Client-side actor manager for chat sessions
//
// Connects to Agent Server via HTTP+SSE for chat streaming.

import type { SessionStreamSnapshot, ToolUseInfo, ToolResultInfo, TokenUsage, ContextUsage, StreamPhase } from '@/types/message';
import type { PermissionRequestEvent } from '@/types/stream';
import { STREAM_IDLE_TIMEOUT_MS } from './constants';
import { showMessageCompletionNotification } from './notification';
import { getAgentServerClient, type ChatOptions } from './agent-http-client';
import { useConversationStore } from '@/stores/conversation-store';

// Provider config interface
interface ProviderConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  provider: string;
  authStyle: string;
}

// Get active provider config from main process via IPC
// Uses the unmasked getActiveProviderConfig API to get the real API key
async function getActiveProviderConfig(): Promise<ProviderConfig | null> {
  try {
    // The provider API is at window.electronAPI.provider
    const electronApi = window.electronAPI as unknown as Record<string, unknown> | undefined;
    const providerApi = electronApi?.provider as { getActiveProviderConfig: () => Promise<unknown> } | undefined;
    if (!providerApi) {
      console.warn('[stream-session-manager] provider API not available');
      return null;
    }

    const config = await providerApi.getActiveProviderConfig() as {
      apiKey: string;
      baseUrl?: string;
      providerType: string;
      model: string;
      provider: string;
      authStyle: string;
    } | null;
    if (!config) {
      console.warn('[stream-session-manager] No active provider config');
      return null;
    }

    console.log('[stream-session-manager] Provider config:', config);

    if (!config.model) {
      console.warn('[stream-session-manager] No model configured in provider');
      return null;
    }

    return {
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      model: config.model,
      provider: config.provider,
      authStyle: config.authStyle,
    };
  } catch (error) {
    console.error('[stream-session-manager] Failed to get active provider config:', error);
    return null;
  }
}

async function getProviderConfigById(providerId: string, model: string): Promise<{ provider: string; apiKey: string; baseURL: string; model: string } | null> {
  try {
    console.log(`[stream-session-manager] Resolving title model provider: "${providerId}", model: "${model}"`);

    const electronApi = window.electronAPI as unknown as Record<string, unknown> | undefined;
    const providerApi = electronApi?.provider as {
      getConfig?: (providerId: string, model: string) => Promise<{ apiKey: string; baseUrl?: string; model: string; provider: string; authStyle: string } | null>;
      list?: () => Promise<Array<{ id: string; name: string; providerType: string; baseUrl: string; apiKey: string; protocol: string }>>;
    } | undefined;

    // Try unmasked getConfig first
    if (providerApi?.getConfig) {
      const config = await providerApi.getConfig(providerId, model);
      if (config) {
        console.log(`[stream-session-manager] Resolved title model via getConfig:`, { provider: config.provider, model: config.model });
        return {
          provider: config.provider,
          apiKey: config.apiKey,
          baseURL: config.baseUrl || '',
          model: config.model,
        };
      }
    }

    // Fallback: resolve via provider list (masked key, works when same as active provider)
    if (!providerApi?.list) {
      console.warn('[stream-session-manager] listProviders API not available');
      return null;
    }

    const providers = await providerApi.list();
    console.log(`[stream-session-manager] Available providers:`, providers.map(p => ({ id: p.id, name: p.name, protocol: p.protocol })));

    // Try exact match first, then case-insensitive match
    let provider = providers.find((p) => p.id === providerId);
    if (!provider) {
      provider = providers.find((p) => p.id.toLowerCase() === providerId.toLowerCase());
    }
    // Also try trimming whitespace
    if (!provider && providerId.trim() !== providerId) {
      provider = providers.find((p) => p.id === providerId.trim());
    }
    if (!provider) {
      console.warn(`[stream-session-manager] Title model provider not found: "${providerId}"`);
      return null;
    }

    console.warn(`[stream-session-manager] Title model using fallback list API (masked key):`, { id: provider.id });

    return {
      provider: provider.protocol || provider.providerType,
      apiKey: provider.apiKey,
      baseURL: provider.baseUrl,
      model,
    };
  } catch (error) {
    console.error('[stream-session-manager] Failed to get provider config by id:', error);
    return null;
  }
}

// Check if model string looks like "providerId:modelName" format
function looksLikeProviderModelFormat(model: string): boolean {
  // Pattern: starts with alphanumeric provider ID followed by colon, then model name
  // e.g., "openrouter:anthropic/claude-3.5-sonnet" or "anthropic:claude-opus-4-6"
  const parts = model.split(':');
  if (parts.length < 2) return false;
  // First part should look like a provider ID (short, alphanumeric with hyphens)
  const providerId = parts[0]!;
  if (providerId.length > 30) return false; // Provider IDs are typically short
  // Model name should have something beyond just simple word (contains slash, hyphen with version, etc.)
  const modelPart = parts.slice(1).join(':');
  return modelPart.includes('/') || /\d/.test(modelPart);
}

// Get provider config for a specific model (which may be in "providerId:modelName" format)
// This allows users to select different provider models from the UI
async function getProviderConfigForModel(
  model: string | undefined,
  providerIdHint?: string,
): Promise<ProviderConfig | null> {
  if (!model) {
    return getActiveProviderConfig();
  }

  // If the caller already resolved a providerId for this session (e.g.
  // user picked a model belonging to a non-default provider), honor it
  // before any heuristic format detection. Without this branch,
  // `getProviderConfigById` would only run when model itself looks
  // like "providerId:modelName", and a plain model id would silently
  // fall through to the active provider — keeping the previous
  // provider's API key/baseURL with the new model name, which
  // manifests as the old provider's rate-limit error.
  if (providerIdHint) {
    const resolved = await getProviderConfigById(providerIdHint, model);
    if (resolved) {
      console.log('[stream-session-manager] Resolved provider config via providerIdHint:', {
        provider: resolved.provider,
        model: resolved.model,
      });
      return {
        apiKey: resolved.apiKey,
        baseURL: resolved.baseURL,
        model: resolved.model,
        provider: resolved.provider,
        authStyle: 'api_key',
      };
    }
    console.warn('[stream-session-manager] providerIdHint failed, falling back to format detection:', {
      providerIdHint,
      model,
    });
  }

  // Check if model looks like "providerId:modelName" format
  if (!looksLikeProviderModelFormat(model)) {
    // Regular model name - use active provider with this model
    const activeConfig = await getActiveProviderConfig();
    if (activeConfig) {
      activeConfig.model = model;
      console.log('[stream-session-manager] Using active provider with model override:', { provider: activeConfig.provider, model: activeConfig.model });
    }
    return activeConfig;
  }

  // Model is in "providerId:modelName" format - extract and resolve provider
  const parts = model.split(':');
  if (parts.length < 2) {
    return getActiveProviderConfig();
  }

  const providerId = parts[0]!;
  const modelName = parts.slice(1).join(':');
  console.log(`[stream-session-manager] Model format detected: providerId="${providerId}", model="${modelName}"`);

  const resolved = await getProviderConfigById(providerId, modelName);
  if (resolved) {
    console.log('[stream-session-manager] Resolved provider config for session model:', { provider: resolved.provider, model: resolved.model });
    return {
      apiKey: resolved.apiKey,
      baseURL: resolved.baseURL,
      model: resolved.model,
      provider: resolved.provider,
      authStyle: 'api_key',
    };
  }

  // Fallback to active provider if resolution fails
  console.warn('[stream-session-manager] Failed to resolve provider, falling back to active provider');
  return getActiveProviderConfig();
}

const ACTIVE_PHASES: StreamPhase[] = ['starting', 'streaming', 'awaiting_permission', 'persisting'];

/** Stream error with optional provider `code` (e.g. `rate_limit_error`,
 *  `usage_limit_exceeded`). Surfaced through `useStreamingError` so the UI
 *  can render a tailored banner instead of the generic agent-error fallback. */
export interface StreamingError {
  message: string;
  code: string | null;
}

interface StreamErrorEventData {
  message?: string;
  code?: string;
}

interface PersistEvent {
  success: boolean;
  reason?: string;
  generation: number;
  messageCount: number;
  streamId?: string;
  /** Timestamp when event was received (for debugging timing) */
  timestamp?: number;
}

export interface FileAttachment {
  id: string;
  name: string;
  type: string;
  url: string;
  size: number;
  path?: string;
  text?: string;
  extractMethod?: 'text' | 'vision' | 'hybrid';
  imageChunks?: Array<{ base64: string; mediaType: string }>;
  thumbnail?: string;
}

interface StartStreamParams {
  sessionId: string;
  content: string;
  displayContent?: string;
  model?: string;
  maxTokens?: number;
  systemPrompt?: string;
  language?: string;
  initialGeneration?: number;
  /**
   * 显式单次 override (trusted caller only). 类型: agent internal mode, 不是 DB profile.
   * 普通 send payload **不**携带此字段; worker 从 session row.permission_profile 派生默认 mode.
   */
  permissionModeOverride?: 'default' | 'auto' | 'bypassPermissions';
  files?: FileAttachment[];
  agentProfileId?: string | null;
  outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean };
  titleGenerationModel?: string;
  titleGenerationModelConfig?: { provider: string; apiKey: string; baseURL: string; model: string };
  mode?: string;
  wikiAgentEnabled?: boolean;
  defaultWorkspaceDirectory?: string;
  securityScanEnabled?: boolean;
  /**
   * Session's provider ID (from the threads row). When set, the
   * provider config is resolved by providerId instead of falling back
   * to the active provider with a model-name override. This is the
   * authoritative path after a model switch — without it, picking a
   * model from a non-default provider still uses the active provider's
   * API key/baseURL.
   */
  providerId?: string;
  /**
   * Anthropic thinking effort level (Low/Medium/High/Max). Forwarded
   * to the agent worker so the LLM client can map it to a
   * `thinking.budget_tokens` value in the request body. undefined/Auto
   * means no extended thinking.
   */
  effort?: string;
  /**
   * Conductor mode flag — when true, the agent runs in conductor mode
   * and binds to the conductorCanvasId. Forwarded to ChatOptions.
   */
  conductorMode?: boolean;
  /**
   * Conductor canvas ID — durable binding from the session row.
   * Injected into the agent's ToolUseContext.conductorCanvasId.
   */
  conductorCanvasId?: string;
  /** Mailbox row backing a user message queued while another run is active. */
  queuedMailboxId?: string;
  /** Internal follow-up turn that consumes queued background task results. */
  backgroundTaskResume?: boolean;
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
  error: Set<(error: StreamingError | null) => void>;
  completedAt: Set<(at: number | null) => void>;
  dbPersisted: Set<(event: SessionStreamSnapshot['dbPersisted']) => void>;
  retry: Set<(info: { attempt: number; maxAttempts: number; delayMs: number; message: string }) => void>;
  skillReview: Set<(event: SkillReviewEvent) => void>;
};

/**
 * Skill-review lifecycle event surfaced to the UI.
 *
 * `phase: 'started'`  → the SelfImprover has hit the threshold and
 *                       spawned a background sub-agent. The UI uses
 *                       this to show a non-blocking toast / inline
 *                       indicator so the user knows something is
 *                       happening in the background.
 * `phase: 'completed'` → the sub-agent finished, with the verdict
 *                       data. `passed = true` means a new skill was
 *                       created (or an existing one improved).
 */
export interface SkillReviewEvent {
  phase: 'started' | 'completed';
  passed?: boolean;
  score?: number;
  feedback?: string;
  skillName?: string;
  iterations?: number;
  maxIterations?: number;
  finalPath?: string;
  error?: string;
}

/** Sub-agent progress event */
export interface AgentProgressEvent {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'started' | 'done' | 'error';
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

/** Conductor-specific streaming event (extends StreamingEvent with conductor metadata) */
export type ConductorEvent =
  | { type: 'text'; content: string; timestamp: number }
  | { type: 'thinking'; content: string; timestamp: number }
  | { type: 'tool_use'; toolUse: ToolUseInfo; timestamp: number }
  | { type: 'tool_result'; toolResult: ToolResultInfo; timestamp: number }
  | { type: 'status'; status: string; timestamp: number }
  | { type: 'error'; message: string; timestamp: number }
  | { type: 'done'; timestamp: number };

/** Conductor stream phase */
export type ConductorPhase = 'idle' | 'thinking' | 'streaming' | 'tool_use' | 'completed' | 'error';

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
  /** Provider error code (e.g. `rate_limit_error`, `usage_limit_exceeded`).
   *  Set alongside `error` so the UI can render a tailored banner. */
  errorCode: string | null;
  finalMessageContent: string | null;
  toolTimeoutInfo: { toolName: string; elapsedSeconds: number } | null;
  toolProgressInfo: { toolName: string; elapsedSeconds: number } | null;
  dbPersisted: SessionStreamSnapshot['dbPersisted'];
  agentProgressEvents: AgentProgressEvent[];
  streamingEvents: StreamingEvent[];
  pendingPermissionRequest: PermissionRequestEvent | null;
  // Deduplication: tool IDs already loaded from DB on page refresh
  loadedToolUseIds: Set<string>;
  loadedToolResultIds: Set<string>;
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

/** Conductor session state */
interface ConductorSessionState {
  canvasId: string;
  currentStreamId: string | null;
  phase: ConductorPhase;
  conductorEvents: ConductorEvent[];
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  // Listeners
  conductorEventsListeners: Set<(events: ConductorEvent[]) => void>;
  conductorPhaseListeners: Set<(phase: ConductorPhase) => void>;
  conductorErrorListeners: Set<(error: string | null) => void>;
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
    errorCode: null,
    finalMessageContent: null,
    toolTimeoutInfo: null,
    toolProgressInfo: null,
    dbPersisted: undefined,
    agentProgressEvents: [],
    streamingEvents: [],
    pendingPermissionRequest: null,
    loadedToolUseIds: new Set(),
    loadedToolResultIds: new Set(),
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
    errorCode: state.errorCode,
    finalMessageContent: state.finalMessageContent,
    toolTimeoutInfo: state.toolTimeoutInfo,
    toolProgressInfo: state.toolProgressInfo,
    dbPersisted: state.dbPersisted,
  };
}

function extractNestedProviderErrorMessage(message: string): string | null {
  let current = message.trim();
  for (let depth = 0; depth < 3; depth++) {
    if (!current.startsWith('{')) break;
    try {
      const parsed = JSON.parse(current) as {
        error?: { message?: string };
        data?: { message?: string };
        message?: string;
      };
      const next = parsed.error?.message || parsed.data?.message || parsed.message;
      if (!next || next === current) break;
      current = next.trim();
    } catch {
      break;
    }
  }
  return current && current !== message ? current : null;
}

function normalizeStreamError(data: StreamErrorEventData | undefined): StreamingError {
  const rawMessage = data?.message || 'Unknown error';
  const nestedMessage = extractNestedProviderErrorMessage(rawMessage);
  const providerMessage = nestedMessage || rawMessage;
  const providerLower = providerMessage.toLowerCase();
  const code = data?.code || (
    providerLower.includes('new_sensitive') || providerLower.includes('output new_sensitive')
      ? 'provider_safety_filter'
      : null
  );

  if (code === 'provider_safety_filter') {
    return {
      code,
      message: 'The model provider stopped the final response because its safety filter flagged newly generated output. Previous tool work and file edits are kept; continue with a narrower request or switch models.',
    };
  }

  return {
    code,
    message: nestedMessage || rawMessage,
  };
}

function isActivePhase(phase: StreamPhase): boolean {
  return ACTIVE_PHASES.includes(phase);
}

class StreamSessionManager {
  private sessions: Map<string, SessionState> = new Map();
  private conductorSessions: Map<string, ConductorSessionState> = new Map();
  private pendingMessages: Map<string, StartStreamParams[]> = new Map();
  private backgroundResumeTemplates = new Map<string, StartStreamParams>();
  private pendingBackgroundResumes = new Set<string>();
  private drainingQueuedSessions = new Set<string>();
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
      skillReview: new Set(),
    };
  }

  // ============ Conductor Session Management ============

  /**
   * Start a conductor agent stream
   */
  startConductorStream(params: {
    canvasId: string;
    content: string;
    snapshot?: unknown;
    model?: string;
    language?: string;
    visionModel?: string;
    permissionMode?: string;
  }): string {
    const streamId = crypto.randomUUID();
    const state: ConductorSessionState = {
      canvasId: params.canvasId,
      currentStreamId: streamId,
      phase: 'thinking',
      conductorEvents: [],
      startedAt: Date.now(),
      completedAt: null,
      error: null,
      conductorEventsListeners: new Set(),
      conductorPhaseListeners: new Set(),
      conductorErrorListeners: new Set(),
    };
    this.conductorSessions.set(params.canvasId, state);

    // Notify initial phase
    this.notifyConductorPhaseListeners(params.canvasId, 'thinking');

    // Add initial thinking event
    this.appendConductorEvent(params.canvasId, { type: 'thinking', content: '', timestamp: Date.now() });

    // Start the agent via conductor port
    const port = (window as any).electronAPI?.getConductorPort?.();
    if (port) {
      port.startAgent({
        content: params.content,
        snapshot: params.snapshot,
        canvasId: params.canvasId,
        model: params.model,
        language: params.language,
        visionModel: params.visionModel,
        permissionMode: params.permissionMode,
      });
    }

    return streamId;
  }

  /**
   * Stop conductor agent stream
   */
  stopConductorStream(canvasId: string): void {
    const state = this.conductorSessions.get(canvasId);
    if (!state || !state.currentStreamId) return;

    const port = (window as any).electronAPI?.getConductorPort?.();
    if (port) {
      port.interruptAgent();
    }

    state.phase = 'completed';
    state.completedAt = Date.now();
    this.appendConductorEvent(canvasId, { type: 'done', timestamp: Date.now() });
    this.notifyConductorPhaseListeners(canvasId, state.phase);
  }

  /**
   * Subscribe to conductor events
   */
  subscribeToConductorEvents(canvasId: string, listener: (events: ConductorEvent[]) => void): () => void {
    let state = this.conductorSessions.get(canvasId);
    if (!state) {
      state = {
        canvasId,
        currentStreamId: null,
        phase: 'idle',
        conductorEvents: [],
        startedAt: Date.now(),
        completedAt: null,
        error: null,
        conductorEventsListeners: new Set(),
        conductorPhaseListeners: new Set(),
        conductorErrorListeners: new Set(),
      };
      this.conductorSessions.set(canvasId, state);
    }
    state.conductorEventsListeners.add(listener);
    listener(state.conductorEvents);
    return () => { state.conductorEventsListeners.delete(listener); };
  }

  /**
   * Subscribe to conductor phase
   */
  subscribeToConductorPhase(canvasId: string, listener: (phase: ConductorPhase) => void): () => void {
    let state = this.conductorSessions.get(canvasId);
    if (!state) {
      state = {
        canvasId,
        currentStreamId: null,
        phase: 'idle',
        conductorEvents: [],
        startedAt: Date.now(),
        completedAt: null,
        error: null,
        conductorEventsListeners: new Set(),
        conductorPhaseListeners: new Set(),
        conductorErrorListeners: new Set(),
      };
      this.conductorSessions.set(canvasId, state);
    }
    state.conductorPhaseListeners.add(listener);
    listener(state.phase);
    return () => { state.conductorPhaseListeners.delete(listener); };
  }

  /**
   * Subscribe to conductor errors
   */
  subscribeToConductorError(canvasId: string, listener: (error: string | null) => void): () => void {
    let state = this.conductorSessions.get(canvasId);
    if (!state) {
      state = {
        canvasId,
        currentStreamId: null,
        phase: 'idle',
        conductorEvents: [],
        startedAt: Date.now(),
        completedAt: null,
        error: null,
        conductorEventsListeners: new Set(),
        conductorPhaseListeners: new Set(),
        conductorErrorListeners: new Set(),
      };
      this.conductorSessions.set(canvasId, state);
    }
    state.conductorErrorListeners.add(listener);
    listener(state.error);
    return () => { state.conductorErrorListeners.delete(listener); };
  }

  /**
   * Handle conductor port events - call this from ConductorComposer
   */
  handleConductorPortEvent(canvasId: string, eventType: string, data: unknown): void {
    const state = this.conductorSessions.get(canvasId);
    if (!state) return;

    const ts = Date.now();
    switch (eventType) {
      case 'text':
        this.appendConductorEvent(canvasId, { type: 'text', content: (data as { content: string }).content || '', timestamp: ts });
        if (state.phase === 'thinking') {
          state.phase = 'streaming';
          this.notifyConductorPhaseListeners(canvasId, state.phase);
        }
        break;
      case 'thinking':
        this.appendConductorEvent(canvasId, { type: 'thinking', content: (data as { content: string }).content || '', timestamp: ts });
        break;
      case 'tool_use': {
        const toolData = data as { id: string; name: string; input: unknown };
        state.phase = 'tool_use';
        this.notifyConductorPhaseListeners(canvasId, state.phase);
        const toolUse: ToolUseInfo = { id: toolData.id, name: toolData.name, input: toolData.input as Record<string, unknown> };
        this.appendConductorEvent(canvasId, {
          type: 'tool_use',
          toolUse,
          timestamp: ts,
        });
        break;
      }
      case 'tool_result': {
        const resultData = data as { id: string; result: unknown; error?: boolean; duration_ms?: number };
        const result: ToolResultInfo = {
          tool_use_id: resultData.id,
          content: typeof resultData.result === 'string' ? resultData.result : JSON.stringify(resultData.result),
          is_error: resultData.error || false,
          duration_ms: resultData.duration_ms,
        };
        this.appendConductorEvent(canvasId, { type: 'tool_result', toolResult: result, timestamp: ts });
        if (state.phase === 'tool_use') {
          state.phase = 'streaming';
          this.notifyConductorPhaseListeners(canvasId, state.phase);
        }
        break;
      }
      case 'status': {
        const statusData = data as { status: string };
        this.appendConductorEvent(canvasId, { type: 'status', status: statusData.status, timestamp: ts });
        if (statusData.status === 'idle') {
          state.phase = 'idle';
        } else if (statusData.status === 'thinking') {
          state.phase = 'thinking';
        } else if (statusData.status === 'streaming') {
          state.phase = 'streaming';
        }
        this.notifyConductorPhaseListeners(canvasId, state.phase);
        break;
      }
      case 'done':
        state.phase = 'completed';
        state.completedAt = ts;
        this.appendConductorEvent(canvasId, { type: 'done', timestamp: ts });
        this.notifyConductorPhaseListeners(canvasId, state.phase);
        break;
      case 'error': {
        const errorData = data as { message: string };
        state.phase = 'error';
        state.error = errorData.message;
        state.completedAt = ts;
        this.appendConductorEvent(canvasId, { type: 'error', message: errorData.message, timestamp: ts });
        this.notifyConductorPhaseListeners(canvasId, state.phase);
        this.notifyConductorErrorListeners(canvasId, state.error);
        break;
      }
    }
  }

  /**
   * Get conductor session state
   */
  getConductorSession(canvasId: string): ConductorSessionState | null {
    return this.conductorSessions.get(canvasId) || null;
  }

  /**
   * Clear conductor session
   */
  clearConductorSession(canvasId: string): void {
    this.conductorSessions.delete(canvasId);
  }

  private appendConductorEvent(canvasId: string, event: ConductorEvent): void {
    const state = this.conductorSessions.get(canvasId);
    if (!state) return;
    state.conductorEvents = [...state.conductorEvents, event];
    this.notifyConductorEventsListeners(canvasId);
  }

  private notifyConductorEventsListeners(canvasId: string): void {
    const state = this.conductorSessions.get(canvasId);
    if (!state) return;
    state.conductorEventsListeners.forEach((listener) => {
      try { listener(state.conductorEvents); } catch (e) { console.error(e); }
    });
  }

  private notifyConductorPhaseListeners(canvasId: string, phase: ConductorPhase): void {
    const state = this.conductorSessions.get(canvasId);
    if (!state) return;
    state.conductorPhaseListeners.forEach((listener) => {
      try { listener(phase); } catch (e) { console.error(e); }
    });
  }

  private notifyConductorErrorListeners(canvasId: string, error: string | null): void {
    const state = this.conductorSessions.get(canvasId);
    if (!state) return;
    state.conductorErrorListeners.forEach((listener) => {
      try { listener(error); } catch (e) { console.error(e); }
    });
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

  enqueueMessage(sessionId: string, params: StartStreamParams): void {
    const queue = this.pendingMessages.get(sessionId) || [];
    queue.push(params);
    this.pendingMessages.set(sessionId, queue);
  }

  getPendingMessages(sessionId: string): StartStreamParams[] {
    return this.pendingMessages.get(sessionId) || [];
  }

  clearQueuedMessages(sessionId: string): void {
    const queue = this.pendingMessages.get(sessionId) ?? [];
    const cancelMailbox = typeof window !== 'undefined'
      ? window.electronAPI?.mailbox?.cancel
      : undefined;
    if (cancelMailbox) {
      for (const item of queue) {
        if (item.queuedMailboxId) {
          void cancelMailbox(item.queuedMailboxId, 'queued_messages_cleared');
        }
      }
    }
    this.pendingMessages.set(sessionId, []);
  }

  hasQueuedMessages(sessionId: string): boolean {
    const queue = this.pendingMessages.get(sessionId);
    return !!queue && queue.length > 0;
  }

  private autoStartQueuedStream(sessionId: string): void {
    if (this.drainingQueuedSessions.has(sessionId)) return;
    this.drainingQueuedSessions.add(sessionId);

    setTimeout(() => {
      void (async () => {
        try {
          const queue = this.pendingMessages.get(sessionId);
          while (queue && queue.length > 0) {
            const next = queue.shift()!;
            this.pendingMessages.set(sessionId, queue);

            if (next.queuedMailboxId) {
              const promoteQueued = typeof window !== 'undefined'
                ? window.electronAPI?.mailbox?.promoteQueued
                : undefined;
              if (promoteQueued) {
                const promoted = await promoteQueued(next.queuedMailboxId);
                if (!promoted) {
                  // The row was cancelled or already absorbed as in-run
                  // guidance. Do not send it again as a separate turn.
                  continue;
                }

                const row = promoted as Record<string, unknown>;
                if (typeof row.content === 'string') {
                  next.content = row.content;
                  next.displayContent = row.content;
                }
                if (typeof row.attachments_json === 'string') {
                  try {
                    const attachments = JSON.parse(row.attachments_json) as FileAttachment[];
                    if (Array.isArray(attachments)) next.files = attachments;
                  } catch {
                    // Keep the originally queued attachments if the stored
                    // representation cannot be decoded.
                  }
                }
              }
            }

            await this.startStream(next);
            return;
          }
        } catch (error) {
          console.error('[stream-session-manager] Failed to start queued message:', error);
        } finally {
          this.drainingQueuedSessions.delete(sessionId);
        }
      })();
    }, 0);
  }

  /**
   * Register messages already loaded from DB (e.g., after page refresh).
   * Extracts tool_use/tool_result IDs so incoming SSE events for the same
   * tools are filtered out, preventing duplicate rendering.
   */
  registerLoadedMessages(
    sessionId: string,
    messages: ReadonlyArray<{ role: string; content: string | unknown[]; msgType?: string }>,
  ): void {
    const state = this.getOrCreateState(sessionId);
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    const loadedUses: ToolUseInfo[] = [];
    const loadedResults: ToolResultInfo[] = [];

    for (const msg of messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === 'object') {
            const b = block as Record<string, unknown>;
            if (b.type === 'tool_use' && b.id) {
              const id = String(b.id);
              toolUseIds.add(id);
              loadedUses.push({
                id,
                name: String(b.name || ''),
                input: (b.input as Record<string, unknown>) || {},
              });
            }
          }
        }
      }
      if (msg.role === 'tool') {
        const toolCallId = msg.msgType === 'tool_result'
          ? (msg as unknown as Record<string, unknown>).parentToolCallId as string
          : undefined;
        if (toolCallId) {
          toolResultIds.add(toolCallId);
          const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          loadedResults.push({
            tool_use_id: toolCallId,
            content,
            is_error: false,
          });
        }
      }
    }

    state.loadedToolUseIds = toolUseIds;
    state.loadedToolResultIds = toolResultIds;

    // Pre-populate tool state so the UI shows tools immediately before SSE catch-up
    if (loadedUses.length > 0 && state.toolUses.length === 0) {
      state.toolUses = loadedUses;
    }
    if (loadedResults.length > 0 && state.toolResults.length === 0) {
      state.toolResults = loadedResults;
    }
    if (loadedUses.length > 0 || loadedResults.length > 0) {
      this.notifyToolListeners(sessionId);
    }
  }

  async resumeBackgroundTask(sessionId: string): Promise<boolean> {
    const state = this.getOrCreateState(sessionId);
    if (isActivePhase(state.phase)) {
      // The worker may signal completion a few milliseconds before the
      // foreground SSE client processes its terminal event. Keep the wakeup
      // until that stream becomes terminal instead of silently dropping it.
      this.pendingBackgroundResumes.add(sessionId);
      return false;
    }

    this.pendingBackgroundResumes.delete(sessionId);
    const template = this.backgroundResumeTemplates.get(sessionId);
    await this.startStream({
      ...template,
      sessionId,
      content: '',
      displayContent: undefined,
      files: undefined,
      queuedMailboxId: undefined,
      backgroundTaskResume: true,
    });
    return true;
  }

  private startPendingBackgroundResume(sessionId: string): void {
    if (!this.pendingBackgroundResumes.has(sessionId)) return;

    this.pendingBackgroundResumes.delete(sessionId);
    void this.resumeBackgroundTask(sessionId).catch((error) => {
      console.error('[stream-session-manager] Failed to resume background task:', error);
    });
  }

  async startStream(params: StartStreamParams): Promise<StartStreamResult> {
    const { sessionId, content, displayContent, model, providerId, effort, maxTokens, systemPrompt, language, initialGeneration, permissionModeOverride, files, agentProfileId, outputStyleConfig, titleGenerationModel, titleGenerationModelConfig: titleGenConfigParam, mode, wikiAgentEnabled, defaultWorkspaceDirectory, securityScanEnabled, conductorMode, conductorCanvasId, backgroundTaskResume } = params;

    if (!backgroundTaskResume) {
      this.backgroundResumeTemplates.set(sessionId, {
        ...params,
        content: '',
        displayContent: undefined,
        files: undefined,
        queuedMailboxId: undefined,
      });
    }

    // Resolve workingDirectory from the thread store — sessionId IS the threadId
    let workingDirectory: string | undefined;
    try {
      const store = useConversationStore.getState();
      const thread = store.threads.find(t => t.id === sessionId);
      if (thread?.workingDirectory) {
        workingDirectory = thread.workingDirectory;
      }
    } catch {
      // Store not available, proceed without workingDirectory
    }

    console.log('[stream-session-manager] startStream:', {
      sessionId,
      workingDirectory,
      contentLength: content.length,
      filesCount: files?.length,
      filesWithText: files?.filter(f => f.text)?.map(f => ({ name: f.name, textLength: f.text?.length })),
      filesWithImageChunks: files?.filter(f => f.imageChunks)?.map(f => ({ name: f.name, chunks: f.imageChunks?.length })),
    });
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
    state.errorCode = null;
    state.finalMessageContent = null;
    state.toolTimeoutInfo = null;
    state.toolProgressInfo = null;
    state.dbPersisted = undefined;
    state.agentProgressEvents = [];
    state.streamingEvents = [];
    state.pendingPermissionRequest = null;
    state.loadedToolUseIds = new Set();
    state.loadedToolResultIds = new Set();

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

    // Use Agent Server HTTP for streaming
    // Get provider config for agent initialization
    // If model is in "providerId:modelName" format, resolve the specific provider
    const providerConfig = await getProviderConfigForModel(model, providerId);
    if (providerConfig) {
      console.log('[stream-session-manager] Using provider config:', { provider: providerConfig.provider, model: providerConfig.model });
    } else {
      console.warn('[stream-session-manager] No provider config available');
    }

    // Inject vision model config into providerConfig if available
    if (providerConfig) {
      try {
        const visionApi = (window.electronAPI as unknown as Record<string, unknown>)?.vision as
          { get: () => Promise<{ provider: string; model: string; baseUrl: string; apiKey: string; enabled: boolean } | null> } | undefined;
        if (visionApi?.get) {
          const vc = await visionApi.get();
          if (vc?.enabled && vc.model) {
            (providerConfig as unknown as Record<string, unknown>).visionConfig = {
              provider: vc.provider,
              model: vc.model,
              baseURL: vc.baseUrl,
              apiKey: vc.apiKey,
              enabled: vc.enabled,
            };
            console.log('[stream-session-manager] Vision model config injected:', {
              provider: vc.provider,
              model: vc.model,
            });
          } else {
            console.log('[stream-session-manager] Vision model not enabled or no model configured');
          }
        }
      } catch (err) {
        console.warn('[stream-session-manager] Failed to get vision config:', err);
      }
    }

    let titleGenerationModelConfig = titleGenConfigParam;
    console.log(`[stream-session-manager] titleGenerationModel raw value: "${titleGenerationModel}"`);
    if (!titleGenerationModelConfig && titleGenerationModel) {
      const parts = titleGenerationModel.split(':');
      console.log(`[stream-session-manager] Split parts:`, parts);
      if (parts.length >= 2) {
        const providerId = parts[0]!;
        const titleModel = parts.slice(1).join(':');
        console.log(`[stream-session-manager] providerId: "${providerId}", titleModel: "${titleModel}"`);
        const resolved = await getProviderConfigById(providerId, titleModel);
        if (resolved) {
          titleGenerationModelConfig = resolved;
          console.log('[stream-session-manager] Resolved title model config:', { provider: resolved.provider, model: resolved.model });
        } else {
          console.warn('[stream-session-manager] Could not resolve title model provider:', providerId);
        }
      } else {
        console.warn('[stream-session-manager] Invalid titleGenerationModel format (need providerId:modelName):', titleGenerationModel);
        // Fallback: treat the raw value as a plain model name using the active
        // provider so title generation still works for legacy/free-form values.
        if (providerConfig) {
          titleGenerationModelConfig = {
            provider: providerConfig.provider,
            apiKey: providerConfig.apiKey,
            baseURL: providerConfig.baseURL || '',
            model: titleGenerationModel,
          };
          console.log('[stream-session-manager] Falling back title model to active provider:', {
            provider: providerConfig.provider,
            model: titleGenerationModel,
          });
        }
      }
    }

    void this.startStreamViaAgentServer(
      sessionId,
      streamId,
      { content, displayContent, model, maxTokens, systemPrompt, permissionModeOverride, files, agentProfileId, outputStyleConfig, titleGenerationModel, titleGenerationModelConfig, providerConfig, workingDirectory, mode, wikiAgentEnabled, defaultWorkspaceDirectory, securityScanEnabled, effort, conductorMode, conductorCanvasId, backgroundTaskResume },
      nextGeneration
    );

    return { streamId, generation: nextGeneration };
  }

  private async startStreamViaAgentServer(
    sessionId: string,
    streamId: string,
    params: {
      content: string;
      displayContent?: string;
      model?: string;
      maxTokens?: number;
      systemPrompt?: string;
      language?: string;
      permissionModeOverride?: 'default' | 'auto' | 'bypassPermissions';
      files?: FileAttachment[];
      agentProfileId?: string | null;
      outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean };
      titleGenerationModel?: string;
      titleGenerationModelConfig?: { provider: string; apiKey: string; baseURL: string; model: string };
      providerConfig?: ProviderConfig | null;
      workingDirectory?: string;
      mode?: string;
      wikiAgentEnabled?: boolean;
      defaultWorkspaceDirectory?: string;
      securityScanEnabled?: boolean;
      effort?: string;
      conductorMode?: boolean;
      conductorCanvasId?: string;
      backgroundTaskResume?: boolean;
    },
    generation: number
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || !state.abortController) return;

    if (!this.isCurrentStream(sessionId, streamId)) {
      return;
    }

    // Get Agent Server client
    const client = getAgentServerClient();

    // Register event handlers for Agent Server
    const cleanup = client.onEvent(sessionId, (event) => {
      const s = this.sessions.get(sessionId);
      if (!s || !this.isCurrentStream(sessionId, streamId)) return;

      switch (event.type) {
        case 'ready':
        case 'message':
          // Handle generic message - determine subtype from data
          this.handleAgentServerEvent(s, streamId, event);
          break;

        case 'text':
          this.handleTextEvent(sessionId, streamId, event.content || '');
          break;

        case 'thinking':
          this.handleThinkingEvent(sessionId, streamId, event.content || '');
          break;

        case 'status':
          this.handleStatusEvent(
            sessionId,
            streamId,
            event.data as { message?: string; status?: string } | undefined,
          );
          break;

        case 'tool_use_started':
        case 'tool_use':
          if (event.name) {
            this.handleToolUseEvent(sessionId, streamId, {
              id: event.id || crypto.randomUUID(),
              name: event.name,
              input: event.input,
            });
          }
          break;

        case 'tool_result':
          if (event.id && event.result !== undefined) {
            this.handleToolResultEvent(sessionId, streamId, {
              tool_use_id: event.id,
              content: String(event.result),
              is_error: !!event.error,
              duration_ms: (event as { duration_ms?: number }).duration_ms,
            });
          }
          break;

        case 'done':
          this.handleDoneEvent(sessionId, streamId);
          break;

        case 'error':
        case 'chat:error':
          // `chat:error` is the legacy/worker-emitted namespace; the agent
          // server normalizes it to `error` today but we keep this branch as
          // a defensive fallback so rate-limit/usage-limit errors still
          // surface in the UI if the server ever forwards the raw name.
          this.handleErrorEvent(sessionId, streamId, event.data as StreamErrorEventData | undefined);
          break;

        case 'stream:end':
          // SSE stream ended without done event (client disconnect, network error, etc.)
          // Only transition to error if session is not already completed/done
          if (this.isCurrentStream(sessionId, streamId)) {
            const s = this.sessions.get(sessionId);
            if (s && s.phase !== 'completed' && s.phase !== 'aborted' && s.phase !== 'error') {
              console.warn('[stream-session-manager] SSE stream ended without done, transitioning to error');
              s.phase = 'error';
              s.error = 'Stream ended unexpectedly';
              s.completedAt = Date.now();
              this.notifyListeners(sessionId);
              this.notifyPhaseListeners(sessionId, s.phase);
              this.notifyErrorListeners(sessionId, s.error);
              this.notifyCompletedAtListeners(sessionId, s.completedAt);
            } else if (s) {
              console.log('[stream-session-manager] SSE stream ended but session already in phase:', s.phase);
            }
          }
          break;

        case 'checkpoint':
          // Checkpoint events - handle but don't change phase
          break;

        case 'permission':
          this.handlePermissionEvent(sessionId, streamId, event.data as { id: string; toolName: string; toolInput: Record<string, unknown>; mode?: string; expiresAt?: number } | undefined);
          break;

        case 'db:request':
          // Forward DB requests to agent server via IPC - don't handle here
          // The agent-server will route them to the database and forward responses
          this.handleAgentServerEvent(s, streamId, event);
          break;

        case 'db_persisted':
        case 'chat:db_persisted':
        case 'title_generated':
        case 'chat:title_generated':
          this.handleAgentServerEvent(s, streamId, event);
          break;

        case 'token_usage':
          this.handleTokenUsageEvent(sessionId, streamId, event.data as { inputTokens: number; outputTokens: number; cacheHitTokens?: number; cacheCreationTokens?: number } | undefined);
          break;

        case 'context_usage':
          this.handleContextUsageEvent(sessionId, streamId, event.data as { usedTokens?: number; contextWindow?: number; percentFull?: number } | undefined);
          break;

        case 'agent_progress':
          // The wire format is a flat object emitted by the worker:
          //   { type: 'chat:agent_progress', sessionId: <parent>, agentEventType,
          //     agentId, agentType, agentName, agentDescription, agentSessionId,
          //     data?, toolName?, toolInput?, toolResult?, duration? }
          // The SSE client already stripped the chat:* prefix to produce
          // AgentHTTPClient normalizes SSE into `{ type, data }`, where
          // `data` contains the flat worker payload. Older callers passed the
          // flat object directly, so handle both shapes.
          this.handleAgentProgressEvent(
            sessionId,
            streamId,
            (event.data ?? event) as unknown as AgentProgressEvent,
          );
          break;

        case 'skill_review_started':
          this.handleSkillReviewStartedEvent(sessionId);
          break;

        case 'skill_review_completed':
          this.handleSkillReviewCompletedEvent(sessionId, event.data);
          break;

        default:
          // Try to handle as generic message with data
          if (event.data) {
            this.handleAgentServerEvent(s, streamId, event);
          }
          break;
      }
    });

    // Store cleanup function
    this.messagePortCleanup.set(sessionId, cleanup);

    // Start chat via Agent Server HTTP
    // DEBUG: log files received
    console.log('[stream-session-manager] startStream files:', params.files?.map(f => ({
      name: f.name,
      hasText: !!f.text,
      textLength: f.text?.length ?? 0,
      hasImageChunks: !!f.imageChunks,
    })) ?? []);
    try {
      await client.startChat(sessionId, params.content, {
        model: params.model,
        maxTokens: params.maxTokens,
        systemPrompt: params.systemPrompt,
        language: params.language,
        permissionModeOverride: params.permissionModeOverride,
        files: params.files,
        agentProfileId: params.agentProfileId,
        outputStyleConfig: params.outputStyleConfig,
        displayContent: params.displayContent,
        mode: params.mode,
        titleGenerationModel: params.titleGenerationModel,
        titleGenerationModelConfig: params.titleGenerationModelConfig,
        providerConfig: params.providerConfig as unknown as Record<string, unknown> | undefined,
        workingDirectory: params.workingDirectory,
        wikiAgentEnabled: params.wikiAgentEnabled,
        defaultWorkspaceDirectory: params.defaultWorkspaceDirectory,
        securityScanEnabled: params.securityScanEnabled,
        effort: params.effort,
        conductorMode: params.conductorMode,
        conductorCanvasId: params.conductorCanvasId,
        backgroundTaskResume: params.backgroundTaskResume,
      } satisfies ChatOptions);
    } catch (error) {
      console.error('[stream-session-manager] Agent Server error:', error);
      const s = this.sessions.get(sessionId);
      if (s && this.isCurrentStream(sessionId, streamId)) {
        s.phase = 'error';
        s.error = error instanceof Error ? error.message : String(error);
        s.completedAt = Date.now();
        this.notifyListeners(sessionId);
        this.notifyPhaseListeners(sessionId, s.phase);
        this.notifyErrorListeners(sessionId, s.error);
        this.notifyCompletedAtListeners(sessionId, s.completedAt);
      }
    }
  }

  private handleAgentServerEvent(
    state: ReturnType<typeof this.getOrCreateState>,
    streamId: string,
    event: { type: string; data?: unknown }
  ): void {
    // Handle events where type is embedded in data
    const data = event.data as Record<string, unknown> | undefined;
    if (!data) return;

    const eventType = (data.type as string | undefined);
    // Strip 'chat:' prefix for consistent event type matching (events may arrive as 'text' or 'chat:text')
    const normalizedType = typeof eventType === 'string' ? eventType.replace(/^chat:/, '') : undefined;
    if (normalizedType) {
      // Dispatch to appropriate handler
      if (normalizedType === 'text' && typeof data.content === 'string') {
        this.handleTextEvent(state.sessionId, streamId, data.content);
      } else if (normalizedType === 'thinking' && typeof data.content === 'string') {
        this.handleThinkingEvent(state.sessionId, streamId, data.content);
      } else if ((normalizedType === 'tool_use_started' || normalizedType === 'tool_use') && data.name) {
        this.handleToolUseEvent(state.sessionId, streamId, {
          id: (data.id as string) || crypto.randomUUID(),
          name: data.name as string,
          input: data.input as Record<string, unknown>,
        });
      } else if (normalizedType === 'tool_result' && data.id) {
        this.handleToolResultEvent(state.sessionId, streamId, {
          tool_use_id: data.id as string,
          content: String(data.result),
          is_error: !!(data as { error?: string }).error,
          duration_ms: (data as { duration_ms?: number }).duration_ms,
        });
      } else if (normalizedType === 'db_persisted') {
        this.handleDbPersistedEvent(state.sessionId, streamId, data as { success?: boolean; messageCount?: number; reason?: string });
      } else if (normalizedType === 'title_generated') {
        this.handleTitleGeneratedEvent(state.sessionId, streamId, data as { title?: string });
      } else if (normalizedType === 'token_usage') {
        this.handleTokenUsageEvent(state.sessionId, streamId, data as { inputTokens: number; outputTokens: number; cacheHitTokens?: number; cacheCreationTokens?: number });
      } else if (normalizedType === 'context_usage') {
        this.handleContextUsageEvent(state.sessionId, streamId, data as { usedTokens?: number; contextWindow?: number; percentFull?: number });
      } else if (normalizedType === 'status') {
        this.handleStatusEvent(state.sessionId, streamId, data as { message?: string; status?: string });
      }
      return;
    }

    // Some status events arrive as { type: 'status', data: { message } } without data.type.
    if (event.type === 'status') {
      this.handleStatusEvent(state.sessionId, streamId, data as { message?: string; status?: string });
    }
  }

  private handleTextEvent(sessionId: string, streamId: string, text: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    if (s.phase === 'starting') {
      s.phase = 'streaming';
      this.notifyPhaseListeners(sessionId, s.phase);
    } else if (s.phase === 'awaiting_permission') {
      // B8: do NOT clear pendingPermissionRequest or change phase here.
      // While we wait for the user to click allow/deny, the agent is
      // blocked and should not be emitting text — but it sometimes does
      // (status text, the LLM continuing to "think out loud" between
      // tool calls, agent metadata messages). Touching `pendingPermissionRequest`
      // here would silently drop the user's in-flight prompt and produce
      // the "Permission denied by user" symptom (user clicks allow, but
      // the local prompt is already gone, the click becomes a no-op or
      // hits the phase-guard and the agent times out at 5min).
      //
      // The pending state should only be cleared by either:
      //   1. a fresh chat:permission event (handled by handlePermissionEvent),
      //   2. an explicit user resolve (respondedToPermission),
      //   3. stream finalization (handleDoneEvent / handleErrorEvent).
    }
    s.streamingText += text;
    s.finalMessageContent = s.streamingText;
    if (s.statusText) {
      s.statusText = undefined;
      this.notifyStatusTextListeners(sessionId, s.statusText);
    }
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
  }

  private handleStatusEvent(
    sessionId: string,
    streamId: string,
    data: { message?: string; status?: string } | undefined,
  ): void {
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    const nextStatus = data?.message || data?.status;
    s.statusText = nextStatus && nextStatus.trim() ? nextStatus : undefined;
    this.notifyStatusTextListeners(sessionId, s.statusText);
    this.notifyListeners(sessionId);
    this.resetIdleTimeout(sessionId);
  }

  private handleThinkingEvent(sessionId: string, streamId: string, text: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    s.streamingThinking = (s.streamingThinking || '') + text;
    const lastEvent = s.streamingEvents[s.streamingEvents.length - 1];
    if (lastEvent && lastEvent.type === 'thinking') {
      lastEvent.content += text;
    } else {
      s.streamingEvents = [...s.streamingEvents, { type: 'thinking', content: text, timestamp: Date.now() }];
    }
    this.notifyThinkingListeners(sessionId, s.streamingThinking);
    this.notifyStreamingEventsListeners(sessionId);
    this.resetIdleTimeout(sessionId);
  }

  private handleToolUseEvent(sessionId: string, streamId: string, toolUse: { id: string; name: string; input: unknown }): void {
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    // Skip if this tool_use was already loaded from DB on page refresh
    if (s.loadedToolUseIds.has(toolUse.id)) return;
    // B8: do not clear pendingPermissionRequest or flip the phase on
    // tool_use events while we are awaiting a user decision. The agent
    // is blocked; any tool_use it emits before resolve is a stale
    // streaming artifact and must not evict the in-flight prompt.
    // (See handleTextEvent for the full rationale.)
    if (s.phase === 'awaiting_permission') {
      // No-op: the next chat:permission event for the new tool will
      // either replace the prompt (different id) or be deduplicated
      // by usePermissions' lastSeenIdRef.
    }
    const info: ToolUseInfo = {
      id: toolUse.id,
      name: toolUse.name,
      input: toolUse.input as Record<string, unknown>,
    };
    const existingIndex = s.toolUses.findIndex((existing) => existing.id === toolUse.id);
    if (existingIndex !== -1) {
      s.toolUses = s.toolUses.map((existing, index) => index === existingIndex ? info : existing);
      s.streamingEvents = s.streamingEvents.map((event) => {
        if (event.type === 'tool_use' && event.toolUse.id === toolUse.id) {
          return { ...event, toolUse: info };
        }
        return event;
      });
      this.notifyToolListeners(sessionId);
      this.notifyStreamingEventsListeners(sessionId);
      this.resetIdleTimeout(sessionId);
      return;
    }
    s.toolUses = [...s.toolUses, info];
    s.streamingEvents = [...s.streamingEvents, { type: 'tool_use', toolUse: info, timestamp: Date.now() }];
    if (toolUse.name === 'show_widget') {
      const widgetCode = (toolUse.input as Record<string, unknown>)?.widget_code;
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
  }

  private handleToolResultEvent(sessionId: string, streamId: string, result: { tool_use_id: string; content: string; is_error: boolean; duration_ms?: number }): void {
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    const existingResultIndex = s.toolResults.findIndex((existing) => existing.tool_use_id === result.tool_use_id);
    if (s.loadedToolResultIds.has(result.tool_use_id) && existingResultIndex !== -1) return;
    // B8: same rationale as handleToolUseEvent — do not touch
    // pendingPermissionRequest or phase during the user's decision window.
    if (s.phase === 'awaiting_permission') {
      // No-op.
    }
    const info: ToolResultInfo = {
      tool_use_id: result.tool_use_id,
      content: result.content,
      is_error: result.is_error,
      duration_ms: result.duration_ms,
    };
    if (existingResultIndex !== -1) {
      s.toolResults = s.toolResults.map((existing, index) => index === existingResultIndex ? info : existing);
    } else {
      s.toolResults = [...s.toolResults, info];
    }
    s.streamingEvents = [...s.streamingEvents, { type: 'tool_result', toolResult: info, timestamp: Date.now() }];
    if (s.phase === 'tool_use') {
      s.phase = 'streaming';
      this.notifyPhaseListeners(sessionId, s.phase);
    }
    this.notifyToolListeners(sessionId);
    this.notifyStreamingEventsListeners(sessionId);
    this.resetIdleTimeout(sessionId);
  }

  private handleAgentProgressEvent(sessionId: string, streamId: string, data: AgentProgressEvent | undefined): void {
    const s = this.sessions.get(sessionId);
    // Background sub-agents can outlive the parent turn that spawned them.
    // Do not gate these events on streamId, or late progress keeps the
    // bottom sub-agent panel alive but never reaches message-local rows.
    void streamId;
    if (!s) return;
    if (!data) return;

    // The worker emits events with `agentEventType` and `agentSessionId` (the
    // sub-agent's session). The AgentProgressEvent shape used by hooks expects
    // `type` and `sessionId`. Remap defensively so either shape works.
    const nested = (data as { data?: unknown }).data;
    const rawData = nested && typeof nested === 'object'
      ? nested as AgentProgressEvent
      : data;
    const raw = rawData as AgentProgressEvent & {
      agentEventType?: AgentProgressEvent['type'];
      agentSessionId?: string;
      agentId?: string;
      agentType?: string;
      agentName?: string;
      agentDescription?: string;
    };
    const rawType = raw.type as string | undefined;
    const eventType = raw.agentEventType
      ?? (rawType === 'agent_progress' || rawType === 'chat:agent_progress'
        ? undefined
        : raw.type);

    const event: AgentProgressEvent = {
      ...rawData,
      type: eventType as AgentProgressEvent['type'],
      sessionId: raw.agentSessionId ?? raw.sessionId,
      agentId: raw.agentId,
      agentType: raw.agentType,
      agentName: raw.agentName,
      agentDescription: raw.agentDescription,
      receivedAt: raw.receivedAt ?? Date.now(),
    };

    s.agentProgressEvents = [...s.agentProgressEvents, event];
    this.notifyAgentProgressListeners(sessionId, event);
    this.resetIdleTimeout(sessionId);
  }

  /**
   * The SelfImprover has spawned a background sub-agent to review
   * the conversation for skill candidates. Notify all UI listeners
   * so they can show a non-blocking indicator.
   *
   * We don't gate on `isCurrentStream` because the sub-agent can
   * outlive the user's current turn — by the time it returns, the
   * SSE stream may have already sent the 'done' event for the
   * user-facing turn. The session is what matters here, not the
   * specific stream.
   */
  private handleSkillReviewStartedEvent(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const event: SkillReviewEvent = { phase: 'started' };
    for (const listener of s.fieldListeners.skillReview) {
      try {
        listener(event);
      } catch (err) {
        console.warn('[stream-session-manager] skillReview listener threw:', err);
      }
    }
  }

  private handleSkillReviewCompletedEvent(
    sessionId: string,
    data: unknown,
  ): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const payload = (data ?? {}) as Partial<SkillReviewEvent>;
    const event: SkillReviewEvent = {
      phase: 'completed',
      passed: payload.passed,
      score: payload.score,
      feedback: payload.feedback,
      skillName: payload.skillName,
      iterations: payload.iterations,
      maxIterations: payload.maxIterations,
      finalPath: payload.finalPath,
      error: payload.error,
    };
    for (const listener of s.fieldListeners.skillReview) {
      try {
        listener(event);
      } catch (err) {
        console.warn('[stream-session-manager] skillReview listener threw:', err);
      }
    }
  }

  private handlePermissionEvent(sessionId: string, streamId: string, data: { id: string; toolName: string; toolInput: Record<string, unknown>; mode?: string; expiresAt?: number } | undefined): void {
    if (!data) return;
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    s.phase = 'awaiting_permission';
    this.notifyPhaseListeners(sessionId, s.phase);
    const event: PermissionRequestEvent = {
      id: data.id,
      toolName: data.toolName,
      toolInput: data.toolInput,
      mode: (data.mode as PermissionRequestEvent['mode']) || 'generic',
      expiresAt: data.expiresAt || Date.now() + 60000,
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
  }

  private handleTokenUsageEvent(
    sessionId: string,
    streamId: string,
    data: { inputTokens?: number; outputTokens?: number; cacheHitTokens?: number; cacheCreationTokens?: number; input_tokens?: number; output_tokens?: number; cache_hit_tokens?: number; cache_creation_tokens?: number; total_tokens?: number } | undefined
  ): void {
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    if (!data) return;

    const inputTokens = data.inputTokens ?? data.input_tokens ?? 0;
    const outputTokens = data.outputTokens ?? data.output_tokens ?? 0;
    const hitTokens = data.cacheHitTokens ?? data.cache_hit_tokens ?? 0;
    const createTokens = data.cacheCreationTokens ?? data.cache_creation_tokens ?? 0;

    s.tokenUsage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: data.total_tokens ?? (inputTokens + outputTokens),
      cache_hit_tokens: hitTokens,
      cache_creation_tokens: createTokens,
    };
    this.notifyTokenUsageListeners(sessionId, s.tokenUsage);
    this.notifyListeners(sessionId);

    // Do NOT write tokenUsage into the frontend message store here.
    // During streaming the message array does not yet contain the current
    // assistant message, so this would attach usage to the *previous*
    // assistant. The authoritative token_usage is written by the agent
    // process when it persists the canonical assistant message.
  }

  private handleContextUsageEvent(
    sessionId: string,
    streamId: string,
    data: { usedTokens?: number; contextWindow?: number; percentFull?: number } | undefined,
  ): void {
    const state = this.sessions.get(sessionId);
    if (!state || !this.isCurrentStream(sessionId, streamId) || !data) return;

    const contextWindow = data.contextWindow ?? 0;
    const usedTokens = data.usedTokens ?? 0;
    if (contextWindow <= 0 || usedTokens < 0) return;

    state.contextUsage = {
      usedTokens,
      contextWindow,
      percentFull: data.percentFull ?? (usedTokens / contextWindow) * 100,
    };
    this.notifyContextUsageListeners(sessionId, state.contextUsage);
    this.notifyListeners(sessionId);
  }

  private handleDoneEvent(sessionId: string, streamId: string): void {
    console.log(`[stream-session-manager] handleDoneEvent: ${sessionId.slice(0, 8)}, streamId=${streamId.slice(0, 8)}`);
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    s.phase = 'completed';
    s.pendingPermissionRequest = null;
    s.statusText = undefined;
    s.completedAt = Date.now();
    this.notifyPhaseListeners(sessionId, s.phase);
    this.notifyStatusTextListeners(sessionId, s.statusText);
    this.notifyCompletedAtListeners(sessionId, s.completedAt);
    this.flushPendingText(sessionId, streamId);
    this.notifyListeners(sessionId);
    this.clearIdleTimeout(sessionId);
    this.autoStartQueuedStream(sessionId);
    this.startPendingBackgroundResume(sessionId);
    showMessageCompletionNotification(sessionId).catch(() => {
      // Ignore notification errors
    });
  }

  private handleErrorEvent(sessionId: string, streamId: string, data: StreamErrorEventData | undefined): void {
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    this.flushPendingText(sessionId, streamId);
    const normalizedError = normalizeStreamError(data);
    s.phase = 'error';
    s.statusText = undefined;
    s.error = normalizedError.message;
    s.errorCode = normalizedError.code;
    s.completedAt = Date.now();
    this.notifyPhaseListeners(sessionId, s.phase);
    this.notifyStatusTextListeners(sessionId, s.statusText);
    this.notifyErrorListeners(sessionId, s.error);
    this.notifyCompletedAtListeners(sessionId, s.completedAt);
    this.notifyListeners(sessionId);
    this.clearIdleTimeout(sessionId);
    this.autoStartQueuedStream(sessionId);
    this.startPendingBackgroundResume(sessionId);
  }

  private handleDbPersistedEvent(
    sessionId: string,
    streamId: string,
    event: { success?: boolean; messageCount?: number; reason?: string; tokenUsage?: { inputTokens: number; outputTokens: number; cacheHitTokens?: number; cacheCreationTokens?: number } }
  ): void {
    const startTime = performance.now();
    console.log(`[stream-session-manager] handleDbPersistedEvent START: ${sessionId.slice(0, 8)}, success=${event.success}`);
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) {
      console.log(`[stream-session-manager] handleDbPersistedEvent SKIP: session or stream mismatch`);
      return;
    }

    // Update tokenUsage from persist event if available
    if (event.tokenUsage) {
      s.tokenUsage = {
        input_tokens: event.tokenUsage.inputTokens,
        output_tokens: event.tokenUsage.outputTokens,
        total_tokens: event.tokenUsage.inputTokens + event.tokenUsage.outputTokens,
        cache_hit_tokens: event.tokenUsage.cacheHitTokens,
        cache_creation_tokens: event.tokenUsage.cacheCreationTokens,
      };
    }

    s.dbPersisted = {
      success: event.success ?? false,
      reason: event.reason,
      generation: s.generation,
      messageCount: event.messageCount ?? 0,
      timestamp: Date.now(),
    };
    console.log(`[stream-session-manager] handleDbPersistedEvent notify listeners: ${s.dbPersistedListeners.size}`);

    // Notify listeners for db_persisted subscription
    for (const listener of s.dbPersistedListeners) {
      try {
        listener({
          success: s.dbPersisted.success,
          reason: s.dbPersisted.reason,
          generation: s.dbPersisted.generation,
          messageCount: s.dbPersisted.messageCount,
          timestamp: s.dbPersisted.timestamp,
        });
      } catch {
        // ignore listener errors
      }
    }

    // Do NOT write tokenUsage into the frontend message store here.
    // The optimistic assistant message has a different id than the
    // canonical DB row, and the message array does not yet contain the
    // current assistant message. The authoritative token_usage is written
    // by the agent process; App.tsx reloads canonical messages from DB.

    console.log(`[stream-session-manager] handleDbPersistedEvent DONE: ${sessionId.slice(0, 8)}, elapsed=${(performance.now() - startTime).toFixed(1)}ms`);
  }

  private handleTitleGeneratedEvent(
    sessionId: string,
    streamId: string,
    event: { title?: string }
  ): void {
    console.log(`[stream-session-manager] handleTitleGeneratedEvent: sessionId=${sessionId.slice(0, 8)}, title="${event.title}"`);
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) {
      console.log(`[stream-session-manager] handleTitleGeneratedEvent SKIP: session or stream mismatch`);
      return;
    }
    if (!event.title) {
      console.log(`[stream-session-manager] handleTitleGeneratedEvent SKIP: no title`);
      return;
    }

    console.log(`[stream-session-manager] Updating thread title: "${event.title}"`);
    useConversationStore.getState().updateThreadTitle(sessionId, event.title);
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

  /**
   * Subscribe to skill-review lifecycle events for this session.
   * Fires with `phase: 'started'` when the SelfImprover spawns a
   * background sub-agent, and `phase: 'completed'` when the
   * sub-agent returns a verdict. The UI uses this to surface
   * "Self-improving..." indicators without blocking the user.
   */
  subscribeToSkillReview(
    sessionId: string,
    listener: (event: SkillReviewEvent) => void,
  ): () => void {
    const state = this.getOrCreateState(sessionId);
    state.fieldListeners.skillReview.add(listener);
    return () => { state.fieldListeners.skillReview.delete(listener); };
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

  subscribeToError(sessionId: string, listener: (error: StreamingError | null) => void): () => void {
    const state = this.getOrCreateState(sessionId);
    state.fieldListeners.error.add(listener);
    listener(state.error ? { message: state.error, code: state.errorCode } : null);
    return () => { state.fieldListeners.error.delete(listener); };
  }

  subscribeToErrorFull(sessionId: string, listener: (error: StreamingError | null) => void): () => void {
    return this.subscribeToError(sessionId, listener);
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
    const info: StreamingError | null = error ? { message: error, code: state.errorCode } : null;
    state.fieldListeners.error.forEach((listener) => {
      try { listener(info); } catch (e) { console.error(e); }
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
export const resumeBackgroundTask = (sessionId: string) => streamSessionManager.resumeBackgroundTask(sessionId);
export const stopStream = (sessionId: string, reason?: string) => streamSessionManager.stopStream(sessionId, reason);
export const canSend = (sessionId: string) => streamSessionManager.canSend(sessionId);
export const enqueueMessage = (sessionId: string, params: StartStreamParams) => streamSessionManager.enqueueMessage(sessionId, params);
export const getPendingMessages = (sessionId: string) => streamSessionManager.getPendingMessages(sessionId);
export const clearQueuedMessages = (sessionId: string) => streamSessionManager.clearQueuedMessages(sessionId);
export const hasQueuedMessages = (sessionId: string) => streamSessionManager.hasQueuedMessages(sessionId);
export const registerLoadedMessages = (sessionId: string, messages: ReadonlyArray<{ role: string; content: string | unknown[]; msgType?: string }>) =>
  streamSessionManager.registerLoadedMessages(sessionId, messages);

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
export const subscribeToSkillReview = (sessionId: string, listener: (event: SkillReviewEvent) => void) =>
  streamSessionManager.subscribeToSkillReview(sessionId, listener);
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
export const subscribeToError = (sessionId: string, listener: (error: StreamingError | null) => void) =>
  streamSessionManager.subscribeToError(sessionId, listener);
export const subscribeToRetry = (sessionId: string, listener: (info: { attempt: number; maxAttempts: number; delayMs: number; message: string }) => void) =>
  streamSessionManager.subscribeToRetry(sessionId, listener);
export const subscribeToStreamingEvents = (sessionId: string, listener: (events: StreamingEvent[]) => void) =>
  streamSessionManager.subscribeToStreamingEvents(sessionId, listener);

// Re-export conductor types and session manager methods
export const startConductorStream = (params: { canvasId: string; content: string; snapshot?: unknown; model?: string; language?: string; visionModel?: string; permissionMode?: string }) =>
  streamSessionManager.startConductorStream(params);

export const stopConductorStream = (canvasId: string) =>
  streamSessionManager.stopConductorStream(canvasId);

export const subscribeToConductorEvents = (canvasId: string, listener: (events: ConductorEvent[]) => void) =>
  streamSessionManager.subscribeToConductorEvents(canvasId, listener);

export const subscribeToConductorPhase = (canvasId: string, listener: (phase: ConductorPhase) => void) =>
  streamSessionManager.subscribeToConductorPhase(canvasId, listener);

export const subscribeToConductorError = (canvasId: string, listener: (error: string | null) => void) =>
  streamSessionManager.subscribeToConductorError(canvasId, listener);

export const handleConductorPortEvent = (canvasId: string, eventType: string, data: unknown) =>
  streamSessionManager.handleConductorPortEvent(canvasId, eventType, data);

export const getConductorSession = (canvasId: string) =>
  streamSessionManager.getConductorSession(canvasId);

export const clearConductorSession = (canvasId: string) =>
  streamSessionManager.clearConductorSession(canvasId);
