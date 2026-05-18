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
import { appendMessages, storeParsedDocumentAttachment, getParsedDocumentAttachmentsForSession } from '../session/db.js';
import { buildAttachmentContext } from '../llm/attachment-context.js';
import type { MessageRow, AttachmentRow, ParsedDocumentAttachment } from '../session/db.js';
import { getAttachmentsForSession, rehydrateContentWithAttachments } from '../session/db.js';
import type { Message, MessageContent } from '../types.js';
import { messageDb } from '../ipc/db-client.js';
import { IncrementalSaveQueue } from './incremental-save-queue.js';
import { generateSessionTitle } from '../session/title-generator.js';
import { getDefaultPromptManager } from '../prompts/PromptManager.js';
import type { PromptProfile } from '../prompts/modes/types.js';
import type { ConductorSnapshot } from '../conductor/ConductorProfile.js';
import { setConductorCanvasState } from '../prompts/sections/dynamic/conductorCanvas.js';
import { duyaAgent } from '../index.js';
import { sendEvent, parseStdin } from './worker-protocol.js';
import { storePendingAnswer } from '../tool/AskUserQuestionTool/AskUserQuestionTool.js';

// CDN domains that should not be used as inline images
const CDN_IMAGE_PATTERNS = [
  /https?:\/\/[^\s]*\.oss-cn-[a-z0-9-]+\.aliyuncs\.com[^\s]*/i,
  /https?:\/\/[^\s]*\.minimax\.io[^\s]*/i,
  /https?:\/\/[^\s]*\.minimaxi\.com[^\s]*/i,
  /https?:\/\/[^/]*\.alicdn\.com[^\s]*/i,
  /https?:\/\/[^/]*\.aliyuncs\.com[^\s]*/i,
];

function isCDNImageUrl(url: string): boolean {
  return CDN_IMAGE_PATTERNS.some(pattern => pattern.test(url));
}

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
  };
  workingDirectory?: string;
  systemPrompt?: string;
  skillPaths?: string[];
  communicationPlatform?: string;
  blockedDomains?: string[];
  language?: string;
  sandboxEnabled?: boolean;
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
}

interface ConductorStartMessage {
  type: 'conductor:agent:start';
  sessionId: string;
  prompt: string;
  snapshot?: ConductorSnapshot;
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
    permissionMode?: string;
    files?: FileAttachment[];
    agentProfileId?: string | null;
    outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean };
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
let pendingChatQueue: ChatStartMessage[] = [];
let sessionSystemPrompt: string | undefined = undefined;
let existingMessageCount = 0;
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

// Pending permission requests registry (id -> resolve function)
// Architecture: permission requests are sent to Main -> Renderer, resolved async
const pendingPermissions = new Map<string, {
  resolve: (decision: 'allow' | 'deny') => void;
  reject: (error: Error) => void;
}>();

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

// ============================================================================
// Agent Initialization
// ============================================================================

