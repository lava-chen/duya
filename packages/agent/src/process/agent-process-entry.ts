/**
 * agent-process-entry.ts - Agent Process Entry Point
 *
 * Runs as a standalone Node.js child process (not Worker Thread).
 * This replaces daemon-worker.ts as the Agent runtime.
 *
 * Architecture:
 * - Main Process ↔ Agent Process via IPC (stdio + ipc channel)
 * - Each Agent Process handles one session
 * - Sub-agents run sequentially within the same process
 *
 * Message Flow:
 * 1. Receive 'init' - Initialize agent with config
 * 2. Receive 'chat:start' - Start streaming chat
 * 3. Emit events back to Main via process.send()
 * 4. Receive 'ping' - Respond with 'pong'
 */

import { randomUUID } from 'crypto';
import { replaceMessages } from '../session/db.js';
import type { MessageRow } from '../session/db.js';
import type { Message, MessageContent } from '../types.js';
import { initDbClient, sessionDb, messageDb } from '../ipc/db-client.js';
import { generateSessionTitle } from '../session/title-generator.js';
import { getDefaultPromptManager } from '../prompts/PromptManager.js';
import type { PromptProfile } from '../prompts/modes/types.js';
import type { ConductorSnapshot } from '../conductor/ConductorProfile.js';
import { setConductorCanvasState } from '../prompts/sections/dynamic/conductorCanvas.js';
import { duyaAgent } from '../index.js';


// Initialize IPC database client listener
initDbClient();

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
// Track title generation per session (Map<sessionId, hasGeneratedTitle>)
const titleGeneratedBySession = new Map<string, boolean>();
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
    console.log('[Agent-Process][DEBUG]', ...args);
  }
}

// Pending permission requests registry (id -> resolve function)
// Architecture: permission requests are sent to Main -> Renderer, resolved async
const pendingPermissions = new Map<string, {
  resolve: (decision: 'allow' | 'deny') => void;
  reject: (error: Error) => void;
}>();

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

