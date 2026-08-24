/**
 * agent-process-entry.ts - Agent Process Entry Point
 *
 * Runs as a standalone Node.js child process (not Worker Thread).
 * This replaces daemon-worker.ts as the Agent runtime.
 *
 * Architecture:
 * - Main Process ↔ Agent Process via stdin/stdout JSON-RPC
 * - Each Agent Process handles one session
 * - Sub-agents run sequentially within the same process
 *
 * Message Flow:
 * 1. Receive 'init' - Initialize agent with config
 * 2. Receive 'chat:start' - Start streaming chat
 * 3. Emit events back to Main via stdout JSON lines (sendEvent)
 * 4. Receive 'ping' - Respond with 'pong'
 */

import { randomUUID } from 'crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendMessages, storeParsedDocumentAttachment } from '../session/db.js';

import type { MessageRow, AttachmentRow, ParsedDocumentAttachment } from '../session/db.js';
import { getAttachmentsForSession, rehydrateContentWithAttachments } from '../session/db.js';
import type { Message, MessageContent, MCPServerConfig, Tool, TokenUsage } from '../types.js';
import type { ProviderRuntimeConfig } from '@duya/ai';
import {
  messageDb,
  pluginDb,
  settingDb,
  sessionDb,
  turnReviewDb,
  goalDb,
} from '../ipc/db-client.js';
import { captureTurnReviewBaseline, completeTurnReview, type TurnReviewBaseline } from '../session/turn-review.js';

import { sendMemoryWakeup } from '../memory-rollout/wakeup.js';
import {
  enqueue,
  dequeue,
  hasCommandsInQueue,
  clearCommandQueue,
  getCommandQueueLength,
} from '../queue/index.js';
import type { QueuedCommand } from '../queue/index.js';
import { generateSessionTitle, shouldRegenerateTitle } from '../session/title-generator.js';
import { getSteeringConfig } from '../hooks/config.js';
import { classifyError, APIErrorType, computeContextEstimate, normalizePromptTokens } from '@duya/ai';
import type { PromptProfile } from '../prompts/modes/types.js';
// Plan 312: type-only import for the App Connection tool descriptor.
import type { AppConnectionToolDescriptor } from '../tool/AppConnectionTool/index.js';
import { buildSandboxImage, setSandboxEnabled } from '../sandbox/index.js';
import { duyaAgent } from '../agent/DuyaAgent.js';
import { Journal } from '../journal/Journal.js';
import { loadSkills, getSkillRegistry } from '../skills/index.js';
import { browserTool } from '../tool/builtin.js';
import { getBashTaskRegistry } from '../session/bash-task-registry.js';
import { hookTaskRegistry } from '../hooks/task-registry.js';
import { backgroundAgentLifecycle } from '../lifecycle/BackgroundAgentLifecycle.js';
import { sendEvent, parseStdin, type WorkerCommand } from './worker-protocol.js';
import { resolveChatStartAgentMode } from './permission-profile-bridge.js';
import { applyMCPConfiguration, type MCPApplyResult } from '../mcp/apply.js';
import { storePendingAnswer } from '../tool/AskUserQuestionTool/AskUserQuestionTool.js';
import { isCDNImageUrl } from '../utils/urlSafety.js';
import { resizeImageBuffer, needsResizing, TARGET_IMAGE_SIZE_BYTES } from '../utils/imageResizer.js';
import { isModelLikelyMultimodal } from '../utils/multimodal-detection.js';
import { detectModelCapability } from '../utils/model-capability-cache.js';
import type { ProbeConfig } from '../utils/model-capability-cache.js';
import { VisionTool } from '../tool/VisionTool/VisionTool.js';
import type { ToolExecutor } from '../tool/registry.js';
import { estimateMessagesTokens } from '../compact/tokenBudget.js';
import type { ApiFormat, ModelCompat } from '@duya/ai';

// Polyfill globalThis.crypto for Node.js
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
  (globalThis as { crypto: { randomUUID: () => string } }).crypto = {
    randomUUID: () => randomUUID(),
  };
}

// Type definitions
interface VisionConfig {
  provider: string;
  model: string;
  baseURL: string;
  apiKey: string;
  enabled: boolean;
}

interface InitMessage {
  type: 'init';
  sessionId: string;
  providerConfig: {
    apiKey: string;
    baseURL?: string;
    model: string;
    provider: 'anthropic' | 'openai' | 'ollama';
    authStyle?: 'api_key' | 'auth_token';
    visionConfig?: VisionConfig;
    compactModelConfig?: VisionConfig;
    /**
     * Phase 2: optional ProviderRuntimeConfig. When present, the agent
     * prefers the apiFormat and headers from this object over the legacy
     * `provider` discriminator. New code should treat this as the
     * authoritative runtime config.
     */
    runtimeConfig?: ProviderRuntimeConfig;
  };
  workingDirectory?: string;
  defaultWorkspaceDirectory?: string;
  systemPrompt?: string;
  skillPaths?: string[];
  communicationPlatform?: string;
  blockedDomains?: string[];
  browserBackendMode?: 'auto' | 'extension' | 'built-in' | 'human-like';
  language?: string;
  sandboxEnabled?: boolean;
  securityScanEnabled?: boolean;
  /** Optional user-defined permission rules. Mirrors `AgentOptions.permissionRules`. */
  permissionRules?: import('../types.js').AgentOptions['permissionRules'];
  /** Authoritative locale/timezone from the user's machine (sent by main). */
  systemLocation?: {
    locale: string;
    localeCountryCode: string | null;
    timezone: string;
  };
}

interface FileAttachment {
  id: string;
  name: string;
  type: string;
  url: string;
  size: number;
  path?: string;
  text?: string;
  extractMethod?: 'text' | 'vision' | 'hybrid';
  imageChunks?: Array<{ base64: string; mediaType: string }>;
  base64?: string;
}

interface ChatStartMessage {
  type: 'chat:start';
  sessionId: string;
  id: string;
  prompt: string;
  options?: {
    messages?: Array<{ role: string; content: string }>;
    systemPrompt?: string;
    language?: string;
    /** @deprecated 由 session row.permission_profile 派生, worker 严格忽略. */
    permissionMode?: string;
    permissionModeOverride?: 'default' | 'auto' | 'bypassPermissions';
    files?: FileAttachment[];
    agentProfileId?: string | null;
    outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean };
    displayContent?: string;
    mode?: string;
    titleGenerationModel?: string;
    titleGenerationModelConfig?: {
      provider: string;
      apiKey: string;
      baseURL: string;
      model: string;
      apiFormat?: string;
      modelCompat?: ModelCompat;
    };
    effort?: string;
    /**
     * Maximum agentic turns for this run. Absent → fall back to the
     * configured `agent.max_turns`, then the built-in default (100).
     */
    maxTurns?: number;
    /**
     * Allowlist of tool names permitted for this chat turn. When set, only
     * tools whose name is in this list are exposed to the LLM. Used by
     * interagent `minimal` mode to restrict the target agent to Read/Grep/Glob.
     */
    allowedTools?: string[];
    /** Conductor mode — inject canvas tools + prompt overlay for this turn. */
    conductorMode?: boolean;
    /** Conductor canvas ID bound to the session (required when conductorMode is true). */
    conductorCanvasId?: string;
    /** Internal continuation for a completed background sub-agent. */
    backgroundTaskResume?: boolean;
    /**
     * Wall-clock timeout (ms) for a single LLM request within this chat turn.
     * When set, each streamChat LLM call is aborted after this duration even
     * if the stream is still producing data (e.g. a MiniMax thinking stream
     * that never converges), so a hung call fails the run fast instead of
     * burning the whole run budget. Optional; absent = no per-request cap.
     */
    llmRequestTimeoutMs?: number;
  };
}

interface PongMessage {
  type: 'pong';
  timestamp: number;
}

// Global state
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let agent: any = null;
let sessionId: string | null = null;
let initializing = false;
let chatInProgress = false;
let currentSecurityScanEnabled = true;
let lastInterruptTime = 0;
const DOUBLE_INTERRUPT_WINDOW_MS = 3000;
let sessionSystemPrompt: string | undefined = undefined;
let existingMessageCount = 0;

// Live context-usage emission (plan 443, pi parity). The context size is
// computed STATELESSLY on every emit via computeContextEstimate(@duya/ai):
// latest valid assistant usage anchor + estimated trailing messages. No
// incremental base / boundary bookkeeping — the previous tracker state
// machine (liveBaseContext / liveBaseMessageCount / hasLiveBase /
// liveBoundaryPending) was the source of ring sawtooth and is gone.
// Set when compaction (manual `/compact` or proactive mid-turn) shrank the
// timeline: retained usage anchors describe the PRE-compaction prompt, so
// emissions stay "unanchored" (ring shows ?) until this turn's first `result`
// provides a post-compaction anchor. Reset on `init`.
let compactedPending = false;
// Session-cumulative usage across every `result` this worker has seen for
// this session (reset on `init`). The ring's ↑/↓/R/W/$ footer is cumulative
// (pi-style), so the worker accumulates rather than broadcasting only the
// last result's deltas — otherwise the stats line would freeze during
// streaming and only update after the turn-end DB persist.
let liveTotalInput = 0;        // normalized input (cache-convention aware)
let liveTotalInputRaw = 0;     // raw input_tokens (for cost on the uncached portion)
let liveTotalOutput = 0;
let liveTotalCacheHit = 0;
let liveTotalCacheCreation = 0;

/** Single-request usage sub-block persisted inside the turn-cumulative
 *  `token_usage` JSON. The cumulative block sums EVERY LLM call of the turn,
 *  so restoring a context base from it inflates the ring ~N× on tool-heavy
 *  turns; `last_call` carries the final request's real prompt size. */
interface LastCallUsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_hit_tokens?: number;
  cache_creation_tokens?: number;
}

// Broadcast the live context-usage snapshot for a session over the worker
// channel. Module scope so the compaction paths (manual `compact` command,
// proactive mid-turn compaction) can push a fresh snapshot too, not just the
// streamChat event loop. Stateless: recomputed from the current message
// timeline on every call.
const emitLiveUsage = (
  targetSessionId: string | null,
  systemFallbackTokens?: number,
): void => {
  if (!targetSessionId) return;
  const msgs: Message[] = agent?.getMessages?.() ?? [];
  // Estimated tokens of the system prompt + tools (excluding message history)
  // — added ONLY on the unanchored fallback path inside computeContextEstimate.
  const systemPrefix =
    (typeof agent?.getSystemContextTokensEstimate === 'function'
      ? agent.getSystemContextTokensEstimate()
      : 0) || systemFallbackTokens || 0;
  const estimate = computeContextEstimate(msgs, { systemPrefixTokens: systemPrefix });
  const anchored = estimate.anchored && !compactedPending;
  // Diagnostic trace for ring anomalies: shows exactly which anchor each
  // broadcast used (index/value/trailing) so a bad frame can be traced in
  // app.log without a debugger. Logged at WARN purely so it survives the
  // default WARN file filter — remove once ring behavior is verified.
  warn(
    `[Agent-Process] emitLiveUsage: msgs=${msgs.length} anchored=${anchored} anchorIdx=${estimate.anchorIndex} anchor=${estimate.anchorTokens} trailing=${estimate.trailingTokens} used=${estimate.usedTokens ?? 'null'} totalsIn=${liveTotalInput} cacheHit=${liveTotalCacheHit}`,
  );
  // Last-request per-call fields for the stats line: read off the anchor
  // message itself (`usage` in-memory from DuyaAgent, `tokenUsage` persisted).
  const anchorMsg =
    estimate.anchorIndex !== null
      ? (msgs[estimate.anchorIndex] as
          | { usage?: LastCallUsageBlock; tokenUsage?: LastCallUsageBlock }
          | undefined)
      : undefined;
  const anchorUsage = anchorMsg?.usage ?? anchorMsg?.tokenUsage;
  const { prompt: lastInput, output: lastOutput } = normalizePromptTokens(anchorUsage);
  sendToMain({
    type: 'chat:token_usage',
    sessionId: targetSessionId,
    // False → renderer shows "?" instead of a number (no data yet, or
    // post-compaction without a fresh response).
    anchored,
    usedTokens: estimate.usedTokens ?? 0,
    inputTokens: lastInput,
    outputTokens: lastOutput,
    cacheHitTokens: anchorUsage?.cache_hit_tokens,
    cacheCreationTokens: anchorUsage?.cache_creation_tokens,
    // Estimated tokens of the system prompt + tools (pi-style prefix), kept
    // in the frame for diagnostics.
    systemTokens: systemPrefix,
    // Session-cumulative totals so the ring's ↑/↓/R/W/$ line moves live.
    totalInput: liveTotalInput,
    totalInputRaw: liveTotalInputRaw,
    totalOutput: liveTotalOutput,
    totalCacheHit: liveTotalCacheHit,
    totalCacheCreation: liveTotalCacheCreation,
  });
};
// Track the main model name for multimodal detection
let mainModelName = '';
let probeConfig: ProbeConfig | null = null;
const visionTool = new VisionTool();
// Track title generation per session (Map<sessionId, lastGeneratedTitle>)
const titleGeneratedBySession = new Map<string, string>();
// Title generation model config (from settings)
let titleGenerationModelConfig: {
  provider: string;
  apiKey: string;
  baseURL: string;
  model: string;
  apiFormat?: string;
  modelCompat?: ModelCompat;
} | null = null;
const DEBUG_IPC = process.env.DUYA_DEBUG_IPC === 'true';
// Heartbeat tracking for long-running operations
let lastPongTime = Date.now();
const HEARTBEAT_INTERVAL = 5000; // Send pong every 5 seconds during streaming

// Independent heartbeat timer to keep process alive during long operations
let chatHeartbeatTimer: NodeJS.Timeout | null = null;
const CHAT_HEARTBEAT_INTERVAL = 8000; // Send pong every 8 seconds while chat is active

// ----------------------------------------------------------------------------
// Bash background task list — push snapshot to renderer on any change.
// Throttled so rapid progress events coalesce into a single update per tick.
// ----------------------------------------------------------------------------
const BASH_TASK_PUSH_THROTTLE_MS = 300;
let bashTaskPushScheduled = false;

function pushBashTaskSnapshot(): void {
  const activeSessionId = sessionId;
  if (!activeSessionId) return;
  const tasks = getBashTaskRegistry().listTasks();
  sendToMain({ type: 'bash_task:update', sessionId: activeSessionId, tasks });
}

function scheduleBashTaskPush(): void {
  if (bashTaskPushScheduled) return;
  bashTaskPushScheduled = true;
  setTimeout(() => {
    bashTaskPushScheduled = false;
    pushBashTaskSnapshot();
  }, BASH_TASK_PUSH_THROTTLE_MS);
}

getBashTaskRegistry().onAnyChange(scheduleBashTaskPush);

// ----------------------------------------------------------------------------
// Background hook tasks — push snapshot to renderer on any change.
// ----------------------------------------------------------------------------
const HOOK_TASK_PUSH_THROTTLE_MS = 300;
let hookTaskPushScheduled = false;

function pushHookTaskSnapshot(): void {
  const activeSessionId = sessionId;
  if (!activeSessionId) return;
  const tasks = hookTaskRegistry.listTasks();
  sendToMain({ type: 'hook_task:update', sessionId: activeSessionId, tasks });
}

function scheduleHookTaskPush(): void {
  if (hookTaskPushScheduled) return;
  hookTaskPushScheduled = true;
  setTimeout(() => {
    hookTaskPushScheduled = false;
    pushHookTaskSnapshot();
  }, HOOK_TASK_PUSH_THROTTLE_MS);
}

hookTaskRegistry.onAnyChange(scheduleHookTaskPush);

// ----------------------------------------------------------------------------
// Background sub-agent in-flight reporting — keep the parent worker alive.
// ----------------------------------------------------------------------------
// Background sub-agents execute inside this worker process. The Agent Server
// reaps idle workers (idle TTL) and replaces the worker when a new chat starts,
// so it must know when background sub-agents are still running here. IPC-only
// (process.send) — the stdout SSE path must not see a control-plane message.
backgroundAgentLifecycle.onInFlightChange = (inFlight: number) => {
  const activeSessionId = sessionId;
  if (!activeSessionId) return;
  try {
    process.send?.({
      type: 'background_tasks:update',
      sessionId: activeSessionId,
      inFlight,
    });
  } catch (err) {
    // Best effort — the server keeps its own TTL fallback if IPC is dead.
    warn('background_tasks:update send failed', err);
  }
};

function startChatHeartbeat(): void {
  if (chatHeartbeatTimer) {
    clearInterval(chatHeartbeatTimer);
  }
  chatHeartbeatTimer = setInterval(() => {
    lastPongTime = Date.now();
    sendToMain({ type: 'pong', timestamp: lastPongTime });
    debugLog('Sent independent heartbeat pong');
  }, CHAT_HEARTBEAT_INTERVAL);
}

function stopChatHeartbeat(): void {
  if (chatHeartbeatTimer) {
    clearInterval(chatHeartbeatTimer);
    chatHeartbeatTimer = null;
  }
}

function debugLog(...args: unknown[]): void {
  if (DEBUG_IPC) {
    log('[Agent-Process][DEBUG]', ...args);
  }
}

// Pending permission requests registry.
// Architecture: permission requests are sent to Main -> Renderer, resolved async.
//
// Keyed by `${sessionId}::${id}` to keep sessions isolated: a sub-agent or
// fork session can never accidentally resolve a top-level session's pending
// prompt (or vice versa) just because they happen to share an id namespace
// at the LLM layer. Each entry also holds a per-request timeout handle so
// we can clear it on resolve/duplicate — otherwise the 5min timer leaks
// and can fire a stray 'deny' after the prompt is already gone.
//
// IMPORTANT: keep the key format in sync with `pendingPermissionKey` below.
type PendingPermissionEntry = {
  resolve: (decision: 'allow' | 'deny') => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
};

const pendingPermissions = new Map<string, PendingPermissionEntry>();

function pendingPermissionKey(sessionId: string, id: string): string {
  return `${sessionId}::${id}`;
}

// Pending IPC requests registry for conductor executor RPC
const pendingIpcRequests = new Map<string, {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}>();