async function initAgent(config: InitMessage['providerConfig'], workDir?: string, sysPrompt?: string, skillPaths?: string[], blockedDomains?: string[], language?: string, sandboxEnabled?: boolean, communicationPlatform?: string): Promise<void> {
  // Dynamic import - .js extension required for NodeNext moduleResolution
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentModule = await import('../index.js') as any;
  // duyaAgent is exported as 'default' in index.js, not a named export
  const duyaAgent = agentModule.default;
  const loadSkills = agentModule.loadSkills;
  const getSkillRegistry = agentModule.getSkillRegistry;
  const setSandboxEnabled = agentModule.setSandboxEnabled as ((enabled: boolean) => void) | undefined;
  const buildSandboxImage = agentModule.buildSandboxImage as ((onProgress?: (msg: string) => void) => Promise<boolean>) | undefined;

  // Store system prompt for use in chat
  sessionSystemPrompt = sysPrompt;

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

  // Load skills - always sync bundled skills, then load from user directory
  // workDir is used for project-level skills and as fallback for cwd
  try {
    const loadOptions: { additionalPaths?: string[]; syncBundled?: boolean; securityBypassSkills?: string[] } = {
      syncBundled: true,
    };
    if (skillPaths?.length) {
      loadOptions.additionalPaths = skillPaths;
    }
    // Read security bypass list from environment variable
    const bypassSkillsEnv = process.env.DUYA_SECURITY_BYPASS_SKILLS;
    if (bypassSkillsEnv) {
      loadOptions.securityBypassSkills = bypassSkillsEnv.split(',').map(s => s.trim()).filter(Boolean);
    }
    // Use workDir if provided, otherwise use process.cwd()
    const skillsCwd = workDir || process.cwd();
    await loadSkills(skillsCwd, loadOptions);
    const skills = getSkillRegistry().list();
    log(`[Agent-Process] Loaded ${skills.length} skills`);
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

  log('[Agent-Process] Agent initialized');
}

// ============================================================================
// Message Handling
// ============================================================================

// Send events via stdout JSON lines (worker-protocol.ts)
function sendToMain(msg: Record<string, unknown>): void {
  sendEvent({ ...msg, _logger: 'agent-process' });
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
      return { type: 'chat:tool_result', id: (event.data as { id: string }).id, result: (event.data as { result: string }).result, error: (event.data as { error?: boolean }).error };
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
      return { type: 'chat:error', message: event.data as string };
    case 'result':
      return { type: 'chat:token_usage', ...(event.data as object) };
    case 'turn_start':
      return { type: 'chat:status', message: `Turn ${(event.data as { turnCount?: number })?.turnCount ?? ''}` };
    case 'skill_review_started':
      return { type: 'chat:skill_review_started', sessionId: (event as { sessionId?: string }).sessionId };
    case 'skill_review_completed':
      return { type: 'chat:skill_review_completed', data: event.data };
    case 'system': {
      // Handle retry events from the retry mechanism
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
    default:
      warn('[Agent-Process] Unknown SSE event type:', event.type);
      return null;
  }
}

// Create permission handler for streaming
function createPermissionHandler(sessId: string): (request: { id: string; toolName: string; toolInput: Record<string, unknown>; expiresAt: number }) => Promise<'allow' | 'deny'> {
  return (request) => {
    return new Promise<'allow' | 'deny'>((resolve, reject) => {
      // Store the pending permission with its resolve/reject
      pendingPermissions.set(request.id, { resolve, reject });

      // Send permission request to main, wait for response
      sendToMain({
        type: 'chat:permission',
        sessionId: sessId,
        request: {
          id: request.id,
          toolName: request.toolName,
          toolInput: request.toolInput,
        },
      });

      // Timeout - default to deny after 5 minutes
      setTimeout(() => {
        if (pendingPermissions.has(request.id)) {
          pendingPermissions.delete(request.id);
          resolve('deny');
        }
      }, 300000);
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

  log('[Agent-Process] handleChatStart:', { sessionId: msg.sessionId, promptLength: msg.prompt.length });
  if (agent) {
    log('[Agent-Process] Agent LLM config:', {
      model: agent.model,
      provider: agent.provider,
      baseURL: agent.baseURL,
    });
  }
  debugLog('chat:start received', {
    sessionId: msg.sessionId,
    hasOptionsMessages: Array.isArray(msg.options?.messages),
    optionsMessageCount: Array.isArray(msg.options?.messages) ? msg.options?.messages.length : 0,
    hasFiles: Array.isArray(msg.options?.files) && msg.options.files.length > 0,
  });

  try {
    startChatHeartbeat();
    const requestPermission = createPermissionHandler(msg.sessionId);
    // Use session system prompt if available, fallback to options.systemPrompt
    const effectiveSystemPrompt = sessionSystemPrompt || msg.options?.systemPrompt;
    // Apply permission mode from chat start options if provided
    const permissionMode = msg.options?.permissionMode;
    if (permissionMode) {
      agent.setPermissionMode(permissionMode);
    }

    // Build document context from inline file attachments.
    // Document files (pdf, docx, etc.) carry their parsed text and imageChunks
    // directly on the FileAttachment objects (path, text, extractMethod, imageChunks).
    const files = msg.options?.files;
    console.error('[DEBUG] first file text length:', msg.options?.files?.[0]?.text?.length);
    console.error('[DEBUG] docFiles count:', (msg.options?.files || []).filter((f: FileAttachment) => f.path || f.text).length);
    const docFiles = (files || []).filter(f => f.path || f.text);
    let messageContent: string | MessageContent[] = msg.prompt;

    // Collect image file paths for vision tool notification
    const imageFilePaths: string[] = [];
    const imagesNeedingVision: Array<{ path: string; name: string }> = [];

    if (files && files.length > 0) {
      const contentBlocks: MessageContent[] = [
        { type: 'text', text: msg.prompt }
      ];
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          // Check if we have base64 data or data URL
          if (file.url.startsWith('data:')) {
            // Legacy: data URL with base64
            const base64Data = file.url.split(',')[1];
            const mediaType = file.type;
            contentBlocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Data,
              },
            });
          } else if (file.base64) {
            // Legacy: explicit base64 field
            contentBlocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: file.type,
                data: file.base64,
              },
            });
          } else if (file.url && !file.url.startsWith('data:')) {
            // File path - check if it's a CDN/external URL (not supported as image)
            if (isCDNImageUrl(file.url)) {
              warn('[Agent-Process] Image file has CDN URL (not supported as image):', file.name);
              // Add path notification so LLM knows about the image
              imageFilePaths.push(file.url);
              imagesNeedingVision.push({ path: file.url, name: file.name });
            } else {
              // Local file path - track for vision tool notification
              imageFilePaths.push(file.url);
              imagesNeedingVision.push({ path: file.url, name: file.name });
            }
          } else {
            warn('[Agent-Process] Image file has no URL or base64 data:', file.name);
          }
        }
      }
      // Also add document-extracted images (e.g. scanned PDF with embedded images)
      for (const doc of docFiles) {
        if (doc.imageChunks) {
          for (const img of doc.imageChunks) {
            contentBlocks.push({
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
      messageContent = contentBlocks;
    } else if (docFiles.some(d => d.imageChunks?.length)) {
      // No direct file attachments, but parsed documents contain extracted images
      const contentBlocks: MessageContent[] = [
        { type: 'text', text: msg.prompt }
      ];
      for (const doc of docFiles) {
        if (doc.imageChunks) {
          for (const img of doc.imageChunks) {
            contentBlocks.push({
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
      messageContent = contentBlocks;
    }

    // Add vision tool notification for image files without base64
    if (imagesNeedingVision.length > 0) {
      const visionNote = imagesNeedingVision.map(img =>
        `[Image file: ${img.name}]\nPath: ${img.path}`
      ).join('\n\n');
      const toolNote = '\n\n---\nYou can use the vision_analyze tool to examine these images. Example: vision_analyze({image_path: "/path/to/image.png"})';

      if (typeof messageContent === 'string') {
        messageContent += '\n\n' + visionNote + toolNote;
      } else {
        // Append to text block
        const textBlock = messageContent.find(b => b.type === 'text');
        if (textBlock) {
          (textBlock as { text: string }).text += '\n\n' + visionNote + toolNote;
        } else {
          messageContent.push({ type: 'text', text: visionNote + toolNote });
        }
      }
      log('[Agent-Process] Added vision tool notification for', imagesNeedingVision.length, 'image files');
    }

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

    const eventGen = agent.streamChat(messageContent, {
      systemPrompt: effectiveSystemPrompt,
      requestPermission,
      agentProfileId: msg.options?.agentProfileId,
      outputStyleConfig: msg.options?.outputStyleConfig,
      attachments: files,
    });

    log('[Agent-Process] streamChat started, iterating events...');
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
      } catch (err) {
        log('[Agent-Process] appendMessages error:', err);
        sendToMain({ type: 'chat:db_persisted', sessionId: msg.sessionId, success: false, reason: err instanceof Error ? err.message : String(err) });
      }
    } else {
      warn(`[Agent-Process] No messages to save for session ${msg.sessionId}`);
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

    // Note: 'chat:done' is already sent inside the for-await loop above
    // when the stream generator yields { type: 'done' }.
    // Do NOT send another 'chat:done' here to avoid duplicate final messages.

  } catch (err) {
    log('[Agent-Process] Chat error:', err);
    sendToMain({
      type: 'chat:error',
      sessionId: msg.sessionId,
      message: err instanceof Error ? err.message : String(err),
    });
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

  // Update canvas state snapshot for every message (not just init)
  if (msg.snapshot) {
    setConductorCanvasState(msg.snapshot);
  }

  log('[Agent-Process] handleConductorStart:', { sessionId: msg.sessionId, promptLength: msg.prompt.length });

  try {
    startChatHeartbeat();
    sendToMain({ type: 'conductor:status', sessionId: msg.sessionId, status: 'streaming' });

    log('[Agent-Process] Starting conductor streamChat with profile: conductor');
    const stream = conductorAgent.streamChat(msg.prompt, {
      agentProfileId: 'conductor',
      conductorIpc: {
        sendToMain,
        ipcRequest: conductorIpcRequest,
      },
    });
    log('[Agent-Process] streamChat generator created, iterating...');

    let eventCount = 0;
    for await (const event of stream) {
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

        case 'tool_result':
          sendToMain({
            type: 'conductor:tool_result',
            sessionId: msg.sessionId,
            id: (event as { type: 'tool_result'; data: { id: string } }).data.id,
            result: (event as { type: 'tool_result'; data: { result: string } }).data.result,
          });
          break;

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

// stderr wrapper to prevent stdout pollution of JSON-RPC protocol
// Use console.error/console.warn directly since log/warn aren't defined yet
const log = (...args: unknown[]): void => { console.error('[Agent-Process]', ...args); };
const warn = (...args: unknown[]): void => { console.warn('[Agent-Process]', ...args); };

// ============================================================================
// Main Message Loop (stdin/stdout JSON-RPC)
// ============================================================================

async function main(): Promise<void> {
  log('Process started, session:', process.env.SESSION_ID);
  log('cwd:', process.cwd());

  try {
    for await (const msg of parseStdin()) {
      const msgType = msg.type as string;
      log('[Agent-Process] Received command from stdin:', msgType, 'sessionId:', (msg as Record<string, unknown>).sessionId);

      switch (msgType) {
        case 'init': {
          const initMsg = msg as unknown as InitMessage;
          log('[Agent-Process] Received init for session:', initMsg.sessionId);
          // Guard: reject re-init while chat is in progress to prevent mid-flight agent destruction
          if (chatInProgress) {
            log('[Agent-Process] Rejecting init: chat in progress, cannot reinit now');
            sendEvent({ type: 'ready', sessionId: initMsg.sessionId, status: 'deferred', reason: 'chat_in_progress' });
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
                sendEvent({ type: 'ready', sessionId });
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
            await initAgent(initMsg.providerConfig, initMsg.workingDirectory, initMsg.systemPrompt, initMsg.skillPaths, initMsg.blockedDomains, initMsg.language, initMsg.sandboxEnabled, initMsg.communicationPlatform);

            try {
              const existingRows = await messageDb.getBySession(sessionId!) as MessageRow[];
              debugLog('loaded history rows', { sessionId, rows: existingRows.length });
              if (existingRows.length > 0) {
                // Load attachments for CDN URL rehydration
                let attachmentMap: Map<string, AttachmentRow[]> | undefined;
                try {
                  attachmentMap = getAttachmentsForSession(sessionId!);
                } catch {
                  // attachmentMap stays undefined, messages load without rehydration
                }
                // Load parsed document attachments for restoring doc text on restart
                let parsedDocMap: Map<string, ParsedDocumentAttachment[]> | undefined;
                try {
                  const parsedDocs = getParsedDocumentAttachmentsForSession(sessionId!);
                  parsedDocMap = new Map<string, ParsedDocumentAttachment[]>();
                  for (const doc of parsedDocs) {
                    const existing = parsedDocMap.get(doc.message_id) || [];
                    existing.push(doc);
                    parsedDocMap.set(doc.message_id, existing);
                  }
                } catch {
                  // parsedDocMap stays undefined, messages load without doc text
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
            // Process any chat:start messages that were queued during init
            if (pendingChatQueue.length > 0 && !chatInProgress) {
              const next = pendingChatQueue.shift()!;
              log('[Agent-Process] Processing queued chat:start after init');
              chatInProgress = true;
              try {
                await handleChatStart(next);
              } finally {
                chatInProgress = false;
              }
            }
          }

          sendEvent({ type: 'ready', sessionId });
          break;
        }

        case 'chat:start': {
          const chatMsg = msg as unknown as ChatStartMessage;
          log('[Agent-Process] Received chat:start for session:', chatMsg.sessionId, 'initInProgress:', initializing);
          // Guard against race condition: init handler yields during await initAgent(),
          // and chat:start may arrive before agent.setMessages() loads DB history.
          // Queue the request so it gets processed after init completes.
          if (initializing || chatInProgress) {
            log('[Agent-Process] Init in progress or chat in progress, queuing chat:start');
            pendingChatQueue.push(chatMsg);
            break;
          }
          chatInProgress = true;
          try {
            await handleChatStart(chatMsg);
          } finally {
            chatInProgress = false;
            // Process any queued messages
            if (pendingChatQueue.length > 0) {
              const next = pendingChatQueue.shift()!;
              log('[Agent-Process] Processing queued chat:start');
              chatInProgress = true;
              try {
                await handleChatStart(next);
              } finally {
                chatInProgress = false;
              }
            }
          }
          break;
        }

        case 'chat:interrupt': {
          log('[Agent-Process] Received chat:interrupt');
          if (agent && agent.interrupt) {
            agent.interrupt();
          }
          break;
        }

        case 'ping': {
          lastPongTime = Date.now();
          sendEvent({ type: 'pong', timestamp: lastPongTime });
          break;
        }

        case 'compact': {
          log('[Agent-Process] Received compact for session:', sessionId);
          if (!agent) {
            sendEvent({ type: 'compact:error', sessionId, message: 'Agent not initialized' });
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
            sendEvent({ type: 'compact:done', sessionId, result });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log('[Agent-Process] Compaction failed:', errorMessage);
            sendEvent({ type: 'compact:error', sessionId, message: errorMessage });
          }
          break;
        }

        case 'conductor:init': {
          const conductorInitMsg = msg as unknown as ConductorInitMessage;
          conductorSessionId = conductorInitMsg.sessionId;
          log('[Agent-Process] Received conductor:init for session:', conductorSessionId);
          if (conductorAgent) {
            log('[Agent-Process] Conductor agent already initialized, skipping re-init');
            sendEvent({ type: 'conductor:ready', sessionId: conductorSessionId });
            break;
          }
          if (conductorInitializing) {
            log('[Agent-Process] Conductor init in progress, waiting...');
            const waitForInit = setInterval(() => {
              if (conductorAgent) {
                clearInterval(waitForInit);
                sendEvent({ type: 'conductor:ready', sessionId: conductorSessionId });
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
          sendEvent({ type: 'conductor:ready', sessionId: conductorSessionId });
          break;
        }

        case 'conductor:agent:start': {
          const conductorStartMsg = msg as unknown as ConductorStartMessage;
          log('[Agent-Process] Received conductor:agent:start for session:', conductorStartMsg.sessionId);
          if (conductorInProgress) {
            log('[Agent-Process] Conductor already in progress, ignoring duplicate');
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
          // Handle permission resolution from main — resolve the pending permission promise
          const { id, decision, updatedInput } = msg as { id: string; decision: string; updatedInput?: Record<string, unknown> };
          log('[Agent-Process] Permission resolved:', id, decision, updatedInput ? 'with updatedInput' : '');

          // Store answers for AskUserQuestion tool retry
          if (updatedInput?.answers) {
            storePendingAnswer(id, updatedInput.answers as Record<string, string>);
          }

          const pending = pendingPermissions.get(id);
          if (pending) {
            pendingPermissions.delete(id);
            if (decision === 'allow' || decision === 'allow_once' || decision === 'allow_for_session') {
              pending.resolve('allow');
            } else {
              pending.resolve('deny');
            }
          } else {
            warn('[Agent-Process] No pending permission found for id:', id);
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

        default:
          warn('[Agent-Process] Unknown message type:', msgType);
      }
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
  void performCleanup().then(() => {
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
  exitAfterCleanup(1);
});

// Start the main loop
void main();
