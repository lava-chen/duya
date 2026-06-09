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
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { appendMessages, storeParsedDocumentAttachment } from '../session/db.js';
import { buildAttachmentContext } from '../llm/attachment-context.js';
import type { MessageRow, AttachmentRow, ParsedDocumentAttachment } from '../session/db.js';
import { getAttachmentsForSession, rehydrateContentWithAttachments } from '../session/db.js';
import type { Message, MessageContent, MCPServerConfig } from '../types.js';
import { messageDb, pluginDb, settingDb, sessionDb } from '../ipc/db-client.js';
import { IncrementalSaveQueue } from './incremental-save-queue.js';
import {
  enqueue,
  enqueuePendingNotification,
  dequeue,
  dequeueAllMatching,
  hasCommandsInQueue,
  clearCommandQueue,
  getCommandQueueLength,
} from '../queue/index.js';
import type { QueuedCommand } from '../queue/index.js';
import { generateSessionTitle } from '../session/title-generator.js';
import { classifyError, APIErrorType } from '../llm/errors.js';
import { getDefaultPromptManager } from '../prompts/PromptManager.js';
import type { PromptProfile } from '../prompts/modes/types.js';
import type { ConductorSnapshot } from '../conductor/ConductorProfile.js';
import { setConductorCanvasState } from '../prompts/sections/dynamic/conductorCanvas.js';
import { duyaAgent } from '../index.js';
import { sendEvent, parseStdin, type WorkerCommand } from './worker-protocol.js';
import { resolveChatStartAgentMode } from './permission-profile-bridge.js';
import { applyMCPConfiguration, type MCPApplyResult } from '../mcp/apply.js';
import { storePendingAnswer } from '../tool/AskUserQuestionTool/AskUserQuestionTool.js';
import { isCDNImageUrl } from '../utils/urlSafety.js';
import { resizeImageBuffer, needsResizing, TARGET_IMAGE_SIZE_BYTES } from '../utils/imageResizer.js';
import { isModelLikelyMultimodal } from '../llm/multimodal-detection.js';
import { detectModelCapability } from '../llm/model-capability-cache.js';
import type { ProbeConfig } from '../llm/model-capability-cache.js';
import { VisionTool } from '../tool/VisionTool/VisionTool.js';

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
  mode?: 'chat' | 'conductor';
  providerConfig: {
    apiKey: string;
    baseURL?: string;
    model: string;
    provider: 'anthropic' | 'openai' | 'ollama';
    authStyle?: 'api_key' | 'auth_token';
    visionConfig?: VisionConfig;
    /**
     * Phase 2: optional ProviderRuntimeConfig. When present, the agent
     * prefers the apiFormat and headers from this object over the legacy
     * `provider` discriminator. New code should treat this as the
     * authoritative runtime config.
     */
    runtimeConfig?: {
      providerId: string;
      providerName?: string;
      apiFormat: 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini' | 'ollama' | 'bedrock' | 'vertex';
      baseUrl: string;
      apiKey?: string;
      accessToken?: string;
      headers: Record<string, string>;
      model: string;
      requestOptions?: Record<string, unknown>;
    };
  };
  workingDirectory?: string;
  defaultWorkspaceDirectory?: string;
  systemPrompt?: string;
  skillPaths?: string[];
  communicationPlatform?: string;
  blockedDomains?: string[];
  language?: string;
  sandboxEnabled?: boolean;
  securityScanEnabled?: boolean;
}

interface ConductorInitMessage {
  type: 'conductor:init';
  sessionId: string;
  providerConfig: {
    apiKey: string;
    baseURL?: string;
    model: string;
    provider: 'anthropic' | 'openai' | 'ollama';
    authStyle?: 'api_key' | 'auth_token';
  };
  snapshot: ConductorSnapshot;
  systemPrompt?: string;
  workingDirectory?: string;
  language?: string;
}

interface ConductorStartMessage {
  type: 'conductor:agent:start';
  sessionId: string;
  prompt: string;
  snapshot?: ConductorSnapshot;
  language?: string;
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
    mode?: string;
    titleGenerationModel?: string;
    titleGenerationModelConfig?: { provider: string; apiKey: string; baseURL: string; model: string };
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
// Track the main model name for multimodal detection
let mainModelName = '';
let probeConfig: ProbeConfig | null = null;
const visionTool = new VisionTool();
// Track title generation per session (Map<sessionId, lastGeneratedTitle>)
const titleGeneratedBySession = new Map<string, string>();
// Title generation model config (from settings)
let titleGenerationModelConfig: { provider: string; apiKey: string; baseURL: string; model: string } | null = null;
const DEBUG_IPC = process.env.DUYA_DEBUG_IPC === 'true';

// Conductor agent global state
let conductorAgent: duyaAgent | null = null;
let conductorSessionId: string | null = null;
let conductorInitializing = false;
let conductorInProgress = false;

// Heartbeat tracking for long-running operations
let lastPongTime = Date.now();
const HEARTBEAT_INTERVAL = 5000; // Send pong every 5 seconds during streaming

// Independent heartbeat timer to keep process alive during long operations
let chatHeartbeatTimer: NodeJS.Timeout | null = null;
const CHAT_HEARTBEAT_INTERVAL = 8000; // Send pong every 8 seconds while chat is active

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
}>();