// Pending inter-agent call registry.
// Architecture: the caller worker sends `interagent:invoke` via process.send,
// the server routes it to a target worker, and forwards the target's chat:*
// events back to the caller as `interagent:event` commands. The caller
// buffers events here (keyed by invoke id) and resolves the tool promise
// on `chat:done` / `chat:error`.
export interface PendingInteragentCall {
  events: import('./worker-protocol.js').WorkerEvent[];
  resolveDone: (event: import('./worker-protocol.js').WorkerEvent) => void;
  resolveError: (event: import('./worker-protocol.js').WorkerEvent) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingInteragentCalls = new Map<string, PendingInteragentCall>();

export function registerPendingInteragentCall(id: string, call: PendingInteragentCall): void {
  pendingInteragentCalls.set(id, call);
}

export function unregisterPendingInteragentCall(id: string): void {
  pendingInteragentCalls.delete(id);
}

export function getPendingInteragentCall(id: string): PendingInteragentCall | undefined {
  return pendingInteragentCalls.get(id);
}

// Helper: IPC request for conductor executor.
//
// This function is assigned to ToolUseContext.ipcRequest, so its signature
// MUST match the ipcRequest contract: (channel, payload, options) => Promise.
// The `channel` is always 'conductor:executor:rpc' (set by ipc-request.ts),
// and `payload` is { action, payload } — the inner action + its payload.
//
// We unwrap the payload and send the RPC message with the action at the
// top level so ConductorExecutorProxy.execute() can switch on it.
function conductorIpcRequest<T = unknown>(
  channel: string,
  payload: unknown,
  options?: { timeout?: number }
): Promise<{ success: boolean; data?: T; error?: { code: string; message: string } }> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = options?.timeout || 30000;

    // Unwrap { action, payload } from the ipc-request.ts helper.
    const outerPayload = payload as { action?: string; payload?: unknown; sessionId?: string } | undefined;
    const action = outerPayload?.action ?? channel;
    const innerPayload = outerPayload?.payload ?? payload;

    const timeoutHandle = setTimeout(() => {
      if (pendingIpcRequests.has(requestId)) {
        pendingIpcRequests.delete(requestId);
        resolve({ success: false, error: { code: 'TIMEOUT', message: `IPC request timeout after ${timeout}ms` } });
      }
    }, timeout);

    pendingIpcRequests.set(requestId, {
      resolve: (v) => resolve(v as { success: boolean; data?: T; error?: { code: string; message: string } }),
      reject: (e) => reject(e),
      timeoutHandle,
    });

    sendToMain({
      type: 'conductor:executor:rpc',
      requestId,
      action,
      payload: innerPayload,
      sessionId: outerPayload?.sessionId,
    });
  });
}

// Plan 312: IPC request for App Connection tool execution.
//
// Routes `appConnection:invoke` messages to the main process
// (ConnectorService). The main process resolves the connection,
// acquires a valid token, dispatches to the provider connector,
// and returns a redacted result. Tokens never enter the agent process.
function appConnectionIpcRequest<T = unknown>(
  _channel: string,
  payload: unknown,
  options?: { timeout?: number }
): Promise<{ success: boolean; data?: T; error?: { code: string; message: string } }> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = options?.timeout || 30000;

    const timeoutHandle = setTimeout(() => {
      if (pendingIpcRequests.has(requestId)) {
        pendingIpcRequests.delete(requestId);
        resolve({ success: false, error: { code: 'TIMEOUT', message: `IPC request timeout after ${timeout}ms` } });
      }
    }, timeout);

    pendingIpcRequests.set(requestId, {
      resolve: (v) => resolve(v as { success: boolean; data?: T; error?: { code: string; message: string } }),
      reject: (e) => reject(e),
      timeoutHandle,
    });

    const invokePayload = payload as {
      connectionId?: string;
      action?: string;
      args?: unknown;
    } | undefined;

    sendToMain({
      type: 'appConnection:invoke',
      requestId,
      connectionId: invokePayload?.connectionId,
      action: invokePayload?.action,
      args: invokePayload?.args,
    });
  });
}

/**
 * Unified tool IPC dispatcher: routes based on the `channel` argument.
 * - `'conductor:executor:rpc'` → conductorIpcRequest (canvas tools)
 * - `'appConnection:invoke'`    → appConnectionIpcRequest (connector tools)
 *
 * Plan 312: always injected into the ToolUseContext so App Connection
 * tools work without conductor mode being active.
 */
function toolIpcRequest<T = unknown>(
  channel: string,
  payload: unknown,
  options?: { timeout?: number }
): Promise<{ success: boolean; data?: T; error?: { code: string; message: string } }> {
  if (channel === 'appConnection:invoke') {
    return appConnectionIpcRequest<T>(channel, payload, options);
  }
  return conductorIpcRequest<T>(channel, payload, options);
}

// Plan 312: fetch connector tool descriptors from the main process.
//
// Sends `appConnection:listDescriptors` and awaits the response via the
// same pendingIpcRequests map used by the conductor / appConnection
// invoke channels. Descriptors contain no tokens.
function fetchAppConnectionDescriptors(): Promise<{
  success: boolean;
  descriptors?: unknown[];
  error?: { code: string; message: string };
}> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const timeout = 10_000;

    const timeoutHandle = setTimeout(() => {
      if (pendingIpcRequests.has(requestId)) {
        pendingIpcRequests.delete(requestId);
        resolve({ success: false, error: { code: 'TIMEOUT', message: `fetch descriptors timeout after ${timeout}ms` } });
      }
    }, timeout);

    pendingIpcRequests.set(requestId, {
      resolve: (v) => resolve(v as { success: boolean; descriptors?: unknown[]; error?: { code: string; message: string } }),
      reject: (e) => resolve({ success: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } }),
      timeoutHandle,
    });

    sendToMain({ type: 'appConnection:listDescriptors', requestId });
  });
}

/**
 * Plan 312: reload App Connection tools after init or MCP reload.
 *
 * Fetches the current connector tool descriptors from the main process
 * and caches them. The per-turn registry merge in DuyaAgent._resolveTools
 * reads from this cache — no IPC round-trip per turn.
 */
async function reloadAppConnectionTools(): Promise<void> {
  try {
    const { setCachedAppConnectionDescriptors } =
      await import('../tool/AppConnectionTool/index.js');
    const response = await fetchAppConnectionDescriptors();
    if (!response.success || !response.descriptors) {
      log('[Agent-Process] App Connection: descriptor fetch failed:', response.error?.message);
      setCachedAppConnectionDescriptors([]);
      return;
    }
    setCachedAppConnectionDescriptors(response.descriptors as AppConnectionToolDescriptor[]);
    log(`[Agent-Process] App Connection: ${response.descriptors.length} descriptors cached`);
  } catch (err) {
    warn('[Agent-Process] App Connection: reload failed:', err);
  }
}

// ============================================================================
// Token Bucket for Tool Rate Limiting
// ============================================================================

class TokenBucket {
  private tokens: number;
  private refillTimer: NodeJS.Timeout;

  constructor(
    private capacity: number,
    private refillRate: number
  ) {
    this.tokens = capacity;
    this.refillTimer = setInterval(() => {
      this.tokens = Math.min(this.capacity, this.tokens + this.refillRate);
    }, 1000);
  }

  async consume(cost = 1): Promise<void> {
    while (this.tokens < cost) {
      // Wait and retry until tokens are available
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    this.tokens -= cost;
  }

  destroy(): void {
    if (this.refillTimer) {
      clearInterval(this.refillTimer);
    }
  }
}

// Tool-level rate limiting
const toolBucket = new TokenBucket(5, 2); // 5 capacity, 2 per second

// ============================================================================
// MessageRow -> Message Conversion
// ============================================================================

function messageRowToMessage(
  row: MessageRow,
  attachmentMap?: Map<string, AttachmentRow[]>,
  parsedDocMap?: Map<string, ParsedDocumentAttachment[]>
): Message {
  let content: string | MessageContent[];
  let toolCallId = row.tool_call_id || undefined;

  if (row.msg_type === 'thinking' && row.thinking) {
    content = [{ type: 'thinking', thinking: row.thinking }];
  } else if (row.msg_type === 'tool_use' && row.tool_name) {
    let input: Record<string, unknown> = {};
    let toolId = row.id;
    try {
      const parsed = JSON.parse(row.content);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const block = parsed[0];
        if (block.id) toolId = block.id;
        if (block.input) input = block.input;
      }
    } catch (err) {
      try {
        input = row.tool_input ? JSON.parse(row.tool_input) : {};
      } catch (parseErr) {
        input = {};
      }
    }
    content = [{ type: 'tool_use', id: toolId, name: row.tool_name, input }];
    toolCallId = toolId;
  } else {
    try {
      const parsed = JSON.parse(row.content);
      if (Array.isArray(parsed)) {
        content = parsed as MessageContent[];
      } else {
        content = row.content;
      }
    } catch {
      content = row.content;
    }
  }

  // Rehydrate CDN image URLs with locally stored base64
  if (attachmentMap && Array.isArray(content)) {
    content = rehydrateContentWithAttachments(content, attachmentMap) as MessageContent[];
  }

  let parsedAttachments: import('../types.js').FileAttachment[] | undefined;
  if (row.attachments) {
    try {
      parsedAttachments = JSON.parse(row.attachments) as import('../types.js').FileAttachment[];
    } catch {
      // ignore parse errors
    }
  }

  // Restore document attachment fields for LLM context on restart.
  // text, path, imageChunks, and extractMethod are restored so that
  // buildAttachmentContext() in the LLM client can assemble the doc context on-the-fly.
  if (parsedAttachments && parsedDocMap) {
    for (const att of parsedAttachments) {
      const docs = parsedDocMap.get(row.id);
      if (docs) {
        const doc = docs.find(d => d.filename === att.name);
        if (doc) {
          att.path = doc.filePath;
          att.text = doc.text;
          if (doc.extractMethod) att.extractMethod = doc.extractMethod as 'text' | 'vision' | 'hybrid';
          if (doc.imageChunks) {
            try {
              const parsed = JSON.parse(doc.imageChunks) as Array<{ base64: string; mediaType: string }>;
              if (parsed.length > 0) {
                att.imageChunks = parsed;
              }
            } catch {
              // ignore parse errors
            }
          }
        }
      }
    }
  }

  let tokenUsage: TokenUsage | undefined;
  if (row.token_usage) {
    try {
      const parsed = JSON.parse(row.token_usage) as Partial<TokenUsage> | null;
      // Restore only if it carries the required numeric counters — malformed
      // rows must not break the live-usage seed scan.
      if (
        parsed &&
        typeof parsed.input_tokens === 'number' &&
        typeof parsed.output_tokens === 'number'
      ) {
        tokenUsage = {
          input_tokens: parsed.input_tokens,
          output_tokens: parsed.output_tokens,
          total_tokens: parsed.total_tokens,
          cache_hit_tokens: parsed.cache_hit_tokens,
          cache_creation_tokens: parsed.cache_creation_tokens,
        };
      }
    } catch {
      // ignore parse errors
    }
  }

  return {
    id: row.id,
    role: row.role,
    content,
    displayContent: row.display_content != null
      ? row.display_content
      : undefined,
    name: row.name || undefined,
    tool_call_id: toolCallId,
    timestamp: row.created_at,
    msg_type: row.msg_type || undefined,
    thinking: row.thinking || undefined,
    tool_name: row.tool_name || undefined,
    tool_input: row.tool_input || undefined,
    parent_tool_call_id: row.parent_tool_call_id || undefined,
    viz_spec: row.viz_spec || undefined,
    status: row.status || undefined,
    seq_index: row.seq_index ?? undefined,
    duration_ms: row.duration_ms ?? undefined,
    sub_agent_id: row.sub_agent_id || undefined,
    attachments: parsedAttachments,
    tokenUsage,
  };
}

function applyRequestDisplayContent(messages: readonly Message[], displayContent?: string): void {
  if (displayContent === undefined) {
    return;
  }
  const userMessage = messages.find((item) => item.role === 'user');
  if (userMessage && userMessage.displayContent === undefined) {
    userMessage.displayContent = displayContent;
  }
}

// ============================================================================
// Message History Validation
// ============================================================================

function getToolUseIds(message: Message): string[] {
  if (message.role !== 'assistant') return [];
  if (message.msg_type === 'tool_use' && message.tool_call_id) {
    return [message.tool_call_id];
  }
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((block) => (
    block.type === 'tool_use' && 'id' in block && typeof block.id === 'string' && block.id
      ? [block.id]
      : []
  ));
}

function getToolResultIds(message: Message): string[] {
  if (message.role === 'tool' && message.tool_call_id) {
    return [message.tool_call_id];
  }
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((block) => (
    block.type === 'tool_result' && 'tool_use_id' in block && typeof block.tool_use_id === 'string' && block.tool_use_id
      ? [block.tool_use_id]
      : []
  ));
}

function assistantContentBlocks(message: Message): MessageContent[] {
  if (Array.isArray(message.content)) return message.content;

  if (message.msg_type === 'tool_use' && message.tool_call_id) {
    let input: Record<string, unknown> = {};
    if (message.tool_input) {
      try {
        const parsed = JSON.parse(message.tool_input);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>;
        }
      } catch {
        // Preserve the call with an empty input rather than dropping its result pair.
      }
    }
    return [{
      type: 'tool_use',
      id: message.tool_call_id,
      name: message.tool_name || 'unknown_tool',
      input,
    }];
  }

  return message.content ? [{ type: 'text', text: message.content }] : [];
}

function mergeAssistantToolRound(messages: readonly Message[]): Message {
  if (messages.length === 1) return messages[0];

  const first = messages[0];
  return {
    ...first,
    content: messages.flatMap(assistantContentBlocks),
    msg_type: undefined,
    tool_call_id: undefined,
    tool_name: undefined,
    tool_input: undefined,
  };
}

/**
 * Canonicalize complete tool rounds before a restored session is reused.
 *
 * Some Anthropic-compatible providers require all tool results to be the next
 * user turn after their assistant tool call. A queued notification may have
 * been persisted between the two; this is recoverable by moving the
 * notification after the completed tool round.
 */
function reorderCompleteToolRounds(messages: Message[]): Message[] {
  const reordered: Message[] = [];
  let repairedRounds = 0;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const pendingToolUseIds = getToolUseIds(message);
    const pendingIds = new Set(pendingToolUseIds);
    if (pendingIds.size === 0) {
      reordered.push(message);
      continue;
    }

    // A model can correct a bad tool name before the executor flushes the
    // first failure. Persisted as two assistant messages, that sequence is
    // invalid for strict Anthropic-compatible providers. Group consecutive
    // tool-bearing assistant messages into one canonical tool round.
    const assistantRound = [message];
    let firstNonAssistantIndex = index + 1;
    while (firstNonAssistantIndex < messages.length) {
      const candidate = messages[firstNonAssistantIndex];
      const candidateIds = getToolUseIds(candidate);
      if (candidateIds.length === 0) break;
      assistantRound.push(candidate);
      pendingToolUseIds.push(...candidateIds);
      candidateIds.forEach((id) => pendingIds.add(id));
      firstNonAssistantIndex++;
    }

    const unresolvedIds = new Set(pendingIds);
    const resultMessages: Array<{ message: Message; order: number }> = [];
    const deferredMessages: Message[] = [];
    let resultEndIndex = -1;

    for (let cursor = firstNonAssistantIndex; cursor < messages.length && unresolvedIds.size > 0; cursor++) {
      const candidate = messages[cursor];
      if (candidate.role === 'assistant') break;

      const matchingIds = getToolResultIds(candidate).filter((id) => unresolvedIds.has(id));
      if (matchingIds.length > 0) {
        matchingIds.forEach((id) => unresolvedIds.delete(id));
        resultMessages.push({
          message: candidate,
          order: Math.min(...matchingIds.map((id) => pendingToolUseIds.indexOf(id))),
        });
        resultEndIndex = cursor;
      } else {
        deferredMessages.push(candidate);
      }
    }

    if (unresolvedIds.size > 0 || resultEndIndex === -1) {
      // Filter out unmatched tool_use blocks to avoid API 400 error
      // (tool_use blocks without corresponding tool_result blocks)
      const filteredAssistantRound = assistantRound
        .map((msg) => {
          if (msg.msg_type === 'tool_use' && msg.tool_call_id && unresolvedIds.has(msg.tool_call_id)) {
            return null;
          }
          if (Array.isArray(msg.content)) {
            const filteredContent = msg.content.filter((block) => {
              if (block.type === 'tool_use' && 'id' in block && typeof block.id === 'string' && unresolvedIds.has(block.id)) {
                return false;
              }
              return true;
            });
            if (filteredContent.length === 0) return null;
            if (filteredContent.length === msg.content.length) return msg;
            return { ...msg, content: filteredContent };
          }
          return msg;
        })
        .filter((msg): msg is Message => msg !== null);
      if (filteredAssistantRound.length > 0) {
        reordered.push(...filteredAssistantRound);
      }
      index = firstNonAssistantIndex - 1;
      continue;
    }

    const alreadyOrdered = assistantRound.length === 1 && resultEndIndex === index + 1 && deferredMessages.length === 0;
    reordered.push(alreadyOrdered ? message : mergeAssistantToolRound(assistantRound));
    if (alreadyOrdered) {
      reordered.push(messages[resultEndIndex]);
    } else {
      resultMessages.sort((left, right) => left.order - right.order);
      reordered.push(...resultMessages.map(({ message: resultMessage }) => resultMessage), ...deferredMessages);
      repairedRounds++;
    }
    index = resultEndIndex;
  }

  if (repairedRounds > 0) {
    log(`[Agent-Process] Reordered ${repairedRounds} persisted tool round(s) to restore tool_use -> tool_result ordering`);
  }

  return repairedRounds > 0 ? reordered : messages;
}

/**
 * Validates and cleans up message history to ensure tool_use/tool_result pairs are complete.
 * 
 * When a stream fails mid-execution (e.g., API error, network issue), the database
 * may contain tool_use messages without corresponding tool_result messages. The
 * Anthropic API rejects requests where tool results don't properly follow tool calls.
 * 
 * This function:
 * 1. Identifies all tool_use message IDs
 * 2. Identifies all tool_result message IDs
 * 3. Removes any tool_use that has no matching tool_result
 * 4. Removes any orphan tool_result that has no matching tool_use
 * 5. Removes trailing incomplete tool_use from the last assistant message
 */
