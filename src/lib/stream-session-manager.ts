// stream-session-manager.ts - Client-side actor manager for chat sessions
//
// Connects to Agent Server via HTTP+SSE for chat streaming.

import type { SessionStreamSnapshot, ToolUseInfo, ToolResultInfo, StreamPhase } from '@/types/message';
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
import type { PermissionRequestEvent, ModeChangedEvent, GoalUpdatedEvent, ResearchUpdatedEvent } from '@/types/stream';
import { STREAM_IDLE_TIMEOUT_MS } from './constants';
import { extractPartialToolFields } from './streaming-tool-input';
import { showMessageCompletionNotification } from './notification';
import { getAgentServerClient, type ChatOptions, type AgentEvent } from './agent-http-client';
import type { PluginMentionCapabilities } from './plugin-mentions';
import { interruptChat } from './agent-sse-client';
import { getConfigValue } from './config-port-bus';
import { useConversationStore } from '@/stores/conversation-store';
import { applyWorkerUsageSnapshot, type WorkerUsageSnapshot } from '@/stores/context-usage-store';
import { useCompactionStore } from '@/stores/compaction-store';

// ---------------------------------------------------------------------------
// Plan 516: rAF-batched field listener fan-out.
//
// Streaming text/thinking/toolOutput arrives at 20-100 chunks/second during
// a long answer. Each notifyXxxListeners() call walks the listener set and
// invokes React setState synchronously, which commits a render. At 100Hz
// this saturates the main thread even when only one chat row is mounted.
//
// We coalesce notifications per (sessionId, field) into a single
// requestAnimationFrame tick: the latest payload wins, listeners see at most
// one call per frame. Outside the browser (SSR / Node test) the helper
// degrades to a direct flush so behavior is preserved.
// ---------------------------------------------------------------------------

type RafFieldKind = 'text' | 'thinking' | 'toolOutput';

interface RafPending {
  handle?: number;
  // We keep the latest payload of the field and broadcast it on flush.
  // Generics collapse to a single shape per field; we narrow on flush.
  text?: string;
  thinking?: string;
  toolOutput?: string;
}

const rafPendingByKey = new Map<string, RafPending>();
const rafListenerSets = new Map<string, Set<(value: never) => void>>();

function rafFlushKey(sessionId: string, field: RafFieldKind): string {
  return `${sessionId}\u0000${field}`;
}

function flushRafBatched(key: string): void {
  const pending = rafPendingByKey.get(key);
  rafPendingByKey.delete(key);
  const listeners = rafListenerSets.get(key);
  if (!pending || !listeners) return;
  // We carry one of three fields; dispatch on whichever is set.
  const payload =
    pending.text !== undefined
      ? pending.text
      : pending.thinking !== undefined
        ? pending.thinking
        : pending.toolOutput;
  listeners.forEach((listener) => {
    try {
      listener(payload as never);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e);
    }
  });
}

function scheduleRafBatched<T>(
  sessionId: string,
  field: RafFieldKind,
  listeners: Set<(value: T) => void>,
  payload: T,
): void {
  const key = rafFlushKey(sessionId, field);
  rafListenerSets.set(key, listeners as unknown as Set<(value: never) => void>);

  // SSR / Node fallback: flush synchronously so callers see consistent behavior.
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    listeners.forEach((listener) => {
      try {
        listener(payload);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(e);
      }
    });
    return;
  }

  const existing = rafPendingByKey.get(key);
  if (existing) {
    if (field === 'text') existing.text = payload as unknown as string;
    else if (field === 'thinking') existing.thinking = payload as unknown as string;
    else existing.toolOutput = payload as unknown as string;
    return;
  }

  const entry: RafPending = {};
  if (field === 'text') entry.text = payload as unknown as string;
  else if (field === 'thinking') entry.thinking = payload as unknown as string;
  else entry.toolOutput = payload as unknown as string;

  const handle = window.requestAnimationFrame(() => flushRafBatched(key));
  entry.handle = handle;
  rafPendingByKey.set(key, entry);
}

// Provider config interface
interface ProviderConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  provider: string;
  authStyle: string;
  /** Provider store id — lets the agent server resolve capabilities for the exact provider. */
  providerId?: string;
  /**
   * Full runtime config (modelCapabilities + modelCompat) resolved by the
   * main process. Threaded through to the worker init so DuyaAgent's
   * compaction budget uses the model's real context window instead of the
   * 200k default. Only set when the resolved (provider, model) pair matches.
   */
  runtimeConfig?: Record<string, unknown>;
}

/**
 * Read the configured per-run max turn count (`agent.max_turns` in
 * config.toml). Resolves to `undefined` when the config is unavailable
 * or unset, in which case the agent runs uncapped (pi-aligned design —
 * the loop exits on natural completion, token exhaustion, abort, or a
 * tool `terminate: true` signal, never on an implicit turn count).
 */
async function readAgentMaxTurns(): Promise<number | undefined> {
  try {
    const raw = await getConfigValue('agent.max_turns');
    const n = typeof raw === 'number' ? raw : raw != null ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  } catch {
    return undefined;
  }
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
      providerId?: string;
      runtimeConfig?: Record<string, unknown>;
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
      providerId: config.providerId,
      runtimeConfig: config.runtimeConfig,
    };
  } catch (error) {
    console.error('[stream-session-manager] Failed to get active provider config:', error);
    return null;
  }
}

async function getProviderConfigById(providerId: string, model: string): Promise<{ provider: string; apiKey: string; baseURL: string; model: string; providerId?: string; runtimeConfig?: Record<string, unknown> } | null> {
  try {
    console.log(`[stream-session-manager] Resolving title model provider: "${providerId}", model: "${model}"`);

    const electronApi = window.electronAPI as unknown as Record<string, unknown> | undefined;
    const providerApi = electronApi?.provider as {
      getConfig?: (providerId: string, model: string) => Promise<{ apiKey: string; baseUrl?: string; model: string; provider: string; authStyle: string; providerId?: string; runtimeConfig?: Record<string, unknown> } | null>;
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
          providerId,
          runtimeConfig: config.runtimeConfig,
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
      providerId: provider.id,
      // No runtimeConfig on this path — the masked list API doesn't carry one.
      // The agent server attaches a server-resolved one at init time.
    };
  } catch (error) {
    console.error('[stream-session-manager] Failed to get provider config by id:', error);
    return null;
  }
}

// Check if model string looks like "providerId:modelName" format
function looksLikeProviderModelFormat(model: string): boolean {  // Pattern: starts with alphanumeric provider ID followed by colon, then model name
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
        providerId: resolved.providerId,
        runtimeConfig: resolved.runtimeConfig,
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
      // The IPC built runtimeConfig for the provider's default model. When
      // the caller overrides the model per-turn, the capability (and thus
      // the compaction budget) would be stale — drop it and let the agent
      // server re-resolve for the exact (provider, model) pair at init.
      const staleRuntime =
        activeConfig.runtimeConfig &&
        activeConfig.runtimeConfig.model !== model;
      activeConfig.model = model;
      if (staleRuntime) delete activeConfig.runtimeConfig;
      console.log('[stream-session-manager] Using active provider with model override:', { provider: activeConfig.provider, model: activeConfig.model, droppedStaleRuntime: !!staleRuntime });
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
      providerId: resolved.providerId,
      runtimeConfig: resolved.runtimeConfig,
    };
  }

  // Fallback to active provider if resolution fails
  console.warn('[stream-session-manager] Failed to resolve provider, falling back to active provider');
  return getActiveProviderConfig();
}

const ACTIVE_PHASES: StreamPhase[] = ['starting', 'streaming', 'awaiting_permission', 'persisting'];

/**
 * Renderer memory policy for retained chat-stream state. The transcript is
 * DB-backed, so once a turn reaches a terminal phase the renderer only needs
 * a small summary (phase / error / finalMessageContent) — not the turn's
 * full event timeline. Mutable so tests can shrink the values; production
 * numbers live here.
 */
export const streamMemoryPolicy = {
  /** Grace period after a terminal phase before the last turn's streaming
   *  payload (events, tool uses, accumulated text) is freed. The delay keeps
   *  the terminal handoff window (StreamingMessage → DB rows) intact. */
  terminalSlimDelayMs: 30_000,
  /** Cap on SessionStates retained in the sessions map. Post-slim states are
   *  small, but the map previously grew without bound for the lifetime of
   *  the renderer. Eviction is LRU and only touches non-active sessions. */
  maxRetainedSessions: 40,
};

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
  /**
   * Plan 450: providers @-mentioned in the composer for this run. Forwarded
   * to the worker so connector tools of these providers skip tool_search.
   */
  mentionedProviders?: string[];
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
   * Maximum agentic turns for this run. When absent, the worker falls back
   * to the `agent.max_turns` config (config.toml), then 100.
   */
  maxTurns?: number;
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
  /**
   * Renderer-minted id of this user send. Threaded through to the agent worker
   * so the persisted user row reuses the same id as the optimistic bubble,
   * letting the frontend merge dedupe by id regardless of timestamp drift.
   */
  clientMsgId?: string;
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
  toolOutput: Set<(output: string) => void>;
  toolProgress: Set<(info: { toolName: string; elapsedSeconds: number } | null) => void>;
  toolTimeout: Set<(info: { toolName: string; elapsedSeconds: number } | null) => void>;
  agentProgress: Set<(event: AgentProgressEvent) => void>;
  error: Set<(error: StreamingError | null) => void>;
  completedAt: Set<(at: number | null) => void>;
  dbPersisted: Set<(event: SessionStreamSnapshot['dbPersisted']) => void>;
  retry: Set<(info: RetryNotice | null) => void>;
};

/** Plan 462: LLM transport retry notice. `message` is the provider's own
 *  wording (e.g. "余额不足，请充值") — the UI appends the attempt counter. */
export interface RetryNotice {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  message: string;
}

/** Sub-agent progress event */
export interface AgentProgressEvent {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'started' | 'done' | 'error' | 'hook_invoked';
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
  /**
   * Plan 437: when `type === 'hook_invoked'`, the agent process nested
   * the full hook payload under this key (see packages/ai/src/types.ts).
   * The flat envelope still passes through; this is the only structured
   * sub-payload because hook events are richer than text/thinking and
   * would otherwise need 10+ top-level fields.
   */
  hookEvent?: {
    hookEventName: string;
    hookType: 'command' | 'process' | 'prompt' | 'http' | 'agent';
    hookName: string;
    matcher?: string;
    additionalContext?: string;
    exitCode?: number;
    async: boolean;
    backgroundTaskId?: string;
    durationMs: number;
    status: 'ok' | 'error' | 'timeout' | 'skipped';
    errorMessage?: string;
    seq: number;
    toolName?: string;
    toolUseId?: string;
  };
}

/** Ordered streaming event for chronological rendering */
export type StreamingEvent =
  | { type: 'text'; content: string; timestamp: number }
  | { type: 'thinking'; content: string; timestamp: number }
  | { type: 'tool_use'; toolUse: ToolUseInfo; timestamp: number }
  | { type: 'tool_result'; toolResult: ToolResultInfo; timestamp: number }
  | { type: 'viz'; content: string; isPartial: boolean; timestamp: number }
  | {
      type: 'hook_invocation';
      hook: import('@/types/hooks').HookAction;
      timestamp: number;
    }
  | {
      type: 'compact';
      /**
       * Plan 517 P3: phase union expanded to mirror the worker's per-step
       * boundary events. The three legacy phases remain terminal forms
       * rendered by CompactSummary chrome.
       */
      phase:
        | 'compacting'
        | 'done'
        | 'error'
        | 'projecting'
        | 'cutting'
        | 'summarizing'
        | 'rebuilding'
        | 'reinjecting'
        | 'trimming'
        | 'over_threshold';
      timestamp: number;
      /** Post-compaction summary text (only on the transient 'done' frame);
       *  the durable record is the persisted `isCompactSummary` message. */
      summary?: string;
      compactedMessageCount?: number;
      strategy?: string;
      errorMessage?: string;
    };