// Helper: IPC request for conductor executor
function conductorIpcRequest<T = unknown>(
  action: string,
  payload: unknown,
  options?: { timeout?: number }
): Promise<{ success: boolean; data?: T; error?: { code: string; message: string } }> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = options?.timeout || 30000;

    pendingIpcRequests.set(requestId, {
      resolve: (v) => resolve(v as { success: boolean; data?: T; error?: { code: string; message: string } }),
      reject: (e) => reject(e),
    });

    sendToMain({
      type: 'conductor:executor:rpc',
      requestId,
      action,
      payload,
    });

    setTimeout(() => {
      if (pendingIpcRequests.has(requestId)) {
        pendingIpcRequests.delete(requestId);
        resolve({ success: false, error: { code: 'TIMEOUT', message: `IPC request timeout after ${timeout}ms` } });
      }
    }, timeout);
  });
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

  return {
    id: row.id,
    role: row.role,
    content,
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
  };
}

// ============================================================================
// Message History Validation
// ============================================================================

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

  if (unmatchedToolUseIds.size === 0) {
    return messages;
  }

  log(`[Agent-Process] Found ${unmatchedToolUseIds.size} incomplete tool call(s) in history, cleaning up`);

  // Filter out messages with unmatched tool_uses
  const cleanedMessages: Message[] = [];
  for (const msg of messages) {
    // Skip tool_result messages that don't have a matching tool_use
    if (msg.role === 'tool' && msg.tool_call_id && !toolUseIds.has(msg.tool_call_id)) {
      log(`[Agent-Process] Removing orphan tool_result: ${msg.tool_call_id}`);
      continue;
    }

    // Skip tool_use messages that don't have a matching result
    if (msg.msg_type === 'tool_use' && msg.tool_call_id && unmatchedToolUseIds.has(msg.tool_call_id)) {
      log(`[Agent-Process] Removing incomplete tool_use: ${msg.tool_call_id} (${msg.tool_name})`);
      continue;
    }

    // For assistant messages with tool_use blocks, remove unmatched tool_use blocks
    if (Array.isArray(msg.content)) {
      const filteredContent = msg.content.filter((block) => {
        if (block.type === 'tool_use' && 'id' in block && typeof block.id === 'string') {
          if (unmatchedToolUseIds.has(block.id)) {
            log(`[Agent-Process] Removing tool_use block from assistant message: ${block.id}`);
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

  log(`[Agent-Process] Cleaned message history: ${messages.length} -> ${cleanedMessages.length} messages`);
  return cleanedMessages;
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

function summarizeConversationForWiki(messages: Message[], maxMessages = 12): string {
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

async function initAgent(config: InitMessage['providerConfig'], workDir?: string, defaultWorkspaceDir?: string, sysPrompt?: string, blockedDomains?: string[], language?: string, sandboxEnabled?: boolean, communicationPlatform?: string): Promise<void> {
  // Dynamic import - .js extension required for NodeNext moduleResolution
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentModule = await import('../index.js') as any;
  const duyaAgent = agentModule.default;
  const setSandboxEnabled = agentModule.setSandboxEnabled as ((enabled: boolean) => void) | undefined;
  const buildSandboxImage = agentModule.buildSandboxImage as ((onProgress?: (msg: string) => void) => Promise<boolean>) | undefined;

  // Store system prompt for use in chat
  sessionSystemPrompt = sysPrompt;

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
    skillNudgeInterval: 10,
    communicationPlatform: (communicationPlatform as 'cli' | 'duya-app' | 'weixin' | 'feishu' | 'telegram' | 'web' | 'api') ?? 'duya-app',
    workingDirectory: workDir,
    visionConfig: config.visionConfig,
    blockedDomains,
    language,
    defaultWorkspaceDirectory: defaultWorkspaceDir,
    // Phase 3: thread the runtime config into the agent. The
    // constructor will prefer `apiFormat` over `provider` when
    // present. Legacy fields stay authoritative for everything else
    // (vision, sub-model resolution, etc.).
    runtimeConfig: config.runtimeConfig,
  });

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentModule = await import('../index.js') as any;
  const loadSkills = agentModule.loadSkills;
  const getSkillRegistry = agentModule.getSkillRegistry;

  try {
    const loadOptions: { additionalPaths?: string[]; syncBundled?: boolean; securityBypassSkills?: string[]; skipSecurityScan?: boolean } = {
      syncBundled: true,
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
          if (disabledNames.has(skill.name)) {
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

function findToolResultBlocks(m: Message): boolean {
  if (Array.isArray(m.content)) {
    return m.content.some(
      (b: unknown) => (b as Record<string, unknown>).type === 'tool_result'
    );
  }
  return false;
}

function findLastToolResultIndex(messages: Message[]): number {
  let lastIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool' || findToolResultBlocks(m)) {
      lastIdx = i;
    }
  }
  return lastIdx;
}

function convertSSEToAgentMessage(event: { type: string; data?: unknown }): Record<string, unknown> | null {
  switch (event.type) {
    case 'text':
      return { type: 'chat:text', content: event.data as string };
    case 'thinking':
      return { type: 'chat:thinking', content: event.data as string };
    case 'tool_use':
      return { type: 'chat:tool_use', id: (event.data as { id: string }).id, name: (event.data as { name: string }).name, input: (event.data as { input?: unknown }).input };
    case 'tool_result':
      return {
        type: 'chat:tool_result',
        id: (event.data as { id: string }).id,
        result: (event.data as { result: string }).result,
        error: (event.data as { error?: boolean }).error,
        duration_ms: (event.data as { duration_ms?: number }).duration_ms,
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
      } | undefined;
      if (agentEvent) {
        const { type: agentEventType, sessionId: _sessionId, ...rest } = agentEvent;
        return {
          ...rest,
          type: 'chat:agent_progress',
          agentEventType,
          agentSessionId: _sessionId,
        };
      }
      return null;
    }
    case 'permission_request':
      return { type: 'chat:permission', request: event.data };
    case 'context_usage':
      return { type: 'chat:context_usage', ...(event.data as object) };
    case 'done':
      return { type: 'chat:done' };
    case 'error':
      return { type: 'chat:error', message: event.data as string, code: (event as { code?: string }).code };
    case 'result':
      return { type: 'chat:token_usage', ...(event.data as object) };
    case 'turn_start':
      return { type: 'chat:status', message: `Turn ${(event.data as { turnCount?: number })?.turnCount ?? ''}` };
    case 'skill_review_started':
      return { type: 'chat:skill_review_started', sessionId: (event as { sessionId?: string }).sessionId };
    case 'skill_review_completed':
      return { type: 'chat:skill_review_completed', data: event.data };
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

  // Update title generation model config from chat options
  const titleModelOption = msg.options?.titleGenerationModel;
  const titleModelConfigOption = msg.options?.titleGenerationModelConfig;

  if (titleModelConfigOption) {
    titleGenerationModelConfig = {
      provider: titleModelConfigOption.provider,
      apiKey: titleModelConfigOption.apiKey,
      baseURL: titleModelConfigOption.baseURL,
      model: titleModelConfigOption.model,
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

  if (msg.options?.language && agent?.promptManager?.updateOptions) {
    agent.promptManager.updateOptions({ language: msg.options.language });
  }

  log('[Agent-Process] handleChatStart:', { sessionId: msg.sessionId, promptLength: msg.prompt.length, agentProfileId: msg.options?.agentProfileId || '(none)' });
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
    // Use session system prompt if available, fallback to options.systemPrompt
    const effectiveSystemPrompt = sessionSystemPrompt || msg.options?.systemPrompt;
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
    console.error('[IMAGE-DETAIL] === Image Processing Start ===');
    console.error('[IMAGE-DETAIL] Files count:', files?.length ?? 0);
    console.error('[IMAGE-DETAIL] Files details:', files?.map(f => ({
      name: f.name,
      type: f.type,
      urlPrefix: f.url?.substring(0, 30),
      hasBase64: !!(f as unknown as Record<string, unknown>).base64,
      urlStartsWithData: f.url?.startsWith('data:') ?? false,
    })) ?? 'none');

    const docFiles = (files || []).filter(f => f.path || f.text);
    const imageFiles = (files || []).filter(f => f.type.startsWith('image/') || f.type.startsWith('img/'));
    console.error('[IMAGE-DETAIL] docFiles count:', docFiles.length);
    console.error('[IMAGE-DETAIL] imageFiles count:', imageFiles.length, 'types:', imageFiles.map(f => f.type));

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

    console.error('[DEBUG] Vision config check:', {
      hasAgent: !!agent,
      hasAnalyzeImage: agent ? typeof (agent as Record<string, unknown>).analyzeImage === 'function' : false,
      imageFilesCount: imageFiles.length,
      modelIsMultimodal,
      mainModelName,
    });

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
      console.error('[IMAGE-DETAIL] Processing image file:', file.name, 'url:', file.url?.substring(0, 50), 'type:', file.type);

      if (file.url.startsWith('data:')) {
        base64Data = file.url.split(',')[1] || '';
        console.error('[IMAGE-DETAIL] Extracted from data: URL, length:', base64Data.length);
      } else if ((file as unknown as Record<string, string>).base64) {
        base64Data = (file as unknown as Record<string, string>).base64;
        console.error('[IMAGE-DETAIL] Extracted from base64 field, length:', base64Data.length);
      } else if (file.url && !file.url.startsWith('data:') && !isCDNImageUrl(file.url)) {
        console.error('[IMAGE-DETAIL] Trying to read file from path:', file.url);
        try {
          const imgBuffer = await readFile(file.url);
          console.error('[IMAGE-DETAIL] File read successfully, size:', imgBuffer.length, 'bytes');
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
            console.error('[IMAGE-DETAIL] Image did not need resizing, base64 length:', base64Data.length);
          }
        } catch (readErr) {
          console.error('[IMAGE-DETAIL] FAILED to read file:', readErr);
          markReadFailed(file.name);
        }
      } else {
        console.error('[IMAGE-DETAIL] Skipped - CDN URL or no valid source:', {
          hasUrl: !!file.url,
          isDataUrl: file.url?.startsWith('data:'),
          isCDN: file.url ? isCDNImageUrl(file.url) : 'N/A'
        });
      }

      if (base64Data) {
        imageDataCache.set(file.name, { base64: base64Data, mediaType });
        console.error('[IMAGE-DETAIL] Cached image:', file.name, 'base64 length:', base64Data.length);
      } else {
        console.error('[IMAGE-DETAIL] FAILED to get base64 for:', file.name);
        if (!isCDNImageUrl(file.url)) {
          markReadFailed(file.name);
        }
      }
    }
    console.error('[IMAGE-DETAIL] imageDataCache entries:', imageDataCache.size);
    console.error('[IMAGE-DETAIL] Cache keys:', [...imageDataCache.keys()]);
    console.error('[IMAGE-DETAIL] readFailedFiles:', [...readFailedFiles]);

    // Phase 2: Vision pre-analysis using the configured vision model.
    // Uses the cached base64 data from Phase 1.
    let preAnalysisText = '';
    let visionAnalysisFailed = false;
    let visionAnalysisError: string | null = null;
    const failedVisionFiles = new Set<string>();
    const hasVisionAnalyzer = agent && typeof (agent as Record<string, unknown>).analyzeImage === 'function';
    if (imageFiles.length > 0 && hasVisionAnalyzer) {
      sendI18nStatus('streaming.visionAnalyzingStart');
    }
    if (imageFiles.length > 0 && hasVisionAnalyzer) {
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
    console.error('[IMAGE-DETAIL] Initial prompt length:', msg.prompt?.length ?? 0);
    if (preAnalysisText) {
      effectivePrompt = msg.prompt
        ? `${msg.prompt}\n\n--- Image Analysis (auto-generated) ---${preAnalysisText}`
        : `The user sent an image. Here is a detailed description generated by an AI vision model:\n${preAnalysisText}\n\nPlease help the user based on the image description above.`;
      console.error('[IMAGE-DETAIL] Added preAnalysisText to prompt, length:', preAnalysisText.length);
    } else {
      console.error('[IMAGE-DETAIL] No preAnalysisText (vision analysis not available or failed)');
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

    if (imageFiles.length > 0 && hasVisionAnalyzer) {
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
    console.error('[IMAGE-DETAIL] Phase 3: Building content blocks. modelIsMultimodal:', modelIsMultimodal);
    console.error('[IMAGE-DETAIL] Files to process:', files.map(f => ({ name: f.name, type: f.type })));
    console.error('[IMAGE-DETAIL] Available in cache:', [...imageDataCache.keys()]);

      for (const file of files) {
        if (file.type.startsWith('image/') || file.type.startsWith('img/')) {
          const cached = imageDataCache.get(file.name);
          console.error('[IMAGE-DETAIL] Processing file:', file.name, 'cached:', !!cached, 'modelMultimodal:', modelIsMultimodal);

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
    console.error('[IMAGE-DETAIL] Final imageBlocks count:', imageBlocks.length);

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
      console.error('[IMAGE-DETAIL] Final messageContent:', {
        isArray: Array.isArray(messageContent),
        blockCount: Array.isArray(messageContent) ? messageContent.length : 0,
        textBlockCount: contentBlocks.length,
        imageBlockCount: imageBlocks.length,
      });
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
    // see these images as content blocks. buildAttachmentContext includes
    // image files and generates a brief text reference ("This image file
    // is attached in this message") so the LLM knows they exist.
    //
    // For non-multimodal models, image content blocks are intentionally
    // omitted — pre-analysis text from the vision model (if configured)
    // is the sole image context.
    // Pre-analysis text from the vision model (if configured) is still
    // prepended to the prompt so the LLM has a text description.
    //
    // vision_analyze tool remains registered so the LLM can request
    // re-analysis of previously analyzed or newly referenced images.

    // Assemble attachment context before passing to streamChat so LLM clients
    // receive fully assembled messages without needing attachment awareness
    const attachmentCtx = buildAttachmentContext(files || []);
    if (attachmentCtx) {
      if (typeof messageContent === 'string') {
        messageContent = attachmentCtx + '\n' + messageContent;
      } else {
        const firstTextIdx = messageContent.findIndex(
          (b: unknown) => (b as Record<string, unknown>).type === 'text'
        );
        if (firstTextIdx >= 0) {
          const block = messageContent[firstTextIdx] as unknown as Record<string, string>;
          block.text = attachmentCtx + '\n' + (block.text || '');
        } else {
          messageContent = [
            { type: 'text' as const, text: attachmentCtx },
            ...messageContent,
          ];
        }
      }
    }

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

    const eventGen = agent.streamChat(messageContent, {
      systemPrompt: effectiveSystemPrompt,
      requestPermission,
      agentProfileId: msg.options?.agentProfileId,
      outputStyleConfig: msg.options?.outputStyleConfig,
      mode: msg.options?.mode,
      attachments: files,
      displayContent: msg.prompt, // Store original prompt without synthetic pre-analysis/attachment context
    });

    log('[Agent-Process] streamChat started, agentProfileId:', msg.options?.agentProfileId || '(none)', 'iterating events...');
    let tokenUsage: { input_tokens: number; output_tokens: number; total_tokens?: number } | null = null;
    let eventCount = 0;
    const incrementalSaveQueue = new IncrementalSaveQueue(msg.sessionId);
    let lastIncrementalSave = Date.now();
    const INCREMENTAL_SAVE_INTERVAL = 5000; // Save every 5 seconds during streaming

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

      // Incremental persistence: save messages periodically during streaming
      // Use IncrementalSaveQueue to serialize saves and prevent race conditions
      if (Date.now() - lastIncrementalSave > INCREMENTAL_SAVE_INTERVAL) {
        lastIncrementalSave = Date.now();
        const currentMessages = agent.getMessages();
        const newMessages = currentMessages.slice(existingMessageCount);
        if (newMessages.length > 0) {
          incrementalSaveQueue.trigger(newMessages).then(result => {
            debugLog('incremental save', { success: result.success, messageCount: newMessages.length });
            if (result.success) {
              // Only update existingMessageCount when tool_result messages are present.
              // A tool_result represents a completed tool round. Streaming text
              // (assistant role) is never counted here — final update happens at chat:done.
              const hasToolResult = newMessages.some(
                (m: Message) => m.role === 'tool' || findToolResultBlocks(m)
              );
              if (hasToolResult) {
                const lastToolResultIdx = findLastToolResultIndex(newMessages);
                const completedCount = lastToolResultIdx + 1;
                existingMessageCount = existingMessageCount + completedCount;
              }
            }
          }).catch(err => {
            debugLog('incremental save failed', { error: err instanceof Error ? err.message : String(err) });
          });
        }
      }

      if (event.type === 'result' && event.data) {
        tokenUsage = event.data as { input_tokens: number; output_tokens: number; total_tokens?: number };
      }
      const agentMsg = convertSSEToAgentMessage(event);
      if (agentMsg) {
        if (agentMsg.type === 'chat:done') {
          // Defer chat:done until after persistence completes
          // to avoid race condition where SSE closes before messages are saved
          continue;
        }
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

    const agentMessages = agent.getMessages();
    // Mark incremental queue as flushed and wait for any pending saves to complete
    incrementalSaveQueue.markFlushed();
    await incrementalSaveQueue.flush();
    if (agentMessages.length > 0) {
      if (tokenUsage) {
        const lastAssistant = [...agentMessages].reverse().find(m => m.role === 'assistant');
        if (lastAssistant) {
          (lastAssistant as Record<string, unknown>).token_usage = tokenUsage;
        }
      }
      try {
        const newMessages = agentMessages.slice(existingMessageCount);
        log(`[Agent-Process] Appending ${newMessages.length} new messages to DB for session ${msg.sessionId} (${agentMessages.length} total)`);
        const result = await appendMessages(msg.sessionId, newMessages);
        log(`[Agent-Process] DB persist result: success=${result.success}, count=${result.count}`);

        // Store parsed document content to DB for rehydration on restart.
        // Each user message with attachments gets its document text stored separately.
        for (const msgItem of newMessages) {
          if (msgItem.role === 'user' && msgItem.attachments && msgItem.attachments.length > 0) {
            // Guard: skip if message has no id (shouldn't happen but be safe)
            if (!msgItem.id) {
              warn('[Agent-Process] storeParsedDocumentAttachment: user message has no id, skipping');
              continue;
            }
            const userMsgId = msgItem.id;
            for (const att of msgItem.attachments) {
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

        sendToMain({ type: 'chat:db_persisted', sessionId: msg.sessionId, success: result.success, messageCount: agentMessages.length });

        // Update existingMessageCount to reflect the newly persisted messages.
        // This ensures subsequent chats correctly calculate the delta for incremental saves.
        existingMessageCount = agentMessages.length;
        log(`[Agent-Process] Updated existingMessageCount to ${existingMessageCount}`);

        // Send chat:done AFTER persistence completes to ensure messages are saved
        // before the SSE stream closes (router.ts starts 2s timeout on done event)
        sendToMain({
          type: 'chat:done',
          sessionId: msg.sessionId,
          turnId: msg.id,
          finalContent: extractFinalAssistantText(agentMessages),
          conversationText: summarizeConversationForWiki(agentMessages),
        });
      } catch (err) {
        log('[Agent-Process] appendMessages error:', err);
        sendToMain({
          type: 'chat:done',
          sessionId: msg.sessionId,
          turnId: msg.id,
          finalContent: extractFinalAssistantText(agentMessages),
          conversationText: summarizeConversationForWiki(agentMessages),
          error: err instanceof Error ? err.message : String(err),
        });
        sendToMain({ type: 'chat:db_persisted', sessionId: msg.sessionId, success: false, reason: err instanceof Error ? err.message : String(err) });
      }
    } else {
      warn(`[Agent-Process] No messages to save for session ${msg.sessionId}`);
      sendToMain({
        type: 'chat:done',
        sessionId: msg.sessionId,
        turnId: msg.id,
        finalContent: '',
        conversationText: '',
      });
    }

    // Background title generation: generate if never generated before (no message limit)
    const hasGeneratedTitle = titleGeneratedBySession.has(msg.sessionId);
    // Count user messages to determine conversation rounds (not total messages)
    const userMessageCount = agentMessages.filter((m: Message) => m.role === 'user').length;
    const assistantMessageCount = agentMessages.filter((m: Message) => m.role === 'assistant').length;
    // Only generate if: (1) never generated before, AND (2) at least 1 complete round (1 user + 1 assistant)
    const shouldGenerate = !hasGeneratedTitle && userMessageCount >= 1 && assistantMessageCount >= 1;

    log(`[Agent-Process] Title generation check: hasGenerated=${hasGeneratedTitle}, userMsg=${userMessageCount}, assistantMsg=${assistantMessageCount}, shouldGenerate=${shouldGenerate}`);
    log(`[Agent-Process] Title generation config: ${titleGenerationModelConfig ? JSON.stringify({provider: titleGenerationModelConfig.provider, model: titleGenerationModelConfig.model}) : 'null'}`);
    log(`[Agent-Process] Agent LLM client available: ${!!agent.llmClient}`);
    if (agent.llmClient) {
      log(`[Agent-Process] Agent LLM config: provider=${agent.provider}, model=${agent.model}, baseURL=${agent.baseURL}`);
    }

    log(`[Agent-Process] Title generation model config: ${JSON.stringify(titleGenerationModelConfig)}`);

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
                const { createLLMClient } = await import('../llm/index.js');
                titleLLMClient = createLLMClient(
                  titleGenerationModelConfig.provider as 'anthropic' | 'openai' | 'ollama',
                  {
                    apiKey: titleGenerationModelConfig.apiKey,
                    baseURL: titleGenerationModelConfig.baseURL,
                    model: titleGenerationModelConfig.model,
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
    }
    sendToMain({
      type: 'chat:error',
      sessionId: msg.sessionId,
      message: errMsg,
      code,
    });
    // Ensure the SSE stream closes even on error
    sendToMain({ type: 'chat:done', sessionId: msg.sessionId });
  } finally {
    stopChatHeartbeat();
  }
}

// ============================================================================
// Conductor Agent Handlers
// ============================================================================

async function handleConductorInit(msg: ConductorInitMessage): Promise<void> {
  setConductorCanvasState(msg.snapshot);

  const promptManager = getDefaultPromptManager();
  if (msg.workingDirectory) {
    promptManager.setWorkingDirectory(msg.workingDirectory);
  }
  if (msg.language) {
    promptManager.updateOptions({ language: msg.language });
  }

  conductorAgent = new duyaAgent({
    apiKey: msg.providerConfig.apiKey,
    baseURL: msg.providerConfig.baseURL || '',
    model: msg.providerConfig.model,
    provider: msg.providerConfig.provider,
    authStyle: msg.providerConfig.authStyle,
    sessionId: msg.sessionId,
    workingDirectory: msg.workingDirectory,
    promptManager,
  });

  log('[Agent-Process] Conductor duyaAgent initialized for session:', msg.sessionId);
}

async function handleConductorStart(msg: ConductorStartMessage): Promise<void> {
  if (!conductorAgent) {
    sendToMain({ type: 'conductor:error', sessionId: msg.sessionId, message: 'Conductor agent not initialized' });
    return;
  }

  if (msg.language) {
    (conductorAgent as unknown as { promptManager?: { updateOptions: (options: { language?: string }) => void } })
      .promptManager?.updateOptions({ language: msg.language });
  }

  // Update canvas state snapshot for every message (not just init)
  if (msg.snapshot) {
    setConductorCanvasState(msg.snapshot);
  }

  log('[Agent-Process] handleConductorStart:', { sessionId: msg.sessionId, promptLength: msg.prompt.length });

  try {
    log('[Agent-Process] handleConductorStart: starting...');

    startChatHeartbeat();
    sendToMain({ type: 'conductor:status', sessionId: msg.sessionId, status: 'streaming' });

    log('[Agent-Process] handleConductorStart: calling streamChat...');
    log('[Agent-Process] handleConductorStart: conductorAgent exists:', !!conductorAgent);
    log('[Agent-Process] handleConductorStart: conductorAgent type:', typeof conductorAgent);
    log('[Agent-Process] handleConductorStart: prompt length:', msg.prompt.length);

    let stream;
    try {
      stream = conductorAgent.streamChat(msg.prompt, {
        agentProfileId: 'conductor',
        conductorIpc: {
          sendToMain,
          ipcRequest: conductorIpcRequest,
        },
      });
      log('[Agent-Process] streamChat generator created successfully');
    } catch (err) {
      log('[Agent-Process] streamChat creation FAILED:', err);
      sendToMain({
        type: 'conductor:error',
        sessionId: msg.sessionId,
        message: `streamChat creation failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      stopChatHeartbeat();
      return;
    }

    let eventCount = 0;
    let streamStarted = false;
    for await (const event of stream) {
      if (!streamStarted) {
        log('[Agent-Process] First event received from stream!');
        streamStarted = true;
      }
      eventCount++;
      if (event.type === 'text' || event.type === 'thinking') {
        log(`[Agent-Process] Event ${eventCount}: ${event.type}, len=${String((event as {data: string}).data).length}`);
      } else {
        log(`[Agent-Process] Event ${eventCount}: ${event.type}`);
      }

      switch (event.type) {
        case 'text':
          sendToMain({
            type: 'conductor:text',
            sessionId: msg.sessionId,
            content: (event as { type: 'text'; data: string }).data,
          });
          break;

        case 'thinking':
          sendToMain({
            type: 'conductor:thinking',
            sessionId: msg.sessionId,
            content: (event as { type: 'thinking'; data: string }).data,
          });
          break;

        case 'tool_use':
          sendToMain({
            type: 'conductor:tool_use',
            sessionId: msg.sessionId,
            id: (event as { type: 'tool_use'; data: { id: string } }).data.id,
            name: (event as { type: 'tool_use'; data: { name: string } }).data.name,
            input: (event as { type: 'tool_use'; data: { input: Record<string, unknown> } }).data.input,
          });
          break;

        case 'tool_result': {
          const trData = (event as { type: 'tool_result'; data: { id: string; result: string; duration_ms?: number } }).data;
          sendToMain({
            type: 'conductor:tool_result',
            sessionId: msg.sessionId,
            id: trData.id,
            result: trData.result,
            duration_ms: trData.duration_ms,
          });
          break;
        }

        case 'done':
          sendToMain({
            type: 'conductor:done',
            sessionId: msg.sessionId,
          });

          // Flush perception events and send as context update for next turn
          const { getPerceptionEngine } = await import('../conductor/PerceptionEngine.js');
          const perceptionContext = getPerceptionEngine().formatEventsAsContext();
          if (perceptionContext) {
            sendToMain({
              type: 'conductor:perception_context',
              sessionId: msg.sessionId,
              context: perceptionContext,
            });
            getPerceptionEngine().drainEvents();
          }
          break;

        case 'error':
          sendToMain({
            type: 'conductor:error',
            sessionId: msg.sessionId,
            message: (event as { type: 'error'; data: string }).data || 'Unknown error',
          });
          break;
      }
    }
    log(`[Agent-Process] Stream completed, total events: ${eventCount}`);
  } catch (err) {
    log('[Agent-Process] Conductor error:', err);
    sendToMain({
      type: 'conductor:error',
      sessionId: msg.sessionId,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    stopChatHeartbeat();
    conductorInProgress = false;
    sendToMain({ type: 'conductor:status', sessionId: msg.sessionId, status: 'idle' });
  }
}

async function drainQueuedChatStart(): Promise<void> {
  while (!chatInProgress) {
    const next = dequeue<ChatStartMessage>(
      (cmd: QueuedCommand<ChatStartMessage>) => cmd.agentId === undefined && cmd.mode === 'prompt'
    );
    if (!next) break;

    log('[Agent-Process] Draining queued chat:start from priority queue');
    chatInProgress = true;
    handleChatStart(next.rawMessage).finally(() => {
      chatInProgress = false;
      drainQueuedChatStart();
    });
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
    const getSkillRegistry = (await import('../index.js')).getSkillRegistry;
    const registry = getSkillRegistry();
    // Clear existing non-bundled skills
    const allSkills = registry.list();
    for (const skill of allSkills) {
      if (skill.source !== 'bundled') {
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
  };
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
    // Phase 2A diagnostic chain: emit a richer `mcp:reloaded`
    // event so main / settings UI can surface the active server
    // keys + tool keys + issue counts without polling. The full
    // `MCPHealthReport`-shaped payload arrives on demand via
    // `mcp:status:get` (handled in the worker protocol switch
    // below).
    sendToMain(buildMcpReloadedEvent(result));
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
  log('[Agent-Process] Received command:', msgType, 'sessionId:', (msg as Record<string, unknown>).sessionId);

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
          sessionId = initMsg.sessionId;
          existingMessageCount = 0;
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
            const waitForInit = setInterval(() => {
              if (!initializing) {
                clearInterval(waitForInit);
                sendToMain({ type: 'ready', sessionId });
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
          try {
            await initAgent(initMsg.providerConfig, initMsg.workingDirectory, initMsg.defaultWorkspaceDirectory, initMsg.systemPrompt, initMsg.blockedDomains, initMsg.language, initMsg.sandboxEnabled, initMsg.communicationPlatform);

            try {
              // Parallel: skills loading (disk I/O) + DB message loading (IPC)
              // Skills errors are handled inside loadAgentSkills; DB errors caught below
              currentSecurityScanEnabled = initMsg.securityScanEnabled !== false;
              const [_, loadedData] = await Promise.all([
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

                // Validate and clean up incomplete tool_use/tool_result pairs
                existingMessages = validateMessageHistory(existingMessages);

                agent.setMessages(existingMessages);
                existingMessageCount = existingMessages.length;
                log(`[Agent-Process] Loaded ${existingMessages.length} messages from DB for session ${sessionId}`);
                debugLog('loaded message roles', existingMessages.map(m => ({ role: m.role, type: m.msg_type || (Array.isArray(m.content) ? m.content.map((c: { type: string }) => c.type).join(',') : 'string') })));
              } else {
                log(`[Agent-Process] No existing messages found in DB for session ${sessionId}`);
              }
            } catch (err) {
              warn('[Agent-Process] Failed to load messages from DB:', err);
            }
          } finally {
            initializing = false;
            await drainQueuedChatStart();
          }

          sendToMain({ type: 'ready', sessionId });

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
              const result = await applyMCPConfiguration({
                agent,
                reason: 'initialization',
              });
              log(
                `[Agent-Process] Initialized MCP servers: ${result.action.clientsConnected} connected, ` +
                `${result.action.toolsAdded} tools, ${result.action.toolsRemoved} removed ` +
                `(${result.loadResult.inventory.length} inventory rows, ${result.loadResult.issues.length} issues)`,
              );
            } catch (mcpErr) {
              warn('[Agent-Process] Failed to initialize MCP servers after ready:', mcpErr);
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
          handleChatStart(chatMsg).finally(() => {
            chatInProgress = false;
            drainQueuedChatStart();
          });
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
            // First press while idle with queued messages: pop the front of the queue
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
          try {
            const result = await agent.compact();
            log('[Agent-Process] Compaction complete:', result);
            const currentMessages = agent.getMessages();
            // After compaction, agent holds a reduced/summarized set.
            // Append all current messages; INSERT OR IGNORE handles dedup
            // for messages already in DB. Update existingMessageCount.
            await appendMessages(sessionId!, currentMessages);
            existingMessageCount = currentMessages.length;
            log(`[Agent-Process] Compaction: appended messages, new count=${existingMessageCount}`);
            sendToMain({ type: 'compact:done', sessionId, result });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log('[Agent-Process] Compaction failed:', errorMessage);
            sendToMain({ type: 'compact:error', sessionId, message: errorMessage });
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

        case 'mcp:status:get': {
          // Diagnostic chain command: main / settings UI queries
          // the active MCP runtime on demand. The full snapshot
          // (inventory + issues + active keys) goes out as a
          // single `mcp:status:snapshot` event.
          sendToMain(buildMcpStatusSnapshot());
          break;
        }

        case 'conductor:init': {
          const conductorInitMsg = msg as unknown as ConductorInitMessage;
          conductorSessionId = conductorInitMsg.sessionId;
          log('[Agent-Process] Received conductor:init for session:', conductorSessionId);
          if (conductorAgent) {
            log('[Agent-Process] Conductor agent already initialized, skipping re-init');
            // Use IPC channel for conductor:ready so AgentProcessPool can receive it
            process.send?.({ type: 'conductor:ready', sessionId: conductorSessionId });
            break;
          }
          if (conductorInitializing) {
            log('[Agent-Process] Conductor init in progress, waiting...');
            const waitForInit = setInterval(() => {
              if (conductorAgent) {
                clearInterval(waitForInit);
                process.send?.({ type: 'conductor:ready', sessionId: conductorSessionId });
              }
            }, 50);
            break;
          }
          conductorInitializing = true;
          try {
            await handleConductorInit(conductorInitMsg);
          } finally {
            conductorInitializing = false;
          }
          // Use IPC channel for conductor:ready so AgentProcessPool can receive it
          process.send?.({ type: 'conductor:ready', sessionId: conductorSessionId });
          break;
        }

        case 'conductor:agent:start': {
          const conductorStartMsg = msg as unknown as ConductorStartMessage;
          log('[Agent-Process] Received conductor:agent:start for session:', conductorStartMsg.sessionId);
          if (conductorInProgress) {
            log('[Agent-Process] Conductor already in progress, ignoring duplicate');
            break;
          }
          if (conductorInitializing) {
            log('[Agent-Process] Conductor still initializing, ignoring');
            break;
          }
          conductorInProgress = true;
          try {
            await handleConductorStart(conductorStartMsg);
          } finally {
            conductorInProgress = false;
          }
          break;
        }

        case 'conductor:interrupt': {
          log('[Agent-Process] Received conductor:interrupt');
          if (conductorAgent) {
            conductorAgent.interrupt();
          }
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

        case 'research:clarification:resolve': {
          const { requestId, answers } = msg as unknown as { requestId: string; answers: Record<string, string> };
          const mode = agent?._activeMode;
          let resolved = false;
          if (mode && typeof mode.resolveClarification === 'function') {
            resolved = mode.resolveClarification(requestId, answers);
          }
          if (!resolved) {
            const { resolveResearchClarificationRequest } = await import('../modes/research-mode/index.js');
            resolved = resolveResearchClarificationRequest(requestId, answers);
          }
          if (!resolved) {
            warn('[Agent-Process] Research clarification resolution failed: no pending request found', requestId);
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

// Handle uncaught errors to avoid zombie processes
process.on('uncaughtException', (err) => {
  log('[Agent-Process] Uncaught exception:', err);
  exitAfterCleanup(1);
});

process.on('unhandledRejection', (reason) => {
  log('[Agent-Process] Unhandled rejection:', reason);
});

// Start the main loop
void main();