function validateMessageHistory(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;

  // Collect all tool_use IDs from messages
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.msg_type === 'tool_use' && msg.tool_call_id) {
      toolUseIds.add(msg.tool_call_id);
    } else if (msg.role === 'tool' && msg.tool_call_id) {
      toolResultIds.add(msg.tool_call_id);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && 'id' in block && typeof block.id === 'string') {
          toolUseIds.add(block.id);
        } else if (block.type === 'tool_result' && 'tool_use_id' in block && typeof block.tool_use_id === 'string') {
          toolResultIds.add(block.tool_use_id);
        }
      }
    }
  }

  // Find tool_uses without matching results
  const unmatchedToolUseIds = new Set<string>();
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) {
      unmatchedToolUseIds.add(id);
    }
  }

  // Find tool_results without matching tool_uses — symmetric with
  // toAnthropicMessages' bidirectional cleanup. Previously this
  // function returned early when there were no unmatched tool_uses,
  // leaving truly orphan tool_results in place to be handled (or
  // missed) downstream. We now drop them in this pass too, so the
  // load-from-DB path keeps the message history in a state that the
  // Anthropic converter can handle without surprises.
  const orphanToolResultIds = new Set<string>();
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) {
      orphanToolResultIds.add(id);
    }
  }

  // Detect tool_result messages with empty/undefined tool_call_id.
  // These come from providers (MiniMax-M3) returning empty tool_use.id;
  // they can never be paired and would trigger Anthropic 2013.
  let unpairedToolResultCount = 0;
  for (const msg of messages) {
    if (msg.role === 'tool' && !msg.tool_call_id) {
      unpairedToolResultCount++;
    }
  }

  if (unmatchedToolUseIds.size === 0 && orphanToolResultIds.size === 0 && unpairedToolResultCount === 0) {
    return reorderCompleteToolRounds(messages);
  }

  log(`[Agent-Process] Cleaning history: ${unmatchedToolUseIds.size} unmatched tool_use(s), ${orphanToolResultIds.size} orphan tool_result(s), ${unpairedToolResultCount} unpaired tool_result(s) with empty tool_call_id`);

  // Filter out messages with unmatched tool_uses or orphan tool_results
  const cleanedMessages: Message[] = [];
  for (const msg of messages) {
    // Drop any tool_result message whose tool_call_id is empty/undefined.
    // These originate from providers (notably MiniMax-M3) that occasionally
    // return an empty `tool_use.id`; the empty string collapses to NULL in
    // the DB (appendMessages uses `msg.tool_call_id || null`), and
    // messageRowToMessage converts NULL back to undefined. Such a
    // tool_result can never be paired with a tool_use — the API rejects
    // it with 400 "tool call id is invalid (2013)". The `msg.tool_call_id`
    // guard in the orphan check below would otherwise skip these, so we
    // catch them explicitly here.
    if (msg.role === 'tool' && !msg.tool_call_id) {
      log(`[Agent-Process] Removing unpaired tool_result with empty tool_call_id (tool_name=${msg.tool_name || 'unknown'})`);
      continue;
    }

    // Drop truly orphan tool_result messages (tool_call_id has no
    // matching tool_use anywhere in the history).
    if (msg.role === 'tool' && msg.tool_call_id && orphanToolResultIds.has(msg.tool_call_id)) {
      log(`[Agent-Process] Removing orphan tool_result: ${msg.tool_call_id}`);
      continue;
    }

    // Skip tool_use messages that don't have a matching result
    if (msg.msg_type === 'tool_use' && msg.tool_call_id && unmatchedToolUseIds.has(msg.tool_call_id)) {
      log(`[Agent-Process] Removing incomplete tool_use: ${msg.tool_call_id} (${msg.tool_name})`);
      continue;
    }

    // For assistant messages with mixed content, drop unmatched
    // tool_use blocks (incomplete calls) AND orphan tool_result
    // blocks (their tool_use is gone). Keep the rest of the message
    // intact — same convention used by toAnthropicMessages: a text
    // block is preserved even when its sibling tool blocks are
    // stripped.
    if (Array.isArray(msg.content)) {
      const filteredContent = msg.content.filter((block) => {
        if (block.type === 'tool_use' && 'id' in block && typeof block.id === 'string') {
          if (unmatchedToolUseIds.has(block.id)) {
            log(`[Agent-Process] Removing tool_use block from assistant message: ${block.id}`);
            return false;
          }
        }
        if (block.type === 'tool_result' && 'tool_use_id' in block && typeof block.tool_use_id === 'string') {
          if (orphanToolResultIds.has(block.tool_use_id)) {
            log(`[Agent-Process] Removing orphan tool_result block from assistant message: ${block.tool_use_id}`);
            return false;
          }
        }
        return true;
      });

      // If all blocks were removed, keep the message with empty content
      // If some blocks remain, use filtered content
      cleanedMessages.push({
        ...msg,
        content: filteredContent.length > 0 ? filteredContent : '',
      });
    } else {
      cleanedMessages.push(msg);
    }
  }

  const orderedMessages = reorderCompleteToolRounds(cleanedMessages);
  log(`[Agent-Process] Cleaned message history: ${messages.length} -> ${orderedMessages.length} messages`);
  return orderedMessages;
}

function extractFinalAssistantText(messages: Message[]): string {
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  if (!lastAssistant) {
    return '';
  }

  if (typeof lastAssistant.content === 'string') {
    return lastAssistant.content.trim();
  }

  return lastAssistant.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { type: 'text'; text: string }).text)
    .join('\n')
    .trim();
}