/** Plan 450/502: payload of the `connector_auth_required` SSE event.
 * `variant: 'connect'` = bot-initiated first-time connect (Plan 503);
 * `variant: 'reauth'` = mid-call re-authorization (Plan 498). */
export type ConnectorAuthRequiredData = {
  provider?: string;
  connectionId?: string;
  toolName?: string;
  variant?: 'connect' | 'reauth';
};

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
  startedAt: number;
  completedAt: number | null;
  /** LRU stamp for sessions-map eviction (streamMemoryPolicy). */
  lastActiveAt: number;
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
  pendingConnectorAuthRequest: ConnectorAuthRequiredData | null;
  // Deduplication: tool IDs already loaded from DB on page refresh
  loadedToolUseIds: Set<string>;
  loadedToolResultIds: Set<string>;
  // Listeners
  listeners: Set<(snapshot: SessionStreamSnapshot) => void>;
  fieldListeners: FieldListeners;
  streamingEventsListeners: Set<(events: StreamingEvent[]) => void>;
  permissionListeners: Set<(request: PermissionRequestEvent | null) => void>;
  /** Plan 450: listeners for app-connection re-authorization events. */
  authRequiredListeners: Set<(data: ConnectorAuthRequiredData | null) => void>;
  /** Plan 224 follow-up: listeners for agent-initiated runtime mode switches. */
  modeChangedListeners: Set<(event: ModeChangedEvent) => void>;
  goalUpdatedListeners: Set<(event: GoalUpdatedEvent) => void>;
  /** Plan 423 Phase 3: listeners for research tracker state broadcasts. */
  researchUpdatedListeners: Set<(event: ResearchUpdatedEvent) => void>;
  /**
   * Current research lifecycle state (e.g. clarifying / planning / gathering /
   * evaluating / synthesizing). Updated whenever a `research_updated` event
   * arrives; the value is stamped onto subsequent tool_use events so the
   * renderer can group tool actions by research stage in arrival order.
   * Empty when no research run is active.
   */
  researchStage: string;
  dbPersistedListeners: Set<(event: PersistEvent) => void>;
  idleTimeout: ReturnType<typeof setTimeout> | null;
  textEmitTimeout: ReturnType<typeof setTimeout> | number | null;
  pendingTextEmit: string;
  /** Plan 491 P0.2: thinking emit throttling (64ms batch) */
  thinkingEmitTimeout: ReturnType<typeof setTimeout> | number | null;
  pendingThinkingEmit: string;
  /**
   * Plan 461: per-tool_use-id accumulated raw JSON argument fragments from
   * `tool_use_delta` events. Never persisted; cleared when the authoritative
   * `tool_use` lands. Used to render file edits while the model is still
   * producing them.
   */
  partialToolInputRaw: Map<string, string>;
  /** 50ms coalescing timer for merging partial tool inputs into toolUses. */
  partialInputFlushTimer: ReturnType<typeof setTimeout> | null;
  sendRetryMessage: ((content: string) => void) | null;
}

// ---- Research event payload types (persisted research_events) ----
// These describe the JSON payload of research_* events stored in the DB
// and replayed by `restoreResearchStateFromDB` after an app restart.

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

interface ResearchSessionState extends ResearchSessionSnapshot {
  listeners: Set<(snapshot: ResearchSessionSnapshot) => void>;
}

function createInitialState(sessionId: string): Omit<SessionState, 'listeners' | 'fieldListeners' | 'streamingEventsListeners' | 'permissionListeners' | 'authRequiredListeners' | 'modeChangedListeners' | 'goalUpdatedListeners' | 'researchUpdatedListeners' | 'dbPersistedListeners' | 'idleTimeout' | 'textEmitTimeout' | 'pendingTextEmit' | 'partialToolInputRaw' | 'partialInputFlushTimer' | 'sendRetryMessage' | 'thinkingEmitTimeout' | 'pendingThinkingEmit'> {
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
    researchStage: '',
    startedAt: Date.now(),
    completedAt: null,
    lastActiveAt: Date.now(),
    error: null,
    errorCode: null,
    finalMessageContent: null,
    toolTimeoutInfo: null,
    toolProgressInfo: null,
    dbPersisted: undefined,
    agentProgressEvents: [],
    streamingEvents: [],
    pendingPermissionRequest: null,
    pendingConnectorAuthRequest: null,
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
  // Strip a leading HTTP status prefix ("429 ") — provider SDKs often
  // stringify `status + JSON body` into error.message, and JSON.parse would
  // otherwise fail before we even get to the nested fields (Plan 462).
  let current = message.trim().replace(/^\d{3}\s+/, '');
  for (let depth = 0; depth < 3; depth++) {
    if (!current.startsWith('{')) break;
    try {
      const parsed = JSON.parse(current) as {
        error?: { message?: string; msg?: string };
        data?: { message?: string };
        message?: string;
        msg?: string;
      };
      const next =
        parsed.error?.message ??
        parsed.error?.msg ??
        parsed.message ??
        parsed.data?.message ??
        parsed.msg;
      if (!next || next === current) break;
      current = next.trim();
    } catch {
      break;
    }
  }
  return current && current !== message ? current : null;
}

/**
 * Strip `[code]` / `[requestId]` wrapping some providers put around the real
 * message, e.g. `[1113][余额不足或无可用资源包,请充值。][20260830103053…]`
 * → `余额不足或无可用资源包，请充值。`
 */
function stripBracketNoise(message: string): string {
  const trimmed = message.trim();
  if (!trimmed.startsWith('[')) return trimmed;

  const groups = [...trimmed.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1].trim());
  const meaningful = groups.filter(
    (g) => g.length > 0 && !/^\d+$/.test(g) && !/^[0-9a-f]{16,}$/i.test(g),
  );
  if (meaningful.length === 0) return trimmed;
  return meaningful[0].replace(/[，,]\s*$/, '').trim();
}

function normalizeStreamError(data: StreamErrorEventData | undefined): StreamingError {
  const rawMessage = data?.message || 'Unknown error';
  const nestedMessage = extractNestedProviderErrorMessage(rawMessage);
  // Plan 462: unwrap `[1113][余额不足…][requestId]` noise so the banner shows
  // the provider's actual sentence instead of bracketed codes.
  const providerMessage = stripBracketNoise(nestedMessage || rawMessage);
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
    message: providerMessage,
  };
}

function isActivePhase(phase: StreamPhase): boolean {
  return ACTIVE_PHASES.includes(phase);
}

/**
 * Human-readable explanation for a `done` SSE reason that indicates the run
 * stopped before the task was actually finished. These reasons previously
 * rendered as a silent "completed"; surfacing them lets the user understand
 * why tool activity stopped mid-task.
 */
function formatDoneReason(reason: string): string {
  switch (reason) {
    case 'max_turns':
      return '达到最大工具轮数上限，任务可能尚未完成。你可以继续发送消息，agent 会在当前会话中接着处理。';
    case 'repeated_tool_calls':
      return '检测到连续重复的工具调用，为避免死循环已停止。请换一种方式重新描述任务。';
    case 'aborted':
      return '本次运行被中止（中断或超时），任务可能尚未完成。你可以重新发送消息继续。';
    default:
      return `Agent 提前停止（原因：${reason}），任务可能尚未完成。`;
  }
}

// ---- Research state helpers ----

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
    lastEvidenceChain: null,
  };
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
    case 'synthesis':
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

function inferPendingResearchRequest(state: ResearchSessionState): ResearchPendingRequest | null {
  if (state.pendingRequest) return state.pendingRequest;

  if (state.stage === 'awaiting_plan_approval' && state.planQuestions.length > 0) {
    return {
      kind: 'plan_approval',
      requestId: `restored_plan_${state.runId || state.sessionId}`,
      questions: state.planQuestions.map((question) => ({
        id: question.id,
        text: question.text,
        type: 'text',
        required: false,
      })),
      allowSkip: false,
    };
  }

  return null;
}

function formatResearchAuxEventTitle(type: string, data: unknown): string {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    switch (type) {
      case 'research_source_found':
        return typeof d.title === 'string' ? `Source: ${d.title.slice(0, 80)}` : 'Source found';
      case 'research_source_rejected':
        return typeof d.reason === 'string' ? `Source rejected: ${d.reason.slice(0, 80)}` : 'Source rejected';
      case 'research_gap_detected':
        return typeof d.description === 'string' ? `Gap: ${d.description.slice(0, 80)}` : 'Gap detected';
      case 'research_next_action':
        return typeof d.action === 'string' ? `Next: ${d.action}` : 'Next action';
      case 'research_conflict_detected':
        return typeof d.description === 'string' ? `Conflict: ${d.description.slice(0, 80)}` : 'Conflict detected';
      case 'research_stop_decision':
        return 'Stop decision evaluated';
      case 'plan_delta':
        return 'Plan delta applied';
      default:
        return type;
    }
  }
  return type;
}