function messageRowToMessage(row: MessageRow): Message {
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
        // Failed to parse tool input, use empty object as fallback
        input = {};
      }
    }
    content = [{ type: 'tool_use', id: toolId, name: row.tool_name, input }];
    // Set tool_call_id to the tool_use id so tool_result can reference it
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

  console.log(`[Agent-Process] Found ${unmatchedToolUseIds.size} incomplete tool call(s) in history, cleaning up`);

  // Filter out messages with unmatched tool_uses
  const cleanedMessages: Message[] = [];
  for (const msg of messages) {
    // Skip tool_result messages that don't have a matching tool_use
    if (msg.role === 'tool' && msg.tool_call_id && !toolUseIds.has(msg.tool_call_id)) {
      console.log(`[Agent-Process] Removing orphan tool_result: ${msg.tool_call_id}`);
      continue;
    }

    // Skip tool_use messages that don't have a matching result
    if (msg.msg_type === 'tool_use' && msg.tool_call_id && unmatchedToolUseIds.has(msg.tool_call_id)) {
      console.log(`[Agent-Process] Removing incomplete tool_use: ${msg.tool_call_id} (${msg.tool_name})`);
      continue;
    }

    // For assistant messages with tool_use blocks, remove unmatched tool_use blocks
    if (Array.isArray(msg.content)) {
      const filteredContent = msg.content.filter((block) => {
        if (block.type === 'tool_use' && 'id' in block && typeof block.id === 'string') {
          if (unmatchedToolUseIds.has(block.id)) {
            console.log(`[Agent-Process] Removing tool_use block from assistant message: ${block.id}`);
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

  console.log(`[Agent-Process] Cleaned message history: ${messages.length} -> ${cleanedMessages.length} messages`);
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
    buildSandboxImage((msg: string) => console.log(msg)).catch(() => {});
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
    console.log(`[Agent-Process] Loaded ${skills.length} skills`);
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
    console.warn('[Agent-Process] Failed to load skills:', err);
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

  console.log('[Agent-Process] Agent initialized');
}

// ============================================================================
// Message Handling
// ============================================================================

function sendToMain(msg: Record<string, unknown>): void {
  try {
    process.send?.(msg);
  } catch (err) {
    console.error('[Agent-Process] Failed to send to main:', err);
  }
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
      console.warn('[Agent-Process] Unknown SSE event type:', event.type);
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

  console.log('[Agent-Process] handleChatStart:', { sessionId: msg.sessionId, promptLength: msg.prompt.length });
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

    // Build message content with file attachments
    let messageContent: string | MessageContent[] = msg.prompt;
    const files = msg.options?.files;
    if (files && files.length > 0) {
      const contentBlocks: MessageContent[] = [
        { type: 'text', text: msg.prompt }
      ];
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          // Extract base64 data from data URL
          const base64Data = file.url.startsWith('data:')
            ? file.url.split(',')[1]
            : file.url;
          const mediaType = file.type;
          contentBlocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64Data,
            },
          });
        }
      }
      if (contentBlocks.length > 1) {
        messageContent = contentBlocks;
      }
    }

    const eventGen = agent.streamChat(messageContent, {
      systemPrompt: effectiveSystemPrompt,
      requestPermission,
      agentProfileId: msg.options?.agentProfileId,
      outputStyleConfig: msg.options?.outputStyleConfig,
    });

    let tokenUsage: { input_tokens: number; output_tokens: number; total_tokens?: number } | null = null;
    let eventCount = 0;
    let lastIncrementalSave = Date.now();
    const INCREMENTAL_SAVE_INTERVAL = 5000; // Save every 5 seconds during streaming

    for await (const event of eventGen) {
      eventCount++;
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
      // Fire-and-forget to avoid blocking the streaming event loop
      if (Date.now() - lastIncrementalSave > INCREMENTAL_SAVE_INTERVAL) {
        lastIncrementalSave = Date.now();
        const currentMessages = agent.getMessages();
        if (currentMessages.length > 0) {
          const sessionId = msg.sessionId;
          // Do NOT await - let the save happen in the background
          sessionDb.get(sessionId)
            .then(session => {
              const currentGeneration = (session as { generation?: number } | null)?.generation ?? 0;
              return replaceMessages(sessionId, currentMessages, currentGeneration);
            })
            .then(result => {
              debugLog('incremental save', { success: result.success, messageCount: currentMessages.length });
            })
            .catch(err => {
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
    if (agentMessages.length > 0) {
      if (tokenUsage) {
        const lastAssistant = [...agentMessages].reverse().find(m => m.role === 'assistant');
        if (lastAssistant) {
          (lastAssistant as Record<string, unknown>).token_usage = JSON.stringify(tokenUsage);
        }
      }
      try {
        const session = await sessionDb.get(msg.sessionId) as { generation?: number } | null;
        const currentGeneration = session?.generation ?? 0;
        console.log(`[Agent-Process] Saving ${agentMessages.length} messages to DB for session ${msg.sessionId}, generation=${currentGeneration}`);
        const result = await replaceMessages(msg.sessionId, agentMessages, currentGeneration);
        console.log(`[Agent-Process] DB persist result: success=${result.success}, messageCount=${agentMessages.length}, reason=${result.reason || 'none'}`);
        sendToMain({ type: 'chat:db_persisted', sessionId: msg.sessionId, success: result.success, messageCount: agentMessages.length });
      } catch (err) {
        console.error('[Agent-Process] replaceMessages error:', err);
        sendToMain({ type: 'chat:db_persisted', sessionId: msg.sessionId, success: false, reason: err instanceof Error ? err.message : String(err) });
      }
    } else {
      console.warn(`[Agent-Process] No messages to save for session ${msg.sessionId}`);
    }

    // Background title generation: per-session tracking with topic drift detection
    const hasGeneratedTitle = titleGeneratedBySession.get(msg.sessionId) ?? false;
    const shouldGenerate = !hasGeneratedTitle && agentMessages.length >= 2;

    if (shouldGenerate) {
      titleGeneratedBySession.set(msg.sessionId, true);
      // Fire-and-forget: title generation is not critical
      void (async () => {
        try {
          // Pass sessionId and previousTitle (null for first generation)
          const result = await generateSessionTitle(
            agentMessages,
            agent.llmClient,
            undefined,
            msg.sessionId,
            null // No previous title for first generation
          );

          if (result.title) {
            sendToMain({ type: 'chat:title_generated', sessionId: msg.sessionId, title: result.title });
            if (DEBUG_IPC) {
              console.log(`[Agent-Process] Title generated: "${result.title}"`);
            }
          }
        } catch (titleErr) {
          // Silently ignore title generation errors
          if (DEBUG_IPC) {
            console.log('[Agent-Process] Title generation error:', titleErr);
          }
        }
      })();
    }

    // Note: 'chat:done' is already sent inside the for-await loop above
    // when the stream generator yields { type: 'done' }.
    // Do NOT send another 'chat:done' here to avoid duplicate final messages.

  } catch (err) {
    console.error('[Agent-Process] Chat error:', err);
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

  console.log('[Agent-Process] Conductor duyaAgent initialized for session:', msg.sessionId);
}

async function handleConductorStart(msg: ConductorStartMessage): Promise<void> {
  if (!conductorAgent) {
    sendToMain({ type: 'conductor:error', sessionId: msg.sessionId, message: 'Conductor agent not initialized' });
    return;
  }

  console.log('[Agent-Process] handleConductorStart:', { sessionId: msg.sessionId, promptLength: msg.prompt.length });

  try {
    startChatHeartbeat();
    sendToMain({ type: 'conductor:status', sessionId: msg.sessionId, status: 'streaming' });

    console.log('[Agent-Process] Starting conductor streamChat with profile: conductor');
    const stream = conductorAgent.streamChat(msg.prompt, {
      agentProfileId: 'conductor',
    });
    console.log('[Agent-Process] streamChat generator created, iterating...');

    let eventCount = 0;
    for await (const event of stream) {
      eventCount++;
      if (event.type === 'text' || event.type === 'thinking') {
        console.log(`[Agent-Process] Event ${eventCount}: ${event.type}, len=${String((event as {data: string}).data).length}`);
      } else {
        console.log(`[Agent-Process] Event ${eventCount}: ${event.type}`);
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
    console.log(`[Agent-Process] Stream completed, total events: ${eventCount}`);
  } catch (err) {
    console.error('[Agent-Process] Conductor error:', err);
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

// ============================================================================
// Main Message Loop
// ============================================================================

process.on('message', async (msg: Record<string, unknown>) => {
  const msgType = msg.type as string;

  switch (msgType) {
    case 'init': {
      const initMsg = msg as unknown as InitMessage;
      sessionId = initMsg.sessionId;
      console.log('[Agent-Process] Received init for session:', sessionId);
      if (agent) {
        console.log('[Agent-Process] Re-init: destroying existing agent and creating new one');
        try {
          agent.destroy?.();
        } catch (err) {
          console.warn('[Agent-Process] Error destroying old agent:', err);
        }
        agent = null;
      }
      if (initializing) {
        console.log('[Agent-Process] Init in progress, waiting...');
        const waitForInit = setInterval(() => {
          if (!initializing) {
            clearInterval(waitForInit);
            sendToMain({ type: 'ready', sessionId });
          }
        }, 50);
        break;
      }
      initializing = true;
      console.log('[Agent-Process] Received init message:', {
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
            let existingMessages = existingRows.map(messageRowToMessage);

            // Validate and clean up incomplete tool_use/tool_result pairs
            existingMessages = validateMessageHistory(existingMessages);

            agent.setMessages(existingMessages);
            console.log(`[Agent-Process] Loaded ${existingMessages.length} messages from DB for session ${sessionId}`);
            debugLog('loaded message roles', existingMessages.map(m => ({ role: m.role, type: m.msg_type || (Array.isArray(m.content) ? m.content.map((c: { type: string }) => c.type).join(',') : 'string') })));
          } else {
            console.log(`[Agent-Process] No existing messages found in DB for session ${sessionId}`);
          }
        } catch (err) {
          console.warn('[Agent-Process] Failed to load messages from DB:', err);
        }
      } finally {
        initializing = false;
      }

      sendToMain({ type: 'ready', sessionId });
      break;
    }

    case 'chat:start': {
      const chatMsg = msg as unknown as ChatStartMessage;
      console.log('[Agent-Process] Received chat:start for session:', chatMsg.sessionId);
      if (chatInProgress) {
        console.log('[Agent-Process] Chat in progress, queuing chat:start');
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
          console.log('[Agent-Process] Processing queued chat:start');
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
      console.log('[Agent-Process] Received chat:interrupt');
      if (agent && agent.interrupt) {
        agent.interrupt();
      }
      break;
    }

    case 'ping': {
      lastPongTime = Date.now();
      sendToMain({ type: 'pong', timestamp: lastPongTime });
      break;
    }

    case 'compact': {
      console.log('[Agent-Process] Received compact for session:', sessionId);
      if (!agent) {
        sendToMain({ type: 'compact:error', sessionId, message: 'Agent not initialized' });
        break;
      }
      try {
        const result = await agent.compact();
        console.log('[Agent-Process] Compaction complete:', result);
        const currentMessages = agent.getMessages();
        const session = await sessionDb.get(sessionId!);
        if (session) {
          const generation = (session as { generation?: number }).generation ?? 0;
          await replaceMessages(sessionId!, currentMessages, generation);
        }
        sendToMain({ type: 'compact:done', sessionId, result });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('[Agent-Process] Compaction failed:', errorMessage);
        sendToMain({ type: 'compact:error', sessionId, message: errorMessage });
      }
      break;
    }

    case 'conductor:init': {
      const conductorInitMsg = msg as unknown as ConductorInitMessage;
      conductorSessionId = conductorInitMsg.sessionId;
      console.log('[Agent-Process] Received conductor:init for session:', conductorSessionId);
      if (conductorAgent) {
        console.log('[Agent-Process] Conductor agent already initialized, skipping re-init');
        sendToMain({ type: 'conductor:ready', sessionId: conductorSessionId });
        break;
      }
      if (conductorInitializing) {
        console.log('[Agent-Process] Conductor init in progress, waiting...');
        const waitForInit = setInterval(() => {
          if (conductorAgent) {
            clearInterval(waitForInit);
            sendToMain({ type: 'conductor:ready', sessionId: conductorSessionId });
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
      sendToMain({ type: 'conductor:ready', sessionId: conductorSessionId });
      break;
    }

    case 'conductor:agent:start': {
      const conductorStartMsg = msg as unknown as ConductorStartMessage;
      console.log('[Agent-Process] Received conductor:agent:start for session:', conductorStartMsg.sessionId);
      if (conductorInProgress) {
        console.log('[Agent-Process] Conductor already in progress, ignoring duplicate');
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
      console.log('[Agent-Process] Received conductor:interrupt');
      if (conductorAgent) {
        conductorAgent.interrupt();
      }
      break;
    }

    case 'permission:resolve': {
      // Handle permission resolution from main — resolve the pending permission promise
      const { id, decision } = msg as { id: string; decision: string };
      console.log('[Agent-Process] Permission resolved:', id, decision);

      const pending = pendingPermissions.get(id);
      if (pending) {
        pendingPermissions.delete(id);
        if (decision === 'allow' || decision === 'allow_once' || decision === 'allow_for_session') {
          pending.resolve('allow');
        } else {
          pending.resolve('deny');
        }
      } else {
        console.warn('[Agent-Process] No pending permission found for id:', id);
      }
      break;
    }

    case 'db:response': {
      // Handled by db-client, just acknowledge
      break;
    }

    default:
      console.warn('[Agent-Process] Unknown message type:', msgType);
  }
});

// ============================================================================
// Graceful Shutdown Handling
// ============================================================================

let isShuttingDown = false;

async function performCleanup(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('[Agent-Process] Starting cleanup...');

  // Stop chat heartbeat
  stopChatHeartbeat();

  // Destroy token bucket timer
  toolBucket.destroy();

  // Shutdown worker pool (kills all BashWorker processes)
  try {
    const { shutdownWorkerPool } = await import('../tool/WorkerPool.js');
    shutdownWorkerPool();
    console.log('[Agent-Process] Worker pool shut down');
  } catch (err) {
    console.warn('[Agent-Process] Failed to shut down worker pool:', err);
  }

  // Close database connection
  try {
    const { closeDbClient } = await import('../ipc/db-client.js');
    await closeDbClient();
    console.log('[Agent-Process] DB client closed');
  } catch (err) {
    console.warn('[Agent-Process] Failed to close DB client:', err);
  }

  console.log('[Agent-Process] Cleanup complete');
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
  console.log('[Agent-Process] Received SIGTERM');
  exitAfterCleanup(0);
});

process.on('SIGINT', () => {
  console.log('[Agent-Process] Received SIGINT');
  exitAfterCleanup(0);
});

// Handle disconnect from parent (Electron main process exited)
// This is the PRIMARY shutdown mechanism on Windows.
process.on('disconnect', () => {
  console.log('[Agent-Process] Parent disconnected, shutting down...');
  exitAfterCleanup(0);
});

// Handle uncaught errors to avoid zombie processes
process.on('uncaughtException', (err) => {
  console.error('[Agent-Process] Uncaught exception:', err);
  exitAfterCleanup(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Agent-Process] Unhandled rejection:', reason);
});

// Signal ready
console.log('[Agent-Process] Process started, session:', process.env.SESSION_ID);