function summarizeConversation(messages: Message[], maxMessages = 12): string {
  return messages
    .slice(-maxMessages)
    .map((message) => {
      const role = message.role.toUpperCase();
      if (typeof message.content === 'string') {
        return `[${role}] ${message.content.slice(0, 1000)}`;
      }

      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as { type: 'text'; text: string }).text)
        .join('\n')
        .trim();

      return text ? `[${role}] ${text.slice(0, 1000)}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

// ============================================================================
// Agent Initialization
// ============================================================================

async function initAgent(
  config: InitMessage['providerConfig'] | null | undefined,
  workDir?: string,
  defaultWorkspaceDir?: string,
  sysPrompt?: string,
  blockedDomains?: string[],
  language?: string,
  sandboxEnabled?: boolean,
  communicationPlatform?: string,
  browserBackendMode?: 'auto' | 'extension' | 'built-in' | 'human-like',
  permissionRules?: InitMessage['permissionRules'],
): Promise<void> {
  // Store system prompt for use in chat
  sessionSystemPrompt = sysPrompt;

  // Guard: providerConfig can be null when no provider is configured.
  // Without this, accessing config.model throws and crashes the worker,
  // which surfaces as a misleading "initialization timeout" after 30s.
  if (!config) {
    throw new Error('No provider config available. Please configure an API provider in Settings.');
  }

  // Store model name for multimodal detection
  mainModelName = config.model;
  if (config.runtimeConfig) {
    // Phase 2: log that the new runtime config has been delivered.
    // The actual wiring into the LLM client is staged for a later
    // iteration; this confirms the new path is end-to-end reachable.
    log('[Agent-Process] runtimeConfig present (Phase 2)', {
      providerId: config.runtimeConfig.providerId,
      apiFormat: config.runtimeConfig.apiFormat,
      baseUrl: config.runtimeConfig.baseUrl,
      model: config.runtimeConfig.model,
      headerKeys: Object.keys(config.runtimeConfig.headers ?? {}),
      // CRITICAL: never log the apiKey / accessToken here.
    });
  }
  probeConfig = {
    model: config.model,
    provider: (config.provider || 'openai') as ProbeConfig['provider'],
    apiKey: config.apiKey || '',
    baseURL: config.baseURL || '',
    authStyle: config.authStyle as ProbeConfig['authStyle'],
  };

  agent = new duyaAgent({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model: config.model,
    authStyle: config.authStyle,
    provider: config.provider,
    sessionId: sessionId!,
    communicationPlatform: (communicationPlatform as 'cli' | 'duya-app' | 'weixin' | 'feishu' | 'telegram' | 'web' | 'api') ?? 'duya-app',
    workingDirectory: workDir,
    visionConfig: config.visionConfig,
    compactModelConfig: config.compactModelConfig,
    blockedDomains,
    browserBackendMode,
    language,
    defaultWorkspaceDirectory: defaultWorkspaceDir,
    permissionRules,
    // Phase 3: thread the runtime config into the agent. The
    // constructor will prefer `apiFormat` over `provider` when
    // present. Legacy fields stay authoritative for everything else
    // (vision, sub-model resolution, etc.).
    runtimeConfig: config.runtimeConfig,
  });

  // Plan 441: wire the per-event journal. Built after the agent so we have
  // sessionId and can attach it via the new `agent.journal` field. Subagent
  // instances also pass through `duyaAgent` constructor and inherit the
  // journal wiring when their own handleChatStart setup runs — the journal
  // is set in this same function for every DuyaAgent constructed in this
  // file (subagent construction in runAgent.ts reuses the same pattern).
  agent.journal = new Journal({
    sessionId: sessionId!,
    onError: (kind, err) => {
      log(`[Agent-Process] journal ${kind} persist failed:`, err instanceof Error ? err.message : String(err));
    },
  });

  // Wire the compaction callback so proactive compaction inside
  // streamChat emits a `rebase` event rather than re-appending the full
  // compacted message list. The old turn-end batch semantics were
  // appendMessages-of-all-messages which only worked because INSERT OR
  // IGNORE deduped — under the journal model we use appendRebase so
  // the rollout file is strictly append-only (Phase 4 replaces the
  // remaining rewriteSession callers with the same pattern).
  agent.onMessagesCompacted = (newMessageCount: number): void => {
    log(`[Agent-Process] Messages compacted, new count=${newMessageCount}`);
    if (!agent.journal) return;
    const currentMessages = agent.getMessages();
    // Plan 441: append-only rebase. A null supersededUpToSeq supersedes ALL
    // raw messages preceding the rebase in the trace — survivors are kept
    // by id matching against the compacted message list. The subprocess has
    // no reliable view of DB-assigned seqs, so a numeric bound would be
    // wrong for resumed sessions.
    agent.journal.appendRebase(
      `compact:${Date.now()}:${currentMessages.length}`,
      null,
      currentMessages,
    );
    log(`[Agent-Process] Compaction rebase emitted, newMessages=${currentMessages.length}`);
    // Proactive mid-turn compaction rewrote the timeline: retained anchors
    // describe the pre-compaction prompt, so mark pending and broadcast an
    // unanchored frame (ring shows "?") until the next `result` lands.
    compactedPending = true;
    emitLiveUsage(sessionId);
  };

  if (setSandboxEnabled) {
    setSandboxEnabled(sandboxEnabled ?? true);
  }

  // Pre-build Docker sandbox image in the background (non-blocking).
  // Image takes ~60s on first build; agent processes commands immediately.
  // If image isn't ready when first command runs, regex defense kicks in.
  if (sandboxEnabled !== false && buildSandboxImage) {
    buildSandboxImage((msg: string) => log(msg)).catch(() => {});
  }

  log('[Agent-Process] Agent core initialized');
}

async function loadAgentSkills(workDir?: string, skillPaths?: string[], securityScanEnabled?: boolean): Promise<void> {
  try {
    // Bundled skills are now installed on-demand via the plugin marketplace;
    // do not auto-sync the entire bundled set at agent startup.
    const loadOptions: { additionalPaths?: string[]; syncBundled?: boolean; securityBypassSkills?: string[]; skipSecurityScan?: boolean } = {
      syncBundled: false,
    };

    // Discover plugin skill directories dynamically
    const pluginSkillPaths = await discoverPluginSkillPaths();
    const allSkillPaths = [...(skillPaths || []), ...pluginSkillPaths];

    if (allSkillPaths.length > 0) {
      loadOptions.additionalPaths = allSkillPaths;
    }
    // Read security bypass list from environment variable
    const bypassSkillsEnv = process.env.DUYA_SECURITY_BYPASS_SKILLS;
    if (bypassSkillsEnv) {
      loadOptions.securityBypassSkills = bypassSkillsEnv.split(',').map(s => s.trim()).filter(Boolean);
    }
    // Honor the securityScanEnabled setting from the UI
    if (securityScanEnabled === false) {
      loadOptions.skipSecurityScan = true;
    }
    // Use workDir if provided, otherwise use process.cwd()
    const skillsCwd = workDir || process.cwd();
    await loadSkills(skillsCwd, loadOptions);
    const registry = getSkillRegistry();

    // Apply user overrides from settings (disabled skills are fully removed from runtime registry)
    try {
      const overridesRaw = await settingDb.getJson<Record<string, boolean>>('skillEnabledOverrides', {});
      const overrides = (overridesRaw && typeof overridesRaw === 'object')
        ? overridesRaw as Record<string, boolean>
        : {};
      const disabledNames = new Set<string>(
        Object.entries(overrides)
          .filter(([, enabled]) => enabled === false)
          .map(([name]) => name)
      );
      if (disabledNames.size > 0) {
        for (const skill of registry.list()) {
          // System-level skills are always enabled; user overrides must not
          // disable them.
          if (disabledNames.has(skill.name) && skill.source !== 'system') {
            registry.unregister(skill.name);
          }
        }
        log(`[Agent-Process] Disabled ${disabledNames.size} skill(s) via user overrides`);
      }
    } catch (overrideErr) {
      warn('[Agent-Process] Failed to apply skill enabled overrides:', overrideErr);
    }

    const skills = registry.list();
    log(`[Agent-Process] Loaded ${skills.length} skills after filtering (${pluginSkillPaths.length} plugin skill paths)`);
    if (skills.length === 0) {
      sendToMain({
        type: 'skills:status',
        synced: false,
        added: [],
        updated: [],
        skipped: [],
        removed: [],
        error: 'No skills loaded. Check bundled skills directory or user skills directory.',
      });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    warn('[Agent-Process] Failed to load skills:', err);
    sendToMain({
      type: 'skills:status',
      synced: false,
      added: [],
      updated: [],
      skipped: [],
      removed: [],
      error: errMsg,
    });
  }
}

// ============================================================================
// Message Handling
// ============================================================================

// Send events via stdout JSON lines (worker-protocol.ts)
// Events go to BOTH channels:
//   - process.send() (IPC) for DB requests, permissions, RPC
//   - sendEvent() (stdout) for the SSE stream handler in router.ts
function sendToMain(msg: Record<string, unknown>): void {
  process.send?.(msg);
  sendEvent(msg);
}

async function persistTurnReview(
  currentSessionId: string,
  turnId: string,
  baseline: TurnReviewBaseline | null,
): Promise<void> {
  if (!baseline) return;
  const review = completeTurnReview(baseline);
  if (!review) return;
  try {
    await turnReviewDb.save({
      id: randomUUID(),
      sessionId: currentSessionId,
      turnId,
      workingDirectory: review.workingDirectory,
      files: review.files,
      patch: review.patch,
      additions: review.additions,
      removals: review.removals,
      truncated: review.truncated,
      binary: review.binary,
      capturedAt: Date.now(),
    });
  } catch (error) {
    warn('[Agent-Process] Failed to persist turn review:', error instanceof Error ? error.message : String(error));
  }
}

function convertSSEToAgentMessage(event: { type: string; data?: unknown }): Record<string, unknown> | null {
  switch (event.type) {
    case 'text':
      return { type: 'chat:text', content: event.data as string };
    case 'thinking':
      return { type: 'chat:thinking', content: event.data as string };
    case 'tool_use_started':
      return { type: 'chat:tool_use_started', id: (event.data as { id: string }).id, name: (event.data as { name: string }).name, input: (event.data as { input?: unknown }).input };
    case 'tool_use':
      return { type: 'chat:tool_use', id: (event.data as { id: string }).id, name: (event.data as { name: string }).name, input: (event.data as { input?: unknown }).input };
    case 'tool_result':
      return {
        type: 'chat:tool_result',
        id: (event.data as { id: string }).id,
        result: (event.data as { result: string }).result,
        error: (event.data as { error?: boolean }).error,
        duration_ms: (event.data as { duration_ms?: number }).duration_ms,
        metadata: (event.data as { metadata?: unknown }).metadata,
      };
    case 'tool_progress':
      return { type: 'chat:tool_progress', toolUseId: (event.data as { toolName: string }).toolName, percent: 0, stage: `${event.data}` };
    case 'agent_progress': {
      // Forward sub-agent progress events so the UI can show what the sub-agent is doing
      const agentEvent = event.data as {
        type: string;
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
        agentSessionId?: string;
      } | undefined;
      if (agentEvent) {
        const { type: agentEventType, sessionId: _parentSessionId, agentSessionId, ...rest } = agentEvent;
        return {
          ...rest,
          type: 'chat:agent_progress',
          agentEventType,
          sessionId: _parentSessionId,
          agentSessionId,
        };
      }
      return null;
    }
    case 'permission_request':
      return { type: 'chat:permission', request: event.data };
    case 'done':
      return { type: 'chat:done', reason: (event as { reason?: string }).reason };
    case 'error':
      return { type: 'chat:error', message: event.data as string, code: (event as { code?: string }).code };
    case 'turn_start':
      return { type: 'chat:status', message: `Turn ${(event.data as { turnCount?: number })?.turnCount ?? ''}` };
    case 'mode_changed':
      // Plan 224 follow-up: agent runtime mode switched via
      // EnterPlanMode / ExitPlanMode / SwitchMode tool. Forward the
      // new mode + source so the renderer can sync input-box chip/glow.
      return { type: 'chat:mode_changed', ...(event.data as object) };
    case 'system': {
      const metadata = (event as { metadata?: { retryAttempt?: number; maxAttempts?: number; retryDelayMs?: number } }).metadata;
      if (metadata?.retryAttempt !== undefined) {
        return {
          type: 'chat:retry',
          attempt: metadata.retryAttempt,
          maxAttempts: metadata.maxAttempts ?? 10,
          delayMs: metadata.retryDelayMs ?? 0,
          message: event.data as string,
        };
      }
      return null;
    }
    // Research mode events
    case 'research_phase':
      return { type: 'chat:research_phase', ...(event.data as object) };
    case 'research_complexity':
      return { type: 'chat:research_complexity', ...(event.data as object) };
    case 'research_questions':
      return { type: 'chat:research_questions', ...(event.data as object) };
    case 'research_iteration':
      return { type: 'chat:research_iteration', ...(event.data as object) };
    case 'research_finding':
      return { type: 'chat:research_finding', ...(event.data as object) };
    case 'research_progress':
      return { type: 'chat:research_progress', ...(event.data as object) };
    case 'research_synthesis_chunk':
      return { type: 'chat:research_synthesis_chunk', ...(event.data as object) };
    case 'research_complete':
      return { type: 'chat:research_complete', ...(event.data as object) };
    case 'research_error':
      // Surface as chat:research_error so the stream-session-manager routes
      // it to handleResearchErrorEvent instead of terminating the entire
      // chat session. The orchestrator's own error event is research-scoped.
      return { type: 'chat:research_error', ...(event.data as object) };
    case 'report_complete': {
      const { type: _t, ...rest } = event as Record<string, unknown>;
      return { type: 'chat:research_report', ...rest };
    }
    case 'evidence_chain_response': {
      const { type: _t, ...rest } = event as Record<string, unknown>;
      return { type: 'chat:research_evidence', ...rest };
    }
    case 'continue_research_start': {
      const { type: _t, ...rest } = event as Record<string, unknown>;
      return { type: 'chat:research_continue', ...rest };
    }
    case 'research_source_found':
      return { type: 'chat:research_source_found', ...(event.data as object) };
    case 'research_source_rejected':
      return { type: 'chat:research_source_rejected', ...(event.data as object) };
    case 'research_gap_detected':
      return { type: 'chat:research_gap_detected', ...(event.data as object) };
    case 'research_next_action':
      return { type: 'chat:research_next_action', ...(event.data as object) };
    case 'research_conflict_detected':
      return { type: 'chat:research_conflict_detected', ...(event.data as object) };
    case 'research_stop_decision':
      return { type: 'chat:research_stop_decision', ...(event.data as object) };
    case 'plan_delta':
      return { type: 'chat:plan_delta', ...(event.data as object) };
    case 'complexity_classified':
      return { type: 'chat:research_complexity', ...(event.data as object) };
    case 'run_status':
      return { type: 'chat:research_run_status', ...(event.data as object) };
    case 'activity':
      return { type: 'chat:research_activity', ...(event.data as object) };
    case 'plan_steps_created':
      return { type: 'chat:research_plan_steps', ...(event.data as object) };
    // Internal events: debug panel only, silently skip for now
    case 'research_quality_snapshot':
    case 'query_deduplicated':
    case 'finding_deduplicated':
    case 'action_executed':
    // LLM usage frame: consumed upstream for token accounting before this
    // converter runs; nothing to forward to the SSE client.
    case 'result':
      return null;
    default:
        warn('[Agent-Process] Unknown SSE event type:', event.type);
        return null;
  }
}

// Create permission handler for streaming
function createPermissionHandler(sessId: string): (request: { id: string; toolName: string; toolInput: Record<string, unknown>; mode?: string; expiresAt: number }) => Promise<'allow' | 'deny'> {
  return (request) => {
    return new Promise<'allow' | 'deny'>((resolve, reject) => {
      const key = pendingPermissionKey(sessId, request.id);

      // Duplicate request: the renderer (or main) is replaying the same id
      // (SSE reconnect, sub-agent fork, race with the 5min timer, etc.).
      // We must NOT overwrite the existing pending entry — doing so would
      // orphan the first promise and create a stuck prompt. The 5min
      // timeout is still armed on the original entry; leave it alone.
      if (pendingPermissions.has(key)) {
        warn('[Agent-Process] Duplicate permission request, ignoring:', { sessionId: sessId, id: request.id });
        return;
      }

      const timeoutHandle = setTimeout(() => {
        const entry = pendingPermissions.get(key);
        if (entry) {
          pendingPermissions.delete(key);
          entry.resolve('deny');
        }
      }, 300000);
      // Don't keep the agent process alive solely for this timer — if the
      // process is otherwise idle (e.g. permission prompt is the only thing
      // outstanding), let it exit gracefully.
      if (typeof (timeoutHandle as { unref?: () => void }).unref === 'function') {
        (timeoutHandle as { unref: () => void }).unref();
      }

      pendingPermissions.set(key, { resolve, reject, timeoutHandle });

      sendToMain({
        type: 'chat:permission',
        sessionId: sessId,
        request: {
          id: request.id,
          toolName: request.toolName,
          toolInput: request.toolInput,
          mode: request.mode,
          expiresAt: request.expiresAt,
        },
      });
    });
  };
}

// ============================================================================
// Chat Handler
// ============================================================================

async function handleChatStart(msg: ChatStartMessage): Promise<void> {
  if (!agent) {
    sendToMain({ type: 'chat:error', message: 'Agent not initialized', sessionId: msg.sessionId });
    return;
  }

  // Plan 314: wait for the long-lived ToolCatalog to have MCP tools
  // registered before resolving tools for this turn. The gate is
  // released once after applyMCPConfiguration completes (init), or
  // after a 3s timeout — whichever is first. Subsequent turns
  // resolve immediately since the promise stays settled.
  await agent.waitForMcpReady(3000);

  const workingDirectory = typeof agent.workingDirectory === 'string' ? agent.workingDirectory : '';
  const turnReviewBaseline = captureTurnReviewBaseline(workingDirectory);

  // Update title generation model config from chat options
  const titleModelOption = msg.options?.titleGenerationModel;
  const titleModelConfigOption = msg.options?.titleGenerationModelConfig;

  if (titleModelConfigOption) {
    titleGenerationModelConfig = {
      provider: titleModelConfigOption.provider,
      apiKey: titleModelConfigOption.apiKey,
      baseURL: titleModelConfigOption.baseURL,
      model: titleModelConfigOption.model,
      apiFormat: titleModelConfigOption.apiFormat,
      modelCompat: titleModelConfigOption.modelCompat,
    };
    log('[Agent-Process] Title generation model configured from options:', titleGenerationModelConfig.model);
  } else if (titleModelOption) {
    const parts = titleModelOption.split(':');
    if (parts.length >= 2) {
      const model = parts.slice(1).join(':');
      titleGenerationModelConfig = {
        provider: agent.provider || 'openai',
        apiKey: agent.apiKey || '',
        baseURL: agent.baseURL || '',
        model: model,
      };
      log('[Agent-Process] Title generation model configured from agent config:', titleGenerationModelConfig.model);
    }
  } else {
    titleGenerationModelConfig = null;
  }

  if (msg.options?.language && agent) {
    agent.setLanguage(msg.options.language);
  }

  log('[Agent-Process] handleChatStart:', {
    sessionId: msg.sessionId,
    promptLength: msg.prompt.length,
    agentProfileId: msg.options?.agentProfileId || '(none)',
    conductorMode: msg.options?.conductorMode ?? false,
    hasConductorCanvasId: !!msg.options?.conductorCanvasId,
  });
  if (agent) {
    log('[Agent-Process] Agent LLM config:', {
      model: agent.model,
      provider: agent.provider,
      baseURL: agent.baseURL,
    });
  }
  debugLog('chat:start received', {
    sessionId: msg.sessionId,
    agentProfileId: msg.options?.agentProfileId || '(none)',
    hasOptionsMessages: Array.isArray(msg.options?.messages),
    optionsMessageCount: Array.isArray(msg.options?.messages) ? msg.options?.messages.length : 0,
    hasFiles: Array.isArray(msg.options?.files) && msg.options.files.length > 0,
    filesKeys: msg.options?.files?.[0] ? Object.keys(msg.options.files[0]) : [],
    firstFileHasText: msg.options?.files?.[0] ? 'text' in msg.options.files[0] : false,
    firstFileTextLength: msg.options?.files?.[0]?.text?.length ?? 'N/A',
    firstFileRaw: msg.options?.files?.[0] ? JSON.stringify(msg.options.files[0]).substring(0, 200) : 'N/A',
  });

  try {
    startChatHeartbeat();
    const requestPermission = createPermissionHandler(msg.sessionId);
    const sendStatus = (message: string): void => {
      sendToMain({ type: 'chat:status', sessionId: msg.sessionId, message });
    };
    const sendI18nStatus = (key: string, params?: Record<string, string | number>): void => {
      const encodedParams = params
        ? Object.entries(params)
          .map(([k, v]) => `|${k}=${encodeURIComponent(String(v))}`)
          .join('')
        : '';
      sendStatus(`@i18n:${key}${encodedParams}`);
    };
    // Emit an immediate "preparing" status so the client shows activity right
    // away (before the MCP gate, image processing, capability probe, and first
    // LLM round-trip run). This is what makes the start feel responsive
    // instead of a silent blank wait after the user hits send.
    sendI18nStatus('streaming.preparing');
    // Use session system prompt if available, fallback to options.systemPrompt
    const effectiveSystemPrompt = sessionSystemPrompt || msg.options?.systemPrompt;
    // Rough token estimate of the system prompt alone (AGENTS.md, skills,
    // base instructions). Tool definitions are added by the agent once it
    // builds the request; before that, this is the only prefix we can price.
    // Used as a floor for the live ring's no-usage fallback.
    const systemPromptTokensEstimate = effectiveSystemPrompt
      ? estimateMessagesTokens([{ role: 'assistant', content: effectiveSystemPrompt }])
      : 0;
    // Resolve permission mode from session row, with explicit override allowed.
    // 严格忽略 msg.options.permissionMode (旧字段), 防止残留发送路径覆盖 DB 决定.
    let rowProfile: string | null = null;
    try {
      const sessionRow = sessionDb.get(msg.sessionId);
      rowProfile = (sessionRow as { permission_profile?: string | null } | null)?.permission_profile ?? null;
    } catch {
      // 静默降级, 走 default
    }
    const resolved = resolveChatStartAgentMode({
      rowProfile,
      optionOverride: msg.options?.permissionModeOverride,
      deprecatedOption: msg.options?.permissionMode,
    });
    if (resolved.ignoredDeprecated) {
      log('[chat:start] ignored deprecated options.permissionMode:', resolved.ignoredDeprecated);
    }
    log('[chat:start] agentMode:', resolved.agentMode, 'fromRow:', resolved.fromRow, 'override:', resolved.override);
    agent.setPermissionMode(resolved.agentMode);

    // Build document context from inline file attachments.
    // Document files (pdf, docx, etc.) carry their parsed text and imageChunks
    // directly on the FileAttachment objects (path, text, extractMethod, imageChunks).
    const files = msg.options?.files;

    const docFiles = (files || []).filter(f => f.path || f.text);
    const imageFiles = (files || []).filter(f => f.type.startsWith('image/') || f.type.startsWith('img/'));

    // Pre-analyze user-attached images with the configured vision model.
    // Mirrors hermes-agent design: a dedicated vision model analyzes images
    // and the text description is passed to the main LLM as context.
    //
    // Image content blocks are only included for natively multimodal-capable
    // models (e.g. Claude, GPT-4V). For text-only models, pre-analysis text
    // is the sole image context.
    // Model capability detection — checks regex heuristics, DB cache, then API probe
    const modelIsMultimodal = probeConfig
      ? await detectModelCapability(probeConfig)
      : isModelLikelyMultimodal(mainModelName);
    log(`[Image-Processing] Model multimodal detection: ${mainModelName} → ${modelIsMultimodal} (${probeConfig ? 'probed' : 'regex-only fallback'})`);

    // Phase 1: Read and compress all image files once.
    // Cache base64 data to avoid double-read (vision analysis + content block).
    interface CachedImageData {
      base64: string;
      mediaType: string;
    }
    const imageDataCache = new Map<string, CachedImageData>();
    const readFailedFiles = new Set<string>();
    const markReadFailed = (name: string) => {
      if (name) readFailedFiles.add(name);
    };

    for (const file of imageFiles) {
      let base64Data = '';
      let mediaType = file.type;

      if (file.url.startsWith('data:')) {
        // Data URL path (clipboard paste / screenshot tool). Decode and
        // run through the same resize pipeline as file-path images so
        // long screenshots (e.g. 1920x8000) get scaled down to <=2048px
        // before being sent to the vision model. Without this, a tall
        // webpage screenshot can blow the model's context window because
        // vision token count is proportional to pixel count, not byte size.
        try {
          const commaIdx = file.url.indexOf(',');
          const header = commaIdx > 0 ? file.url.slice(5, commaIdx) : '';
          const rawBase64 = file.url.slice(commaIdx + 1);
          const imgBuffer = Buffer.from(rawBase64, 'base64');
          // Prefer the media type declared in the data URL header;
          // fall back to the FileAttachment.type.
          const headerMediaType = /data:([^;]+)/.exec(header)?.[1];
          mediaType = headerMediaType || file.type;
          if (needsResizing(imgBuffer)) {
            try {
              const resized = await resizeImageBuffer(imgBuffer, TARGET_IMAGE_SIZE_BYTES);
              base64Data = resized.buffer.toString('base64');
              mediaType = resized.mediaType;
              log(`[Agent-Process] Compressed pasted image "${file.name}": ${imgBuffer.length} → ${resized.buffer.length} bytes`);
            } catch (resizeErr) {
              warn(`[Agent-Process] Image compression failed for pasted "${file.name}", using original:`, resizeErr);
              base64Data = rawBase64;
            }
          } else {
            base64Data = rawBase64;
          }
        } catch (decodeErr) {
          // Last-resort fallback: keep the old behavior.
          base64Data = file.url.split(',')[1] || '';
        }
      } else if ((file as unknown as Record<string, string>).base64) {
        base64Data = (file as unknown as Record<string, string>).base64;
      } else if (file.url && !file.url.startsWith('data:') && !isCDNImageUrl(file.url)) {
        try {
          const imgBuffer = await readFile(file.url);
          if (needsResizing(imgBuffer)) {
            try {
              const resized = await resizeImageBuffer(imgBuffer, TARGET_IMAGE_SIZE_BYTES);
              base64Data = resized.buffer.toString('base64');
              mediaType = resized.mediaType;
              log(`[Agent-Process] Compressed image "${file.name}": ${imgBuffer.length} → ${resized.buffer.length} bytes`);
            } catch (resizeErr) {
              warn(`[Agent-Process] Image compression failed for "${file.name}", using original:`, resizeErr);
              base64Data = imgBuffer.toString('base64');
            }
          } else {
            base64Data = imgBuffer.toString('base64');
          }
        } catch (readErr) {
          markReadFailed(file.name);
        }
      } else if (isCDNImageUrl(file.url)) {
        // CDN URLs have no local data available; skip silently.
      } else {
        markReadFailed(file.name);
      }

      if (base64Data) {
        imageDataCache.set(file.name, { base64: base64Data, mediaType });
      } else if (!isCDNImageUrl(file.url)) {
        markReadFailed(file.name);
      }
    }

    // Phase 2: Vision pre-analysis using the configured vision model.
    // Only run this for text-only main models. When the main model can
    // consume image blocks natively, sending both the original image and a
    // synthetic vision summary duplicates context and adds avoidable latency.
    let preAnalysisText = '';
    let visionAnalysisFailed = false;
    let visionAnalysisError: string | null = null;
    const failedVisionFiles = new Set<string>();
    const hasVisionAnalyzer = agent && typeof (agent as Record<string, unknown>).analyzeImage === 'function';
    const shouldUseVisionPreAnalysis = imageFiles.length > 0 && hasVisionAnalyzer && !modelIsMultimodal;
    if (imageFiles.length > 0 && hasVisionAnalyzer && modelIsMultimodal) {
      log('[Image-Processing] Skipping vision pre-analysis because main model accepts image input directly');
    }
    if (shouldUseVisionPreAnalysis) {
      sendI18nStatus('streaming.visionAnalyzingStart');
    }
    if (shouldUseVisionPreAnalysis) {
      let analyzedCount = 0;
      for (const file of imageFiles) {
        const cached = imageDataCache.get(file.name);
        if (!cached) continue;

        try {
          analyzedCount += 1;
          sendI18nStatus('streaming.visionAnalyzingProgress', {
            current: analyzedCount,
            total: imageFiles.length,
          });
          const quickVisionPrompt = msg.prompt?.trim()
            ? `Briefly analyze this image for the user's request: ${msg.prompt.trim()}. `
              + 'Return concise key points only, include critical text/OCR if relevant.'
            : 'Provide a concise image summary with key objects and critical text only.';
          const result = await (agent as unknown as { analyzeImage: (b64: string, mt: string, prompt?: string) => Promise<string> }).analyzeImage(
            cached.base64,
            cached.mediaType,
            quickVisionPrompt,
          );
          preAnalysisText += `\n\n[Image: "${file.name}"]\n${result}`;
          log(`[Agent-Process] Vision analysis: "${file.name}" — ${result.length} chars`);
        } catch (err) {
          visionAnalysisFailed = true;
          visionAnalysisError = err instanceof Error ? err.message : String(err);
          failedVisionFiles.add(file.name);
          warn(`[Agent-Process] Vision analysis failed for "${file.name}": ${visionAnalysisError}`);
        }
      }
    }

    let effectivePrompt = msg.prompt;
    if (preAnalysisText) {
      effectivePrompt = msg.prompt
        ? `${msg.prompt}\n\n--- Image Analysis (auto-generated) ---${preAnalysisText}`
        : `The user sent an image. Here is a detailed description generated by an AI vision model:\n${preAnalysisText}\n\nPlease help the user based on the image description above.`;
    }

    // Fallback: if direct pre-analysis failed for non-multimodal models,
    // run a controlled vision_analyze tool pass and append its output.
    if (
      imageFiles.length > 0 &&
      !modelIsMultimodal &&
      (!preAnalysisText || visionAnalysisFailed)
    ) {
      sendI18nStatus('streaming.visionFallback');
      const toolPassResults: string[] = [];
      for (const file of imageFiles) {
        const cached = imageDataCache.get(file.name);
        const imagePath = (file.path || file.url || '').trim();

        // Skip CDN URLs (no local data available)
        if (isCDNImageUrl(imagePath)) {
          continue;
        }

        try {
          let toolResult: { error?: boolean; result?: unknown };

          if (cached) {
            // Skip immediate re-try if this file already failed in phase 2.
            if (failedVisionFiles.has(file.name)) {
              continue;
            }
            // For data: URLs and already-read files, use analyzeImage directly
            // with the cached base64 to avoid double-read
            const analyzeImage = (agent as unknown as { analyzeImage?: (b64: string, mt: string, prompt?: string) => Promise<string> })?.analyzeImage?.bind(agent);
            if (!analyzeImage) {
              continue;
            }
            const question = msg.prompt?.trim()
              ? `Analyze this image for the user's request: ${msg.prompt.trim()}`
              : 'Describe this image in detail.';
            const analysis = await analyzeImage(cached.base64, cached.mediaType, question);
            toolResult = { result: analysis };
          } else if (imagePath && !imagePath.startsWith('data:')) {
            // For local file paths, use VisionTool which reads the file
            toolResult = await visionTool.execute(
              {
                image_path: imagePath,
                question: msg.prompt?.trim()
                  ? `Analyze this image for the user's request: ${msg.prompt.trim()}`
                  : 'Describe this image in detail.',
              },
              undefined,
              {
                options: {
                  analyzeImage: (agent as unknown as { analyzeImage?: (b64: string, mt: string, prompt?: string) => Promise<string> })?.analyzeImage?.bind(agent),
                },
              } as unknown as import('../types.js').ToolUseContext,
            );
          } else {
            continue;
          }

          if (!toolResult.error && typeof toolResult.result === 'string' && toolResult.result.trim()) {
            const normalized = toolResult.result.replace(/\r\n/g, '\n');
            const marker = '\n\n';
            const body = normalized.includes(marker)
              ? normalized.slice(normalized.indexOf(marker) + marker.length).trim()
              : normalized.trim();
            if (body) {
              toolPassResults.push(`[Image: "${file.name}"]\n${body}`);
            }
          }
        } catch (err) {
          warn(`[Agent-Process] vision_analyze fallback failed for "${file.name}":`, err);
        }
      }
      if (toolPassResults.length > 0) {
        const fallbackText = toolPassResults.join('\n\n');
        effectivePrompt = effectivePrompt
          ? `${effectivePrompt}\n\n--- Image Analysis (vision_analyze fallback) ---\n${fallbackText}`
          : `The user sent image(s). Here is a detailed analysis generated by vision_analyze:\n\n${fallbackText}`;
        preAnalysisText = fallbackText;
        visionAnalysisFailed = false;
      }
    }

    // When vision analysis failed and the main model doesn't support
    // multimodal, warn the user that images cannot be analyzed.
    if (visionAnalysisFailed && imageFiles.length > 0 && !modelIsMultimodal) {
      const errorDetail = visionAnalysisError ? ` Error: ${visionAnalysisError}` : '';
      const warnMsg = `\n\n[System: Image analysis is unavailable.${errorDetail} `
        + 'The configured vision model failed to analyze the uploaded image(s), '
        + 'and the main model does not support direct image input. '
        + 'Please check your vision model settings or switch to a multimodal model '
        + '(e.g. Claude, GPT-4V, Gemini).]';
      effectivePrompt = effectivePrompt
        ? `${effectivePrompt}${warnMsg}`
        : `The user sent image(s) but image analysis is unavailable. ${warnMsg}`;
    }

    // When images exist but the agent cannot see them at all (model not
    // multimodal and no vision analyzer configured), at minimum include
    // the image file names in the prompt so the agent knows they exist.
    if (imageFiles.length > 0 && !modelIsMultimodal && !hasVisionAnalyzer && !visionAnalysisFailed) {
      const imageNames = imageFiles.map(f => f.name).join(', ');
      const parts: string[] = [];
      parts.push(`\n\n[System: The user sent ${imageFiles.length} image file(s): ${imageNames}.`);
      parts.push('This model cannot view images directly and no vision model is configured.');
      if (readFailedFiles.size > 0) {
        parts.push(`Unable to read from disk: ${Array.from(readFailedFiles).join(', ')}.`);
      }
      parts.push('Please configure a vision model in Settings or use a multimodal model (e.g. Claude, GPT-4V, Gemini) to process images.]');
      const imageInfo = parts.join(' ');
      effectivePrompt = effectivePrompt
        ? `${effectivePrompt}${imageInfo}`
        : `The user sent image(s): ${imageNames}. ${imageInfo}`;
    }

    // Image read failures that still have some cached data (multimodal model
    // will see the image blocks, but add a note about failed files)
    if (readFailedFiles.size > 0 && modelIsMultimodal) {
      const failedFileNames = Array.from(readFailedFiles);
      const failedInfo = `\n\n[System: Note: ${failedFileNames.length} image file(s) could not be read from disk (${failedFileNames.join(', ')}). Only successfully read images are shown.]`;
      effectivePrompt = effectivePrompt
        ? `${effectivePrompt}${failedInfo}`
        : failedInfo;
    }

    // When files are attached but no text prompt, provide a default instruction
    // so the agent knows to analyze the attachments instead of guessing the user's intent.
    if (!effectivePrompt.trim() && files && files.length > 0) {
      effectivePrompt = 'The user has attached file(s). Please analyze the attached files and provide a helpful response based on their contents.';
    }

    if (shouldUseVisionPreAnalysis) {
      sendI18nStatus('streaming.visionPreprocessDone');
    }

    let messageContent: string | MessageContent[] = effectivePrompt;

    if (files && files.length > 0) {
      const contentBlocks: MessageContent[] = [];
      const imageBlocks: MessageContent[] = [];

      // First add text block if there's actual text
      if (effectivePrompt && effectivePrompt.trim()) {
        contentBlocks.push({ type: 'text', text: effectivePrompt });
      }

      // Phase 3: Build image content blocks using cached data.
      // Only send image blocks to multimodal-capable models.
      for (const file of files) {
        if (file.type.startsWith('image/') || file.type.startsWith('img/')) {
          const cached = imageDataCache.get(file.name);

          if (cached) {
            if (modelIsMultimodal) {
              imageBlocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: cached.mediaType,
                  data: cached.base64,
                },
              });
              log(`[Agent-Process] Added image block: "${file.name}"`);
            } else {
              log(`[Agent-Process] Skipping image block, model not multimodal: "${file.name}"`);
            }
          } else if (isCDNImageUrl(file.url)) {
            warn('[Agent-Process] Skipping CDN image URL:', file.name);
          } else {
            warn('[Agent-Process] Image file has no cached base64 data:', file.name);
          }
        }
      }

      // Also add document-extracted images (e.g. scanned PDF with embedded images)
      // Only for multimodal-capable models
      if (modelIsMultimodal) {
        for (const doc of docFiles) {
          if (doc.imageChunks) {
            for (const img of doc.imageChunks) {
              imageBlocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: img.mediaType,
                  data: img.base64,
                },
              });
            }
          }
        }
      }

      // Assemble: text first, then images
      messageContent = [...contentBlocks, ...imageBlocks];
    } else if (docFiles.some(d => d.imageChunks?.length)) {
      // No direct file attachments, but parsed documents contain extracted images
      const contentBlocks: MessageContent[] = [];
      const imageBlocks: MessageContent[] = [];

      // Text first (filter empty)
      if (effectivePrompt && effectivePrompt.trim()) {
        contentBlocks.push({ type: 'text', text: effectivePrompt });
      }

      for (const doc of docFiles) {
        if (doc.imageChunks && modelIsMultimodal) {
          for (const img of doc.imageChunks) {
            imageBlocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: img.mediaType,
                data: img.base64,
              },
            });
          }
        }
      }
      messageContent = [...contentBlocks, ...imageBlocks];
    }

    // Images that could not be auto-inlined (CDN URLs, local file read
    // failures, or missing base64 data) are silently skipped. The LLM won't
    // see these images as content blocks. The attachment text context is
    // separately injected as a durable runtime_context message by
    // DuyaAgent._injectRuntimeContext via adaptAttachmentContext, so the
    // user message content no longer embeds it (avoids duplicate injection).
    //
    // For non-multimodal models, image content blocks are intentionally
    // omitted — pre-analysis text from the vision model (if configured)
    // is the sole image context.
    // Pre-analysis text from the vision model (if configured) is still
    // prepended to the prompt so the LLM has a text description.
    //
    // vision_analyze tool remains registered so the LLM can request
    // re-analysis of previously analyzed or newly referenced images.

    // Defensive sync: ensure agent's in-memory messages match the DB state.
    // During long-running sessions, the agent accumulates messages in memory.
    // If an out-of-band modification occurs (e.g., concurrent process, crash
    // recovery with partial persist), the agent's view can become stale.
    // Reload from DB when the count diverges to guarantee consistency.
    const agentMsgCountBeforeSync = agent.getMessages().length;
    log(`[Agent-Process] Before sync: agent has ${agentMsgCountBeforeSync} messages, existingMessageCount=${existingMessageCount}`);
    
    if (existingMessageCount > 0) {
      try {
        const dbCount = await messageDb.getCount(msg.sessionId) as number;
        log(`[Agent-Process] DB message count: ${dbCount}`);
        if (dbCount > existingMessageCount) {
          log(`[Agent-Process] DB has ${dbCount} messages but agent has ${existingMessageCount}, syncing...`);
          const loaded = await messageDb.loadMessages(msg.sessionId) as { messages: MessageRow[] };
          const allRows = loaded.messages;
          if (allRows.length > existingMessageCount) {
            const attachmentMap = getAttachmentsForSession(msg.sessionId);
            const allMsgs = allRows.map(row => messageRowToMessage(row, attachmentMap));
            const validated = validateMessageHistory(allMsgs);
            agent.setMessages(validated);
            existingMessageCount = validated.length;
            log(`[Agent-Process] Synced ${validated.length} messages from DB`);
          }
        }
      } catch (syncErr) {
        log('[Agent-Process] Message resync failed (non-critical):', syncErr);
      }
    } else if (agentMsgCountBeforeSync === 0) {
      // If existingMessageCount is 0 but agent also has no messages, try loading from DB
      try {
        const dbCount = await messageDb.getCount(msg.sessionId) as number;
        if (dbCount > 0) {
          log(`[Agent-Process] Agent has no messages but DB has ${dbCount}, loading...`);
          const loaded = await messageDb.loadMessages(msg.sessionId) as { messages: MessageRow[] };
          const allRows = loaded.messages;
          const attachmentMap = getAttachmentsForSession(msg.sessionId);
          const allMsgs = allRows.map(row => messageRowToMessage(row, attachmentMap));
          const validated = validateMessageHistory(allMsgs);
          agent.setMessages(validated);
          existingMessageCount = validated.length;
          log(`[Agent-Process] Loaded ${validated.length} messages from DB`);
        }
      } catch (loadErr) {
        log('[Agent-Process] Message load failed (non-critical):', loadErr);
      }
    }

    // Seed the session-cumulative live totals (and the authoritative context
    // base) from the history the agent now holds. The router sends `init` on
    // EVERY turn, which zeroes the live counters — without re-seeding, the
    // ring's ↑/↓/R/$ would reset to 0 at the start of each new turn instead
    // of continuing from the real cumulative numbers. Re-seeding from
    // messages also survives a full worker restart (messages are reloaded
    // from the DB above), so the stats stay correct regardless of process
    // lifetime. `result` events during this turn then accumulate on top.
    {
      let seedTotalInput = 0;
      let seedTotalInputRaw = 0;
      let seedTotalOutput = 0;
      let seedTotalCacheHit = 0;
      let seedTotalCacheCreation = 0;
      for (const m of agent.getMessages()) {
        // `tokenUsage` (camel) is set when messages were reloaded from the DB;
        // `token_usage` (snake) is attached in-process at turn end. Read both
        // so same-process follow-up turns seed from the previous turn too.
        const raw = m as {
          tokenUsage?: (Record<string, number | undefined> & { last_call?: LastCallUsageBlock });
          token_usage?: (Record<string, number | undefined> & { last_call?: LastCallUsageBlock });
        };
        const u = raw.tokenUsage ?? raw.token_usage;
        if (!u) continue;
        const rawInput = u.input_tokens ?? 0;
        const output = u.output_tokens ?? 0;
        const cacheHit = u.cache_hit_tokens ?? 0;
        const cacheCreation = u.cache_creation_tokens ?? 0;
        // Keep the cache-convention guard identical to the `result` handler
        // below: a fully cache-served request can report input=0 while hits
        // (read or write) are large, so the persisted raw fields must be
        // normalized the same way when re-seeding the cumulative totals.
        const normalizedInput =
          cacheHit > rawInput || cacheCreation > rawInput
            ? rawInput + cacheHit + cacheCreation
            : rawInput;
        seedTotalInput += normalizedInput;
        seedTotalInputRaw += rawInput;
        seedTotalOutput += output;
        seedTotalCacheHit += cacheHit;
        seedTotalCacheCreation += cacheCreation;
      }
      liveTotalInput = seedTotalInput;
      liveTotalInputRaw = seedTotalInputRaw;
      liveTotalOutput = seedTotalOutput;
      liveTotalCacheHit = seedTotalCacheHit;
      liveTotalCacheCreation = seedTotalCacheCreation;
      // Plan 443: no context-base restore here. The pure estimator anchors on
      // the persisted usage blocks directly (preferring `last_call`) — same
      // numbers, zero bookkeeping. Post-compaction staleness is handled by
      // `compactedPending` + boundary markers instead of skipping the seed.
    }

    // Plan 426 Phase 4: steering config from [steering] in ~/.duya/config.toml.
    // Fresh read per streamChat — hot reload semantics (hooks/config.ts).
    const steering = getSteeringConfig();

    const eventGen = agent.streamChat(messageContent, {
      systemPrompt: effectiveSystemPrompt,
      requestPermission,
      agentProfileId: msg.options?.agentProfileId,
      outputStyleConfig: msg.options?.outputStyleConfig,
      mode: msg.options?.mode,
      attachments: files,
      displayContent: msg.options?.displayContent,
      // Plan 441: thread the chat:start message id through as the turn id
      // so every journal emit and rebase event for this turn carries the
      // same id. The renderer uses it for turn-scoped queries via the
      // `message_index.turn_id` column.
      turnId: msg.id,
      effort: msg.options?.effort,
      maxTurns: msg.options?.maxTurns,
      allowedTools: msg.options?.allowedTools,
      conductorMode: msg.options?.conductorMode ? true : undefined,
      conductorCanvasId: msg.options?.conductorCanvasId,
      // Plan 312: always inject ipcRequest so App Connection tools work
      // without conductor mode. The unified dispatcher routes by channel.
      conductorIpc: { sendToMain, ipcRequest: toolIpcRequest },
      backgroundTaskResume: msg.options?.backgroundTaskResume,
      llmRequestTimeoutMs: msg.options?.llmRequestTimeoutMs,
      todoGate: { enabled: steering.todoGateEnabled },
      antiDeadLoop: { ...steering.antiDeadLoop },
      toolIntentNudgeMax: steering.toolIntentNudgeMax,
      disabledLoopHooks: steering.disabledLoopHooks,
    });

    log('[Agent-Process] streamChat started, agentProfileId:', msg.options?.agentProfileId || '(none)', 'iterating events...');
    // Turn-cumulative token usage (sum over every `result` event of this
    // turn; persisted on the turn's last assistant message at stream end).
    let tokenUsage: {
      input_tokens: number;
      output_tokens: number;
      total_tokens?: number;
      cache_hit_tokens?: number;
      cache_creation_tokens?: number;
    } | null = null;
    // Usage of the SINGLE LLM call behind the newest `result`. Persisted as a
    // `last_call` sub-block inside the turn-cumulative token_usage so the
    // next turn's seed (and the renderer's persisted scan) can restore the
    // context base from one real prompt size instead of the N-call sum.
    let lastCallUsage: LastCallUsageBlock & { output_tokens: number } | null =
      null;
    // Terminal `done` reason from the agent loop (completed / max_turns /
    // repeated_tool_calls / aborted). Captured from the deferred chat:done
    // and attached to the final chat:done so the renderer can surface why
    // the run stopped.
    let turnEndReason: string | undefined;
    let eventCount = 0;
    // Stable-boundary persistence baseline: capture the message count at turn
    // start so the single end-of-turn append can persist exactly the messages
    // this turn produced (user/assistant/tool_use/tool_result), in order,
    // without an incremental counter.
    const turnStartMessageCount = agent.getMessages().length;

    // Live context-usage emission — stateless pure function at module scope
    // (computeContextEstimate / emitLiveUsage, plan 443). Local wrapper binds
    // the session id and this turn's system-prompt fallback estimate.
    const emitTokenUsage = (): void =>
      emitLiveUsage(msg.sessionId, systemPromptTokensEstimate);

    // Kick off the ring before the first LLM `result` lands.
    emitTokenUsage();

    for await (const event of eventGen) {
      eventCount++;
      if (eventCount <= 5) {
        log(`[Agent-Process] Event ${eventCount}:`, event.type, event.data ? String((event as {data?: unknown}).data).substring(0, 100) : '');
      }
        if (DEBUG_IPC && (
        event.type === 'tool_use'
        || event.type === 'tool_result'
        || event.type === 'agent_progress'
        || event.type === 'error'
        || event.type === 'done'
      )) {
        debugLog('stream event', {
          sessionId: msg.sessionId,
          eventCount,
          type: event.type,
          hasData: event.data !== undefined,
        });
      }

      // Heartbeat: send pong periodically during long streaming to prevent being killed
      if (eventCount % 10 === 0 && Date.now() - lastPongTime > HEARTBEAT_INTERVAL) {
        lastPongTime = Date.now();
        sendToMain({ type: 'pong', timestamp: lastPongTime });
        debugLog('Sent heartbeat pong during streaming');
      }

      if (event.type === 'result' && event.data) {
        const candidateUsage = event.data as { input_tokens: number; output_tokens: number; total_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cache_hit_tokens?: number; cache_creation_tokens?: number };
        const rawInput = candidateUsage.input_tokens ?? 0;
        const outputTokens = candidateUsage.output_tokens ?? 0;
        const cacheHitTokens = candidateUsage.cache_hit_tokens ?? candidateUsage.cache_read_input_tokens ?? 0;
        const cacheCreationTokens =
          candidateUsage.cache_creation_tokens ?? candidateUsage.cache_creation_input_tokens ?? 0;
        // Cache-convention guard: Anthropic's input_tokens already includes
        // cached tokens, but some OpenAI-compatible gateways report
        // prompt_tokens EXCLUDING cache. When cache hits exceed the reported
        // input, the input clearly omits cache — add the hits back (pi does
        // the same: input + cacheRead + cacheWrite). The cacheWrite clause
        // covers the first request of a session where cacheRead is still 0
        // but the full prefix (system + tools) is written to cache.
        const normalizedInput =
          cacheHitTokens > rawInput || cacheCreationTokens > rawInput
            ? rawInput + cacheHitTokens + cacheCreationTokens
            : rawInput;
        // Ignore all-zero usage: persisting it would make the context ring show
        // hasData=true but used=0, which renders as an empty ring. Cache hits
        // count toward meaningful usage too (a fully cache-served request can
        // report input=0 while hits are large).
        const meaningfulUsage =
          rawInput +
          outputTokens +
          cacheHitTokens +
          (candidateUsage.total_tokens ?? 0) > 0;
        if (meaningfulUsage) {
          // Accumulate across ALL result events in this turn — one fires per
          // LLM API call, so a tool-heavy turn emits many. Keeping only the
          // last event (the old behavior) lost every earlier round's tokens,
          // and input grows each round, so the loss was large. Raw fields are
          // summed; per-provider conventions (input includes cache,
          // total_tokens = input + output) survive summation.
          const cacheCreationTokens =
            candidateUsage.cache_creation_tokens ?? candidateUsage.cache_creation_input_tokens ?? 0;
          const callTotal = candidateUsage.total_tokens ?? rawInput + outputTokens;
          if (!tokenUsage) {
            tokenUsage = {
              input_tokens: rawInput,
              output_tokens: outputTokens,
              total_tokens: callTotal,
              cache_hit_tokens: cacheHitTokens,
              cache_creation_tokens: cacheCreationTokens,
            };
          } else {
            tokenUsage.input_tokens += rawInput;
            tokenUsage.output_tokens += outputTokens;
            tokenUsage.total_tokens = (tokenUsage.total_tokens ?? 0) + callTotal;
            tokenUsage.cache_hit_tokens = (tokenUsage.cache_hit_tokens ?? 0) + cacheHitTokens;
            tokenUsage.cache_creation_tokens = (tokenUsage.cache_creation_tokens ?? 0) + cacheCreationTokens;
          }
          lastCallUsage = {
            input_tokens: rawInput,
            output_tokens: outputTokens,
            cache_hit_tokens: cacheHitTokens,
            cache_creation_tokens: cacheCreationTokens,
          };
          warn(`[Agent-Process] Received result event, turn tokenUsage accumulated: input=${tokenUsage.input_tokens}, output=${tokenUsage.output_tokens}, cacheHit=${tokenUsage.cache_hit_tokens ?? 0} (call: input=${rawInput}, output=${outputTokens}, cacheHit=${cacheHitTokens}, normalizedInput=${normalizedInput})`);
          // A real request just landed — its usage rides on the assistant
          // message DuyaAgent pushes right after `done` (plan 443), so the
          // pure estimator anchors on it directly. Clear the post-compaction
          // pending flag here too.
          compactedPending = false;
          // Accumulate session-cumulative totals for the ring's stats line.
          liveTotalInput += normalizedInput;
          liveTotalInputRaw += rawInput;
          liveTotalOutput += outputTokens;
          liveTotalCacheHit += cacheHitTokens;
          liveTotalCacheCreation += cacheCreationTokens;
          emitTokenUsage();
        } else {
          warn('[Agent-Process] Received all-zero usage, ignoring to avoid empty context ring');
        }
      } else if (event.type === 'tool_result' && event.data) {
        // Tool results are appended to the in-memory history and will be sent
        // to the model on the next request. Recompute statelessly from the
        // full timeline so trailing tool-result volume is included.
        emitTokenUsage();
      } else if (event.type === 'done') {
        // The assistant message carrying this round's usage is pushed BEFORE
        // `done` yields downstream, so emitting here re-anchors the frame on
        // the fresh per-call usage immediately. Without this, a thinking /
        // text-only round emits nothing after its `result` (which fires pre-
        // push) and the ring freezes until the next tool_result or turn end.
        emitTokenUsage();
      }

      const agentMsg = convertSSEToAgentMessage(event);
      if (agentMsg) {
        // Plan 441: chat:done flows through directly. Each persisted event
        // is emitted at its semantic completion boundary (user_msg_added,
        // assistant_message_finalized, tool_result_added) via the Journal
        // wired into _pushDurable, so there is no longer a turn-end batch
        // to gate SSE close on. chat:done is the natural turn-end signal.
        if (DEBUG_IPC && (
          agentMsg.type === 'chat:tool_use'
          || agentMsg.type === 'chat:tool_result'
          || agentMsg.type === 'chat:agent_progress'
          || agentMsg.type === 'chat:error'
          || agentMsg.type === 'chat:done'
        )) {
          debugLog('forward event->main', {
            sessionId: msg.sessionId,
            from: event.type,
            to: agentMsg.type,
          });
        }
        sendToMain({ ...agentMsg, sessionId: msg.sessionId });
      } else if (DEBUG_IPC) {
        debugLog('event dropped by converter', {
          sessionId: msg.sessionId,
          type: event.type,
        });
      }
    }

    let agentMessages = agent.getMessages();

    // Plan 437: persist hook invocation rows. The ConfigHooksRunner buffers
    // one `msg_type: 'hook_invocation'` Message per dispatch in
    // agent.pendingHookMessages; without this drain the rows never reach
    // the DB and hook cards vanish after reload. Best-effort: a failed
    // append must not break the turn (rows are lost, chat:done still flows).
    try {
      const hookMessages = agent.drainPendingHookMessages();
      if (hookMessages.length > 0) {
        const hookRes = await appendMessages(msg.sessionId, hookMessages);
        existingMessageCount += hookRes.count;
        log(`[Agent-Process] Persisted ${hookRes.count}/${hookMessages.length} hook invocation message(s)`);
      }
    } catch (hookErr) {
      warn('[Agent-Process] Failed to persist hook messages:', hookErr instanceof Error ? hookErr : new Error(String(hookErr)));
    }

    log(`[Agent-Process] Stream ended, tokenUsage present=${!!tokenUsage}, agentMessages=${agentMessages.length}, existingMessageCount=${existingMessageCount}`);
    if (agentMessages.length > 0) {
      if (tokenUsage) {
        const lastAssistant = [...agentMessages].reverse().find(m => m.role === 'assistant');
        if (lastAssistant) {
          // Attach the turn-cumulative token_usage + last_call sub-block
          // directly on the in-memory assistant message. The journal already
          // emitted this assistant message via assistant_message_finalized
          // at the done-event boundary (see _pushDurable wrap), so the
          // token_usage lands on the next replay through setMessages in
          // load-on-start (it serializes via metadata.token_usage in the
          // IPC DTO). Persisting it here would be a re-emit the storage
          // layer dedupes via INSERT OR IGNORE.
          (lastAssistant as Record<string, unknown>).token_usage =
            lastCallUsage ? { ...tokenUsage, last_call: lastCallUsage } : tokenUsage;
          log(`[Agent-Process] Attached token_usage to last assistant message: id=${lastAssistant.id}, lastCallInput=${lastCallUsage?.input_tokens ?? 'n/a'}`);
        } else {
          warn('[Agent-Process] No assistant message found to attach token_usage');
        }
      } else {
        warn('[Agent-Process] No tokenUsage received during stream');
      }

      // Plan 441: post-stream bookkeeping that is NOT message persistence:
      //   - token-budget delta (goal mirror)
      //   - parsed document attachments (per-message)
      //   - turn-review baseline flush
      //   - update existingMessageCount for the next turn's defensive resync
      //
      // These used to be wrapped inside the same try/catch as the turn-end
      // `appendMessages` call. Now that the journal handles persistence
      // synchronously per boundary, only the bookkeeping remains — and it
      // is best-effort (errors are logged, not propagated to chat:done).

      // Plan 331 Phase 2.3: persist token-budget delta after each turn.
      try {
        if (tokenUsage) {
          const turnTokens = tokenUsage.total_tokens ?? (tokenUsage.input_tokens + tokenUsage.output_tokens);
          if (turnTokens > 0) {
            await goalDb.updateBudget(msg.sessionId, { tokensUsedDelta: turnTokens });
            log(`[Agent-Process] Persisted token budget delta: +${turnTokens} for session ${msg.sessionId}`);
          }
        }
        const stats = agent.getContextStats();
        if (stats.totalTokens >= stats.maxTokens) {
          await goalDb.setStatus(msg.sessionId, 'usage_limited');
          log(`[Agent-Process] Session ${msg.sessionId} marked usage_limited (context exhausted: ${stats.totalTokens}/${stats.maxTokens})`);
        } else {
          await goalDb.setStatus(msg.sessionId, 'active');
        }
      } catch (err) {
        warn('[Agent-Process] Failed to persist token budget delta:', err);
      }

      // Store parsed document content to DB for rehydration on restart.
      // The journal already persisted the user message itself; this side
      // channel stores the attachment text separately so the user-message
      // payload stays small.
      for (const msgItem of agentMessages) {
        if (msgItem.role === 'user' && msgItem.attachments && msgItem.attachments.length > 0) {
          if (!msgItem.id) {
            warn('[Agent-Process] storeParsedDocumentAttachment: user message has no id, skipping');
            continue;
          }
          const userMsgId = msgItem.id;
          for (const att of msgItem.attachments as FileAttachment[]) {
            if (att.text && (att.path || att.url)) {
              try {
                storeParsedDocumentAttachment(userMsgId, msg.sessionId, {
                  filename: att.name,
                  filePath: att.path || att.url || '',
                  charCount: att.text.length,
                  text: att.text,
                  extractMethod: att.extractMethod,
                  imageChunks: att.imageChunks,
                });
              } catch (storeErr) {
                warn('[Agent-Process] Failed to store parsed document:', storeErr);
              }
            }
          }
        }
      }

      await persistTurnReview(msg.sessionId, msg.id, turnReviewBaseline);

      // Update existingMessageCount baseline for the next turn's defensive
      // resync. The journal already wrote each message; this is just our
      // local view of "where we left off".
      existingMessageCount = agentMessages.length;
      log(`[Agent-Process] Updated existingMessageCount to ${existingMessageCount}`);
    } else {
      warn(`[Agent-Process] No messages to save for session ${msg.sessionId}`);
      await persistTurnReview(msg.sessionId, msg.id, turnReviewBaseline);
      sendToMain({
        type: 'chat:done',
        sessionId: msg.sessionId,
        turnId: msg.id,
        reason: turnEndReason,
        finalContent: '',
        conversationText: '',
      });
    }

    // Background title generation: generate if never generated before (no message limit)
    const hasGeneratedTitle = titleGeneratedBySession.has(msg.sessionId);
    const previousTitle = titleGeneratedBySession.get(msg.sessionId) ?? null;
    // Count user messages to determine conversation rounds (not total messages)
    const userMessageCount = agentMessages.filter((m: Message) => m.role === 'user').length;
    const assistantMessageCount = agentMessages.filter((m: Message) => m.role === 'assistant').length;
    // Only generate if: (1) never generated before, AND (2) at least 1 complete round (1 user + 1 assistant)
    const isFirstGeneration = !hasGeneratedTitle && userMessageCount >= 1 && assistantMessageCount >= 1;
    // Topic drift: regenerate if the conversation has shifted away from the original title
    const shouldRegenerate = hasGeneratedTitle
      && userMessageCount >= 3
      && shouldRegenerateTitle(msg.sessionId, agentMessages, previousTitle);
    const shouldGenerate = isFirstGeneration || shouldRegenerate;

    log(`[Agent-Process] Title generation check: hasGenerated=${hasGeneratedTitle}, userMsg=${userMessageCount}, assistantMsg=${assistantMessageCount}, isFirstGeneration=${isFirstGeneration}, shouldRegenerate=${shouldRegenerate}, shouldGenerate=${shouldGenerate}`);
    log(`[Agent-Process] Title generation config: ${titleGenerationModelConfig ? JSON.stringify({provider: titleGenerationModelConfig.provider, model: titleGenerationModelConfig.model}) : 'null'}`);
    log(`[Agent-Process] Agent LLM client available: ${!!agent.llmClient}`);
    if (agent.llmClient) {
      log(`[Agent-Process] Agent LLM config: provider=${agent.provider}, model=${agent.model}, baseURL=${agent.baseURL}`);
    }

    log(`[Agent-Process] Title generation model config: ${
      titleGenerationModelConfig
        ? JSON.stringify({
            provider: titleGenerationModelConfig.provider,
            baseURL: titleGenerationModelConfig.baseURL,
            model: titleGenerationModelConfig.model,
            hasApiKey: Boolean(titleGenerationModelConfig.apiKey),
          })
        : 'null'
    }`);

    if (shouldGenerate) {
      void (async () => {
        try {
          // For MiniMax endpoints, always use agent's own LLM client
          // because MiniMax requires X-Api-Key header which agent already has configured correctly
          let titleLLMClient = agent.llmClient;
          if (titleGenerationModelConfig) {
            // Check if baseURL is a MiniMax endpoint (includes minimax in domain)
            const isMiniMaxEndpoint = titleGenerationModelConfig.baseURL?.includes('minimax');
            if (isMiniMaxEndpoint) {
              // MiniMax requires X-Api-Key auth - agent LLM client is already configured correctly
              log(`[Agent-Process] Title model is MiniMax endpoint, using agent LLM client (has correct X-Api-Key auth)`);
              titleLLMClient = agent.llmClient;
            } else {
              try {
                const { createAIClient } = await import('@duya/ai');
                const { findModelCompat } = await import('@duya/ai');

                // Resolve apiFormat: use provided value, or infer from the
                // legacy provider discriminator. This matches the inference
                // already done inside createLLMClient, but we materialize it
                // here so findModelCompat can be called with a concrete value.
                const titleApiFormat = (titleGenerationModelConfig.apiFormat
                  ?? (titleGenerationModelConfig.provider === 'anthropic' ? 'anthropic' : 'openai-chat')) as
                  ApiFormat;

                // Resolve modelCompat: use provided value, or look up from
                // @duya/ai presets so reasoning models (DeepSeek, Qwen, GLM,
                // Kimi, etc.) parse reasoning content correctly.
                const titleModelCompat = titleGenerationModelConfig.modelCompat
                  ?? findModelCompat(titleApiFormat, titleGenerationModelConfig.model);

                titleLLMClient = createAIClient({
                    apiKey: titleGenerationModelConfig.apiKey,
                    baseURL: titleGenerationModelConfig.baseURL,
                    model: titleGenerationModelConfig.model,
                    apiFormat: titleApiFormat,
                    providerId: titleGenerationModelConfig.provider,
                    modelCapabilities: titleModelCompat,
                  }
                );
                log(`[Agent-Process] Using custom title model: ${titleGenerationModelConfig.model}`);
              } catch (createErr) {
                warn('[Agent-Process] Failed to create title model client, falling back to agent LLM:', createErr);
                titleLLMClient = agent.llmClient;
              }
            }
          }

          log(`[Agent-Process] Title LLM client ready: provider=${titleLLMClient ? 'yes' : 'no'}`);
          log('[Agent-Process] Calling generateSessionTitle...');
          log(`[Agent-Process] Messages to pass: count=${agentMessages.length}, firstRole=${agentMessages[0]?.role}, firstContentType=${typeof agentMessages[0]?.content}`);
          const result = await generateSessionTitle(
            agentMessages,
            titleLLMClient,
            undefined,
            msg.sessionId
          );

          log(`[Agent-Process] generateSessionTitle returned: title="${result.title}"`);

          if (result.title) {
            titleGeneratedBySession.set(msg.sessionId, result.title);
            // Persist to DB immediately so the title survives renderer crashes
            try {
              await sessionDb.update(msg.sessionId, { title: result.title });
            } catch (dbErr) {
              warn('[Agent-Process] Failed to persist title to DB:', dbErr instanceof Error ? dbErr.message : String(dbErr));
            }
            sendToMain({ type: 'chat:title_generated', sessionId: msg.sessionId, title: result.title });
            log(`[Agent-Process] Title generated and sent: "${result.title}"`);
          } else {
            log('[Agent-Process] Title generation returned null, not sending');
          }
        } catch (titleErr) {
          // Log title generation errors for debugging
          log('[Agent-Process] Title generation error:', titleErr);
        }
      })();
    }

    // Note: 'chat:done' is sent AFTER persistence completes above.
    // It is intentionally deferred from the for-await loop to ensure
    // messages are saved to DB before the SSE stream closes.

  } catch (err) {
    log('[Agent-Process] Chat error:', err);
    const errMsg = err instanceof Error ? err.message : String(err);
    const errType = classifyError(err);
    let code: string | undefined;
    if (errType === APIErrorType.RATE_LIMIT) {
      code = 'rate_limit_error';
    } else if (errType === APIErrorType.USAGE_LIMIT) {
      code = 'usage_limit_exceeded';
    } else if (errType === APIErrorType.PROVIDER_SAFETY_FILTER) {
      code = 'provider_safety_filter';
    }
    sendToMain({
      type: 'chat:error',
      sessionId: msg.sessionId,
      message: errMsg,
      code,
    });
    // Persist any buffered hook rows even on a failed/aborted turn so the
    // cards survive reload — hooks that ran before the failure still count.
    try {
      const hookMessages = agent.drainPendingHookMessages();
      if (hookMessages.length > 0) {
        await appendMessages(msg.sessionId, hookMessages);
        log(`[Agent-Process] Persisted ${hookMessages.length} hook message(s) on error path`);
      }
    } catch (hookErr) {
      warn('[Agent-Process] Failed to persist hook messages on error path:', hookErr instanceof Error ? hookErr : new Error(String(hookErr)));
    }
    // Ensure the SSE stream closes even on error
    await persistTurnReview(msg.sessionId, msg.id, turnReviewBaseline);
    sendToMain({ type: 'chat:done', sessionId: msg.sessionId });
  } finally {
    stopChatHeartbeat();
  }
}

