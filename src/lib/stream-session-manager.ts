// stream-session-manager.ts - Client-side actor manager for chat sessions
//
// Connects to Agent Server via HTTP+SSE for chat streaming.

import type { SessionStreamSnapshot, ToolUseInfo, ToolResultInfo, TokenUsage, ContextUsage, StreamPhase } from '@/types/message';
import type {
  ResearchActivityItem,
  ResearchPanelFinding,
  ResearchPanelQuestion,
  ResearchPendingRequest,
  ResearchSessionSnapshot,
  ResearchPlanDetail,
  ResearchPersistedCitation,
  ResearchPersistedEvent,
  ResearchPersistedSource,
  ResearchReportArtifact,
} from '@/types/research';
import type { PermissionRequestEvent } from '@/types/stream';
import { STREAM_IDLE_TIMEOUT_MS } from './constants';
import { showMessageCompletionNotification } from './notification';
import { getAgentServerClient } from './agent-http-client';
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
async function getProviderConfigForModel(model: string | undefined): Promise<ProviderConfig | null> {
  if (!model) {
    return getActiveProviderConfig();
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

/** Conductor-specific streaming event (extends StreamingEvent with conductor metadata) */
export type ConductorEvent =
  | { type: 'text'; content: string; timestamp: number }
  | { type: 'thinking'; content: string; timestamp: number }
  | { type: 'tool_use'; toolUse: ToolUseInfo; timestamp: number }
  | { type: 'tool_result'; toolResult: ToolResultInfo; timestamp: number }
  | { type: 'status'; status: string; timestamp: number }
  | { type: 'error'; message: string; timestamp: number }
  | { type: 'done'; timestamp: number };

interface ResearchQuestionEventData {
  kind: 'clarification' | 'plan_approval' | 'update';
  questions: Array<{
    id: string;
    text: string;
    type: 'text' | 'choice';
    required: boolean;
    options?: string[];
  }>;
  allowSkip: boolean;
  timestamp: number;
  requestId?: string;
  changeType?: 'added' | 'obsoleted';
  complexity?: string;
  maxIterations?: number;
  approvalRequired?: boolean;
  plan?: ResearchPlanDetail;
}

interface ResearchProgressEventData {
  phase: string;
  iteration: number;
  maxIterations: number;
  coverage: number;
  findingsCount: number;
  questionCount: number;
  timestamp: number;
}

interface ResearchIterationEventData {
  iteration: number;
  maxIterations: number;
  phase: 'start' | 'complete' | 'early_stop';
  questions: string[];
  findingsCount: number;
  coverage: number;
  timestamp: number;
}

interface ResearchFindingEventData {
  finding: ResearchPanelFinding;
  timestamp: number;
}

interface ResearchComplexityEventData {
  complexity: string;
  maxIterations: number;
  description: string;
  timestamp: number;
}

interface ResearchCompleteEventData {
  summary: string;
  iterations: number;
  coverage: number;
  findingsCount: number;
  timestamp: number;
}

interface ResearchErrorEventData {
  message: string;
  timestamp: number;
}

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

interface ResearchSessionState extends ResearchSessionSnapshot {
  listeners: Set<(snapshot: ResearchSessionSnapshot) => void>;
}

function createInitialResearchState(sessionId: string): Omit<ResearchSessionState, 'listeners'> {
  return {
    sessionId,
    mode: null,
    active: false,
    stage: 'idle',
    originalQuery: '',
    complexity: undefined,
    complexityDescription: undefined,
    phase: undefined,
    maxIterations: 0,
    currentIteration: 0,
    coverage: 0,
    findingsCount: 0,
    questionCount: 0,
    planQuestions: [],
    plan: null,
    findings: [],
    reportText: '',
    summary: undefined,
    error: null,
    pendingRequest: null,
    activities: [],
    startedAt: null,
    completedAt: null,
    runId: null,
    runStatus: null,
    planSteps: [],
    progressSummary: null,
    visitedPagesCount: 0,
    persistedEvents: [],
    persistedSources: [],
    persistedCitations: [],
    reportArtifact: null,
  };
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
    finalMessageContent: state.finalMessageContent,
    toolTimeoutInfo: state.toolTimeoutInfo,
    toolProgressInfo: state.toolProgressInfo,
    dbPersisted: state.dbPersisted,
  };
}

function isActivePhase(phase: StreamPhase): boolean {
  return ACTIVE_PHASES.includes(phase);
}

function mapPhaseToStageAndRunStatus(
  phase: string | undefined,
  runStatus: string | null,
): ResearchSessionSnapshot['stage'] {
  if (runStatus) {
    switch (runStatus) {
      case 'classifying':
      case 'planning':
        return 'planning';
      case 'awaiting_clarification':
        return 'clarifying';
      case 'awaiting_approval':
        return 'awaiting_plan_approval';
      case 'running':
        return 'researching';
      case 'synthesizing':
        return 'synthesizing';
      case 'completed':
        return 'complete';
      case 'failed':
        return 'error';
      case 'aborted':
        return 'aborted';
    }
  }
  switch (phase) {
    case 'planning':
      return 'planning';
    case 'awaiting_plan_approval':
      return 'awaiting_plan_approval';
    case 'clarifying':
      return 'clarifying';
    case 'researching':
      return 'researching';
    case 'synthesizing':
      return 'synthesizing';
    case 'complete':
      return 'complete';
    case 'error':
      return 'error';
    case 'aborted':
      return 'aborted';
    default:
      return 'idle';
  }
}

function parsePersistedResearchEvent(row: ResearchPersistedEvent): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

class StreamSessionManager {
  private sessions: Map<string, SessionState> = new Map();
  private conductorSessions: Map<string, ConductorSessionState> = new Map();
  private researchSessions: Map<string, ResearchSessionState> = new Map();
  private pendingMessages: Map<string, StartStreamParams[]> = new Map();
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
        const resultData = data as { id: string; result: unknown; error?: boolean };
        const result: ToolResultInfo = {
          tool_use_id: resultData.id,
          content: typeof resultData.result === 'string' ? resultData.result : JSON.stringify(resultData.result),
          is_error: resultData.error || false,
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
    this.pendingMessages.set(sessionId, []);
  }

  hasQueuedMessages(sessionId: string): boolean {
    const queue = this.pendingMessages.get(sessionId);
    return !!queue && queue.length > 0;
  }

  private autoStartQueuedStream(sessionId: string): void {
    const queue = this.pendingMessages.get(sessionId);
    if (!queue || queue.length === 0) return;
    const next = queue.shift()!;
    this.pendingMessages.set(sessionId, queue);
    setTimeout(() => {
      void this.startStream(next);
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

  async startStream(params: StartStreamParams): Promise<StartStreamResult> {
    const { sessionId, content, model, maxTokens, systemPrompt, language, initialGeneration, permissionModeOverride, files, agentProfileId, outputStyleConfig, titleGenerationModel, titleGenerationModelConfig: titleGenConfigParam, mode, wikiAgentEnabled, defaultWorkspaceDirectory, securityScanEnabled } = params;

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

    if (mode === 'research') {
      this.resetResearchState(sessionId, content);
    } else {
      const researchState = this.getOrCreateResearchState(sessionId);
      if (researchState.mode !== 'research') {
        Object.assign(researchState, createInitialResearchState(sessionId));
        this.notifyResearchListeners(sessionId);
      }
    }

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
    const providerConfig = await getProviderConfigForModel(model);
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
      }
    }

    void this.startStreamViaAgentServer(
      sessionId,
      streamId,
      { content, model, maxTokens, systemPrompt, permissionModeOverride, files, agentProfileId, outputStyleConfig, titleGenerationModel, titleGenerationModelConfig, providerConfig, workingDirectory, mode, wikiAgentEnabled, defaultWorkspaceDirectory, securityScanEnabled },
      nextGeneration
    );

    return { streamId, generation: nextGeneration };
  }

  private async startStreamViaAgentServer(
    sessionId: string,
    streamId: string,
    params: {
      content: string;
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
            });
          }
          break;

        case 'done':
          this.handleDoneEvent(sessionId, streamId);
          break;

        case 'error':
          this.handleErrorEvent(sessionId, streamId, event.data as { message?: string } | undefined);
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

        case 'research_phase':
          this.handleResearchPhaseEvent(sessionId, event.data as { from: string; to: string; timestamp: number } | undefined);
          break;

        case 'research_questions':
          this.handleResearchQuestionsEvent(sessionId, event.data as ResearchQuestionEventData | undefined);
          break;

        case 'research_iteration':
          this.handleResearchIterationEvent(sessionId, event.data as ResearchIterationEventData | undefined);
          break;

        case 'research_finding':
          this.handleResearchFindingEvent(sessionId, event.data as ResearchFindingEventData | undefined);
          break;

        case 'research_progress':
          this.handleResearchProgressEvent(sessionId, event.data as ResearchProgressEventData | undefined);
          break;

        case 'research_synthesis_chunk':
          this.handleResearchSynthesisChunkEvent(sessionId, event.data as { delta: string; total: number; timestamp: number } | undefined);
          break;

        case 'research_complete':
          this.handleResearchCompleteEvent(sessionId, event.data as ResearchCompleteEventData | undefined);
          break;

        case 'research_complexity':
          this.handleResearchComplexityEvent(sessionId, event.data as ResearchComplexityEventData | undefined);
          break;

        case 'research_error':
          this.handleResearchErrorEvent(sessionId, event.data as ResearchErrorEventData | undefined);
          break;

        case 'research_run_status':
          this.handleResearchRunStatusEvent(sessionId, event.data as { runStatus: string; phase: string; timestamp: number } | undefined);
          break;

        case 'research_activity':
          this.handleResearchActivityEvent(sessionId, event.data as { activityId: string; kind: string; title: string; detail?: string; sequence: number; timestamp: number } | undefined);
          break;

        case 'research_plan_steps':
          this.handleResearchPlanStepsEvent(sessionId, event.data as { steps: Array<{ id: string; order: number; label: string }>; timestamp: number } | undefined);
          break;

        case 'agent_progress':
          this.handleAgentProgressEvent(sessionId, streamId, event.data as AgentProgressEvent | undefined);
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
        mode: params.mode,
        titleGenerationModel: params.titleGenerationModel,
        titleGenerationModelConfig: params.titleGenerationModelConfig,
        providerConfig: params.providerConfig as unknown as Record<string, unknown> | undefined,
        workingDirectory: params.workingDirectory,
        wikiAgentEnabled: params.wikiAgentEnabled,
        defaultWorkspaceDirectory: params.defaultWorkspaceDirectory,
        securityScanEnabled: params.securityScanEnabled,
      });
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
      } else if (normalizedType === 'tool_use' && data.name) {
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
      s.phase = 'streaming';
      s.pendingPermissionRequest = null;
      this.notifyPhaseListeners(sessionId, s.phase);
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
    if (s.phase === 'awaiting_permission') {
      s.phase = 'streaming';
      s.pendingPermissionRequest = null;
      this.notifyPhaseListeners(sessionId, s.phase);
    }
    const info: ToolUseInfo = {
      id: toolUse.id,
      name: toolUse.name,
      input: toolUse.input as Record<string, unknown>,
    };
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
    // Skip if this tool_result was already loaded from DB on page refresh
    if (s.loadedToolResultIds.has(result.tool_use_id)) return;
    if (s.phase === 'awaiting_permission') {
      s.phase = 'streaming';
      s.pendingPermissionRequest = null;
      this.notifyPhaseListeners(sessionId, s.phase);
    }
    const info: ToolResultInfo = {
      tool_use_id: result.tool_use_id,
      content: result.content,
      is_error: result.is_error,
      duration_ms: result.duration_ms,
    };
    s.toolResults = [...s.toolResults, info];
    s.streamingEvents = [...s.streamingEvents, { type: 'tool_result', toolResult: info, timestamp: Date.now() }];
    this.notifyToolListeners(sessionId);
    this.notifyStreamingEventsListeners(sessionId);
    this.resetIdleTimeout(sessionId);
  }

  private handleAgentProgressEvent(sessionId: string, streamId: string, data: AgentProgressEvent | undefined): void {
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    if (!data) return;

    const event: AgentProgressEvent = {
      ...data,
      receivedAt: data.receivedAt ?? Date.now(),
    };

    s.agentProgressEvents = [...s.agentProgressEvents, event];
    this.notifyAgentProgressListeners(sessionId, event);
    this.resetIdleTimeout(sessionId);
  }

  private handleResearchPhaseEvent(
    sessionId: string,
    data: { from: string; to: string; timestamp: number } | undefined,
  ): void {
    if (!data) return;
    const state = this.getOrCreateResearchState(sessionId);
    state.active = true;
    state.phase = data.to;

    switch (data.to) {
      case 'clarification':
        state.stage = 'clarifying';
        break;
      case 'planning':
        state.stage = 'planning';
        break;
      case 'research_loop':
        state.stage = 'researching';
        state.pendingRequest = null;
        break;
      case 'synthesis':
      case 'interactive_report':
        state.stage = 'synthesizing';
        state.pendingRequest = null;
        break;
      case 'complete':
        state.stage = 'complete';
        state.active = false;
        state.pendingRequest = null;
        state.completedAt = state.completedAt || data.timestamp;
        break;
      case 'aborted':
        state.stage = 'aborted';
        state.active = false;
        state.completedAt = state.completedAt || data.timestamp;
        break;
      default:
        break;
    }

    this.pushResearchActivity(sessionId, {
      kind: 'phase',
      title: `Phase: ${data.to.replace(/_/g, ' ')}`,
      timestamp: data.timestamp,
    });
    this.notifyResearchListeners(sessionId);
  }

  private handleResearchQuestionsEvent(
    sessionId: string,
    data: ResearchQuestionEventData | undefined,
  ): void {
    if (!data) return;
    const state = this.getOrCreateResearchState(sessionId);
    state.active = true;

    if (data.kind === 'clarification' && data.requestId) {
      state.stage = 'clarifying';
      state.pendingRequest = {
        kind: 'clarification',
        requestId: data.requestId,
        questions: data.questions,
        allowSkip: data.allowSkip,
      };
      this.pushResearchActivity(sessionId, {
        kind: 'milestone',
        title: 'Waiting for clarification',
        detail: `${data.questions.length} question${data.questions.length === 1 ? '' : 's'} need input.`,
        timestamp: data.timestamp,
        tone: 'warning',
      });
    }

    if (data.kind === 'plan_approval') {
      state.plan = data.plan || null;
      const planQuestionMap = new Map(
        (state.plan?.researchQuestions || []).map((question) => [question.id, question])
      );
      state.planQuestions = data.questions.map((question) => {
        const matchedPlanQuestion = planQuestionMap.get(question.id);
        return {
          id: question.id,
          text: question.text,
          status: 'pending',
          purpose: matchedPlanQuestion?.purpose,
          priority: matchedPlanQuestion?.priority,
          dependsOn: matchedPlanQuestion?.dependsOn,
          requiredEvidence: matchedPlanQuestion?.requiredEvidence,
        };
      });
      state.questionCount = state.planQuestions.length;
      if (typeof data.maxIterations === 'number') {
        state.maxIterations = data.maxIterations;
      }
      if (data.complexity) {
        state.complexity = data.complexity;
      }
      if (data.requestId) {
        state.pendingRequest = {
          kind: 'plan_approval',
          requestId: data.requestId,
          questions: data.questions,
          allowSkip: false,
        };
      }
      state.stage = 'awaiting_plan_approval';
      this.pushResearchActivity(sessionId, {
        kind: 'milestone',
        title: 'Research plan ready',
        detail: `${data.questions.length} planned steps prepared for approval.`,
        timestamp: data.timestamp,
      });
    }

    if (data.kind === 'update') {
      const updateQuestions = data.questions.map((question) => ({
        id: question.id,
        text: question.text,
        status: data.changeType === 'obsoleted' ? ('obsolete' as const) : ('pending' as const),
      }));

      if (data.changeType === 'added') {
        const existingIds = new Set(state.planQuestions.map((question) => question.id));
        state.planQuestions = [
          ...state.planQuestions,
          ...updateQuestions.filter((question) => !existingIds.has(question.id)),
        ];
      } else if (data.changeType === 'obsoleted') {
        const obsoleteIds = new Set(updateQuestions.map((question) => question.id));
        state.planQuestions = state.planQuestions.map((question) =>
          obsoleteIds.has(question.id)
            ? { ...question, status: 'obsolete' }
            : question,
        );
      }

      this.pushResearchActivity(sessionId, {
        kind: 'milestone',
        title: data.changeType === 'obsoleted' ? 'Plan updated' : 'New research questions added',
        detail: `${data.questions.length} question${data.questions.length === 1 ? '' : 's'} ${data.changeType === 'obsoleted' ? 'closed' : 'added'}.`,
        timestamp: data.timestamp,
      });
    }

    this.notifyResearchListeners(sessionId);
  }

  private handleResearchComplexityEvent(
    sessionId: string,
    data: ResearchComplexityEventData | undefined,
  ): void {
    if (!data) return;
    const state = this.getOrCreateResearchState(sessionId);
    state.active = true;
    state.complexity = data.complexity;
    state.complexityDescription = data.description;
    state.maxIterations = data.maxIterations;
    this.pushResearchActivity(sessionId, {
      kind: 'milestone',
      title: 'Complexity classified',
      detail: data.description,
      timestamp: data.timestamp,
    });
    this.notifyResearchListeners(sessionId);
  }

  private handleResearchIterationEvent(
    sessionId: string,
    data: ResearchIterationEventData | undefined,
  ): void {
    if (!data) return;
    const state = this.getOrCreateResearchState(sessionId);
    state.active = true;
    state.currentIteration = data.iteration;
    state.maxIterations = data.maxIterations || state.maxIterations;
    state.coverage = data.coverage;
    state.findingsCount = Math.max(state.findingsCount, data.findingsCount);

    if (data.phase === 'start') {
      const activeTexts = new Set(data.questions);
      state.planQuestions = state.planQuestions.map((question) => ({
        ...question,
        status: activeTexts.has(question.text)
          ? 'active'
          : question.status === 'active'
            ? 'done'
            : question.status,
      }));
      this.pushResearchActivity(sessionId, {
        kind: 'search',
        title: `Iteration ${data.iteration} started`,
        detail: data.questions[0] || 'Collecting sources.',
        timestamp: data.timestamp,
      });
    } else {
      state.planQuestions = state.planQuestions.map((question) =>
        question.status === 'active'
          ? { ...question, status: 'done' }
          : question,
      );
      this.pushResearchActivity(sessionId, {
        kind: 'milestone',
        title: data.phase === 'early_stop' ? 'Research stopped early' : `Iteration ${data.iteration} complete`,
        detail: `${Math.round(data.coverage * 100)}% coverage, ${data.findingsCount} findings.`,
        timestamp: data.timestamp,
        tone: data.phase === 'early_stop' ? 'success' : 'neutral',
      });
    }

    this.notifyResearchListeners(sessionId);
  }

  private handleResearchProgressEvent(
    sessionId: string,
    data: ResearchProgressEventData | undefined,
  ): void {
    if (!data) return;
    const state = this.getOrCreateResearchState(sessionId);
    state.active = true;
    state.phase = data.phase;
    state.currentIteration = data.iteration || state.currentIteration;
    state.maxIterations = data.maxIterations || state.maxIterations;
    state.coverage = data.coverage;
    state.findingsCount = Math.max(state.findingsCount, data.findingsCount);
    state.questionCount = Math.max(state.questionCount, data.questionCount, state.planQuestions.length);

    if (data.phase === 'planning' && state.stage === 'idle') {
      state.stage = 'planning';
    } else if (data.phase === 'synthesis') {
      state.stage = 'synthesizing';
    }

    this.notifyResearchListeners(sessionId);
  }

  private handleResearchFindingEvent(
    sessionId: string,
    data: ResearchFindingEventData | undefined,
  ): void {
    if (!data) return;
    const state = this.getOrCreateResearchState(sessionId);
    state.active = true;
    state.findings = [data.finding, ...state.findings].slice(0, 80);
    state.findingsCount = Math.max(state.findingsCount, state.findings.length);
    this.pushResearchActivity(sessionId, {
      kind: 'finding',
      title: data.finding.title || data.finding.source || 'New source found',
      detail: data.finding.content,
      timestamp: data.timestamp,
      tone: data.finding.stance === 'contradicts' ? 'warning' : 'neutral',
    });
    this.notifyResearchListeners(sessionId);
  }

  private handleResearchSynthesisChunkEvent(
    sessionId: string,
    data: { delta: string; total: number; timestamp: number } | undefined,
  ): void {
    if (!data) return;
    const state = this.getOrCreateResearchState(sessionId);
    state.active = true;
    state.stage = 'synthesizing';
    state.pendingRequest = null;
    state.reportText += data.delta;
    this.notifyResearchListeners(sessionId);
  }

  private handleResearchCompleteEvent(
    sessionId: string,
    data: ResearchCompleteEventData | undefined,
  ): void {
    if (!data) return;
    const state = this.getOrCreateResearchState(sessionId);
    state.active = false;
    state.stage = 'complete';
    state.summary = data.summary;
    state.currentIteration = data.iterations;
    state.coverage = data.coverage;
    state.findingsCount = data.findingsCount;
    state.pendingRequest = null;
    state.completedAt = data.timestamp;
    this.pushResearchActivity(sessionId, {
      kind: 'milestone',
      title: 'Research complete',
      detail: data.summary,
      timestamp: data.timestamp,
      tone: 'success',
    });
    this.notifyResearchListeners(sessionId);
  }

  private handleResearchErrorEvent(
    sessionId: string,
    data: ResearchErrorEventData | undefined,
  ): void {
    if (!data) return;
    const state = this.getOrCreateResearchState(sessionId);
    state.active = false;
    state.stage = 'error';
    state.error = data.message;
    state.completedAt = data.timestamp;
    this.pushResearchActivity(sessionId, {
      kind: 'error',
      title: 'Research error',
      detail: data.message,
      timestamp: data.timestamp,
      tone: 'warning',
    });
    this.notifyResearchListeners(sessionId);
  }

  private handleResearchRunStatusEvent(
    sessionId: string,
    data: { runStatus: string; phase: string; timestamp: number } | undefined,
  ): void {
    if (!data) return;
    const state = this.getOrCreateResearchState(sessionId);
    state.runStatus = data.runStatus as ResearchSessionSnapshot['runStatus'];

    switch (data.runStatus) {
      case 'classifying':
      case 'planning':
        state.stage = 'planning';
        break;
      case 'awaiting_clarification':
        state.stage = 'clarifying';
        break;
      case 'awaiting_approval':
        state.stage = 'awaiting_plan_approval';
        break;
      case 'running':
        state.stage = 'researching';
        break;
      case 'synthesizing':
        state.stage = 'synthesizing';
        break;
      case 'completed':
        state.stage = 'complete';
        state.active = false;
        break;
      case 'failed':
        state.stage = 'error';
        state.active = false;
        break;
      case 'aborted':
        state.stage = 'aborted';
        state.active = false;
        break;
    }
    this.notifyResearchListeners(sessionId);
  }

  private handleResearchActivityEvent(
    sessionId: string,
    data: {
      activityId: string;
      kind: string;
      title: string;
      detail?: string;
      sequence: number;
      timestamp: number;
      sources?: Array<{ url: string; title: string }>;
    } | undefined,
  ): void {
    if (!data) return;
    const state = this.getOrCreateResearchState(sessionId);
    if (data.kind === 'browse') {
      state.visitedPagesCount = (state.visitedPagesCount || 0) + 1;
    }
    this.pushResearchActivity(sessionId, {
      kind: data.kind as ResearchActivityItem['kind'] || 'milestone',
      title: data.title,
      detail: data.detail,
      timestamp: data.timestamp,
      sources: data.sources,
      tone: data.kind === 'finding' || data.kind === 'question_answered' ? 'success'
        : data.kind === 'error' ? 'warning'
        : 'neutral',
    });
    this.notifyResearchListeners(sessionId);
  }

  private handleResearchPlanStepsEvent(
    sessionId: string,
    data: { steps: Array<{ id: string; order: number; label: string }>; timestamp: number } | undefined,
  ): void {
    if (!data || !data.steps || data.steps.length === 0) return;
    const state = this.getOrCreateResearchState(sessionId);
    state.planSteps = data.steps.map((s) => ({
      id: s.id,
      order: s.order,
      label: s.label,
      status: 'pending' as const,
      startedAt: null,
      completedAt: null,
    }));
    this.notifyResearchListeners(sessionId);
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

    // Update the last assistant message in the store with tokenUsage
    const messages = useConversationStore.getState().messages[sessionId];
    if (messages && messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role === 'assistant') {
        const updatedMessage = {
          ...lastMsg,
          tokenUsage: s.tokenUsage,
        };
        useConversationStore.setState((state) => ({
          messages: {
            ...state.messages,
            [sessionId]: state.messages[sessionId].map((m, i) =>
              i === messages.length - 1 ? updatedMessage : m
            ),
          },
        }));
        // Sync to database
        useConversationStore.getState().syncMessageToDatabase(sessionId, updatedMessage);
      }
    }
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
    showMessageCompletionNotification(sessionId).catch(() => {
      // Ignore notification errors
    });
  }

  private handleErrorEvent(sessionId: string, streamId: string, data: { message?: string } | undefined): void {
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    s.phase = 'error';
    s.statusText = undefined;
    s.error = data?.message || 'Unknown error';
    s.completedAt = Date.now();
    this.notifyPhaseListeners(sessionId, s.phase);
    this.notifyStatusTextListeners(sessionId, s.statusText);
    this.notifyErrorListeners(sessionId, s.error);
    this.notifyCompletedAtListeners(sessionId, s.completedAt);
    this.notifyListeners(sessionId);
    this.clearIdleTimeout(sessionId);
    this.autoStartQueuedStream(sessionId);
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

    // If we have tokenUsage and finalMessageContent, update the assistant message in the store.
    // Do NOT sync to database here — the agent is the authoritative source for message
    // persistence. Saving the optimistic message would create a duplicate row with a
    // different ID (optimistic-text-xxx vs agent's crypto.randomUUID()).
    // App.tsx will call loadThreadMessages() to reload canonical messages from DB.
    if (s.tokenUsage && s.finalMessageContent) {
      const messages = useConversationStore.getState().messages[sessionId];
      if (messages && messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role === 'assistant') {
          useConversationStore.setState((state) => ({
            messages: {
              ...state.messages,
              [sessionId]: state.messages[sessionId].map((m, i) =>
                i === messages.length - 1
                  ? { ...m, tokenUsage: s.tokenUsage }
                  : m
              ),
            },
          }));
        }
      }
    }

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

  subscribeToResearch(sessionId: string, listener: (snapshot: ResearchSessionSnapshot) => void): () => void {
    const state = this.getOrCreateResearchState(sessionId);
    state.listeners.add(listener);
    const snapshot = this.getResearchSnapshot(sessionId);
    if (snapshot) {
      listener(snapshot);
    }
    return () => {
      state.listeners.delete(listener);
    };
  }

  getSnapshot(sessionId: string): SessionStreamSnapshot | null {
    const state = this.sessions.get(sessionId);
    return state ? buildSnapshot(state) : null;
  }

  getResearchSnapshot(sessionId: string): ResearchSessionSnapshot | null {
    const state = this.researchSessions.get(sessionId);
    if (!state) return null;
    const { listeners: _listeners, ...snapshot } = state;
    return { ...snapshot };
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

  private getOrCreateResearchState(sessionId: string): ResearchSessionState {
    const existing = this.researchSessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const state: ResearchSessionState = {
      ...createInitialResearchState(sessionId),
      listeners: new Set(),
    };
    this.researchSessions.set(sessionId, state);
    return state;
  }

  private resetResearchState(sessionId: string, originalQuery = ''): ResearchSessionState {
    const state = this.getOrCreateResearchState(sessionId);
    const fresh = createInitialResearchState(sessionId);
    Object.assign(state, fresh, {
      mode: 'research',
      active: true,
      stage: 'planning' as const,
      originalQuery,
      startedAt: Date.now(),
    });
    this.notifyResearchListeners(sessionId);
    return state;
  }

  /**
   * Restore research state from backend database after app restart.
   */
  async restoreResearchStateFromDB(sessionId: string): Promise<boolean> {
    const client = getAgentServerClient();
    const dbRow = await client.getResearchSnapshot(sessionId);
    if (!dbRow) {
      return false;
    }

    const runStatus = dbRow.run_status as string | null;
    const legacyStatus = dbRow.status as string;
    const isActive = runStatus
      ? ['classifying', 'planning', 'awaiting_clarification', 'awaiting_approval', 'running', 'paused', 'synthesizing'].includes(runStatus)
      : legacyStatus === 'active';
    const isCompleted = runStatus === 'completed' || legacyStatus === 'completed';
    const isFailed = runStatus === 'failed' || legacyStatus === 'aborted';

    if (!isActive && !isCompleted && !isFailed) {
      return false;
    }

    const state = this.getOrCreateResearchState(sessionId);
    state.mode = 'research';
    state.active = isActive;
    state.originalQuery = (dbRow.original_query as string) || '';
    state.stage = mapPhaseToStageAndRunStatus(dbRow.current_phase as string, runStatus);
    state.currentIteration = (dbRow.iterations as number) || 0;
    state.coverage = (dbRow.coverage as number) || 0;
    state.startedAt = dbRow.created_at as number || null;
    state.completedAt = dbRow.completed_at as number || null;
    state.runId = dbRow.id as string || null;
    state.runStatus = (runStatus as ResearchSessionSnapshot['runStatus']) || null;
    state.progressSummary = dbRow.progress_summary as string || null;
    state.error = dbRow.error_json
      ? (() => { try { return JSON.parse(dbRow.error_json as string).message; } catch { return null; } })()
      : null;

    // Restore from context_json
    if (dbRow.context_json && typeof dbRow.context_json === 'string') {
      try {
        const context = JSON.parse(dbRow.context_json);

        // ResearchContext.toJSON() saves questions as "questions", not "planQuestions"
        const rawQuestions = context.planQuestions || context.questions;
        if (rawQuestions && Array.isArray(rawQuestions)) {
          state.planQuestions = rawQuestions.map((q: Record<string, unknown>) => {
            const backendStatus = String(q.status || 'pending');
            let status: ResearchPanelQuestion['status'] = 'pending';
            if (backendStatus === 'answered') status = 'done';
            else if (backendStatus === 'searching' || backendStatus === 'partial' || backendStatus === 'blocked') status = 'active';
            else if (backendStatus === 'obsolete') status = 'obsolete';

            return {
              id: String(q.id),
              text: String(q.text),
              status,
              purpose: q.purpose as string | undefined,
              priority: [1, 2, 3].includes(q.priority as number) ? (q.priority as 1 | 2 | 3) : undefined,
              dependsOn: q.dependsOn as string[] | undefined,
              requiredEvidence: q.requiredEvidence as unknown as ResearchPanelQuestion['requiredEvidence'],
            };
          });
          state.questionCount = state.planQuestions.length;
        }
        if (context.pendingRequest) {
          state.pendingRequest = context.pendingRequest as ResearchPendingRequest;
        }
        // ResearchContext.toJSON() saves plan as "researchPlan", not "plan"
        const rawPlan = context.plan || context.researchPlan;
        if (rawPlan) {
          state.plan = rawPlan as ResearchPlanDetail;
        }
        if (context.findings && Array.isArray(context.findings)) {
          state.findings = context.findings as ResearchPanelFinding[];
          state.findingsCount = state.findings.length;
        }
        if (context.reportText) {
          state.reportText = String(context.reportText);
        }
        if (context.summary) {
          state.summary = String(context.summary);
        }
      } catch {
        // context_json parsing failed, continue with basic restoration
      }
    }

    // Restore activities from db row if available
    if (dbRow.activities && Array.isArray(dbRow.activities)) {
      state.activities = dbRow.activities as ResearchActivityItem[];
    }

    // Restore plan steps from db if available
    if (dbRow.planSteps && Array.isArray(dbRow.planSteps)) {
      state.planSteps = (dbRow.planSteps as Array<Record<string, unknown>>).map((s) => ({
        id: String(s.id),
        order: Number(s.order_num),
        label: String(s.user_facing_label),
        status: (s.status as ResearchSessionSnapshot['planSteps'][0]['status']) || 'pending',
        startedAt: typeof s.started_at === 'number' ? s.started_at : null,
        completedAt: typeof s.completed_at === 'number' ? s.completed_at : null,
      }));
    }

    if (dbRow.events && Array.isArray(dbRow.events)) {
      state.persistedEvents = (dbRow.events as ResearchPersistedEvent[])
        .slice()
        .sort((a, b) => a.sequence - b.sequence);
    }

    if (dbRow.sources && Array.isArray(dbRow.sources)) {
      state.persistedSources = dbRow.sources as ResearchPersistedSource[];
    }

    if (dbRow.citations && Array.isArray(dbRow.citations)) {
      state.persistedCitations = dbRow.citations as ResearchPersistedCitation[];
    }

    if (dbRow.report && typeof dbRow.report === 'object') {
      state.reportArtifact = dbRow.report as ResearchReportArtifact;
      if (!state.reportText && state.reportArtifact.markdown) {
        state.reportText = state.reportArtifact.markdown;
      }
    }

    if (state.persistedEvents.length > 0) {
      this.rebuildResearchProgressFromEvents(sessionId, state.persistedEvents);
      if (state.reportArtifact?.markdown) {
        state.reportText = state.reportArtifact.markdown;
      }
    }

    // Restore complexity / max iterations
    if (dbRow.complexity) {
      state.complexity = dbRow.complexity as string;
    }
    if (dbRow.max_iterations) {
      state.maxIterations = dbRow.max_iterations as number;
    }

    this.notifyResearchListeners(sessionId);
    return true;
  }

  private rebuildResearchProgressFromEvents(
    sessionId: string,
    events: ResearchPersistedEvent[],
  ): void {
    const state = this.getOrCreateResearchState(sessionId);
    const persistedEvents = state.persistedEvents;
    const persistedSources = state.persistedSources;
    const persistedCitations = state.persistedCitations;
    const reportArtifact = state.reportArtifact;

    state.planQuestions = [];
    state.plan = null;
    state.findings = [];
    state.reportText = '';
    state.summary = undefined;
    state.error = null;
    state.pendingRequest = null;
    state.activities = [];
    state.currentIteration = 0;
    state.coverage = 0;
    state.findingsCount = 0;
    state.questionCount = 0;

    for (const row of events) {
      const event = parsePersistedResearchEvent(row);
      if (!event) continue;

      switch (event.type) {
        case 'research_phase':
          this.handleResearchPhaseEvent(sessionId, event.data as { from: string; to: string; timestamp: number } | undefined);
          break;
        case 'research_questions':
          this.handleResearchQuestionsEvent(sessionId, event.data as ResearchQuestionEventData | undefined);
          break;
        case 'research_iteration':
          this.handleResearchIterationEvent(sessionId, event.data as ResearchIterationEventData | undefined);
          break;
        case 'research_finding':
          this.handleResearchFindingEvent(sessionId, event.data as ResearchFindingEventData | undefined);
          break;
        case 'research_progress':
          this.handleResearchProgressEvent(sessionId, event.data as ResearchProgressEventData | undefined);
          break;
        case 'research_synthesis_chunk':
          this.handleResearchSynthesisChunkEvent(sessionId, event.data as { delta: string; total: number; timestamp: number } | undefined);
          break;
        case 'research_complete':
          this.handleResearchCompleteEvent(sessionId, event.data as ResearchCompleteEventData | undefined);
          break;
        case 'research_complexity':
          this.handleResearchComplexityEvent(sessionId, event.data as ResearchComplexityEventData | undefined);
          break;
        case 'research_error':
          this.handleResearchErrorEvent(sessionId, event.data as ResearchErrorEventData | undefined);
          break;
        case 'research_run_status':
          this.handleResearchRunStatusEvent(sessionId, event.data as { runStatus: string; phase: string; timestamp: number } | undefined);
          break;
        case 'research_activity':
          this.handleResearchActivityEvent(sessionId, event.data as { activityId: string; kind: string; title: string; detail?: string; sequence: number; timestamp: number } | undefined);
          break;
        case 'research_plan_steps':
          this.handleResearchPlanStepsEvent(sessionId, event.data as { steps: Array<{ id: string; order: number; label: string }>; timestamp: number } | undefined);
          break;
        case 'report_complete':
          state.stage = 'complete';
          state.active = false;
          state.completedAt = typeof event.timestamp === 'number' ? event.timestamp : state.completedAt;
          state.reportText = typeof event.content === 'string' ? event.content : state.reportText;
          break;
        default:
          break;
      }
    }

    state.persistedEvents = persistedEvents;
    state.persistedSources = persistedSources;
    state.persistedCitations = persistedCitations;
    state.reportArtifact = reportArtifact;
  }

  private notifyResearchListeners(sessionId: string): void {
    const state = this.researchSessions.get(sessionId);
    if (!state) return;
    const snapshot = this.getResearchSnapshot(sessionId);
    if (!snapshot) return;
    state.listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (error) {
        console.error(`[stream-session-manager] Research listener error for ${sessionId}:`, error);
      }
    });
  }

  private pushResearchActivity(
    sessionId: string,
    activity: Omit<ResearchActivityItem, 'id'>,
  ): void {
    const state = this.getOrCreateResearchState(sessionId);
    const uniqueSuffix = Math.random().toString(36).substring(2, 6);
    const item: ResearchActivityItem = {
      id: `${activity.timestamp}-${state.activities.length}-${uniqueSuffix}`,
      kind: activity.kind || 'milestone',
      title: activity.title,
      detail: activity.detail,
      timestamp: activity.timestamp,
      tone: activity.tone,
      iconType: activity.iconType,
      sources: activity.sources,
    };
    state.activities = [
      item,
      ...state.activities,
    ].slice(0, 40);
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

export const restoreResearchStateFromDB = (sessionId: string) =>
  streamSessionManager.restoreResearchStateFromDB(sessionId);

export const ensureSession = (sessionId: string) => streamSessionManager.ensureSession(sessionId);
export const startStream = (params: StartStreamParams) => streamSessionManager.startStream(params);
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
export const subscribeToResearch = (sessionId: string, listener: (snapshot: ResearchSessionSnapshot) => void) =>
  streamSessionManager.subscribeToResearch(sessionId, listener);
export const getResearchSnapshot = (sessionId: string) =>
  streamSessionManager.getResearchSnapshot(sessionId);

// Re-export conductor types and session manager methods
export const startConductorStream = (params: { canvasId: string; content: string; snapshot?: unknown; model?: string; language?: string }) =>
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