// Exported for tests that need a fresh instance isolated from the
// globalThis singleton (memory-retention / eviction specs).
export class StreamSessionManager {
  private sessions: Map<string, SessionState> = new Map();
  private researchSessions: Map<string, ResearchSessionState> = new Map();
  private pendingMessages: Map<string, StartStreamParams[]> = new Map();
  private backgroundResumeTemplates = new Map<string, StartStreamParams>();
  private pendingBackgroundResumes = new Set<string>();
  private drainingQueuedSessions = new Set<string>();
  private textEmitInterval = 64; // Plan 491 P0.2: 15fps throttle (~64ms) // Increased from 100ms to reduce UI flickering
  private idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS;
  /** Deferred slim timers keyed by sessionId (streamMemoryPolicy). */
  private terminalSlimTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
        authRequiredListeners: new Set(),
        modeChangedListeners: new Set(),
        goalUpdatedListeners: new Set(),
        researchUpdatedListeners: new Set(),
        dbPersistedListeners: new Set(),
        idleTimeout: null,
        textEmitTimeout: null,
        pendingTextEmit: '',
        // Plan 491 P0.2: thinking emit throttle (64ms batch)
        thinkingEmitTimeout: null,
        pendingThinkingEmit: '',
        partialToolInputRaw: new Map(),
        partialInputFlushTimer: null,
        sendRetryMessage: null,
      };
      this.sessions.set(sessionId, state);
      this.evictExcessSessions();
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
   *
   * Input contract: each `msg` must be a camelCase IpcMessage shape (post
   * `dbMessageToMessage` mapping). Snake_case raw rows (e.g. the output of
   * `storedEventsToIpcMessages`) silently lose their `parentToolCallId`
   * and `toolCallId` fields, leaving `loadedToolResultIds` empty and
   * causing every SSE tool_result replay to re-render. The `assertShape`
   * guard below catches that regression loudly in dev. The 447 + 489
   * callers in `conversation-store.ts` already feed the mapped shape.
   */
  registerLoadedMessages(
    sessionId: string,
    messages: ReadonlyArray<{ role: string; content: string | unknown[]; msgType?: string; parentToolCallId?: unknown; toolCallId?: unknown }>,
  ): void {
    const state = this.getOrCreateState(sessionId);
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    const loadedUses: ToolUseInfo[] = [];
    const loadedResults: ToolResultInfo[] = [];
    let toolRowCount = 0;

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
        toolRowCount += 1;
        // addMessage() always writes msg_type='tool_result' for role='tool'
        // rows (db.ts:969), so the msgType guard is implicit. We read
        // `parentToolCallId` (camelCase) directly — see Input contract above.
        const toolCallId = (msg as unknown as { parentToolCallId?: string }).parentToolCallId
          ?? (msg as unknown as { toolCallId?: string }).toolCallId;
        if (typeof toolCallId === 'string' && toolCallId) {
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

    // Dev shape guard: if the input has tool rows but we extracted zero
    // tool_call ids, the caller almost certainly passed raw snake_case
    // rows from `storedEventsToIpcMessages` instead of the camelCase
    // `IpcMessage` shape produced by `dbMessageToMessage`. Warn loudly
    // so this regression is caught in development instead of silently
    // re-rendering every SSE tool_result on switch-back.
    if (import.meta.env?.DEV && toolRowCount > 0 && toolResultIds.size === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        '[stream-session-manager] registerLoadedMessages received tool rows but extracted 0 tool_call ids. ' +
          'This usually means the input is raw snake_case rows; pass `dbMessageToMessage`-mapped IpcMessages instead. ' +
          'See stream-session-manager.ts:1162 (Input contract).',
      );
    }

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

  /**
   * Plan 450 Phase G: resolve `@<providerId>`/`@<label>` tokens in the user
   * message and rewrite them to codex-style `[@label](app://id)` links that
   * the model can resolve. Connects to the App Connections API to enumerate
   * connected providers, then delegates to the pure `rewriteAppMentionTokens`
   * helper. Best-effort; on failure returns the content unchanged with no
   * mentions so the agent falls back to default discoverable tools.
   */
  private async resolveAppMentions(
    content: string,
  ): Promise<{ content: string; mentionedProviders: string[] }> {
    try {
      // Lazy import to avoid bundling electronAPI types into the message
      // library entry points that don't need it (test runners, SSR shims).
      const { getAppConnectionAPI, rewriteAppMentionTokens } = await import('./app-connection-ipc');
      const api = getAppConnectionAPI();
      if (!api) return { content, mentionedProviders: [] };
      const [list, providers] = await Promise.all([api.list(), api.providers()]);
      const connected = (list.data ?? [])
        .filter((c) => c.status === 'connected')
        .map((c) => c.provider);
      const available = (providers.data ?? [])
        .filter((p) => connected.includes(p.id))
        .map((p) => ({ id: p.id, label: p.label }));
      return rewriteAppMentionTokens(content, available);
    } catch {
      return { content, mentionedProviders: [] };
    }
  }

  /**
   * Plan 450 Phase H: rewrite a leading `/skill-name` composer command into
   * a codex-style `[/name](skill://name)` link and extract the mentioned
   * skill names for structured transport. The name list comes from the same
   * `skills.list` IPC the `/` popover uses, so only real registry skills are
   * rewritten (built-in composer commands and prose `/paths` pass through).
   * Best-effort; on failure the content is returned unchanged.
   */
  private async resolveSkillMentions(
    content: string,
  ): Promise<{ content: string; mentionedSkills: string[] }> {
    interface SkillListEntry { name: string; aliases?: string[] }
    interface SkillsListApi { list?: () => Promise<{ success: boolean; skills?: SkillListEntry[] }> }
    try {
      const api = (window as unknown as { electronAPI?: { skills?: SkillsListApi } }).electronAPI?.skills;
      const result = await api?.list?.();
      const available = (result?.skills ?? []).map((s) => ({ name: s.name, aliases: s.aliases }));
      if (available.length === 0) return { content, mentionedSkills: [] };
      const { rewriteSkillMentionTokens } = await import('./skill-mentions');
      return rewriteSkillMentionTokens(content, available);
    } catch {
      return { content, mentionedSkills: [] };
    }
  }

  /**
   * Plugin mention resolution: the `@` popover lists installed plugins, so a
   * bare `@pluginId`/`@pluginName` token in the message must be rewritten to a
   * codex-style `[@Name](plugin://id)` link AND the plugin's connected app
   * connectors must flow into `mentionedProviders` (the user asked: "if a
   * plugin contains apps, use the existing app-tool injection"). MCP servers
   * and skills are NOT separately activated — the agent's `<plugin-activation>`
   * block lists them so the model knows they exist.
   *
   * Runs after `resolveAppMentions`; the merged provider list is authoritative.
   */
  private async resolvePluginMentions(
    content: string,
    existingProviders: string[],
  ): Promise<{ content: string; mentionedPlugins: PluginMentionCapabilities[]; mergedProviders: string[] }> {
    try {
      // Deliberately does NOT go through plugin-ipc/plugin-types: those pull in
      // @duya/plugin-core at runtime, which is heavy for the message-library
      // entry points (test runners, SSR shims). Access the preload surface
      // directly with a minimal inline shape instead.
      const { rewritePluginMentionTokens } = await import('./plugin-mentions');
      const win = window as unknown as {
        electronAPI?: {
          plugin?: {
            registry?: {
              list: () => Promise<{
                success: boolean;
                data?: Array<{
                  id: string;
                  name: string;
                  description?: string;
                  enabled?: boolean;
                  manifest?: {
                    components?: { appConnections?: string[]; mcpServers?: string[]; skills?: string[] };
                    capabilities?: { mcpServers?: Array<{ name: string }>; skills?: string[] };
                  };
                }>;
                error?: string;
              }>;
            };
          };
          appConnection?: {
            list: () => Promise<{
              success: boolean;
              data?: Array<{ provider: string; status: string }>;
              error?: string;
            }>;
          };
        };
      };
      const [pluginRes, appRes] = await Promise.all([
        win.electronAPI?.plugin?.registry?.list?.() ?? Promise.resolve(undefined),
        win.electronAPI?.appConnection?.list?.() ?? Promise.resolve(undefined),
      ]);
      const plugins = (pluginRes?.data ?? []).filter((p) => p.enabled !== false);
      if (plugins.length === 0) return { content, mentionedPlugins: [], mergedProviders: [...existingProviders] };

      const connected = new Set(
        (appRes?.data ?? []).filter((c) => c.status === 'connected').map((c) => c.provider),
      );
      const available = plugins.map((p): PluginMentionCapabilities => {
        // v1 manifests store skills/mcpServers in `manifest.capabilities`;
        // v2 manifests store them in `manifest.components`.  Both paths must
        // be checked so builtin v1 plugins (github / notion / zotero / ...) are
        // not silently dropped from the @mention capability list.
        const comps = p.manifest?.components;
        const caps = p.manifest?.capabilities;
        return {
          pluginId: p.id,
          name: p.name || p.id,
          description: typeof p.description === 'string' && p.description ? p.description : undefined,
          appConnections: comps?.appConnections ?? [],
          // v2: components.mcpServers is string[]; v1: capabilities.mcpServers is
          // MCPServerDeclaration[] — extract names for v1, use string[] directly for v2.
          mcpServers: comps?.mcpServers?.length
            ? comps.mcpServers
            : caps?.mcpServers?.map((s: { name: string }) => s.name) ?? [],
          // v1 stores skill names in capabilities.skills; v2 in components.skills.
          skillNames: comps?.skills ?? caps?.skills ?? [],
        };
      });

      return rewritePluginMentionTokens(content, available, [...connected], existingProviders);
    } catch {
      return { content, mentionedPlugins: [], mergedProviders: [...existingProviders] };
    }
  }

  async startStream(params: StartStreamParams): Promise<StartStreamResult> {
    const { sessionId, content, displayContent, model, providerId, effort, maxTokens, systemPrompt, language, initialGeneration, permissionModeOverride, files, agentProfileId, outputStyleConfig, titleGenerationModel, titleGenerationModelConfig: titleGenConfigParam, mode, defaultWorkspaceDirectory, securityScanEnabled, conductorMode, conductorCanvasId, backgroundTaskResume, clientMsgId } = params;

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
    // Immediate "preparing" feedback so the UI shows activity the moment the
    // user hits send — before the worker is even contacted. The worker's own
    // status / turn_start events, or the first text/thinking event, replace it
    // as the run progresses (handleTextEvent clears statusText on first text).
    state.statusText = '@i18n:streaming.preparing';
    state.startedAt = Date.now();
    state.lastActiveAt = Date.now();
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
    this.notifyPermissionListeners(sessionId, null);
    state.loadedToolUseIds = new Set();
    state.loadedToolResultIds = new Set();
    // Plan 461: fresh run → no stale partial tool inputs or coalescing timer.
    this.clearPartialToolInputs(state);

    // Plan 462: a fresh run must not carry over the previous run's retry
    // notice into the streaming status line.
    this.notifyRetryListeners(sessionId, null);

    this.notifyListeners(sessionId);
    this.notifyStreamingEventsListeners(sessionId);
    this.notifyPhaseListeners(sessionId, state.phase);
    this.notifyTextListeners(sessionId, state.streamingText);
    this.notifyThinkingListeners(sessionId, state.streamingThinking);
    this.notifyToolListeners(sessionId);
    this.notifyStatusTextListeners(sessionId, state.statusText);
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
          { get: () => Promise<{ provider: string; model: string; baseUrl: string; enabled: boolean } | null> } | undefined;
        if (visionApi?.get) {
          const vc = await visionApi.get();
          if (vc?.enabled && vc.model) {
            // The vision chain no longer carries its own apiKey
            // (auxiliary.vision.apiKey is removed). The credential is always
            // resolved from the configured provider, so vision stays in
            // lockstep with the provider that already authenticates the agent.
            const visionProvider = await getProviderConfigById(vc.provider, vc.model);
            const visionApiKey = visionProvider?.apiKey || '';
            if (!visionApiKey) {
              console.warn('[stream-session-manager] No provider apiKey found for vision:', vc.provider);
            }
            (providerConfig as unknown as Record<string, unknown>).visionConfig = {
              provider: vc.provider,
              model: vc.model,
              baseURL: vc.baseUrl,
              apiKey: visionApiKey,
              enabled: vc.enabled,
            };
            console.log('[stream-session-manager] Vision model config injected:', {
              provider: vc.provider,
              model: vc.model,
              hasApiKey: !!visionApiKey,
            });
          } else {
            console.log('[stream-session-manager] Vision model not enabled or no model configured');
          }
        }
      } catch (err) {
        console.warn('[stream-session-manager] Failed to get vision config:', err);
      }
    }

    // Inject compact model config into providerConfig if available
    if (providerConfig) {
      try {
        const compactApi = (window.electronAPI as unknown as Record<string, unknown>)?.compact as
          { get: () => Promise<{ provider: string; model: string; baseUrl: string; apiKey: string; enabled: boolean } | null> } | undefined;
        if (compactApi?.get) {
          const cm = await compactApi.get();
          if (cm?.enabled && cm.model) {
            (providerConfig as unknown as Record<string, unknown>).compactModelConfig = {
              provider: cm.provider,
              model: cm.model,
              baseURL: cm.baseUrl,
              apiKey: cm.apiKey,
              enabled: cm.enabled,
            };
          }
        }
      } catch {
        // Compact model config is best-effort; ignore failures.
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
      { content, displayContent, model, maxTokens, maxTurns: params.maxTurns ?? (await readAgentMaxTurns()), systemPrompt, permissionModeOverride, files, agentProfileId, outputStyleConfig, titleGenerationModel, titleGenerationModelConfig, providerConfig, workingDirectory, mode, defaultWorkspaceDirectory, securityScanEnabled, effort, conductorMode, conductorCanvasId, backgroundTaskResume, clientMsgId },
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
      maxTurns?: number;
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
      defaultWorkspaceDirectory?: string;
      securityScanEnabled?: boolean;
      effort?: string;
      conductorMode?: boolean;
      conductorCanvasId?: string;
      backgroundTaskResume?: boolean;
      clientMsgId?: string;
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

    // Register event handlers for Agent Server (shared with attachToExistingStream)
    const cleanup = client.onEvent(sessionId, this.createStreamEventHandler(sessionId, streamId));

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
      // Plan 450 Phase G: rewrite `@<provider>` composer tokens into
      // `[@label](app://id)` links for the model and extract the mention
      // list for per-turn activation. Best-effort; failure to enumerate
      // connections (e.g. agent server unreachable during typing) leaves
      // the content unchanged and the array empty, which simply degrades
      // to the default discoverable tools.
      const appMentions = await this.resolveAppMentions(params.content);
      // Plugin mentions: rewrite `@pluginId` → `[@Name](plugin://id)` and merge
      // the plugin's connected app connectors into `mentionedProviders` (the
      // `@` popover now lists plugins, so a plugin mention must still activate
      // its apps through the existing app-tool pipeline).
      const pluginMentions = await this.resolvePluginMentions(
        appMentions.content,
        appMentions.mentionedProviders,
      );
      // Plan 450 Phase H: same treatment for a leading `/skill-name` —
      // rewritten to `[/name](skill://name)` and transported as
      // `mentionedSkills` so the agent injects the SKILL.md body this turn.
      const skillMentions = await this.resolveSkillMentions(pluginMentions.content);
      await client.startChat(sessionId, skillMentions.content, {
        model: params.model,
        maxTokens: params.maxTokens,
        maxTurns: params.maxTurns,
        systemPrompt: params.systemPrompt,
        language: params.language,
        permissionModeOverride: params.permissionModeOverride,
        files: params.files,
        agentProfileId: params.agentProfileId,
        outputStyleConfig: params.outputStyleConfig,
        // The rewritten content is model-facing; keep the composer's original
        // text as the stored/displayed user message when no explicit override.
        displayContent: params.displayContent ?? params.content,
        mode: params.mode,
        ...(pluginMentions.mergedProviders.length > 0
          ? { mentionedProviders: pluginMentions.mergedProviders }
          : {}),
        ...(skillMentions.mentionedSkills.length > 0
          ? { mentionedSkills: skillMentions.mentionedSkills }
          : {}),
        ...(pluginMentions.mentionedPlugins.length > 0
          ? { mentionedPlugins: pluginMentions.mentionedPlugins }
          : {}),
        titleGenerationModel: params.titleGenerationModel,
        titleGenerationModelConfig: params.titleGenerationModelConfig,
        providerConfig: params.providerConfig as unknown as Record<string, unknown> | undefined,
        workingDirectory: params.workingDirectory,
        defaultWorkspaceDirectory: params.defaultWorkspaceDirectory,
        securityScanEnabled: params.securityScanEnabled,
        effort: params.effort,
        conductorMode: params.conductorMode,
        conductorCanvasId: params.conductorCanvasId,
        backgroundTaskResume: params.backgroundTaskResume,
        clientMsgId: params.clientMsgId,
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

  /**
   * Build the shared Agent-Server SSE event handler for a session. Used by both
   * `startStreamViaAgentServer` (renderer-initiated turn) and
   * `attachToExistingStream` (attaching to a run started elsewhere, e.g. cron).
   */
  private createStreamEventHandler(sessionId: string, streamId: string): (event: AgentEvent) => void {
    return (event: AgentEvent) => {
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

        case 'retry':
        case 'chat:retry':
          // Plan 462: LLM transport retry notice (provider wording + counter).
          this.handleRetryEvent(sessionId, streamId, event.data as RetryNotice | undefined);
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

        case 'tool_use_delta':
          // Plan 461: incremental argument fragment for a tool call still
          // being generated. Coalesced and merged into the matching toolUse
          // so the file-edit row renders partial content live.
          if (event.id && typeof event.delta === 'string') {
            this.handleToolUseDeltaEvent(sessionId, streamId, {
              id: event.id,
              name: event.name || '',
              delta: event.delta,
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
              metadata: (event as { metadata?: Record<string, unknown> }).metadata,
            });
          }
          break;

        case 'token_usage':
          // Live context-usage snapshot pushed by the worker during streaming.
          applyWorkerUsageSnapshot(sessionId, event.data as WorkerUsageSnapshot);
          break;

        case 'compact:start':
          // Auto-compaction just fired mid-turn. Mirror into the compaction
          // store (kept for the manual `/compact` toast + degraded banner)
          // AND push a transient 'compact' streaming event so the inline
          // action row renders at the point in the flow where it happened,
          // like a tool call.
          useCompactionStore.getState().setCompacting(sessionId);
          this.handleCompactEvent(sessionId, streamId, { phase: 'compacting' });
          break;

        case 'compact:done': {
          const data = event.data as { strategy?: string; tokensRemoved?: number; tokensRetained?: number; removedCount?: number } | undefined;
          useCompactionStore.getState().setDone(sessionId, {
            strategy: data?.strategy ?? 'session_memory',
            tokensRemoved: data?.tokensRemoved ?? 0,
            tokensRetained: data?.tokensRetained ?? 0,
          });
          this.handleCompactEvent(sessionId, streamId, {
            phase: 'done',
            strategy: data?.strategy,
            compactedMessageCount: data?.removedCount,
          });
          break;
        }

        case 'compact:error': {
          const data = event.data as { message?: string } | undefined;
          useCompactionStore.getState().setError(sessionId, data?.message ?? 'Unknown error');
          this.handleCompactEvent(sessionId, streamId, { phase: 'error', errorMessage: data?.message });
          break;
        }

        case 'compact:step': {
          // Plan 517 P3: per-step lifecycle event. Mirror into the
          // compaction store so the inline MessageList row can read
          // current step + stepMessageCount without each render
          // resubscribing. The streaming event is also pushed so the
          // chrome reflects the current verb (e.g. "summarizing 32
          // messages...").
          const data = event.data as
            | {
                step: 'projecting' | 'cutting' | 'summarizing' | 'rebuilding' | 'reinjecting' | 'trimming';
                phase: 'started' | 'finished';
                messageCount?: number;
              }
            | undefined;
          if (data) {
            useCompactionStore.getState().setStep(sessionId, data);
            // Only the 'started' boundary changes the visible phase — a
            // 'finished' boundary for step N is implicitly the start of
            // step N+1, and the worker emits that next.
            if (data.phase === 'started') {
              this.handleCompactEvent(sessionId, streamId, {
                phase: data.step,
                compactedMessageCount: data.messageCount,
              });
            }
          }
          break;
        }

        case 'compact:over_threshold': {
          // Plan 517 P2.2: compaction succeeded but the post-compact
          // projection is still over the budget. The agent has already
          // applied `suppress('size')`; we surface the info so the
          // renderer can show a paused-state hint.
          const data = event.data as { tokensRetained?: number; available?: number } | undefined;
          useCompactionStore.getState().setOverThreshold(sessionId, {
            tokensRetained: data?.tokensRetained ?? 0,
            available: data?.available ?? 0,
          });
          this.handleCompactEvent(sessionId, streamId, {
            phase: 'over_threshold',
          });
          break;
        }

        case 'done':
          this.handleDoneEvent(sessionId, streamId, event.data as { reason?: string } | undefined);
          break;

        case 'error':
        case 'chat:error':
          // Keep the live context snapshot: a failed turn does not shrink the
          // conversation, and clearing here opened a no-data window (empty
          // ring reading as 0%) until the next turn's token_usage. History-
          // changing operations (rewind, edit-resend, compaction) invalidate
          // the snapshot explicitly at their own completion points instead.
          this.handleErrorEvent(sessionId, streamId, event.data as StreamErrorEventData | undefined);
          break;

        case 'stream:end':
          // SSE stream ended without done (client disconnect, network error, etc.)
          if (this.isCurrentStream(sessionId, streamId)) {
            const s2 = this.sessions.get(sessionId);
            if (s2 && s2.phase !== 'completed' && s2.phase !== 'aborted' && s2.phase !== 'error') {
              // Plan 467 fallback: even when no `done` event made it through,
              // a successful `db_persisted` ack proves the worker's journal
              // committed the turn to the DB. Treat that as a completed turn
              // instead of an error — otherwise a late chunk loss on the
              // terminal `event: done` frame (Electron IPC, server keep-alive,
              // packaged renderer buffers) flips an otherwise-completed turn
              // into the false-positive `Stream ended unexpectedly` banner.
              if (s2.dbPersisted?.success) {
                console.warn('[stream-session-manager] SSE stream ended without done but db persisted OK — treating as completed', {
                  sessionId,
                  messageCount: s2.dbPersisted.messageCount,
                });
                s2.phase = 'completed';
                s2.completedAt = Date.now();
                this.flushPendingText(sessionId, streamId);
                this.notifyPhaseListeners(sessionId, s2.phase);
                this.notifyCompletedAtListeners(sessionId, s2.completedAt);
                this.notifyListeners(sessionId);
                this.clearIdleTimeout(sessionId);
                this.autoStartQueuedStream(sessionId);
                this.startPendingBackgroundResume(sessionId);
              } else {
                // Agent Server may have crashed and restarted; before falling
                // back to a hard error, give the session a chance to reattach
                // to a live run that is still in progress on a fresh server
                // (e.g. the user's prompt is still being streamed by the
                // worker that survived the server restart). The attach is
                // best-effort — if it fails we surface the error below.
                console.warn('[stream-session-manager] SSE stream ended without done, attempting reattach before error transition');
                this.attemptReattachAfterStreamEnd(sessionId, s2).then((reattached) => {
                  if (reattached) return;
                  const s3 = this.sessions.get(sessionId);
                  if (!s3 || s3.phase === 'completed' || s3.phase === 'aborted' || s3.phase === 'error') {
                    return;
                  }
                  s3.phase = 'error';
                  s3.error = 'Stream ended unexpectedly';
                  s3.completedAt = Date.now();
                  this.notifyListeners(sessionId);
                  this.notifyPhaseListeners(sessionId, s3.phase);
                  this.notifyErrorListeners(sessionId, s3.error);
                  this.notifyCompletedAtListeners(sessionId, s3.completedAt);
                });
              }
            } else if (s2) {
              console.log('[stream-session-manager] SSE stream ended but session already in phase:', s2.phase);
            }
          }
          break;

        case 'checkpoint':
          // Checkpoint events - handle but don't change phase
          break;

        case 'permission':
          this.handlePermissionEvent(sessionId, streamId, event.data as { id: string; toolName: string; toolInput: Record<string, unknown>; mode?: string; expiresAt?: number } | undefined);
          break;

        case 'connector_auth_required':
          // Plan 450: pass through to dedicated listeners (AuthRequiredCard).
          this.handleConnectorAuthRequiredEvent(
            sessionId,
            streamId,
            (event.data ?? {}) as ConnectorAuthRequiredData,
          );
          break;

        case 'mode_changed':
          this.handleModeChangedEvent(sessionId, streamId, event.data as ModeChangedEvent | undefined);
          break;

        case 'goal_updated':
          this.handleGoalUpdatedEvent(
            sessionId,
            streamId,
            (event.data ?? event) as unknown as GoalUpdatedEvent | undefined,
          );
          break;

        case 'research_updated':
          this.handleResearchUpdatedEvent(
            sessionId,
            streamId,
            (event.data ?? event) as unknown as ResearchUpdatedEvent | undefined,
          );
          break;

        case 'db:request':
          // Forward DB requests to agent server via IPC - don't handle here
          this.handleAgentServerEvent(s, streamId, event);
          break;

        case 'db_persisted':
        case 'chat:db_persisted':
        case 'title_generated':
        case 'chat:title_generated':
          this.handleAgentServerEvent(s, streamId, event);
          break;

        case 'agent_progress':
          this.handleAgentProgressEvent(
            sessionId,
            streamId,
            (event.data ?? event) as unknown as AgentProgressEvent,
          );
          break;

        default:
          // Try to handle as generic message with data
          if (event.data) {
            this.handleAgentServerEvent(s, streamId, event);
          }
          break;
      }
    };
  }

  /**
   * Attach to an already-running session's live stream (e.g. a cron run kicked
   * off by the main-process scheduler). Opens a GET /chat SSE connection to the
   * agent server for the session and routes events into the same state machine
   * as a renderer-initiated turn, so existing phase/text/tool subscriptions
   * receive live updates. Safe when the session has already finished — the
   * attach fails gracefully and callers fall back to persisted messages.
   */
  async attachToExistingStream(sessionId: string): Promise<void> {
    // Drop any previous attach handler for this session so re-attaching (e.g.
    // reopening the cron modal mid-run) does not stack duplicate subscriptions.
    this.cleanupMessagePort(sessionId);

    const state = this.getOrCreateState(sessionId);
    const streamId = crypto.randomUUID();
    state.currentStreamId = streamId;
    state.generation = 0;
    state.streamId = streamId;
    state.phase = 'streaming';
    state.error = null;
    state.errorCode = null;
    state.completedAt = null;
    state.streamingText = '';
    state.streamingThinking = '';
    state.toolUses = [];
    state.toolResults = [];
    state.streamingEvents = [];
    this.clearPartialToolInputs(state);

    const cleanup = getAgentServerClient().onEvent(sessionId, this.createStreamEventHandler(sessionId, streamId));
    this.messagePortCleanup.set(sessionId, cleanup);

    this.notifyListeners(sessionId);
    this.notifyPhaseListeners(sessionId, state.phase);
    this.notifyTextListeners(sessionId, state.streamingText);

    try {
      await getAgentServerClient().attachToLiveStream(sessionId, 0);
      // On success the stream's own `done`/`error` events drive the terminal
      // phase. On failure (session already finished → 409, or not streaming),
      // reset back to idle so the UI does not stay wedged in "streaming".
    } catch (error) {
      console.warn('[stream-session-manager] attachToExistingStream failed:', error);
      const s = this.sessions.get(sessionId);
      if (s && s.phase === 'streaming') {
        s.phase = 'idle';
        this.notifyListeners(sessionId);
        this.notifyPhaseListeners(sessionId, s.phase);
      }
    }
  }

  /**
   * Used by the `stream:end` fallback path. Probe the Agent Server's session
   * status; if the worker is still STREAMING (the server restarted but the
   * worker survived and kept producing events), attach to the live stream
   * and resume the same phase machine.
   *
   * Returns true when reattachment was kicked off, false when the session
   * is already terminal on the server (caller should treat the stream end
   * as the final transition).
   */
  private async attemptReattachAfterStreamEnd(
    sessionId: string,
    state: ReturnType<typeof this.getOrCreateState>,
  ): Promise<boolean> {
    try {
      const status = await getAgentServerClient().getSessionStatus(sessionId);
      if (!status || status.status !== 'STREAMING') {
        return false;
      }
      console.log('[stream-session-manager] Reattaching to live stream after stream:end', {
        sessionId,
        lastEventId: status.lastEventId,
      });
      // Reset generation so any stale chunks from the previous stream id
      // are ignored by isCurrentStream.
      state.streamId = crypto.randomUUID();
      state.currentStreamId = state.streamId;
      state.phase = 'streaming';
      state.error = null;
      state.completedAt = null;
      this.cleanupMessagePort(sessionId);
      const cleanup = getAgentServerClient().onEvent(
        sessionId,
        this.createStreamEventHandler(sessionId, state.streamId),
      );
      this.messagePortCleanup.set(sessionId, cleanup);
      // Note: do NOT call getAgentServerClient().attachToLiveStream here —
      // its catch path will reschedule reconnects on its own, but the new
      // sessionId-scoped reconnect map would interfere with the existing
      // active stream. Just start tailing the existing stream by reissuing
      // the GET /chat connection with the last known event id.
      void getAgentServerClient()
        .attachToLiveStream(sessionId, status.lastEventId)
        .catch((err) => {
          console.warn('[stream-session-manager] reattach after stream:end failed:', err);
        });
      this.notifyListeners(sessionId);
      this.notifyPhaseListeners(sessionId, state.phase);
      return true;
    } catch (err) {
      console.warn('[stream-session-manager] attemptReattachAfterStreamEnd probe failed:', err);
      return false;
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
      } else if (normalizedType === 'tool_use_delta' && data.id) {
        // Plan 461: embedded-type variant (event.data.type === 'tool_use_delta').
        this.handleToolUseDeltaEvent(state.sessionId, streamId, {
          id: data.id as string,
          name: (data.name as string) || '',
          delta: (data.delta as string) || '',
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

  /**
   * Plan 462: LLM transport is retrying after a transient failure. Notify the
   * retry subscribers (drives the streaming status line) and mirror the reason
   * into `statusText` so non-streaming consumers (e.g. session list) also see
   * why the run is stalled.
   */
  private handleRetryEvent(sessionId: string, streamId: string, data: RetryNotice | undefined): void {
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    if (!data) return;

    const notice: RetryNotice = {
      attempt: data.attempt,
      maxAttempts: data.maxAttempts,
      delayMs: data.delayMs,
      message: data.message?.trim() || '连接中断，正在重试',
    };
    this.notifyRetryListeners(sessionId, notice);
    s.statusText = notice.message;
    this.notifyStatusTextListeners(sessionId, s.statusText);
    this.notifyListeners(sessionId);
    this.resetIdleTimeout(sessionId);
  }

  private handleThinkingEvent(sessionId: string, streamId: string, text: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;

    // Plan 491 P0.2: throttle thinking emit with 64ms batch
    // Accumulate thinking for batched emit instead of immediate update
    s.pendingThinkingEmit = (s.pendingThinkingEmit || '') + text;

    // Update streaming events immediately for accurate event log
    const lastEvent = s.streamingEvents[s.streamingEvents.length - 1];
    if (lastEvent && lastEvent.type === 'thinking') {
      lastEvent.content += text;
    } else {
      s.streamingEvents = [...s.streamingEvents, { type: 'thinking', content: text, timestamp: Date.now() }];
    }

    // Schedule throttled emit for UI updates
    this.scheduleThinkingEmit(sessionId, streamId);

    this.resetIdleTimeout(sessionId);
  }

  /**
   * Record a context-compaction milestone (compact:start / done / error) as a
   * transient `compact` streaming event, so it renders as an inline action row
   * at the exact spot in the message flow where the compaction happened —
   * instead of a single divider pinned to the bottom of the list.
   */
  private handleCompactEvent(
    sessionId: string,
    streamId: string,
    info: {
      phase:
        | 'compacting'
        | 'done'
        | 'error'
        | 'projecting'
        | 'cutting'
        | 'summarizing'
        | 'rebuilding'
        | 'reinjecting'
        | 'trimming'
        | 'over_threshold';
      compactedMessageCount?: number;
      strategy?: string;
      errorMessage?: string;
    },
  ): void {
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    s.streamingEvents = [
      ...s.streamingEvents,
      {
        type: 'compact',
        phase: info.phase,
        timestamp: Date.now(),
        compactedMessageCount: info.compactedMessageCount,
        strategy: info.strategy,
        errorMessage: info.errorMessage,
      },
    ];
    this.notifyStreamingEventsListeners(sessionId);
    this.notifyListeners(sessionId);
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
      stage: s.researchStage || undefined,
    };
    // Plan 461: the authoritative input has arrived — drop any accumulated
    // partial fragments for this tool call so the row stops streaming.
    this.dropPartialToolInput(s, toolUse.id);
    const existingIndex = s.toolUses.findIndex((existing) => existing.id === toolUse.id);
    if (existingIndex !== -1) {
      s.toolUses = s.toolUses.map((existing, index) => index === existingIndex ? info : existing);
      // In-place update of the matching streamingEvents slot instead
      // of `.map()`-ing the whole array. The only subscriber is
      // useStreamingActions, which does not rely on the array
      // reference changing — it triggers re-render via setActions()
      // inside its rAF flush, not via reference equality. Creating a
      // fresh array on every tool_use update (e.g. streaming input
      // deltas) caused every streamingEventsListener callback to
      // re-run and every downstream memo to invalidate, even when a
      // single entry changed.
      for (let i = 0; i < s.streamingEvents.length; i++) {
        const event = s.streamingEvents[i];
        if (event.type === 'tool_use' && event.toolUse.id === toolUse.id) {
          s.streamingEvents[i] = { ...event, toolUse: info };
          break;
        }
      }
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

  /**
   * Plan 461: accumulate a raw JSON argument fragment for a tool call whose
   * arguments are still being generated. Coalesced with a short timer —
   * deltas can arrive per token and we must not re-render the row on every
   * one. The authoritative `tool_use` input replaces the partial merge when
   * it lands (see handleToolUseEvent).
   */
  private handleToolUseDeltaEvent(
    sessionId: string,
    streamId: string,
    delta: { id: string; name: string; delta: string },
  ): void {
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    if (!delta.delta) return;

    const raw = s.partialToolInputRaw.get(delta.id) || '';
    // Safety valve: stop accumulating past a 4 MiB fragment. Real LLM
    // file writes stay far below this; the final tool_use is authoritative
    // anyway, so truncation only affects the live preview.
    if (raw.length >= 4 * 1024 * 1024) return;
    s.partialToolInputRaw.set(delta.id, raw + delta.delta);

    if (s.partialInputFlushTimer !== null) return;
    s.partialInputFlushTimer = setTimeout(() => {
      this.flushPartialToolInputs(sessionId, streamId);
    }, 50);
  }

  /**
   * Plan 461: merge every accumulated partial fragment into its matching
   * ToolUseInfo (in place, so the shared streamingEvents entry picks it up)
   * and notify subscribers once. Only top-level string fields are merged —
   * numbers/arrays/objects are skipped because a truncated value would
   * corrupt the row's shape.
   */
  private flushPartialToolInputs(sessionId: string, streamId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    s.partialInputFlushTimer = null;
    if (s.partialToolInputRaw.size === 0) return;

    let changed = false;
    for (const [id, raw] of s.partialToolInputRaw) {
      const idx = s.toolUses.findIndex((u) => u.id === id);
      if (idx === -1) continue; // tool_use_started not seen yet — keep raw
      const fields = extractPartialToolFields(raw);
      const keys = Object.keys(fields);
      if (keys.length === 0) continue;
      const info = s.toolUses[idx];
      const nextInput = { ...((info.input as Record<string, unknown>) || {}), ...fields };
      if (JSON.stringify(nextInput) === JSON.stringify(info.input)) continue;
      info.input = nextInput;
      changed = true;
    }
    if (changed) {
      this.notifyToolListeners(sessionId);
      this.notifyStreamingEventsListeners(sessionId);
    }
    this.resetIdleTimeout(sessionId);
  }

  /** Drop accumulated partial fragments for one tool call (or all when
   *  `id` is omitted). Clears the coalescing timer when the map empties. */
  private dropPartialToolInput(s: SessionState, id?: string): void {
    if (id !== undefined) {
      s.partialToolInputRaw.delete(id);
    } else {
      s.partialToolInputRaw.clear();
    }
    if (s.partialToolInputRaw.size === 0 && s.partialInputFlushTimer !== null) {
      clearTimeout(s.partialInputFlushTimer);
      s.partialInputFlushTimer = null;
    }
  }

  private clearPartialToolInputs(s: SessionState): void {
    this.dropPartialToolInput(s);
  }

  private handleToolResultEvent(
    sessionId: string,
    streamId: string,
    result: {
      tool_use_id: string;
      content: string;
      is_error: boolean;
      duration_ms?: number;
      metadata?: Record<string, unknown>;
    },
  ): void {
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    const existingResultIndex = s.toolResults.findIndex((existing) => existing.tool_use_id === result.tool_use_id);
    // Plan 447: skip unconditionally when the result is already durable —
    // previously the guard required the result to also exist in snapshot
    // state, so a replayed durable event (attach path) could re-enter and
    // duplicate the row.
    if (s.loadedToolResultIds.has(result.tool_use_id)) return;
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
      metadata: result.metadata,
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

    // Plan 437: hook events are routed through this handler. Convert
    // the structured `hookEvent` payload into a `HookAction` and append
    // it as a streaming event so `useStreamingActions` and
    // `computeSegments` see it the same way they see tool_use.
    if (event.type === 'hook_invoked' && event.hookEvent) {
      const hookAction: import('@/types/hooks').HookAction = {
        id: `hook-${event.hookEvent.seq}-${Date.now()}`,
        hookEventName: event.hookEvent.hookEventName,
        hookType: event.hookEvent.hookType,
        hookName: event.hookEvent.hookName,
        matcher: event.hookEvent.matcher,
        additionalContext: event.hookEvent.additionalContext,
        exitCode: event.hookEvent.exitCode,
        async: event.hookEvent.async,
        backgroundTaskId: event.hookEvent.backgroundTaskId,
        durationMs: event.hookEvent.durationMs,
        status: event.hookEvent.status,
        errorMessage: event.hookEvent.errorMessage,
        seq: event.hookEvent.seq,
        toolName: event.hookEvent.toolName,
        toolUseId: event.hookEvent.toolUseId,
      };
      s.streamingEvents = [
        ...s.streamingEvents,
        { type: 'hook_invocation', hook: hookAction, timestamp: Date.now() },
      ];
      this.notifyStreamingEventsListeners(sessionId);
    }

    this.resetIdleTimeout(sessionId);
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

  /**
   * Plan 450: surface connector re-authorization events so the renderer
   * can prompt the user without polluting the chat error stream. The
   * last seen event per session is memoized so a fresh subscriber (e.g.
   * page remount) can replay the latest card without an extra round-trip.
   */
  private handleConnectorAuthRequiredEvent(
    sessionId: string,
    streamId: string,
    data: ConnectorAuthRequiredData,
  ): void {
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    s.pendingConnectorAuthRequest = data;
    s.authRequiredListeners.forEach((listener) => {
      try {
        listener(data);
      } catch (error) {
        console.error(`[stream-session-manager] Auth-required listener error for ${sessionId}:`, error);
      }
    });
  }

  /**
   * Plan 224 follow-up: handle `mode_changed` SSE event emitted by the
   * agent after a mode-switch tool call (EnterPlanMode / ExitPlanMode /
   * SwitchMode) completes. Notifies registered listeners so ChatView
   * can sync the input-box chip/glow with the new runtime mode. Does
   * NOT mutate `phase` — mode changes are orthogonal to the streaming
   * phase machine.
   */
  private handleModeChangedEvent(
    sessionId: string,
    streamId: string,
    data: ModeChangedEvent | undefined
  ): void {
    if (!data) return;
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    const event: ModeChangedEvent = {
      mode: data.mode,
      source: data.source ?? 'agent',
      reason: data.reason,
    };
    s.modeChangedListeners.forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        console.error(`[stream-session-manager] Mode changed listener error for ${sessionId}:`, error);
      }
    });
  }

  /**
   * Plan 411: goal tracker state broadcast (start / verdict / pause /
   * budget). Notifies registered listeners so the UI can render a goal
   * status card. The event carries the flat worker payload (state,
   * objective, tokens, gaps…).
   */
  private handleGoalUpdatedEvent(
    sessionId: string,
    streamId: string,
    data: GoalUpdatedEvent | undefined
  ): void {
    if (!data) return;
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    s.goalUpdatedListeners.forEach((listener) => {
      try {
        listener(data as GoalUpdatedEvent);
      } catch (error) {
        console.error(`[stream-session-manager] Goal updated listener error for ${sessionId}:`, error);
      }
    });
  }

  /**
   * Plan 423 Phase 3: research tracker state broadcast (start / fan-out /
   * finalize). Notifies registered listeners so the UI can render a research
   * status card. The event carries the flat worker payload (state, query,
   * sub-questions, sources, gaps…).
   */
  private handleResearchUpdatedEvent(
    sessionId: string,
    streamId: string,
    data: ResearchUpdatedEvent | undefined
  ): void {
    if (!data) return;
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    // Stamp the current research stage onto the session so subsequent
    // tool_use events get grouped by stage in arrival order.
    s.researchStage = data.state || '';
    s.researchUpdatedListeners.forEach((listener) => {
      try {
        listener(data as ResearchUpdatedEvent);
      } catch (error) {
        console.error(`[stream-session-manager] Research updated listener error for ${sessionId}:`, error);
      }
    });
  }

  private handleDoneEvent(sessionId: string, streamId: string, data?: { reason?: string }): void {
    console.log(`[stream-session-manager] handleDoneEvent: ${sessionId.slice(0, 8)}, streamId=${streamId.slice(0, 8)}, reason=${data?.reason ?? 'completed'}`);
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    // Turn over: keep the live context-usage snapshot. The worker's tracker
    // is authoritative across turns (its base survives re-init), so clearing
    // here only opens a window where the renderer falls back to the persisted
    // scan — which lags behind (tokenUsage lands in the DB at turn end) and
    // made the ring flicker to 0% between turns. Rewind / compaction /
    // errors invalidate explicitly at their own completion points instead.
    const reason = data?.reason;
    // The turn is terminal for every branch below — schedule the deferred
    // slim of this turn's streaming payload (see slimTerminalSessionState).
    this.scheduleTerminalSlim(sessionId, streamId);

    // Plan 462: terminal — drop any pending retry notice from the status line.
    this.notifyRetryListeners(sessionId, null);

    // Early-stop reasons (max_turns / repeated_tool_calls) mean the run ended
    // before the task was done. Surface them as an error banner instead of a
    // silent "completed", so the user understands why tool activity stopped.
    if (reason === 'max_turns' || reason === 'repeated_tool_calls') {
      s.phase = 'error';
      s.pendingPermissionRequest = null;
      this.notifyPermissionListeners(sessionId, null);
      s.statusText = undefined;
      s.error = formatDoneReason(reason);
      s.errorCode = reason;
      s.completedAt = Date.now();
      this.notifyPhaseListeners(sessionId, s.phase);
      this.notifyStatusTextListeners(sessionId, s.statusText);
      this.notifyErrorListeners(sessionId, s.error);
      this.notifyCompletedAtListeners(sessionId, s.completedAt);
      this.flushPendingText(sessionId, streamId);
      this.notifyListeners(sessionId);
      this.clearIdleTimeout(sessionId);
      this.autoStartQueuedStream(sessionId);
      this.startPendingBackgroundResume(sessionId);
      return;
    }

    // User-initiated abort / external interrupt: keep the aborted phase so
    // the existing "stopped" UX applies; record the reason for diagnostics
    // but do NOT raise the error banner (phase === 'aborted' suppresses it).
    if (reason === 'aborted') {
      s.phase = 'aborted';
      s.pendingPermissionRequest = null;
      this.notifyPermissionListeners(sessionId, null);
      s.statusText = undefined;
      s.error = formatDoneReason(reason);
      s.errorCode = reason;
      s.completedAt = Date.now();
      this.notifyPhaseListeners(sessionId, s.phase);
      this.notifyStatusTextListeners(sessionId, s.statusText);
      this.notifyErrorListeners(sessionId, s.error);
      this.notifyCompletedAtListeners(sessionId, s.completedAt);
      this.flushPendingText(sessionId, streamId);
      this.notifyListeners(sessionId);
      this.clearIdleTimeout(sessionId);
      this.autoStartQueuedStream(sessionId);
      this.startPendingBackgroundResume(sessionId);
      return;
    }

    // Normal completion (completed / end_turn / stop_sequence / undefined).
    s.phase = 'completed';
    s.pendingPermissionRequest = null;
    this.notifyPermissionListeners(sessionId, null);
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
    const threadTitle = useConversationStore.getState().threads.find((t) => t.id === sessionId)?.title;
    showMessageCompletionNotification(sessionId, threadTitle, s.finalMessageContent ?? undefined).catch(() => {
      // Ignore notification errors
    });
  }

  private handleErrorEvent(sessionId: string, streamId: string, data: StreamErrorEventData | undefined): void {
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) return;
    this.flushPendingText(sessionId, streamId);
    this.scheduleTerminalSlim(sessionId, streamId);
    const normalizedError = normalizeStreamError(data);
    s.phase = 'error';
    s.statusText = undefined;
    s.error = normalizedError.message;
    s.errorCode = normalizedError.code;
    s.completedAt = Date.now();
    // Plan 462: terminal — drop any pending retry notice.
    this.notifyRetryListeners(sessionId, null);
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
    event: { success?: boolean; messageCount?: number; reason?: string }
  ): void {
    const startTime = performance.now();
    console.log(`[stream-session-manager] handleDbPersistedEvent START: ${sessionId.slice(0, 8)}, success=${event.success}`);
    const s = this.sessions.get(sessionId);
    if (!s || !this.isCurrentStream(sessionId, streamId)) {
      console.log(`[stream-session-manager] handleDbPersistedEvent SKIP: session or stream mismatch`);
      return;
    }

    s.dbPersisted = {
      success: event.success ?? false,
      reason: event.reason,
      generation: s.generation,
      messageCount: event.messageCount ?? 0,
      timestamp: Date.now(),
    };
    // `done` follows this acknowledgement. Notify snapshot subscribers now so
    // the terminal handoff can make one authoritative persisted-vs-transient
    // decision instead of guessing from event timing.
    this.notifyListeners(sessionId);
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

  /**
   * Free the last turn's streaming payload once the turn is over. The
   * transcript is DB-backed, so the renderer only keeps a small terminal
   * summary (phase / error / finalMessageContent — the bot phase hook reads
   * the latter). Without this, every session that ever streamed held its
   * full event timeline (tool inputs included) for the renderer's lifetime.
   */
  private slimTerminalSessionState(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || isActivePhase(s.phase)) return;
    s.streamingText = '';
    s.streamingThinking = '';
    s.streamingToolOutput = '';
    s.streamingEvents = [];
    s.toolUses = [];
    s.toolResults = [];
    s.agentProgressEvents = [];
    s.partialToolInputRaw.clear();
  }

  /**
   * Schedule the terminal slim for a session's current stream. Guarded by
   * streamId so a follow-up turn (which reuses the same SessionState) is
   * never slimmed out from under its live events.
   */
  private scheduleTerminalSlim(sessionId: string, streamId: string | null): void {
    const prev = this.terminalSlimTimers.get(sessionId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.terminalSlimTimers.delete(sessionId);
      const s = this.sessions.get(sessionId);
      if (!s) return;
      if (streamId && s.streamId !== streamId) return;
      if (isActivePhase(s.phase)) return;
      this.slimTerminalSessionState(sessionId);
      this.evictExcessSessions();
    }, streamMemoryPolicy.terminalSlimDelayMs);
    this.terminalSlimTimers.set(sessionId, timer);
  }

  private isSessionEvictable(sessionId: string, state: SessionState): boolean {
    if (isActivePhase(state.phase)) return false;
    if ((this.pendingMessages.get(sessionId)?.length ?? 0) > 0) return false;
    if (this.pendingBackgroundResumes.has(sessionId)) return false;
    return true;
  }

  /**
   * LRU-cap on the sessions map. Post-slim states are small but previously
   * accumulated without bound; only non-active sessions (no live turn, no
   * queued messages, no pending background resume) are evicted, and any SSE
   * subscription left over from the finished stream is unsubscribed first.
   */
  private evictExcessSessions(): void {
    if (this.sessions.size <= streamMemoryPolicy.maxRetainedSessions) return;
    const evictable = [...this.sessions.entries()]
      .filter(([id, s]) => this.isSessionEvictable(id, s))
      .sort((a, b) => a[1].lastActiveAt - b[1].lastActiveAt);
    let excess = this.sessions.size - streamMemoryPolicy.maxRetainedSessions;
    for (const [id] of evictable) {
      if (excess <= 0) break;
      const timer = this.terminalSlimTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.terminalSlimTimers.delete(id);
      }
      this.cleanupMessagePort(id);
      this.sessions.delete(id);
      excess -= 1;
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
    this.scheduleTerminalSlim(sessionId, state.currentStreamId);

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

  subscribeToRetry(sessionId: string, listener: (info: RetryNotice | null) => void): () => void {
    const state = this.getOrCreateState(sessionId);
    state.fieldListeners.retry.add(listener);
    return () => { state.fieldListeners.retry.delete(listener); };
  }

  subscribeToPermissions(
    sessionId: string,
    listener: (request: PermissionRequestEvent | null) => void
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

  /**
   * Plan 450: subscribe to per-session connector re-authorization events.
   * Replays the latest pending event so a remounting UI shows the card
   * without waiting for the next failed call.
   */
  subscribeToConnectorAuthRequired(
    sessionId: string,
    listener: (data: ConnectorAuthRequiredData | null) => void,
  ): () => void {
    const state = this.getOrCreateState(sessionId);
    state.authRequiredListeners.add(listener);
    if (state.pendingConnectorAuthRequest) {
      try {
        listener(state.pendingConnectorAuthRequest);
      } catch (error) {
        console.error(`[stream-session-manager] Auth-required listener immediate replay error for ${sessionId}:`, error);
      }
    }
    return () => {
      state.authRequiredListeners.delete(listener);
    };
  }

  /** Clear the latest pending auth-required event after the user acted on it. */
  clearConnectorAuthRequired(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.pendingConnectorAuthRequest = null;
    this.notifyAuthRequiredListeners(sessionId, null);
  }

  /**
   * Clear the stored pending permission request for a session. Called after
   * the user resolves a permission (e.g. answers an AskUserQuestion) so a
   * later re-subscription (page switch / remount) does NOT replay a stale
   * request that the user already answered. Without this, the pending
   * request lingers until the stream ends or a new stream starts, and the
   * card reappears after navigating away and back.
   */
  clearPendingPermission(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.pendingPermissionRequest = null;
      this.notifyPermissionListeners(sessionId, null);
    }
  }

  /**
   * Plan 224 follow-up: subscribe to agent-initiated runtime mode
   * switches (EnterPlanMode / ExitPlanMode / SwitchMode tool calls).
   * Returns an unsubscribe function. The listener is fire-and-forget —
   * there is no pending state to replay because mode_changed events
   * are transient; if the renderer re-mounts mid-stream it simply
   * waits for the next event.
   */
  subscribeToModeChanged(
    sessionId: string,
    listener: (event: ModeChangedEvent) => void
  ): () => void {
    const state = this.getOrCreateState(sessionId);
    state.modeChangedListeners.add(listener);
    return () => {
      state.modeChangedListeners.delete(listener);
    };
  }

  /**
   * Plan 411: subscribe to goal tracker state broadcasts (goal status
   * card). Events are transient — a re-mount simply waits for the next
   * transition.
   */
  subscribeToGoalUpdated(
    sessionId: string,
    listener: (event: GoalUpdatedEvent) => void
  ): () => void {
    const state = this.getOrCreateState(sessionId);
    state.goalUpdatedListeners.add(listener);
    return () => {
      state.goalUpdatedListeners.delete(listener);
    };
  }

  /**
   * Plan 423 Phase 3: subscribe to research tracker state broadcasts
   * (research status card). Events are transient — a re-mount simply waits
   * for the next transition.
   */
  subscribeToResearchUpdated(
    sessionId: string,
    listener: (event: ResearchUpdatedEvent) => void
  ): () => void {
    const state = this.getOrCreateState(sessionId);
    state.researchUpdatedListeners.add(listener);
    return () => {
      state.researchUpdatedListeners.delete(listener);
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
      authRequiredListeners: new Set(),
      modeChangedListeners: new Set(),
      goalUpdatedListeners: new Set(),
        researchUpdatedListeners: new Set(),
      dbPersistedListeners: new Set(),
      idleTimeout: null,
      textEmitTimeout: null,
      pendingTextEmit: '',
      // Plan 491 P0.2: thinking emit throttle (64ms batch)
      thinkingEmitTimeout: null,
      pendingThinkingEmit: '',
      partialToolInputRaw: new Map(),
      partialInputFlushTimer: null,
      sendRetryMessage: null,
    };

    this.sessions.set(sessionId, state);
    this.evictExcessSessions();
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
    scheduleRafBatched(sessionId, 'text', state.fieldListeners.text, text);
  }

  private notifyThinkingListeners(sessionId: string, thinking: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    scheduleRafBatched(sessionId, 'thinking', state.fieldListeners.thinking, thinking);
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

  private notifyToolOutputListeners(sessionId: string, output: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    scheduleRafBatched(sessionId, 'toolOutput', state.fieldListeners.toolOutput, output);
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

  /**
   * Plan 516 — notify permission / connector-auth subscribers when the
   * pending request is cleared (user answered, stream ended, fresh run).
   * The push path (permission_request event handler) already notifies
   * listeners with the event; the clear path previously only mutated
   * state, leaving subscribers (e.g. the sidebar awaiting-input pill
   * in BotContactListItem / ThreadListItem) stuck on the stale request
   * until remount. Always pair the push with a clear notification so
   * listeners can drop the pill.
   */
  private notifyPermissionListeners(sessionId: string, request: PermissionRequestEvent | null): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.permissionListeners.forEach((listener) => {
      try { listener(request); } catch (e) { console.error(e); }
    });
  }

  private notifyAuthRequiredListeners(sessionId: string, request: ConnectorAuthRequiredData | null): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.authRequiredListeners.forEach((listener) => {
      try { listener(request); } catch (e) { console.error(e); }
    });
  }

  private notifyRetryListeners(sessionId: string, info: RetryNotice | null): void {
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
    // Plan 491 P0.2: Use 64ms setTimeout for 15fps throttle (rAF is 60fps, too fast)
    state.textEmitTimeout = setTimeout(() => {
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

    // Preserve block-level markdown boundaries: when the accumulated text
    // does not end with a newline but the pending chunk starts with a
    // block-level pattern (#, -, *, >, 1.), insert a newline so headings,
    // list items, and blockquotes are not swallowed into the previous
    // paragraph. This prevents `###` from rendering as literal text.
    const chunk = state.pendingTextEmit;
    const prev = state.streamingText;
    const needsNewline = prev.length > 0
      && !prev.endsWith('\n')
      && /^[#\*>\-\d]/.test(chunk);
    if (needsNewline) {
      state.streamingText += '\n';
    }
    state.streamingText += chunk;
    state.finalMessageContent = state.streamingText;
    const newText = state.streamingText;
    state.pendingTextEmit = '';
    state.textEmitTimeout = null;
    this.notifyTextListeners(sessionId, newText);
    this.notifyListeners(sessionId);
  }

  // Plan 491 P0.2: thinking emit throttle (64ms batch)
  private scheduleThinkingEmit(sessionId: string, streamId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || !this.isCurrentStream(sessionId, streamId) || state.thinkingEmitTimeout) return;
    state.thinkingEmitTimeout = setTimeout(() => {
      this.flushPendingThinking(sessionId, streamId);
    }, this.textEmitInterval);
  }

  private clearThinkingEmitTimeout(state: SessionState): void {
    if (state.thinkingEmitTimeout !== null) {
      if (typeof state.thinkingEmitTimeout === 'number') {
        cancelAnimationFrame(state.thinkingEmitTimeout);
      } else {
        clearTimeout(state.thinkingEmitTimeout);
      }
      state.thinkingEmitTimeout = null;
    }
  }

  private flushPendingThinking(sessionId: string, streamId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || !this.isCurrentStream(sessionId, streamId)) return;
    if (!state.pendingThinkingEmit) {
      state.thinkingEmitTimeout = null;
      return;
    }
    const thinking = state.pendingThinkingEmit;
    state.streamingThinking = thinking;
    state.pendingThinkingEmit = '';
    state.thinkingEmitTimeout = null;
    this.notifyThinkingListeners(sessionId, thinking);
    this.notifyStreamingEventsListeners(sessionId);
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

    // Pause the idle timer while a tool call is still awaiting its result.
    //
    // Foreground tools (BashTool, ReadTool on slow paths, MCP calls, etc.)
    // do not stream progress events while they await the underlying
    // subprocess — `cargo test` / a large build / a slow HTTP fetch can sit
    // silent for minutes. Without this pause, the session-level idle
    // timeout (STREAM_IDLE_TIMEOUT_MS = 280s) would trip mid-run, abort the
    // SSE stream, and the renderer would see the entire message list
    // disappear even though the tool was making progress.
    //
    // The tool_result handler calls resetIdleTimeout once the result lands;
    // at that point toolUses.length === toolResults.length, so a fresh
    // 280s window starts for the LLM to consume the result and respond.
    const hasPendingTool = state.toolUses.length > state.toolResults.length;
    if (hasPendingTool) {
      return;
    }

    state.idleTimeout = setTimeout(() => {
      void this.stopStream(sessionId, 'Idle timeout exceeded');
    }, this.idleTimeoutMs);
  }

  // ---- Research session state management ----
  // The research mode persists durable progress in the research_events
  // table. After an app restart, `restoreResearchStateFromDB` rebuilds
  // the in-memory ResearchSessionState from that event log so the UI
  // can resume showing the run's progress, findings, and report.

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

  /**
   * Restore research state from backend database after app restart.
   * Replays the persisted research_events log to rebuild the snapshot,
   * then merges DB row metadata (run status, completed_at, etc.).
   */
  async restoreResearchStateFromDB(sessionId: string): Promise<boolean> {
    const client = getAgentServerClient();
    const dbRow = await client.getResearchSnapshot(sessionId);
    if (!dbRow) {
      return false;
    }

    const runStatus = dbRow.run_status as string | null;
    const legacyStatus = dbRow.status as string;
    const workerActive = dbRow.workerActive === true;
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
    state.progressSummary = (dbRow.progress_summary as string) || null;
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

    const restoredMetadata = {
      mode: state.mode,
      active: state.active,
      originalQuery: state.originalQuery,
      stage: state.stage,
      phase: state.phase,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      runId: state.runId,
      runStatus: state.runStatus,
      progressSummary: state.progressSummary,
      error: state.error,
      pendingRequest: state.pendingRequest,
      plan: state.plan,
      planQuestions: state.planQuestions,
      planSteps: state.planSteps,
      findings: state.findings,
      reportText: state.reportText,
      summary: state.summary,
      activities: state.activities,
      currentIteration: state.currentIteration,
      coverage: state.coverage,
      findingsCount: state.findingsCount,
      questionCount: state.questionCount,
    };

    if (state.persistedEvents.length > 0) {
      this.rebuildResearchProgressFromEvents(sessionId, state.persistedEvents);
      if (state.reportArtifact?.markdown) {
        state.reportText = state.reportArtifact.markdown;
      }
    }

    state.mode = restoredMetadata.mode;
    state.active = restoredMetadata.active;
    state.originalQuery = restoredMetadata.originalQuery;
    state.stage = restoredMetadata.stage;
    state.phase = restoredMetadata.phase;
    state.startedAt = restoredMetadata.startedAt;
    state.completedAt = restoredMetadata.completedAt;
    state.runId = restoredMetadata.runId;
    state.runStatus = restoredMetadata.runStatus;
    state.progressSummary = restoredMetadata.progressSummary;
    state.error = restoredMetadata.error;
    state.currentIteration = Math.max(state.currentIteration, restoredMetadata.currentIteration);
    state.coverage = Math.max(state.coverage, restoredMetadata.coverage);

    if (!state.pendingRequest && restoredMetadata.pendingRequest) {
      state.pendingRequest = restoredMetadata.pendingRequest;
    }
    if (!state.plan && restoredMetadata.plan) {
      state.plan = restoredMetadata.plan;
    }
    if (state.planQuestions.length === 0 && restoredMetadata.planQuestions.length > 0) {
      state.planQuestions = restoredMetadata.planQuestions;
      state.questionCount = restoredMetadata.questionCount;
    }
    if (state.planSteps.length === 0 && restoredMetadata.planSteps.length > 0) {
      state.planSteps = restoredMetadata.planSteps;
    }
    if (state.findings.length === 0 && restoredMetadata.findings.length > 0) {
      state.findings = restoredMetadata.findings;
      state.findingsCount = restoredMetadata.findingsCount;
    }
    if (!state.reportText && restoredMetadata.reportText) {
      state.reportText = restoredMetadata.reportText;
    }
    if (!state.summary && restoredMetadata.summary) {
      state.summary = restoredMetadata.summary;
    }
    if (state.activities.length === 0 && restoredMetadata.activities.length > 0) {
      state.activities = restoredMetadata.activities;
    }
    state.pendingRequest = inferPendingResearchRequest(state);
    if (!workerActive && state.pendingRequest) {
      state.pendingRequest = {
        ...state.pendingRequest,
        requestId: `restored_plan_${state.runId || state.sessionId}`,
      };
    }
    if (!workerActive && state.active && !isCompleted && !isFailed) {
      state.active = false;
      state.progressSummary = state.progressSummary || 'Research state restored, but the original worker is no longer running.';
    }
    state.questionCount = state.planQuestions.length || state.questionCount;
    state.findingsCount = state.findings.length || state.findingsCount;

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

        case 'research_source_found':
        case 'research_source_rejected':
        case 'research_gap_detected':
        case 'research_next_action':
        case 'research_conflict_detected':
        case 'research_stop_decision':
        case 'plan_delta':
          // These events are emitted by the orchestrator for transparency
          // (debug panel / future UI surfaces) but currently have no
          // dedicated snapshot field. Record them as activities so the
          // research log is not silently empty when they fire.
          this.handleResearchActivityEvent(sessionId, {
            activityId: `${event.type}_${Date.now()}`,
            kind: event.type,
            title: formatResearchAuxEventTitle(event.type, event.data),
            detail: typeof event.data === 'object' ? JSON.stringify(event.data).slice(0, 240) : undefined,
            sequence: 0,
            timestamp: typeof (event as { timestamp?: unknown }).timestamp === 'number'
              ? (event as { timestamp: number }).timestamp
              : Date.now(),
          });
          break;

        case 'research_continue':
          this.handleResearchContinueEvent(sessionId, event.data as { addedQuestions: ResearchPanelQuestion[]; coverageBefore: number; timestamp: number } | undefined);
          break;

        case 'research_evidence':
          this.handleResearchEvidenceEvent(sessionId, event.data as { requestId: string; conclusion: string; chain: { evidenceNodes: Array<{ id: string; type: string; content: string; source?: string; supports: boolean; depth: number }>; confidence: number; reasoning: string }; timestamp: number } | undefined);
          break;

        case 'research_report':
          this.handleResearchReportEvent(sessionId, event.data as { reportId: string; content: string; contextSnapshot: { questionCount: number; findingCount: number; coverage: number; entities: string[] }; availableActions?: string[]; timestamp: number } | undefined);
          break;
        case 'report_complete':
          state.stage = 'complete';
          state.active = false;
          state.completedAt = typeof event.timestamp === 'number' ? event.timestamp : state.completedAt;
          state.reportText = typeof (event as { content?: unknown }).content === 'string'
            ? (event as { content: string }).content
            : state.reportText;
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
    state.active = true;
    state.runStatus = data.runStatus as ResearchSessionSnapshot['runStatus'];
    state.stage = mapPhaseToStageAndRunStatus(data.phase, data.runStatus);
    this.notifyResearchListeners(sessionId);
  }

  private handleResearchActivityEvent(
    sessionId: string,
    data: { activityId: string; kind: string; title: string; detail?: string; sequence: number; timestamp: number } | undefined,
  ): void {
    if (!data) return;
    this.pushResearchActivity(sessionId, {
      kind: (data.kind as ResearchActivityItem['kind']) || 'milestone',
      title: data.title,
      detail: data.detail,
      timestamp: data.timestamp,
    });
    this.notifyResearchListeners(sessionId);
  }

  private handleResearchPlanStepsEvent(
    sessionId: string,
    data: { steps: Array<{ id: string; order: number; label: string }>; timestamp: number } | undefined,
  ): void {
    if (!data) return;
    const state = this.getOrCreateResearchState(sessionId);
    state.planSteps = data.steps.map((step, index) => ({
      id: step.id,
      order: step.order ?? index,
      label: step.label,
      status: 'pending',
      startedAt: null,
      completedAt: null,
    }));
    this.notifyResearchListeners(sessionId);
  }

  private handleResearchContinueEvent(
    sessionId: string,
    data: { addedQuestions: ResearchPanelQuestion[]; coverageBefore: number; timestamp: number } | undefined,
  ): void {
    if (!data) return;
    const state = this.getOrCreateResearchState(sessionId);
    const existingIds = new Set(state.planQuestions.map((q) => q.id));
    state.planQuestions = [
      ...state.planQuestions,
      ...data.addedQuestions.filter((q) => !existingIds.has(q.id)),
    ];
    state.questionCount = state.planQuestions.length;
    this.notifyResearchListeners(sessionId);
  }

  private handleResearchEvidenceEvent(
    sessionId: string,
    data: { requestId: string; conclusion: string; chain: { evidenceNodes: Array<{ id: string; type: string; content: string; source?: string; supports: boolean; depth: number }>; confidence: number; reasoning: string }; timestamp: number } | undefined,
  ): void {
    if (!data) return;
    const state = this.getOrCreateResearchState(sessionId);
    state.lastEvidenceChain = {
      requestId: data.requestId,
      conclusion: data.conclusion,
      chain: {
        evidenceNodes: data.chain.evidenceNodes as ResearchSessionSnapshot['lastEvidenceChain'] extends null ? never : NonNullable<ResearchSessionSnapshot['lastEvidenceChain']>['chain']['evidenceNodes'],
        confidence: data.chain.confidence,
        reasoning: data.chain.reasoning,
      },
      timestamp: data.timestamp,
    };
    this.notifyResearchListeners(sessionId);
  }

  private handleResearchReportEvent(
    sessionId: string,
    data: { reportId: string; content: string; contextSnapshot: { questionCount: number; findingCount: number; coverage: number; entities: string[] }; availableActions?: string[]; timestamp: number } | undefined,
  ): void {
    if (!data) return;
    const state = this.getOrCreateResearchState(sessionId);
    state.reportText = data.content;
    state.stage = 'synthesizing';
    this.notifyResearchListeners(sessionId);
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
export const subscribeToConnectorAuthRequired = (
  sessionId: string,
  listener: (data: ConnectorAuthRequiredData | null) => void,
) => streamSessionManager.subscribeToConnectorAuthRequired(sessionId, listener);
export const clearConnectorAuthRequired = (sessionId: string) =>
  streamSessionManager.clearConnectorAuthRequired(sessionId);
export const resumeBackgroundTask = (sessionId: string) => streamSessionManager.resumeBackgroundTask(sessionId);
export const attachToExistingStream = (sessionId: string) => streamSessionManager.attachToExistingStream(sessionId);
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
export const subscribeToPermissions = (sessionId: string, listener: (request: PermissionRequestEvent | null) => void) =>
  streamSessionManager.subscribeToPermissions(sessionId, listener);
export const clearPendingPermission = (sessionId: string) =>
  streamSessionManager.clearPendingPermission(sessionId);
export const subscribeToModeChanged = (sessionId: string, listener: (event: ModeChangedEvent) => void) =>
  streamSessionManager.subscribeToModeChanged(sessionId, listener);

export const subscribeToGoalUpdated = (sessionId: string, listener: (event: GoalUpdatedEvent) => void) =>
  streamSessionManager.subscribeToGoalUpdated(sessionId, listener);
export const subscribeToResearchUpdated = (sessionId: string, listener: (event: ResearchUpdatedEvent) => void) =>
  streamSessionManager.subscribeToResearchUpdated(sessionId, listener);
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
export const subscribeToToolOutput = (sessionId: string, listener: (output: string) => void) =>
  streamSessionManager.subscribeToToolOutput(sessionId, listener);
export const subscribeToToolProgress = (sessionId: string, listener: (info: { toolName: string; elapsedSeconds: number } | null) => void) =>
  streamSessionManager.subscribeToToolProgress(sessionId, listener);
export const subscribeToToolTimeout = (sessionId: string, listener: (info: { toolName: string; elapsedSeconds: number } | null) => void) =>
  streamSessionManager.subscribeToToolTimeout(sessionId, listener);
export const subscribeToError = (sessionId: string, listener: (error: StreamingError | null) => void) =>
  streamSessionManager.subscribeToError(sessionId, listener);
export const subscribeToRetry = (sessionId: string, listener: (info: RetryNotice | null) => void) =>
  streamSessionManager.subscribeToRetry(sessionId, listener);
export const subscribeToStreamingEvents = (sessionId: string, listener: (events: StreamingEvent[]) => void) =>
  streamSessionManager.subscribeToStreamingEvents(sessionId, listener);

/**
 * True while the session has a live turn (starting/streaming/awaiting_
 * permission/persisting). Consumers that free session-scoped renderer state
 * (e.g. conversation-store evicting off-screen transcripts) must skip busy
 * sessions — their in-memory rows feed the durable-subtraction path.
 */
export const isSessionBusy = (sessionId: string): boolean => {
  const state = streamSessionManager.getSnapshot(sessionId);
  return state ? isActivePhase(state.phase) : false;
};

// Research session helpers — used by the UI to rebuild research mode state
// from persisted research_events after an app restart.
export const restoreResearchStateFromDB = (sessionId: string) =>
  streamSessionManager.restoreResearchStateFromDB(sessionId);
export const getResearchSnapshot = (sessionId: string) =>
  streamSessionManager.getResearchSnapshot(sessionId);