async function drainQueuedChatStart(): Promise<void> {
  // Atomic check-and-set: if a chat is already in progress, bail
  // out immediately. The finally block of the active chat will
  // re-invoke this via setImmediate, so we don't need a while loop.
  if (chatInProgress) return;

  const next = dequeue<ChatStartMessage>(
    (cmd: QueuedCommand<ChatStartMessage>) => cmd.agentId === undefined && cmd.mode === 'prompt'
  );
  if (!next) return;

  log('[Agent-Process] Draining queued chat:start from priority queue');
  chatInProgress = true;
  try {
    await handleChatStart(next.rawMessage);
  } finally {
    chatInProgress = false;
    // Use setImmediate to avoid stack overflow on rapid drain cycles
    // and to ensure the current microtask queue clears first.
    if (hasCommandsInQueue()) {
      setImmediate(() => { void drainQueuedChatStart(); });
    }
  }
}

// stderr wrapper to prevent stdout pollution of JSON-RPC protocol
// Use console.error/console.warn directly since log/warn aren't defined yet
const log = (...args: unknown[]): void => { console.error('[Agent-Process]', ...args); };
const warn = (...args: unknown[]): void => { console.warn('[Agent-Process]', ...args); };

// ============================================================================
// Plugin Skill Discovery
// ============================================================================

async function discoverPluginSkillPaths(): Promise<string[]> {
  const paths: string[] = [];
  try {
    const installed = await pluginDb.registryList() as Array<{ id?: unknown; enabled?: unknown; installPath?: unknown }>;
    const enabledPlugins = installed.filter(
      (item) => item.enabled === true && typeof item.id === 'string' && typeof item.installPath === 'string'
    );
    for (const plugin of enabledPlugins) {
      const installPath = plugin.installPath as string;
      const skillsDir = path.join(installPath, 'skills');
      if (existsSync(skillsDir)) {
        paths.push(skillsDir);
      }
    }
    if (paths.length > 0) {
      log(`[Agent-Process] Discovered ${paths.length} plugin skill directories`);
    }
  } catch (err) {
    warn('[Agent-Process] Failed to discover plugin skill paths:', err);
  }
  return paths;
}

async function reloadSkills(): Promise<void> {
  try {
    const registry = getSkillRegistry();
    // Clear existing non-bundled skills (system-level skills are
    // re-registered idempotently by loadSkills; keeping them out of the
    // unregister pass avoids a transient window with no system skills).
    const allSkills = registry.list();
    for (const skill of allSkills) {
      if (skill.source !== 'bundled' && skill.source !== 'system') {
        registry.unregister(skill.name);
      }
    }
    // Reload with plugin discovery
    await loadAgentSkills(agent?.workingDirectory, [], currentSecurityScanEnabled);
    sendToMain({ type: 'skills:reloaded', count: registry.list().length });
  } catch (err) {
    warn('[Agent-Process] Failed to reload skills:', err);
    sendToMain({ type: 'skills:reload:error', error: err instanceof Error ? err.message : String(err) });
  }
}

// ============================================================================
// Phase 2A diagnostic chain helpers
// ============================================================================
//
// The worker owns the post-apply snapshot (apply.ts PHASE C). Main /
// settings UI consumes the diagnostic chain through two events:
//   - `mcp:reloaded`      — emitted after every successful apply
//                           (init or reload). Carries the post-apply
//                           action summary + active server/tool
//                           keys + issue counts. Lightweight; safe
//                           to fire on every apply.
//   - `mcp:status:snapshot` — emitted only in response to a
//                           `mcp:status:get` command from main. The
//                           full inventory + issues + alias map
//                           summary, so the UI can render the
//                           settings page without a separate
//                           worker round-trip.
// Failure events:
//   - `mcp:reload:error`  — apply threw; old runtime preserved.
// Both are routed through `sendToMain`, which fans out to
// `process.send` (consumed by router's `child.on('message')`) and
// `sendEvent` (consumed by the SSE parser).

/**
 * Build the lightweight post-apply diagnostic event. The shape
 * is intentionally flat (no nested arrays of long strings) so the
 * router can serialize it without size concerns on every reload.
 */
function buildMcpReloadedEvent(result: MCPApplyResult): Record<string, unknown> {
  // The action summary comes from MCPApplyResult. The active
  // server keys are the same `scopedServerName`s in the
  // post-filter `resolvedConfigs`. The active tool keys are
  // the internalKeys installed by the apply. We surface them
  // so the UI can render the post-reload state without
  // needing a follow-up `mcp:status:get`.
  return {
    type: 'mcp:reloaded',
    reason: result.reason,
    committedAt: result.committedAt,
    clientsConnected: result.action.clientsConnected,
    toolsAdded: result.action.toolsAdded,
    toolsRemoved: result.action.toolsRemoved,
    inventoryRows: result.loadResult.inventory.length,
    issueCount: result.loadResult.issues.length,
    activeServerKeys: result.loadResult.resolvedConfigs.map((c) => c.scopedServerName),
  };
}

/**
 * Build the full diagnostic snapshot. The output mirrors the
 * shape consumed by the settings page: every inventory row, the
 * active server / tool keys, the full issues list, and the
 * apply reason + committedAt. Heavier than `mcp:reloaded`; only
 * emitted on explicit `mcp:status:get` requests.
 *
 * Phase 3 enrichment: also surface a per-server `mcpStatus` block
 * (connectionStatus + tool list + annotations) keyed by
 * `scopedServerName`. The main-process capability-management
 * aggregator consumes this so the settings UI / popovers can
 * show live "connected / disconnected" dots and the actual tool
 * list without a second IPC. The data is sourced from the
 * agent's live `MCPManager.getAllClients()` — nothing stale.
 */
function buildMcpStatusSnapshot(): Record<string, unknown> {
  if (!agent) {
    return {
      type: 'mcp:status:snapshot',
      hasAgent: false,
      inventory: [],
      activeServerKeys: [],
      activeToolKeys: [],
      issues: [],
      reason: null,
      committedAt: null,
      mcpStatus: {},
    };
  }
  const snapshot = agent.activeMCPRuntimeSnapshot;
  if (!snapshot) {
    return {
      type: 'mcp:status:snapshot',
      hasAgent: true,
      inventory: [],
      activeServerKeys: [],
      activeToolKeys: [],
      issues: [],
      reason: null,
      committedAt: null,
      mcpStatus: collectMcpStatusByServer(agent.getActiveMCPManager()),
    };
  }

  return {
    type: 'mcp:status:snapshot',
    hasAgent: true,
    reason: snapshot.reason,
    committedAt: snapshot.committedAt,
    inventory: snapshot.loadResult.inventory,
    activeServerKeys: snapshot.activeServerKeys,
    activeToolKeys: snapshot.activeToolKeys,
    issues: snapshot.loadResult.issues,
    connectionIssues: snapshot.connectionIssues,
    registrationIssues: snapshot.registrationIssues,
    mcpStatus: collectMcpStatusByServer(agent.getActiveMCPManager()),
  };
}

/**
 * Walk the live MCPManager and produce a per-server status map.
 * Empty when no runtime is active (initial boot before PHASE B2
 * commits).
 */
function collectMcpStatusByServer(
  manager: ReturnType<NonNullable<typeof agent>['getActiveMCPManager']>,
): Record<
  string,
  {
    connectionStatus: 'connected' | 'disconnected' | 'connecting' | 'error';
    toolCount: number;
    tools: Array<{
      name: string;
      description: string;
      annotations: Record<string, unknown> | undefined;
    }>;
  }
> {
  if (!manager) return {};
  const out: Record<
    string,
    {
      connectionStatus: 'connected' | 'disconnected' | 'connecting' | 'error';
      toolCount: number;
      tools: Array<{
        name: string;
        description: string;
        annotations: Record<string, unknown> | undefined;
      }>;
    }
  > = {};
  for (const client of manager.getAllClients()) {
    const status = client.getStatus();
    const tools = client.getTools();
    out[client.getName()] = {
      connectionStatus: status,
      toolCount: tools.length,
      tools: tools.map((t: { name: string; description: string; annotations?: Record<string, unknown> }) => ({
        name: t.name,
        description: t.description,
        annotations: t.annotations,
      })),
    };
  }
  return out;
}

async function reloadMCP(): Promise<void> {
  // Phase 2A worker closure: reload now goes through the same
  // applyMCPConfiguration state machine as init. PHASE A computes
  // the next typed state without touching the active runtime;
  // PHASE B1 prepares the new manager + tool registration plan;
  // PHASE B2 atomically swaps the registry entries and the
  // active manager; PHASE C commits the snapshot. In-flight
  // calls against the old client fail deterministically after
  // PHASE B2 (this is the documented known limit; a future
  // tool-call drain is out of scope for this round).
  if (!agent) return;
  try {
    const result = await applyMCPConfiguration({
      agent,
      reason: 'manual',
      agentProfileId: agent.getActiveAgentProfileId(),
    });
    log(
      `[Agent-Process] Reloaded MCP: ${result.action.clientsConnected} connected, ` +
      `${result.action.toolsAdded} tools added, ${result.action.toolsRemoved} removed ` +
      `(${result.loadResult.inventory.length} inventory rows, ${result.loadResult.issues.length} issues)`,
    );
    for (const issue of result.loadResult.issues) {
      log(
        `[Agent-Process] MCP issue [${issue.phase}] ${issue.serverName ?? '(unknown)'}: ${issue.humanMessage}` +
        (issue.suggestedAction ? ` (action: ${issue.suggestedAction})` : ''),
      );
    }
    // Phase 2A diagnostic chain: emit a richer `mcp:reloaded`
    // event so main / settings UI can surface the active server
    // keys + tool keys + issue counts without polling. The full
    // `MCPHealthReport`-shaped payload arrives on demand via
    // `mcp:status:get` (handled in the worker protocol switch
    // below).
    sendToMain(buildMcpReloadedEvent(result));
    // Plan 312: refresh App Connection descriptors after MCP reload.
    // The /plugins/reload broadcast triggers reloadMCP; connect/disconnect
    // triggers /plugins/reload, so this covers both paths.
    void reloadAppConnectionTools();
  } catch (err) {
    warn('[Agent-Process] Failed to reload MCP:', err);
    sendToMain({ type: 'mcp:reload:error', error: err instanceof Error ? err.message : String(err) });
  }
}

// ============================================================================
// Main Message Loop (stdin/stdout JSON-RPC)
// ============================================================================

async function handleCommand(msg: WorkerCommand): Promise<void> {
  const msgType = msg.type as string;
  if (msgType !== 'db:response') {
    log('[Agent-Process] Received command:', msgType, 'sessionId:', (msg as Record<string, unknown>).sessionId);
  }

  switch (msgType) {
    case 'init': {
          const initMsg = msg as unknown as InitMessage;
          log('[Agent-Process] Received init for session:', initMsg.sessionId);
          // Guard: reject re-init while chat is in progress to prevent mid-flight agent destruction
          if (chatInProgress) {
            log('[Agent-Process] Rejecting init: chat in progress, cannot reinit now');
            sendToMain({ type: 'ready', sessionId: initMsg.sessionId, status: 'deferred', reason: 'chat_in_progress' });
            break;
          }
          const previousSessionId = sessionId;
          sessionId = initMsg.sessionId;
          existingMessageCount = 0;
          // Fresh session served by this worker process: clear the live
          // context-usage tracker carried over from the previous session.
          // A re-init for the SAME session (main re-sends init between
          // turns) must keep it — wiping here dropped the authoritative base
          // every turn, so the ring fell back to the capped local estimate
          // until the first `result` of the next turn rebased it.
          if (previousSessionId !== sessionId) {
            compactedPending = false;
            liveTotalInput = 0;
            liveTotalInputRaw = 0;
            liveTotalOutput = 0;
            liveTotalCacheHit = 0;
            liveTotalCacheCreation = 0;
          }
          if (agent) {
            log('[Agent-Process] Re-init: destroying existing agent and creating new one');
            try {
              agent.destroy?.();
            } catch (err) {
              warn('[Agent-Process] Error destroying old agent:', err);
            }
            agent = null;
          }
          if (initializing) {
            log('[Agent-Process] Init in progress, waiting...');
            const INIT_POLL_TIMEOUT_MS = 30_000;
            const initPollStartTime = Date.now();
            const waitForInit = setInterval(() => {
              if (!initializing) {
                clearInterval(waitForInit);
                sendToMain({ type: 'ready', sessionId });
              } else if (Date.now() - initPollStartTime >= INIT_POLL_TIMEOUT_MS) {
                clearInterval(waitForInit);
                initializing = false;
                warn(`[Agent-Process] Init poll timed out after ${INIT_POLL_TIMEOUT_MS}ms, forcing ready`);
                sendToMain({ type: 'ready', sessionId, status: 'error', reason: 'init_timeout' });
              }
            }, 50);
            break;
          }
          initializing = true;
          log('[Agent-Process] Received init message:', {
            sessionId: initMsg.sessionId,
            workingDirectory: initMsg.workingDirectory,
            systemPrompt: initMsg.systemPrompt ? 'present' : 'not present',
            providerConfig: initMsg.providerConfig ? {
              provider: initMsg.providerConfig.provider,
              model: initMsg.providerConfig.model,
              baseURL: initMsg.providerConfig.baseURL,
              hasApiKey: !!initMsg.providerConfig.apiKey,
            } : 'MISSING!',
          });
          let initError: string | null = null;
          try {
            await initAgent(
              initMsg.providerConfig,
              initMsg.workingDirectory,
              initMsg.defaultWorkspaceDirectory,
              initMsg.systemPrompt,
              initMsg.blockedDomains,
              initMsg.language,
              initMsg.sandboxEnabled,
              initMsg.communicationPlatform,
              initMsg.browserBackendMode,
              initMsg.permissionRules,
            );

            try {
              // Parallel: initToolCatalog (only depends on agent instance),
              // skills loading (disk I/O), and DB message loading (IPC).
              // Skills errors are handled inside loadAgentSkills; DB errors caught below.
              currentSecurityScanEnabled = initMsg.securityScanEnabled !== false;
              const [_, __, loadedData] = await Promise.all([
                // Plan 314: initToolCatalog only depends on the agent instance, no dependency on skills/messages, run in parallel
                agent ? agent.initToolCatalog() : Promise.resolve(),
                loadAgentSkills(initMsg.workingDirectory, initMsg.skillPaths, initMsg.securityScanEnabled),
                messageDb.loadMessages(sessionId!) as Promise<{ messages: MessageRow[]; parsedDocuments: ParsedDocumentAttachment[] }>,
              ]);
              const existingRows = loadedData.messages;
              debugLog('loaded history rows', { sessionId, rows: existingRows.length });
              if (existingRows.length > 0) {
                // Load attachments for CDN URL rehydration
                let attachmentMap: Map<string, AttachmentRow[]> | undefined;
                try {
                  attachmentMap = getAttachmentsForSession(sessionId!);
                } catch {
                  // attachmentMap stays undefined, messages load without rehydration
                }
                // Build parsed doc map from combined IPC response (saves 1 round trip)
                let parsedDocMap: Map<string, ParsedDocumentAttachment[]> | undefined;
                if (loadedData.parsedDocuments?.length) {
                  parsedDocMap = new Map<string, ParsedDocumentAttachment[]>();
                  for (const doc of loadedData.parsedDocuments) {
                    const existing = parsedDocMap.get(doc.message_id) || [];
                    existing.push(doc);
                    parsedDocMap.set(doc.message_id, existing);
                  }
                }
                let existingMessages = existingRows.map(row => messageRowToMessage(row, attachmentMap, parsedDocMap));

                // Validate and repair incomplete or out-of-order tool rounds
                // before the history is ever sent back to a provider. Persist
                // successful repairs so a legacy bad row cannot poison this
                // session again after the worker restarts.
                const validatedMessages = validateMessageHistory(existingMessages);
                if (validatedMessages !== existingMessages) {
                  const repairResult = await messageDb.replace(sessionId!, validatedMessages, 0) as {
                    success?: boolean;
                    reason?: string;
                  };
                  if (repairResult.success) {
                    log(`[Agent-Process] Repaired persisted message history for session ${sessionId}`);
                  } else {
                    warn(`[Agent-Process] Could not persist repaired message history for session ${sessionId}: ${repairResult.reason ?? 'unknown error'}`);
                  }
                }
                existingMessages = validatedMessages;

                agent.setMessages(existingMessages);
                existingMessageCount = existingMessages.length;
                log(`[Agent-Process] Loaded ${existingMessages.length} messages from DB for session ${sessionId}`);
                debugLog('loaded message roles', existingMessages.map(m => ({ role: m.role, type: m.msg_type || (Array.isArray(m.content) ? m.content.map((c: { type: string }) => c.type).join(',') : 'string') })));

                // Plan 331 Phase 2.4: restore (or create) the session_goals row
                // so token-budget deltas persist across restarts. The in-memory
                // TokenBudgetManager is rebuilt from the message history above
                // (updateContextTokens is called lazily on first
                // shouldCompact / getContextStats), so we only need to ensure
                // the DB row exists — the accumulators (tokens_used,
                // time_used_seconds) are read back on the next turn report.
                // Both branches below converge on get-then-create so a re-init
                // (row exists, message history empty) never trips the
                // UNIQUE(session_id) constraint.
                try {
                  const existingGoal = await goalDb.get(sessionId!) as Record<string, unknown> | undefined;
                  if (!existingGoal) {
                    const { randomUUID } = await import('node:crypto');
                    await goalDb.create({
                      id: randomUUID(),
                      session_id: sessionId!,
                    });
                    log(`[Agent-Process] Created new session_goals row for ${sessionId}`);
                  } else {
                    log(`[Agent-Process] Restored session_goals for ${sessionId}: tokens_used=${existingGoal.tokens_used}, status=${existingGoal.status}`);
                  }
                } catch (err) {
                  warn('[Agent-Process] Failed to restore/create session goal:', err);
                }
              } else {
                log(`[Agent-Process] No existing messages found in DB for session ${sessionId}`);
                // Plan 331 Phase 2.4: even for a brand-new session, create
                // the session_goals row so the first turn report has a row
                // to increment. Get-then-create keeps this idempotent — a
                // leftover goal row from an earlier run of the same session
                // is restored instead of rejected by the UNIQUE constraint.
                try {
                  const existingGoal = await goalDb.get(sessionId!) as Record<string, unknown> | undefined;
                  if (existingGoal) {
                    log(`[Agent-Process] Restored session_goals for ${sessionId}: tokens_used=${existingGoal.tokens_used}, status=${existingGoal.status}`);
                  } else {
                    const { randomUUID } = await import('node:crypto');
                    await goalDb.create({
                      id: randomUUID(),
                      session_id: sessionId!,
                    });
                    log(`[Agent-Process] Created new session_goals row for ${sessionId} (new session)`);
                  }
                } catch (err) {
                  warn('[Agent-Process] Failed to restore/create session goal:', err);
                }
              }
            } catch (err) {
              warn('[Agent-Process] Failed to load messages from DB:', err);
            }
          } catch (err) {
            initError = err instanceof Error ? err.message : String(err);
            warn('[Agent-Process] Agent initialization failed:', err);
          } finally {
            initializing = false;
            await drainQueuedChatStart();
          }

          sendToMain({
            type: 'ready',
            sessionId,
            ...(initError ? { status: 'error', error: initError } : {}),
          });

          // Plan 312: fire-and-forget App Connection descriptor fetch.
          // Caches the descriptor list so DuyaAgent._resolveTools can
          // merge connector tools into the per-turn registry.
          if (!initError) {
            void reloadAppConnectionTools();
          }

          // Plan 305 Phase B: fire-and-forget memory wakeup. The
          // main-process router intercepts the `memory:wakeup` worker
          // event and triggers `MemoryWorker.forceSweep()` so Stage 1
          // extraction runs immediately after init (no 60s wait).
          // Gated by DUYA_MEMORY_ENABLED; failures are swallowed.
          if (!initError) {
            sendMemoryWakeup(
              (event) => sendToMain(event as unknown as Record<string, unknown>),
              { sessionId: sessionId ?? undefined },
            );
          }

          // Initialize MCP servers asynchronously after sending ready so that slow or hung
          // MCP servers do not block the worker from becoming ready.
          //
          // Phase 2A worker closure: both init and reload go
          // through `applyMCPConfiguration` (Phase 2A apply state
          // machine). Old Phase 1C "init typed, reload legacy"
          // transitional state is removed.
          (async () => {
            if (!agent) return;
            try {
              agent.setActiveAgentProfileId(undefined);
              log('[Agent-Process] Initializing MCP servers (applyMCPConfiguration)...');
              const result = await applyMCPConfiguration({
                agent,
                reason: 'initialization',
              });
              log(
                `[Agent-Process] Initialized MCP servers: ${result.action.clientsConnected} connected, ` +
                `${result.action.toolsAdded} tools, ${result.action.toolsRemoved} removed ` +
                `(${result.loadResult.inventory.length} inventory rows, ${result.loadResult.issues.length} issues)`,
              );
              for (const issue of result.loadResult.issues) {
                log(
                  `[Agent-Process] MCP issue [${issue.phase}] ${issue.serverName ?? '(unknown)'}: ${issue.humanMessage}` +
                  (issue.suggestedAction ? ` (action: ${issue.suggestedAction})` : ''),
                );
              }
            } catch (mcpErr) {
              warn('[Agent-Process] Failed to initialize MCP servers after ready:', mcpErr);
            } finally {
              // Plan 314: release the mcpReady gate regardless of outcome
              // so first chat is never permanently blocked. Success →
              // tools are in catalog; failure → degraded turn without MCP.
              agent.notifyMcpReady();
            }
          })();
          break;
        }

        case 'chat:start': {
          const chatMsg = msg as unknown as ChatStartMessage;
          log('[Agent-Process] Received chat:start for session:', chatMsg.sessionId, 'initInProgress:', initializing);
          if (initializing || chatInProgress) {
            log('[Agent-Process] Init in progress or chat in progress, queuing chat:start');
            enqueue({
              value: chatMsg.prompt,
              mode: 'prompt',
              priority: 'next',
              agentId: undefined,
              rawMessage: chatMsg,
            });
            break;
          }
          chatInProgress = true;
          handleChatStart(chatMsg).catch((err) => {
            // Defensive: any uncaught error inside handleChatStart
            // (e.g. turn-review temp-dir cleanup EBUSY on Windows)
            // must not crash the worker. Log and let the finally
            // block reset chatInProgress.
            warn('[Agent-Process] handleChatStart error:', err);
            sendToMain({
              type: 'chat:error',
              message: err instanceof Error ? err.message : String(err),
              sessionId: chatMsg.sessionId,
            });
          }).finally(() => {
            chatInProgress = false;
            setImmediate(() => {
              void drainQueuedChatStart();
            });
          });
          break;
        }

        case 'permission:set': {
          const pMode = (msg as { mode?: string }).mode;
          log('[Agent-Process] Received permission:set', { sessionId, mode: pMode });
          if (agent && pMode) {
            agent.setPermissionMode(pMode);
            log('[Agent-Process] Permission mode updated live', { sessionId, mode: pMode });
          }
          break;
        }

        case 'chat:interrupt': {
          const now = Date.now();
          log('[Agent-Process] Received chat:interrupt, chatInProgress:', chatInProgress);

          if (chatInProgress) {
            // First press: abort current chat
            if (agent && agent.interrupt) {
              agent.interrupt();
            }
            lastInterruptTime = now;
            break;
          }

          // Second press within window OR no chat running: clear queued messages
          if (hasCommandsInQueue() && (now - lastInterruptTime < DOUBLE_INTERRUPT_WINDOW_MS || !chatInProgress)) {
            log('[Agent-Process] Double interrupt: clearing command queue');
            clearCommandQueue();
            lastInterruptTime = 0;
          } else if (hasCommandsInQueue()) {
            // First press while idle with queued messages: pop the front of the
            // queue. Only user commands (agentId undefined) are interrupt-popped;
            // queue holds user prompts only now that background notifications
            // flow through the mailbox instead of the command queue.
            const popped = dequeue<ChatStartMessage>(
              (cmd: QueuedCommand<ChatStartMessage>) => cmd.agentId === undefined
            );
            if (popped) {
              log('[Agent-Process] Interrupt popped queued command from queue, remaining:', getCommandQueueLength());
            }
            lastInterruptTime = now;
          }
          break;
        }

        case 'ping': {
          lastPongTime = Date.now();
          sendToMain({ type: 'pong', timestamp: lastPongTime });
          break;
        }

        case 'compact': {
          log('[Agent-Process] Received compact for session:', sessionId);
          if (!agent) {
            sendToMain({ type: 'compact:error', sessionId, message: 'Agent not initialized' });
            break;
          }
          // Plan 422: lazy-load messages if the worker has not yet seen this
          // session via chat:start. The /compact popover button is dispatched
          // independently of chat:start, so without this the worker would call
          // agent.compact() on an empty timeline and return strategy: 'none'
          // — the symptom the user hit on a 332-message session.
          try {
            if (sessionId) {
              const dbCount = await messageDb.getCount(sessionId) as number
              if (dbCount > 0 && agent.getMessages().length === 0) {
                const loaded = await messageDb.loadMessages(sessionId) as { messages: MessageRow[] }
                const attachmentMap = getAttachmentsForSession(sessionId)
                const allMsgs = loaded.messages.map(row => messageRowToMessage(row, attachmentMap))
                const validated = validateMessageHistory(allMsgs)
                agent.setMessages(validated)
                existingMessageCount = validated.length
                log('[Agent-Process] Compact: lazy-loaded ' + validated.length + ' messages from DB')
              }
            }
          } catch (loadErr) {
            log('[Agent-Process] Compact: lazy-load failed (continuing):', loadErr)
          }
          try {
            // Extract optional compact options from message
            const compactMsg = msg as unknown as {
              strategy?: string;
              maxMessagesToKeep?: number;
              customInstructions?: string;
              keepRecentTokens?: number;
            };

            const result = await agent.compact({
              strategy: compactMsg.strategy,
              maxMessagesToKeep: compactMsg.maxMessagesToKeep,
              customInstructions: compactMsg.customInstructions,
            });
            log('[Agent-Process] Compaction complete:', result);
            const currentMessages = agent.getMessages();
            // After compaction, agent holds a reduced/summarized set.
            // Append all current messages; INSERT OR IGNORE handles dedup
            // for messages already in DB. Update existingMessageCount.
            await appendMessages(sessionId!, currentMessages);
            existingMessageCount = currentMessages.length;
            log(`[Agent-Process] Compaction: appended messages, new count=${existingMessageCount}`);
            // Broadcast BEFORE compact:done: retained anchors describe the
            // pre-compact prompt, so mark pending and emit an unanchored
            // frame — the ring shows "?" until the next turn's first `result`
            // provides a post-compaction anchor (plan 443, pi parity).
            compactedPending = true;
            emitLiveUsage(sessionId);
            sendToMain({ type: 'compact:done', sessionId, result });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log('[Agent-Process] Compaction failed:', errorMessage);
            sendToMain({ type: 'compact:error', sessionId, message: errorMessage });
          }
          break;
        }

        case 'side:question': {
          const sideMsg = msg as unknown as import('./worker-protocol.js').SideQuestionCommand;
          log('[Agent-Process] Received side:question for session:', sideMsg.sessionId);
          if (!agent) {
            sendToMain({
              type: 'side:answer',
              sessionId: sideMsg.sessionId,
              id: sideMsg.id,
              answer: '',
              error: 'Agent not initialized',
            } satisfies import('./worker-protocol.js').SideQuestionResponse);
            break;
          }
          try {
            const answer = await agent.sideQuestion(sideMsg.question);
            sendToMain({
              type: 'side:answer',
              sessionId: sideMsg.sessionId,
              id: sideMsg.id,
              answer,
            } satisfies import('./worker-protocol.js').SideQuestionResponse);
          } catch (err) {
            warn('[Agent-Process] side:question failed:', err);
            sendToMain({
              type: 'side:answer',
              sessionId: sideMsg.sessionId,
              id: sideMsg.id,
              answer: '',
              error: err instanceof Error ? err.message : String(err),
            } satisfies import('./worker-protocol.js').SideQuestionResponse);
          }
          break;
        }

        case 'reload:skills': {
          log('[Agent-Process] Received reload:skills');
          void reloadSkills();
          break;
        }

        case 'reload:mcp': {
          log('[Agent-Process] Received reload:mcp');
          void reloadMCP();
          break;
        }

        case 'config:update': {
          const cfgMsg = msg as unknown as { browserBackendMode?: 'auto' | 'extension' | 'built-in' | 'human-like'; blockedDomains?: string[] };
          log('[Agent-Process] Received config:update:', cfgMsg);
          if (cfgMsg.browserBackendMode) {
            browserTool.setBrowserConfig({
              mode: cfgMsg.browserBackendMode,
              extensionProbeTimeoutMs: 500,
            });
            log('[Agent-Process] Browser backend mode updated:', cfgMsg.browserBackendMode);
          }
          break;
        }

        case 'mcp:status:get': {
          // Diagnostic chain command: main / settings UI queries
          // the active MCP runtime on demand. The full snapshot
          // (inventory + issues + active keys) goes out as a
          // single `mcp:status:snapshot` event.
          sendToMain(buildMcpStatusSnapshot());
          break;
        }

        case 'permission:resolve': {
          // Handle permission resolution from main — resolve the pending permission promise.
          // sessionId is required to keep sessions isolated (B4): a stray resolve
          // from a sub-agent/fork must not unlock a top-level session's prompt.
          const { id, decision, updatedInput, sessionId: resolveSessionId } = msg as {
            id: string;
            decision: string;
            updatedInput?: Record<string, unknown>;
            message?: string;
            sessionId?: string;
          };

          if (!resolveSessionId) {
            warn('[Agent-Process] permission:resolve missing sessionId, ignoring:', id);
            break;
          }

          log('[Agent-Process] Permission resolved:', resolveSessionId, id, decision, updatedInput ? 'with updatedInput' : '');

          // Store answers for AskUserQuestion tool retry
          if (updatedInput?.answers) {
            storePendingAnswer(id, updatedInput.answers as Record<string, string>);
          }

          const key = pendingPermissionKey(resolveSessionId, id);
          const pending = pendingPermissions.get(key);
          if (pending) {
            // Clear the 5min timer FIRST so a late expiry can never race
            // with this resolve and emit a stray 'deny'.
            clearTimeout(pending.timeoutHandle);
            pendingPermissions.delete(key);
            if (decision === 'allow' || decision === 'allow_once' || decision === 'allow_for_session') {
              pending.resolve('allow');
            } else {
              pending.resolve('deny');
            }
          } else {
            // Common during SSE reconnect: a fresh permission event was
            // emitted after the original had already been resolved. The
            // renderer's `waitingRef` guard prevents double-send, and the
            // missing entry is the expected state — log at info, not warn,
            // to avoid noise.
            log('[Agent-Process] No pending permission for resolved id (likely already resolved or expired):', resolveSessionId, id);
          }
          break;
        }

        case 'interagent:event': {
          const eventMsg = msg as unknown as { type: 'interagent:event'; id: string; event: import('./worker-protocol.js').WorkerEvent };
          const call = pendingInteragentCalls.get(eventMsg.id);
          if (!call) {
            // Stale event after cleanup — safe to ignore
            break;
          }
          call.events.push(eventMsg.event);
          if (eventMsg.event.type === 'chat:done') {
            call.resolveDone(eventMsg.event);
          } else if (eventMsg.event.type === 'chat:error') {
            call.resolveError(eventMsg.event);
          }
          break;
        }

        case 'db:response': {
          // Handled by db-client, just acknowledge
          break;
        }

        case 'conductor:executor:rpc:response': {
          const { requestId, success, result, error } = msg as unknown as {
            requestId: string;
            success: boolean;
            result?: unknown;
            error?: { code: string; message: string };
          };
          const pending = pendingIpcRequests.get(requestId);
          if (pending) {
            // Clear the timeout so it doesn't fire after a successful response
            if (pending.timeoutHandle) {
              clearTimeout(pending.timeoutHandle);
            }
            pendingIpcRequests.delete(requestId);
            if (success) {
              pending.resolve({ success: true, data: result });
            } else {
              pending.resolve({ success: false, error: error || { code: 'UNKNOWN', message: 'Unknown error' } });
            }
          } else {
            warn('[Agent-Process] No pending IPC request found for requestId:', requestId);
          }
          break;
        }

        // Plan 312: App Connection tool execution response.
        case 'appConnection:invoke:response': {
          const { requestId, success, data, error } = msg as unknown as {
            requestId: string;
            success: boolean;
            data?: unknown;
            error?: { code: string; message: string };
          };
          const pending = pendingIpcRequests.get(requestId);
          if (pending) {
            if (pending.timeoutHandle) {
              clearTimeout(pending.timeoutHandle);
            }
            pendingIpcRequests.delete(requestId);
            if (success) {
              pending.resolve({ success: true, data });
            } else {
              pending.resolve({ success: false, error: error || { code: 'UNKNOWN', message: 'Unknown error' } });
            }
          } else {
            warn('[Agent-Process] No pending appConnection IPC request found for requestId:', requestId);
          }
          break;
        }

        // Plan 312: App Connection descriptor list response.
        case 'appConnection:listDescriptors:response': {
          const { requestId, success, descriptors, error } = msg as unknown as {
            requestId: string;
            success: boolean;
            descriptors?: unknown[];
            error?: { code: string; message: string };
          };
          const pending = pendingIpcRequests.get(requestId);
          if (pending) {
            if (pending.timeoutHandle) {
              clearTimeout(pending.timeoutHandle);
            }
            pendingIpcRequests.delete(requestId);
            if (success) {
              pending.resolve({ success: true, descriptors });
            } else {
              pending.resolve({ success: false, error: error || { code: 'UNKNOWN', message: 'Unknown error' } });
            }
          } else {
            warn('[Agent-Process] No pending appConnection descriptor request found for requestId:', requestId);
          }
          break;
        }
    default:
      warn('[Agent-Process] Unknown message type:', msgType);
  }
}

async function main(): Promise<void> {
  log('Process started, session:', process.env.SESSION_ID);
  log('cwd:', process.cwd());

  // Handle IPC messages from AgentProcessPool (cronjob, conductor, etc.)
  // Agent Server uses stdin/stdout, but AgentProcessPool uses IPC child.send()
  process.on('message', (msg: unknown) => {
    if (msg && typeof msg === 'object') {
      void handleCommand(msg as WorkerCommand);
    }
  });

  try {
    for await (const msg of parseStdin()) {
      await handleCommand(msg);
    }
  } catch (err) {
    log('[Agent-Process] Fatal error in main loop:', err);
    writeAgentCrashLog(err, 'main-loop');
    exitAfterCleanup(1);
  }
}

// ============================================================================
// Graceful Shutdown Handling
// ============================================================================

let isShuttingDown = false;

async function performCleanup(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log('[Agent-Process] Starting cleanup...');

  // Stop chat heartbeat
  stopChatHeartbeat();

  // Destroy token bucket timer
  toolBucket.destroy();

  // Shutdown worker pool (kills all BashWorker processes)
  try {
    const { shutdownWorkerPool } = await import('../tool/WorkerPool.js');
    shutdownWorkerPool();
    log('[Agent-Process] Worker pool shut down');
  } catch (err) {
    warn('[Agent-Process] Failed to shut down worker pool:', err);
  }

  // Clear title generation state
  titleGeneratedBySession.clear();

  // Close database connection
  try {
    const { closeDbClient } = await import('../ipc/db-client.js');
    await closeDbClient();
    log('[Agent-Process] DB client closed');
  } catch (err) {
    warn('[Agent-Process] Failed to close DB client:', err);
  }

  log('[Agent-Process] Cleanup complete');
}

function exitAfterCleanup(code: number): void {
  const safetyTimeout = setTimeout(() => {
    log('[Agent-Process] Cleanup timed out, force exiting');
    process.exit(code);
  }, 5000);

  void performCleanup().then(() => {
    clearTimeout(safetyTimeout);
    process.exit(code);
  }).catch((err) => {
    log('[Agent-Process] Cleanup failed:', err);
    clearTimeout(safetyTimeout);
    process.exit(code);
  });
}

// Handle termination signals
// Note: On Windows, Node.js child processes do NOT receive SIGTERM/SIGINT
// from parent.kill(). We rely primarily on 'disconnect' event.
process.on('SIGTERM', () => {
  log('[Agent-Process] Received SIGTERM');
  exitAfterCleanup(0);
});

process.on('SIGINT', () => {
  log('[Agent-Process] Received SIGINT');
  exitAfterCleanup(0);
});

// Handle disconnect from parent (Electron main process exited)
// This is the PRIMARY shutdown mechanism on Windows.
process.on('disconnect', () => {
  log('[Agent-Process] Parent disconnected, shutting down...');
  exitAfterCleanup(0);
});

// Persist the full error to a file so the crash is diagnosable even though
// the process pool only retains the first 5 stderr lines. Called from both
// the main-loop fatal-error catch and the uncaughtException handler.
function writeAgentCrashLog(err: unknown, origin: string): void {
  try {
    const crashDir = path.join(os.tmpdir(), 'duya-agent-crash');
    mkdirSync(crashDir, { recursive: true });
    const crashPath = path.join(crashDir, `agent-${sessionId || 'unknown'}-${origin}-${Date.now()}.log`);
    writeFileSync(
      crashPath,
      `[${new Date().toISOString()}] sessionId=${sessionId} origin=${origin}\n${err instanceof Error ? (err.stack || err.toString()) : String(err)}\n`,
      'utf-8',
    );
    log(`[Agent-Process] Crash log written to ${crashPath}`);
  } catch (writeErr) {
    warn('[Agent-Process] Failed to write crash log:', writeErr);
  }
}

// Swallow EPIPE / broken-pipe errors on our own stdout & stderr. When the
// parent tears the process down (releaseAndWait / killProcessTree) or exits
// before we finish flushing, the write pipe is broken. Node surfaces that as
// an ASYNC 'error' event on the stream (not a synchronous throw), which the
// write-queue try/catch in worker-protocol.ts cannot intercept — without a
// listener it escalates to uncaughtException and is misreported as a crash
// (exit code 1 + a spurious crash log). A genuine write failure elsewhere is
// still observable via other channels, so it is safe to swallow EPIPE only.
const swallowPipeError = (err: unknown): void => {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'EPIPE' || code === 'ERR_STREAM_WRITE_AFTER_END') {
    log('[Agent-Process] Ignoring broken pipe on process output:', code);
    return;
  }
  // Any other stream error is unexpected; surface it as a crash.
  log('[Agent-Process] Fatal process output error:', err);
  writeAgentCrashLog(err, 'output-stream');
  exitAfterCleanup(1);
};
process.stdout.on('error', swallowPipeError);
process.stderr.on('error', swallowPipeError);

// Handle uncaught errors to avoid zombie processes
process.on('uncaughtException', (err) => {
  log('[Agent-Process] Uncaught exception:', err);
  writeAgentCrashLog(err, 'uncaught-exception');
  exitAfterCleanup(1);
});

process.on('unhandledRejection', (reason) => {
  log('[Agent-Process] Unhandled rejection:', reason);
});

// Start the main loop
void main();
