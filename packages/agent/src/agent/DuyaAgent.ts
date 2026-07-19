/**
 * duyaAgent - AI Agent 核心类
 * 提供流式对话、工具调用、会话管理能力
 *
 * Implementation home for the `duyaAgent` class. The public surface
 * (type re-exports, supporting utilities) lives in `src/index.ts`,
 * which re-exports `duyaAgent` from this file.
 *
 * Module-level helpers (`extractTextFromContent`,
 * `collectRecentImageAttachments`, `buildBackgroundTaskNotification`,
 * `buildAgentIdentityBlock`) live alongside the class because they are
 * only used by it; if any become useful to other modules, lift them
 * into their own files.
 */

import {
  DEFAULT_MAX_OUTPUT_TOKENS,
} from '../types.js';
import type {
  AgentOptions,
  ChatOptions,
  ImageContent,
  Message,
  MessageContent,
  Tool,
  ToolUse,
  SSEEvent,
  SessionInfo,
  MCPServerConfig,
  MCPConnectionStatus,
  ToolUseContext,
  ToolResultContent,
  AgentProgressEvent,
} from '../types.js';
import { PromptManager, asSystemPrompt, DEFAULT_PROMPT_PROFILE, getPromptProfileForAgentProfile, PromptsRegistry, resolvePromptSystemName } from '../prompts/index.js';
import type { PromptSystem } from '../prompts/index.js';
import { getMemoryManager } from '../memory/index.js'
import { createMemoryReviewService } from '../memory/index.js';
import { compactHistory } from '../compact/compact.js';
import type { CompactResult, TokenEstimation } from '../compact/compact.js';
import { estimateContextTokens, needsCompression, DEFAULT_CONTEXT_WINDOW, COMPRESSION_THRESHOLD } from '../compact/compact.js';
import { microCleanupMessages } from '../compact/microCompactCleanup.js';
import { compressHistoricalCanvasToolCalls } from '../compact/canvasHistoryCompress.js';
import { createLLMClient, createRetryableLLMClient, inferProvider, isMiniMaxURL, LLMClientWrapper } from '../llm/index.js';
import type { LLMClient, RetryConfig } from '../llm/index.js';
import { resolveLlmClientDiscriminator } from '../providers/ProviderRuntimeAdapter.js';
import { stripPastedContentMarkers } from '../utils/pasted-content.js';
import { StreamingToolExecutor } from '../tool/StreamingToolExecutor.js';
import type { CanUseToolFn } from '../tool/StreamingToolExecutor.js';
import type { WidgetStyleSignature, CanvasFreshnessState } from '../types.js';
import { backgroundAgentLifecycle } from '../lifecycle/BackgroundAgentLifecycle.js';
import { dequeueAllMatching, enqueuePendingNotification } from '../queue/index.js';
import { createHasPermissionsToUseTool } from '../permissions/permissions.js';
import type { ToolPermissionCheckContext } from '../permissions/permissions.js';
import type { ToolPermissionContext, PermissionMode, ToolPermissionRulesBySource, AdditionalWorkingDirectory, PermissionRuleSource } from '../permissions/types.js';
import { permissionModeFromString } from '../permissions/PermissionMode.js';
import { settingsJsonToRules } from '../permissions/permissionsLoader.js';
import { permissionRuleValueToString } from '../permissions/permissionRuleParser.js';
import { logger } from '../utils/logger.js';
import { createChildAbortController } from '../abort/index.js';
import { getAgentProfileService } from '../agent-profile/AgentProfileService.js';
import type { AgentProfile } from '../agent-profile/types.js';
import { resolveAllowedTools } from '../agent-profile/ToolFilter.js';
import { ResearchMemory } from '../research-memory/index.js';
import { mailboxDb, pluginDb } from '../ipc/db-client.js';
import { MCPManager } from '../mcp/index.js';
import type { MailboxApplyMode, MailboxRow } from '../session/db.js';
import path from 'node:path';

function extractTextFromContent(content: string | MessageContent[]): string {
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push((block as { text: string }).text || '')
    } else if (block.type === 'tool_use') {
      const b = block as unknown as { name: string }
      parts.push(`[Tool call: ${b.name || 'unknown'}]`)
    } else if (block.type === 'tool_result') {
      const b = block as unknown as { content: string | Array<{ type: string; text: string }> }
      const resultText = typeof b.content === 'string'
        ? b.content
        : Array.isArray(b.content)
          ? b.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
          : ''
      parts.push(`[Tool result: ${resultText.slice(0, 300)}]`)
    }
  }
  return parts.join('\n')
}

function collectRecentImageAttachments(messages: Message[]): Array<{
  name: string;
  path?: string;
  url?: string;
  type: string;
}> {
  const recent: Array<{
    name: string;
    path?: string;
    url?: string;
    type: string;
  }> = [];
  const seen = new Set<string>();

  for (let i = messages.length - 1; i >= 0; i--) {
    const attachments = messages[i]?.attachments;
    if (!attachments || attachments.length === 0) continue;

    for (const attachment of [...attachments].reverse()) {
      if (!attachment?.type?.startsWith('image/')) continue;
      const source = attachment.path || attachment.url;
      if (!source) continue;

      const dedupeKey = `${attachment.name}::${source}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      recent.push({
        name: attachment.name,
        path: attachment.path,
        url: attachment.url,
        type: attachment.type,
      });
    }
  }

  return recent;
}

// Side-effect import so the class is in scope for the rest of this
// module (e.g. `new SelfImprover(...)` in the constructor and
// `getDefaultSelfImprover()` in the integration wiring below).
import {
  SelfImprover,
  getDefaultSelfImprover,
  type ImprovementResult,
} from '../self-improver/SelfImprover.js';
import { SkillCurator, getDefaultCurator } from '../self-improver/SkillCurator.js';

// Mode System imports (the class is the only consumer in this file;
// the public re-exports live in src/index.ts).
import { modeModifierRegistry } from '../modes/index.js';
import type { ModeModifier, ModeModifierContext, OrchestratorDeps, ResolvedMode, ToolRegistration } from '../modes/index.js';
import { applyModes, collectActiveModes } from '../modes/apply-modes.js';

import { ToolRegistry } from '../tool/registry.js';
import type { ToolExecutor } from '../tool/registry.js';
import type { AgentDefinition } from '../tool/SubagentTool/index.js';
import { CompactionManager, createCompactionManager } from '../compact/CompactionManager.js';
import type { CompactOptions } from '../compact/types.js';

export function filterToolsByAllowedTools(tools: Tool[], allowedTools: readonly string[]): Tool[] {
  const allowedSet = new Set(allowedTools);
  return tools.filter((tool) => allowedSet.has(tool.name));
}

function hasRunningBackgroundTasksForSession(parentSessionId?: string): boolean {
  if (!parentSessionId) return false
  return backgroundAgentLifecycle.getAll().some(
    (task) =>
      task.parentSessionId === parentSessionId &&
      (task.status === 'pending' || task.status === 'running')
  )
}

async function waitForBackgroundTaskNotifications(parentSessionId?: string): Promise<string[]> {
  const TIMEOUT_MS = 120_000
  const startTime = Date.now()

  while (hasRunningBackgroundTasksForSession(parentSessionId)) {
    const drained = dequeueAllMatching(
      (cmd) => cmd.mode === 'task-notification' && cmd.agentId === undefined
    )
    if (drained.length > 0) {
      return drained.map((cmd) => cmd.value)
    }
    if (Date.now() - startTime >= TIMEOUT_MS) {
      // Timeout: list unfinished task IDs and yield what we have so
      // the main conversation is not blocked indefinitely.
      const unfinishedTaskIds = backgroundAgentLifecycle
        .getAll()
        .filter(
          (task) =>
            task.parentSessionId === parentSessionId &&
            (task.status === 'pending' || task.status === 'running'),
        )
        .map((task) => task.taskId)
      logger.warn(
        `[Agent] waitForBackgroundTaskNotifications timed out after ${TIMEOUT_MS}ms; ` +
        `unfinished tasks: ${unfinishedTaskIds.join(', ') || '(none)'}`,
      )
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return dequeueAllMatching(
    (cmd) => cmd.mode === 'task-notification' && cmd.agentId === undefined
  ).map((cmd) => cmd.value)
}

type RuntimeMailboxDecision =
  | { action: 'continue'; absorbed: boolean }
  | { action: 'soft_stop'; summary: string }
  | { action: 'hard_replace'; replacement: string };

interface RuntimeMailboxClaim {
  rows: MailboxRow[];
  claimTokens: string[];
}

function isRuntimeMailboxMessage(message: Message): boolean {
  return message.metadata?.mailboxRuntimeInstruction === true;
}

function persistableMessages(messages: Message[]): Message[] {
  return messages.filter((message) => !isRuntimeMailboxMessage(message));
}

function formatMailboxRuntimeInstruction(rows: MailboxRow[]): string {
  const lines = rows
    .map((row, index) => {
      const label = row.kind === 'constraint'
        ? 'constraint'
        : row.kind === 'correction'
          ? 'correction'
          : 'follow-up';
      return `${index + 1}. (${label}) ${row.content.trim()}`;
    })
    .filter((line) => line.trim().length > 0);

  return [
    '<runtime-user-guidance>',
    'The user sent the following instruction while you were already working.',
    'Incorporate it into the current plan at the next safe point. Do not mention this wrapper.',
    ...lines,
    '</runtime-user-guidance>',
  ].join('\n');
}

function chooseMailboxApplyMode(row: MailboxRow): MailboxApplyMode {
  if (row.kind === 'stop' || row.kind === 'abort_and_replace') {
    return 'interrupt_signal';
  }
  return 'runtime_instruction';
}

/**
 * duyaAgent 类
 */
export class duyaAgent {
  private llmClient: LLMClient;
  private messages: Message[] = [];
  private abortController: AbortController | null = null;
  private sessionInfo: SessionInfo;
  private promptManager: PromptManager;
  private compactionManager: CompactionManager;
  private apiKey: string;
  private baseURL?: string;
  private authStyle?: 'api_key' | 'auth_token';
  private provider: 'anthropic' | 'openai' | 'ollama';
  private sessionId?: string; // Session ID for task persistence
  private workingDirectory?: string; // Working directory for tool execution
  private defaultWorkspaceDirectory?: string; // Default workspace directory for permission checking
  private communicationPlatform?: import('../prompts/types.js').CommunicationPlatform; // Communication platform for prompt injection
  private permissionMode: PermissionMode = 'default'; // Permission mode for tool execution
  private hasPermissionsToUseTool: ReturnType<typeof createHasPermissionsToUseTool>;
  private alwaysAllowRules: ToolPermissionRulesBySource = {};
  private alwaysDenyRules: ToolPermissionRulesBySource = {};
  private alwaysAskRules: ToolPermissionRulesBySource = {};
  private additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory> = new Map();
  private selfImprover: SelfImprover; // Self-improvement tracker for skill creation
  /** Bridge for results that finish after the foreground SSE stream closes. */
  onSkillReviewCompleted?: (result: ImprovementResult) => Promise<void> | void;
  private curator: SkillCurator; // Periodic skill consolidation curator
  private visionClient?: LLMClient; // Optional vision model client
  private visionConfig?: import('../types.js').VisionConfig; // Vision model configuration
  private blockedDomains: string[] = [];
  private browserBackendMode: 'auto' | 'extension' | 'built-in' = 'auto';
  private researchMemoryRuntime: ResearchMemory;
  private mcpManager: MCPManager | null = null;
  /**
   * Rolling history of recent widget/dynamic style signatures.
   * Canvas tools push to this via ToolUseContext so the conductor
   * prompt can nudge the model away from repeating the same palette
   * or layout.
   */
  private widgetStyleHistory: WidgetStyleSignature[] = [];
  /**
   * Per-session mutable canvas state (list-freshness timestamp, created
   * element IDs, ref map). Shared across tool calls and turns via a
   * stable reference on ToolUseContext so StreamingToolExecutor's
   * per-call shallow spread does not lose writes.
   */
  private canvasFreshness: CanvasFreshnessState = {
    recentlyCreatedElementIds: new Set(),
  };
  /**
   * System prompt without mode-modifier prefixes/suffixes. Stored so
   * each turn can re-evaluate mode prompt prefixes (e.g. conductor's
   * anti-slop section) against the latest mode context state without
   * rebuilding the entire prompt system context.
   *
   * Plan 224 Phase 3: generalizes the former
   * `baseSystemPromptWithoutConductor` (conductor-only) to all mode modifiers.
   */
  private baseSystemPromptWithoutModes?: string;
  /**
   * Resolved mode modifiers for the current streamChat call. Used by
   * the per-turn prompt refresh loop to re-evaluate function-form
   * prefixes (e.g. conductor's `buildConductorPrefix` which reads the
   * rolling `widgetStyleHistory`).
   */
  private resolvedModes?: ResolvedMode;
  /**
   * Mode context for the current streamChat call. Holds
   * `toolUseContextPatch` (consumed by the tool executor) and
   * `state` (read by mode prompt builders and hooks).
   */
  private modeCtx?: ModeModifierContext;
  /**
   * Phase 2: optional ProviderRuntimeConfig delivered by the main
   * process. The agent currently does not consume it directly (the
   * legacy `apiKey / baseURL / provider` fields stay authoritative
   * for the LLM client factory). Future agent code can use this to
   * bypass `inferProvider(baseURL)` heuristics.
   */
  readonly runtimeConfig?: AgentOptions['runtimeConfig'];

  /**
   * Optional callback invoked after a proactive compaction replaces
   * this.messages with a compressed set. The argument is the new
   * message count. The caller (agent-process-entry) uses this to
   * update its existingMessageCount and persist the compacted
   * message list so subsequent incremental saves use the correct
   * baseline.
   */
  onMessagesCompacted?: (newMessageCount: number) => void;

  // Phase 2A worker closure: the agent owns the long-lived MCP
  // runtime. `activeMCPRegistry` is the ToolRegistry slot that
  // holds `owner === 'mcp'` entries between streamChat
  // invocations; `activeMCPRuntimeSnapshot` is the post-commit
  // snapshot that UI/diagnostic consumers read; the alias map
  // converts model-returned providerNames to internalKeys;
  // `toolEntries` is a stash of the current entries for ad-hoc
  // dispatch. `activeAgentProfileId` is used by
  // `filterResolvedMCPServersForAgent` to apply allowedAgentIds
  // filtering consistently across init and reload.
  readonly activeMCPRegistry: ToolRegistry = new ToolRegistry();
  activeMCPRuntimeSnapshot: import('../mcp/apply.js').ActiveMCPRuntimeSnapshot | null = null;
  private providerNameToInternalKey: Map<string, string> = new Map();
  private registeredMCPToolKeys: Set<string> = new Set();
  private activeMCPToolEntries: Map<string, { definition: Tool; executor: ToolExecutor }> = new Map();
  private activeAgentProfileId: string | undefined;

  constructor(options: AgentOptions) {
    // Phase 3: prefer the new `runtimeConfig.apiFormat` when present
    // (authoritative source of truth). Fall back to the legacy
    // `options.provider` discriminator, then to the URL-sniffing
    // `inferProvider(baseURL)` heuristic for backward compat.
    let provider: 'anthropic' | 'openai' | 'ollama';
    let resolvedFromRuntime = false;
    if (options.runtimeConfig) {
      provider = resolveLlmClientDiscriminator(options.runtimeConfig.apiFormat);
      resolvedFromRuntime = true;
    } else {
      provider = options.provider || inferProvider(options.baseURL || '');
    }
    this.provider = provider;
    this.sessionId = options.sessionId; // Store sessionId

    // Model is required - no hardcoded defaults
    if (!options.model) {
      throw new Error(
        `Model is required. Please specify a model in your provider settings. ` +
        `Provider: ${provider}, BaseURL: ${options.baseURL || 'not provided'}`
      );
    }

    const baseURL = options.baseURL || this.getDefaultBaseURL(provider);
    const model = options.model;

    // Use retryable client if enabled (default: true)
    const enableRetry = options.enableRetry !== false;

    // When the runtimeConfig is present, surface that fact in the
    // debug log so the new path is observable end-to-end.
    if (resolvedFromRuntime && options.runtimeConfig) {
      logger.debug(
        '[duyaAgent] LLM client selected from runtimeConfig.apiFormat',
        {
          apiFormat: options.runtimeConfig.apiFormat,
          provider,
          headerKeys: Object.keys(options.runtimeConfig.headers ?? {}),
          // CRITICAL: never log apiKey / accessToken here.
        },
      );
    }

    if (isMiniMaxURL(baseURL)) {
      const wrapper = new LLMClientWrapper({
        apiKey: options.apiKey,
        baseURL,
        model,
        authStyle: options.authStyle,
        provider,
      });
      this.llmClient = wrapper;
    } else if (enableRetry) {
      logger.debug('[duyaAgent] Using retryable LLM client');
      this.llmClient = createRetryableLLMClient(provider, {
        apiKey: options.apiKey,
        baseURL,
        model,
        authStyle: options.authStyle,
        retryConfig: options.retryConfig,
      });
    } else {
      logger.debug('[duyaAgent] Using standard LLM client (retry disabled)');
      this.llmClient = createLLMClient(provider, {
        apiKey: options.apiKey,
        baseURL,
        model,
        authStyle: options.authStyle,
      });
    }

    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL;
    this.authStyle = options.authStyle;
    this.workingDirectory = options.workingDirectory;
    this.defaultWorkspaceDirectory = options.defaultWorkspaceDirectory;
    this.sessionInfo = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
    };

    this.model = options.model;
    this.runtimeConfig = options.runtimeConfig;
    this.communicationPlatform = options.communicationPlatform;

    // Initialize vision model client if configured
    logger.info(`[duyaAgent] Vision config check: enabled=${options.visionConfig?.enabled}, provider=${options.visionConfig?.provider}, model=${options.visionConfig?.model}, baseURL=${options.visionConfig?.baseURL}`);
    if (options.visionConfig?.enabled) {
      this.visionConfig = options.visionConfig;
      const visionProvider = inferProvider(options.visionConfig.baseURL || '', options.visionConfig.provider);
      logger.info(`[duyaAgent] Vision provider inferred: provider=${options.visionConfig.provider}, baseURL=${options.visionConfig.baseURL} -> resolved=${visionProvider}`);
      try {
        this.visionClient = createLLMClient(visionProvider, {
          apiKey: options.visionConfig.apiKey,
          baseURL: options.visionConfig.baseURL || this.getDefaultBaseURL(visionProvider),
          model: options.visionConfig.model,
        });
        logger.info(`[duyaAgent] Vision model initialized: ${options.visionConfig.model} (resolved provider: ${visionProvider})`);
      } catch (err) {
        logger.warn(`[duyaAgent] Failed to initialize vision model: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      logger.info(`[duyaAgent] Vision model NOT initialized - disabled or not configured`);
    }

    this.promptManager = options.promptManager || new PromptManager({
      sessionId: options.sessionId,
      workingDirectory: options.workingDirectory,
      communicationPlatform: options.communicationPlatform,
      modelId: options.model,
      language: options.language,
    });

    // Load memory for session (memory manager is a singleton).
    // Deferred to next tick so agent construction returns immediately.
    // Memory snapshot defaults to empty; populated before first streamChat.
    const memoryManager = getMemoryManager();
    const projectPath = options.workingDirectory || process.cwd();
    if (!memoryManager.isLoadedForPath(projectPath)) {
      setImmediate(() => {
        try {
          memoryManager.loadForSession(projectPath);
        } catch (err) {
          logger.warn(`[duyaAgent] Memory load failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }

    // Wire the model-level `contextWindow` (e.g. 1M for Sonnet 4.6 1M) into
    // the compaction budget. Falls back to the 200K default if the renderer
    // didn't attach a capability row (e.g. legacy call site or missing entry).
    const capabilityContextWindow =
      options.runtimeConfig?.modelCapabilities?.contextWindow;
    this.compactionManager = createCompactionManager({
      enableReinjection: true,
      maxTokens:
        typeof capabilityContextWindow === 'number' && capabilityContextWindow > 0
          ? capabilityContextWindow
          : undefined,
    });

    // Wire up the LLM summarizer so strategies can generate summaries
    this.compactionManager.setSummarizer(async (text: string, prompt: string): Promise<string> => {
      const summaryMessages: Message[] = [
        {
          role: 'user',
          content: text,
        },
      ];

      const result: string[] = [];
      // Use a child abort controller linked to the agent's main
      // abortController so user interrupts also cancel the summarizer.
      const childController = this.abortController
        ? createChildAbortController(this.abortController)
        : new AbortController();
      const stream = this.llmClient.streamChat(summaryMessages, {
        systemPrompt: prompt,
        maxTokens: 4096,
        temperature: 0.3,
        signal: childController.signal,
      });

      try {
        for await (const event of stream) {
          if (event.type === 'text') {
            result.push(event.data);
          }
          if (event.type === 'done' || event.type === 'error') {
            break;
          }
        }
      } finally {
        // Dispose the parent handler to avoid leaking it on the
        // main abortController's signal.
        const disposable = childController as AbortController & { dispose?: () => void };
        disposable.dispose?.();
      }

      return result.join('').trim();
    });

    // Wire up background memory review service
    const memoryReviewService = createMemoryReviewService(memoryManager, {
      enabled: true,
      nudgeInterval: 10,
    });

    memoryReviewService.setSummarizer(async (prompt: string): Promise<string> => {
      const reviewMessages: Message[] = [
        {
          role: 'user',
          content: prompt,
        },
      ];

      const result: string[] = [];
      // Use a child abort controller linked to the agent's main
      // abortController so user interrupts also cancel the review.
      const childController = this.abortController
        ? createChildAbortController(this.abortController)
        : new AbortController();
      const stream = this.llmClient.streamChat(reviewMessages, {
        maxTokens: 2048,
        temperature: 0.2,
        signal: childController.signal,
      });

      try {
        for await (const event of stream) {
          if (event.type === 'text') {
            result.push(event.data);
          }
          if (event.type === 'done' || event.type === 'error') {
            break;
          }
        }
      } finally {
        const disposable = childController as AbortController & { dispose?: () => void };
        disposable.dispose?.();
      }

      return result.join('').trim();
    });

    memoryManager.setupReviewService(memoryReviewService);

    // Initialize permission system
    this.permissionMode = options.permissionMode || 'default';
    this.hasPermissionsToUseTool = createHasPermissionsToUseTool();

    // Parse optional user-defined permission rules so allow/deny/ask rules
    // actually reach the permission engine (they were previously hardcoded
    // to empty maps in _buildPermissionContext).
    const ruleSource: PermissionRuleSource = 'userSettings';
    const allRules = settingsJsonToRules(options.permissionRules ?? null, ruleSource);
    this.alwaysAllowRules = this.groupRulesBySource(
      allRules.filter((r) => r.ruleBehavior === 'allow'),
    );
    this.alwaysDenyRules = this.groupRulesBySource(
      allRules.filter((r) => r.ruleBehavior === 'deny'),
    );
    this.alwaysAskRules = this.groupRulesBySource(
      allRules.filter((r) => r.ruleBehavior === 'ask'),
    );

    const additionalDirs = options.permissionRules?.permissions?.additionalDirectories ?? [];
    for (const dir of additionalDirs) {
      const resolved = path.resolve(dir);
      this.additionalWorkingDirectories.set(resolved, { path: resolved, source: ruleSource });
    }

    // Initialize self-improvement system.
    // Use the process-wide singleton when no explicit interval is
    // given — this is what lets the counter persist across
    // duyaAgent instances (each user query creates a fresh
    // instance, so without the singleton the "every N turns"
    // trigger would never see more than one query's worth of
    // accumulation).
    this.selfImprover = options.skillNudgeInterval !== undefined
      ? new SelfImprover(options.skillNudgeInterval)
      : getDefaultSelfImprover();
    // Fire-and-forget: load any persisted counters from disk so
    // the first turn of a new query sees the accumulated count
    // from previous queries. Errors are absorbed inside `init`.
    void this.selfImprover.init();

    // Skill Curator — periodic umbrella consolidation.
    // Uses a global singleton so the 7-day interval persists
    // across DuyaAgent instances (each query creates a new agent).
    this.curator = getDefaultCurator();

    // Store blocked domains for browser tool
    this.blockedDomains = options.blockedDomains ?? [];
    this.browserBackendMode = options.browserBackendMode ?? 'auto';
    this.researchMemoryRuntime = new ResearchMemory();
  }

  private getDefaultBaseURL(provider: 'anthropic' | 'openai' | 'ollama'): string {
    switch (provider) {
      case 'anthropic':
        return 'https://api.anthropic.com';
      case 'openai':
        return 'https://api.openai.com/v1';
      case 'ollama':
        return 'http://localhost:11434';
      default:
        return 'https://api.openai.com/v1';
    }
  }

  private _model!: string;
  get model(): string {
    return this._model;
  }
  set model(value: string) {
    this._model = value;
    // Sync model change to PromptManager so system prompt shows correct model info
    if (this.promptManager) {
      this.promptManager.updateOptions({ modelId: value });
    }
  }

  /**
   * Analyze an image using the configured vision model.
   * Returns text description of the image.
   * Throws an error if vision is unavailable or the API call fails.
   */
  async analyzeImage(imageBase64: string, mediaType: string, customPrompt?: string): Promise<string> {
    logger.debug('[duyaAgent] analyzeImage called', {
      hasVisionClient: !!this.visionClient,
      visionConfig: this.visionConfig,
      imageBase64Length: imageBase64.length,
      mediaType,
      customPrompt: customPrompt?.substring(0, 100),
    });

    if (!this.visionClient) {
      logger.warn('[duyaAgent] analyzeImage: No vision client configured');
      throw new Error('Vision model is not configured. Please configure a vision model in Settings > Vision Model.');
    }

    const prompt = customPrompt || 'Please describe this image in detail. What do you see? Include any text, colors, shapes, objects, people, and the overall scene.';

    const userMessage: Message = {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType as ImageContent['source']['media_type'], data: imageBase64 },
        },
      ],
    };

    const result: string[] = [];
    let lastError: string | null = null;
    try {
      logger.debug('[duyaAgent] Starting vision stream');
      const stream = this.visionClient.streamChat([userMessage], {
        maxTokens: 2048,
        temperature: 0,
      });

      let eventCount = 0;
      for await (const event of stream) {
        eventCount++;
        logger.debug(`[duyaAgent] Vision stream event: ${event.type} (${eventCount})`);
        if (event.type === 'text') {
          result.push(event.data);
          logger.debug(`[duyaAgent] Vision text event: ${event.data?.substring(0, 100)}`);
        }
        if (event.type === 'error') {
          lastError = event.data as string;
          logger.debug(`[duyaAgent] Vision stream error event: ${lastError}`);
          break;
        }
        if (event.type === 'done') {
          logger.debug('[duyaAgent] Vision stream ended: done');
          break;
        }
      }
      logger.debug(`[duyaAgent] Vision stream finished, events: ${eventCount}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`[duyaAgent] Vision analysis failed: ${errMsg}`);
      throw new Error(`Vision model API error: ${errMsg}`);
    }

    if (lastError) {
      throw new Error(`Vision model returned an error: ${lastError}`);
    }

    const analysis = result.join('').trim();
    logger.info(`[duyaAgent] Vision analysis complete: ${analysis.length} chars`);

    if (!analysis) {
      throw new Error('Vision model returned empty analysis. The model may not support image input, or the image format may be unsupported.');
    }

    return analysis;
  }

  /**
   * Stream chat with tool execution loop
   * @param prompt User input
   * @param options Chat options
   * @yields SSE events including tool_use, tool_result, text, turn_start, and done
   */
  async *streamChat(
    prompt: string | MessageContent[],
    options?: ChatOptions
  ): AsyncGenerator<SSEEvent, void, unknown> {
    this.abortController = new AbortController();
    logger.info(`[Agent] streamChat started, sessionId=${this.sessionId}, model=${this._model}, provider=${this.provider}`);

    // Resolve agent profile early so mode dispatch can use promptSystem for auto-resolution
    const appliedProfile = this._resolveAgentProfile(options);

    // === Mode Dispatch ===
    // Resolve mode: explicit option > 'normal'. Orchestrator-paradigm
    // modes (research) take over the entire stream via
    // `_dispatchOrchestratorMode`. Modifier-paradigm modes (plan-task,
    // conductor via `conductorMode` flag) fall through to the normal
    // agent loop where `applyModes` composes them on top of the profile.
    const requestedMode = options?.mode || 'normal';
    if (requestedMode !== 'normal') {
      const mod = modeModifierRegistry.get(requestedMode);
      if (mod?.orchestrator) {
        yield* this._dispatchOrchestratorMode(mod, prompt, options);
        return;
      }
      if (!mod && !options?.conductorMode) {
        // Unknown mode — no registry entry and no conductor flag.
        yield {
          type: 'error',
          data: `Unknown mode: ${requestedMode}`,
        } as SSEEvent;
        return;
      }
      // Modifier-paradigm mode (plan-task) or conductor-only — fall
      // through to the normal agent loop; `applyModes` below composes
      // the mode overlay onto the profile-resolved base.
    }

    // === Normal Mode ===
    // Tool resolution, prompt assembly, permission wiring, and initial
    // message selection are factored into private helpers (Phase F1 of
    // Plan 211). The system-message extraction block below remains inline
    // because it mutates `messages`, `systemPromptContent`, and
    // `this.messages` together — a single bridge between helper output
    // and the main loop.

    const { tools: baseTools, registry, agentDefinitions } = await this._resolveTools(options, appliedProfile);
    let tools = baseTools;
    // Diagnostic: worker uses console.error for stderr (stdout is JSON-RPC).
    // eslint-disable-next-line no-console
    console.error(`[Agent-Process] streamChat tools (${tools.length}): conductorMode=${options?.conductorMode}, agentProfileId=${options?.agentProfileId}, mode=${options?.mode}, hasCanvasCreate=${tools.some(t => t.name === 'canvas_create_element')}`);
    // eslint-disable-next-line no-console
    console.error(`[Agent-Process] canvas tools: ${tools.filter(t => t.name.startsWith('canvas_')).map(t => t.name).join(', ') || '(none)'}`);
    let systemPromptContent = await this._buildSystemPrompt(tools, options, appliedProfile);
    const { permissionContext, canUseTool } = this._buildPermissionContext();
    let messages = this._resolveInitialMessages(prompt, options);

    // Extract system-role messages from message history (compaction summaries,
    // session memory, etc.) and merge into the system prompt.
    // Anthropic API does not support system-role messages in the messages array;
    // they must go through the separate `system` parameter. If left in the
    // messages array, toAnthropicMessages skips them silently, dropping all
    // compaction context and causing the agent to "forget" earlier turns.
    {
      const systemContentParts: string[] = [];
      const nonSystemMessages: Message[] = [];
      for (const msg of messages) {
        if (msg.role === 'system') {
          systemContentParts.push(typeof msg.content === 'string' ? msg.content : extractTextFromContent(msg.content));
        } else {
          nonSystemMessages.push(msg);
        }
      }
      if (systemContentParts.length > 0) {
        if (systemPromptContent) {
          systemPromptContent += '\n\n---\n\n## Conversation Context\n\n' + systemContentParts.join('\n\n---\n\n');
        } else {
          systemPromptContent = systemContentParts.join('\n\n---\n\n');
        }
        messages = nonSystemMessages;
        this.messages = nonSystemMessages;
        logger.info(`[Agent] Extracted ${systemContentParts.length} system messages into system prompt`);
      }
    }

    // === Plan 224 Phase 3+4: apply declarative mode modifiers ===
    // Modifier-paradigm modes (conductor, plan-task) inject tools,
    // prepend prompt prefixes, and merge toolUseContextPatch on top
    // of the profile-resolved base. Orchestrator-paradigm modes
    // (research) are dispatched earlier via `_dispatchOrchestratorMode`
    // and never reach this path.
    //
    // The resolved modes + ctx are stored on `this` so the per-turn
    // refresh loop below can re-evaluate function-form prompt prefixes
    // (e.g. conductor's anti-slop section) against the latest
    // `widgetStyleHistory` without re-running `onEnter` hooks.
    const activeModeIds = collectActiveModes(options ?? {});
    this.resolvedModes = activeModeIds.length > 0
      ? modeModifierRegistry.resolve(activeModeIds)
      : undefined;
    if (this.resolvedModes && this.resolvedModes.modes.length > 0) {
      // Capture the pre-mode system prompt BEFORE applyModes applies
      // prefixes. The per-turn refresh loop re-evaluates function-form
      // prefixes against this base each turn.
      this.baseSystemPromptWithoutModes = systemPromptContent;

      // Build the mode context. `state` is pre-populated with fields
      // modes need to read in their hooks / prompt builders:
      //  - conductorCanvasId: passed by the frontend (4-level priority
      //    resolution in ChatView.handleConductorChange)
      //  - widgetStyleHistory: the agent's rolling anti-slop history
      this.modeCtx = {
        sessionId: this.sessionId ?? '',
        workingDirectory: this.workingDirectory ?? '',
        state: {
          conductorCanvasId: options?.conductorCanvasId,
          widgetStyleHistory: this.widgetStyleHistory,
        },
      };

      // Build base ToolRegistration[] from the profile-filtered tools.
      // The registry holds the executors; we look them up by name.
      const baseToolRegistrations: ToolRegistration[] = tools.map((t) => ({
        definition: t,
        executor: registry.getExecutor(t.name)!,
      }));

      const modeResult = await applyModes({
        basePrompt: systemPromptContent,
        baseTools: baseToolRegistrations,
        baseToolUseContext: undefined,
        ctx: this.modeCtx,
        resolved: this.resolvedModes,
      });

      // Register injected tool executors into the registry so the
      // streaming executor can dispatch them. Tools that were already
      // registered (e.g. by an earlier call) are skipped.
      for (const tr of modeResult.tools) {
        if (!registry.has(tr.definition.name)) {
          registry.register(tr.definition, tr.executor);
        }
      }

      // Update the LLM-facing tool list and system prompt with the
      // mode-applied versions.
      tools = modeResult.tools.map((t) => t.definition);
      systemPromptContent = modeResult.systemPrompt;

      logger.info(
        `[Agent] streamChat: Applied ${this.resolvedModes.modes.length} mode modifier(s): ${this.resolvedModes.modes.map((m) => m.id).join(', ')}`,
      );
    } else {
      // No active modes — clear stored state so per-turn refresh is a no-op.
      this.resolvedModes = undefined;
      this.modeCtx = undefined;
      this.baseSystemPromptWithoutModes = undefined;
    }

    let turnCount = 0;
    const maxTurns = options?.maxTurns ?? 100;
    let runtimePromptMessageId: string | null = null;

    // Generate a unique seq_index for this streamChat call
    // All messages created in this call (including multi-turn) will share this seq_index
    // This allows the UI to group all related messages into a single "round"
    const seqIndex = Date.now();
    const runId = crypto.randomUUID();

    // Track total elapsed time for the entire stream (including all turns and tool execution)
    const streamStartTime = Date.now();

    while (!this.abortController.signal.aborted) {
      turnCount++;
      const turnStartTime = Date.now();

      // Plan 224 Phase 3: re-evaluate function-form mode prompt prefixes
      // each turn so mode state that mutates during the stream (e.g.
      // conductor's `widgetStyleHistory` grows as canvas tools push new
      // signatures) is reflected in the system prompt without rebuilding
      // the entire base prompt.
      if (
        this.resolvedModes &&
        this.modeCtx &&
        this.baseSystemPromptWithoutModes !== undefined &&
        this.resolvedModes.prompt.prefixes.length > 0
      ) {
        // Refresh ctx.state with the latest rolling state so prefix
        // builders read current values.
        this.modeCtx.state.widgetStyleHistory = this.widgetStyleHistory;
        let prefix = '';
        for (const p of this.resolvedModes.prompt.prefixes) {
          prefix += typeof p === 'function' ? p(this.modeCtx, this.baseSystemPromptWithoutModes) : p;
        }
        systemPromptContent = prefix + '\n\n' + this.baseSystemPromptWithoutModes;
      }

      // Only add user message on first turn (original prompt)
      // Subsequent turns are continuations after tool results, not new prompts
      if (turnCount === 1) {
        // Check if the last message is already a user message with the same content
        // This prevents duplicates when messages are pre-loaded from DB before streamChat is called
        const lastMessage = messages[messages.length - 1];
        // Compare the model-facing prompt. UI marker content is persisted
        // separately as displayContent and must not replace content.
        const compareContent = typeof prompt === 'string'
          ? prompt
          : (Array.isArray(prompt)
              ? prompt.filter((b: unknown) => (b as Record<string, unknown>).type === 'text')
                  .map((b: unknown) => (b as Record<string, string>).text || '')
                  .join('')
              : '');
        // Extract comparable content from lastMessage (handle both string and MessageContent[])
        const lastMessageContent = typeof lastMessage?.content === 'string'
          ? lastMessage.content
          : (Array.isArray(lastMessage?.content)
              ? (lastMessage.content as Array<{type: string; text?: string}>)
                  .filter(b => b.type === 'text')
                  .map(b => b.text || '')
                  .join('')
              : '');
        const normalizedLastMessageContent = stripPastedContentMarkers(lastMessageContent).trim();
        const normalizedCompareContent = stripPastedContentMarkers(compareContent).trim();
        const isDuplicate = lastMessage &&
          lastMessage.role === 'user' &&
          (normalizedLastMessageContent === normalizedCompareContent ||
            lastMessageContent.trim() === compareContent.trim());

        const displayContent = options?.displayContent && options.displayContent.length > 0
          ? options.displayContent
          : undefined;
        const persistedPromptContent = prompt as string | MessageContent[];

        if (!isDuplicate) {
          const userMessage = {
            id: crypto.randomUUID(),
            role: 'user',
            content: persistedPromptContent,
            displayContent: displayContent !== undefined ? displayContent : undefined,
            timestamp: Date.now(),
            seq_index: seqIndex,
            attachments: (options as ChatOptions & { attachments?: Message['attachments'] })?.attachments,
          } as Message;
          messages.push(userMessage);
          runtimePromptMessageId = userMessage.id ?? null;
        } else if (lastMessage) {
          lastMessage.seq_index = seqIndex;
          runtimePromptMessageId = lastMessage.id ?? null;
          const newAttachments = (options as ChatOptions & { attachments?: Message['attachments'] })?.attachments;
          lastMessage.content = persistedPromptContent;
          lastMessage.displayContent = displayContent;
          if (newAttachments && newAttachments.length > 0) {
            lastMessage.attachments = newAttachments;
          }
        }
      }

      // Create executor for this turn
      const toolUseContext: ToolUseContext = {
        toolUseId: crypto.randomUUID(),
        abortController: this.abortController,
        getAppState: () => ({}),
        setAppState: () => {},
        widgetStyleHistory: this.widgetStyleHistory,
        canvasFreshness: this.canvasFreshness,
        options: {
          recentImageAttachments: collectRecentImageAttachments(messages),
          tools,
          commands: [],
          mainLoopModel: this._model,
          mcpClients: [],
          apiKey: this.apiKey,
          baseURL: this.baseURL,
          authStyle: this.authStyle,
          provider: this.provider,
          sessionId: this.sessionId, // Pass sessionId for task persistence
          workingDirectory: this.workingDirectory, // Pass working directory for tool execution
          agentDefinitions: {
            activeAgents: agentDefinitions,
            allAgents: agentDefinitions,
          },
          analyzeImage: this.analyzeImage.bind(this),
          // Phase 2A worker closure: providerName -> internalKey
          // resolver. StreamingToolExecutor consults this for
          // every model-returned tool name. The closure is
          // stable for the lifetime of the executor (per turn),
          // but the underlying map is mutated in place by
          // setActiveMCPRuntime so reload takes effect for the
          // next turn without re-creating the executor.
          resolveMCPProviderToolName: (name: string) =>
            this.resolveMCPToolNameToInternalKey(name),
        },
        // Permission callback - passed from ChatOptions by API route
        requestPermission: options?.requestPermission,
        // IPC for conductor executor communication
        ipcRequest: options?.conductorIpc?.ipcRequest,
        // Plan 224 Phase 3: mode modifiers surface fields like
        // `conductorCanvasId` via `toolUseContextPatch` (populated by
        // `conductorMode.hooks.onEnter`). Spread it here so every
        // canvas tool sees the bound canvasId without the LLM passing
        // it explicitly. Falls back to the legacy `options.conductorCanvasId`
        // for safety when no mode modifier is active.
        conductorCanvasId:
          (this.modeCtx?.toolUseContextPatch?.conductorCanvasId as string | undefined) ??
          options?.conductorCanvasId,
        canvasTarget: {
          canvasId:
            (this.modeCtx?.toolUseContextPatch?.conductorCanvasId as string | undefined) ??
            options?.conductorCanvasId,
        },
        // Propagate canvas_manage's switch/create-with-switchTo back into
        // the persistent modeCtx so the NEXT turn's toolUseContextPatch
        // reflects the new target. Without this, intra-streamChat
        // cross-turn canvas switches revert to the canvas bound at
        // streamChat start.
        updateModeCanvasId: this.modeCtx
          ? (canvasId: string) => {
              this.modeCtx!.state.conductorCanvasId = canvasId;
              this.modeCtx!.toolUseContextPatch = {
                ...(this.modeCtx!.toolUseContextPatch ?? {}),
                conductorCanvasId: canvasId,
              };
            }
          : undefined,
      };

      const executor = new StreamingToolExecutor(
        registry,
        canUseTool,
        toolUseContext
      );

      // Per-turn state
      const assistantContent: MessageContent[] = [];
      let needsFollowUp = false;
      let thinkingContent = '';  // Accumulate thinking content for this turn
      let hasThinkingContent = false;  // Track if we have any thinking content
      let toolCallCountThisTurn = 0;  // Track tool calls for self-improvement trigger

      yield { type: 'turn_start', data: { turnCount } };

      // Lightweight tool result cleanup before each turn
      messages = microCleanupMessages(messages);

      // Proactive context compaction before each LLM call
      if (this.shouldCompact()) {
        logger.info(`[Agent] Turn ${turnCount}: Proactive compaction triggered`);
        try {
          const compactResult = await this.compact();
          logger.info(`[Agent] Turn ${turnCount}: Compacted with strategy=${compactResult.strategy}, removed=${compactResult.tokensRemoved} tokens, retained=${compactResult.tokensRetained} tokens`);
          // Update messages reference since compact() replaces this.messages
          messages = this.messages;
          // Notify external listener so it can persist the compacted
          // message list and update its baseline count.
          this.onMessagesCompacted?.(this.messages.length);
        } catch (compactError) {
          const compactErrorMsg = compactError instanceof Error ? compactError.message : String(compactError);
          logger.error(`[Agent] Turn ${turnCount}: Proactive compaction failed: ${compactErrorMsg}`);
          // Continue anyway — let the API call fail if truly over limit
        }
      }

      const mailboxDecision = await this._claimMailboxAtCheckpoint(
        runId,
        messages,
        seqIndex,
        'before_model_turn',
      );
      if (mailboxDecision.action === 'soft_stop') {
        const stopMessage = mailboxDecision.summary || 'Stopped as requested.';
        messages.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: stopMessage,
          timestamp: Date.now(),
          duration_ms: Date.now() - streamStartTime,
          seq_index: seqIndex,
        });
        this.messages = persistableMessages(messages);
        this.sessionInfo.messageCount = this.messages.length;
        this.sessionInfo.updatedAt = Date.now();
        yield { type: 'text', data: stopMessage };
        yield { type: 'done', reason: 'completed' };
        return;
      }
      if (mailboxDecision.action === 'hard_replace') {
        const replacement = mailboxDecision.replacement || 'The user replaced the previous instruction.';
        messages.push({
          id: crypto.randomUUID(),
          role: 'user',
          content: `<runtime-user-replacement>\n${replacement}\n</runtime-user-replacement>`,
          timestamp: Date.now(),
          seq_index: seqIndex,
          metadata: { mailboxRuntimeInstruction: true },
        });
      }

      try {
        // Stream from LLM with FULL message history
        logger.info(`[Agent] Turn ${turnCount}: Starting LLM stream, messages=${messages.length}, provider=${this.provider}`);
        let llmEventCount = 0;
        logger.info(`[Agent] Turn ${turnCount}: Calling llmClient.streamChat...`);
        const llmMessages = compressHistoricalCanvasToolCalls(
          runtimePromptMessageId
            ? messages.map((msg) => (
                msg.id === runtimePromptMessageId
                  ? {
                      ...msg,
                      content: prompt as string | MessageContent[],
                    }
                  : msg
              ))
            : messages
        );
        const streamGenerator = this.llmClient.streamChat(llmMessages, {
          systemPrompt: systemPromptContent,
          tools,
          maxTokens: options?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          temperature: options?.temperature ?? 1,
          signal: this.abortController.signal,
          effort: options?.effort,
          maxOutputTokens: this.runtimeConfig?.modelCapabilities?.maxOutputTokens,
        });
        logger.info(`[Agent] Turn ${turnCount}: Stream generator created, starting iteration...`);
        for await (const event of streamGenerator) {
          llmEventCount++;
          if (event.type === 'text' || event.type === 'thinking') {
            logger.debug(`[Agent] LLM event ${llmEventCount}: type=${event.type}, data_length=${String(event.data).length}`);
          } else {
            logger.debug(`[Agent] LLM event ${llmEventCount}: type=${event.type}`);
          }

          if (event.type === 'tool_use_started') {
            yield event;

          } else if (event.type === 'tool_use') {
            toolCallCountThisTurn++;

            // Track skill_manage usage for self-improvement
            if (event.data.name === 'skill_manage') {
              this.selfImprover.onSkillManageUsed();
              this.compactionManager.cacheSkillContext([{
                name: (event.data.input as Record<string, unknown>)?.name as string || 'unknown',
                description: (event.data.input as Record<string, unknown>)?.description as string || '',
                invokedAt: Date.now(),
              }]);
            }

            // Add tool to executor for background execution
            executor.addTool(event.data);
            needsFollowUp = true;

            // Build assistant content with tool_use block
            assistantContent.push({
              type: 'tool_use',
              id: event.data.id,
              name: event.data.name,
              input: event.data.input,
            });

            // Yield the tool_use event to caller
            yield event;

          } else if (event.type === 'text') {
            // Accumulate text content - merge consecutive text blocks
            // to prevent markdown fragmentation when stored in DB
            const lastBlock = assistantContent[assistantContent.length - 1];
            if (lastBlock && lastBlock.type === 'text') {
              lastBlock.text += event.data;
            } else {
              assistantContent.push({
                type: 'text',
                text: event.data,
              });
            }

            // Yield text event to caller
            yield event;

          } else if (event.type === 'done') {
            // LLM stream is done for this turn
            // IMPORTANT: Add assistant message BEFORE tool results for OpenAI API compatibility
            // OpenAI requires: assistant (tool_calls) -> tool (result) message order

            // Build final assistant content including thinking block if present
            const finalAssistantContent: MessageContent[] = [];

            // Add thinking block first if we have thinking content
            if (hasThinkingContent && thinkingContent) {
              finalAssistantContent.push({
                type: 'thinking',
                thinking: thinkingContent,
              });
            }

            // Add the rest of the content (text and tool_use blocks)
            finalAssistantContent.push(...assistantContent);

            if (finalAssistantContent.length > 0 || needsFollowUp) {
              messages.push({ id: crypto.randomUUID(), role: 'assistant', content: finalAssistantContent.length > 0 ? finalAssistantContent : assistantContent, timestamp: Date.now(), duration_ms: Date.now() - streamStartTime, seq_index: seqIndex });
            }

            // Now get remaining tool results and add them after assistant message
            logger.debug(`[Agent] Turn ${turnCount}: entering getRemainingResults, needsFollowUp=${needsFollowUp}`);
            let toolResultMessageCount = 0;
            for await (const result of executor.getRemainingResults()) {
              if (result.message) {
                // Check if this is an agent_progress message
                const isAgentProgress = result.message.metadata?.type === 'agent_progress';
                if (isAgentProgress) {
                  // Yield agent progress event so the UI can show sub-agent activity
                  const agentEvent = result.message.metadata?.agentEvent as AgentProgressEvent | undefined;
                  if (agentEvent) {
                    yield {
                      type: 'agent_progress',
                      data: agentEvent,
                    };
                  }
                  continue;
                }

                // Check if this is a tool_result message (role: 'tool' or content type 'tool_result')
                const messageContent = result.message.content;
                const isToolResult = result.message.role === 'tool' ||
                  (Array.isArray(messageContent) &&
                    messageContent.length > 0 &&
                    messageContent[0]?.type === 'tool_result');

                // Only add tool_result messages to history, skip progress messages
                if (isToolResult) {
                  toolResultMessageCount++;
                  result.message.seq_index = seqIndex;
                  if (!result.message.id) {
                    result.message.id = crypto.randomUUID();
                  }
                  messages.push(result.message);

                  // Yield tool result event
                  let toolResultId = '';
                  let toolResultContent = '';
                  let toolResultError = false;

                  if (result.message.role === 'tool') {
                    // New format: role: 'tool' with string content
                    toolResultId = result.message.tool_call_id || '';
                    toolResultContent = typeof messageContent === 'string' ? messageContent : JSON.stringify(messageContent);
                    // Check if content indicates an error
                    toolResultError = toolResultContent.includes('<tool_error>');
                  } else {
                    // Old format: content array with tool_result block
                    const contentBlock = (messageContent as MessageContent[])[0] as ToolResultContent;
                    toolResultId = contentBlock.tool_use_id;
                    toolResultContent = typeof contentBlock.content === 'string'
                      ? contentBlock.content
                      : JSON.stringify(contentBlock.content);
                    toolResultError = contentBlock.is_error ?? false;
                  }

                  yield {
                    type: 'tool_result',
                    data: {
                      id: toolResultId,
                      name: '',
                      result: toolResultContent,
                      error: toolResultError,
                      duration_ms: result.message.duration_ms,
                      // Forward tool-result metadata so renderer ToolResultInfo
                      // can surface previews (browser screenshot / vision_analyze).
                      metadata: result.message.metadata,
                    },
                  };
                }
              }
            }
            logger.debug(
              `[Agent] Turn ${turnCount}: getRemainingResults completed, toolResultMessageCount=${toolResultMessageCount}`
            );

            // widgetStyleHistory and canvasFreshness are stable references
            // injected into toolUseContext; canvas tools mutate them in
            // place, so nothing to copy back here. The next turn reads the
            // same references via this.widgetStyleHistory / this.canvasFreshness.

            // Drain completed background sub-agents and inject their
            // <task-notification> XML envelopes (claude-code protocol).
            // metadata.isTaskNotification lets the renderer hide these
            // from the chat UI without relying on a string-prefix sniff.
            const completedNotificationXml = dequeueAllMatching(
              (cmd) => cmd.mode === 'task-notification' && cmd.agentId === undefined
            ).map((cmd) => cmd.value)
            if (completedNotificationXml.length > 0) {
              for (const xml of completedNotificationXml) {
                messages.push({
                  id: crypto.randomUUID(),
                  role: 'user',
                  content: xml,
                  timestamp: Date.now(),
                  metadata: { isTaskNotification: true },
                })
              }
              needsFollowUp = true
            }

            // Do NOT yield the LLM's 'done' event to the SSE client here.
            // In multi-turn conversations, the LLM client yields a 'done' event
            // at the end of each turn. Forwarding it would cause the client to
            // prematurely think the stream is complete. Only the final 'done'
            // event (yielded after the while-loop) should reach the client.

          } else if (event.type === 'error') {
            // Propagate error events
            yield event;

          } else if (event.type === 'thinking') {
            // Accumulate thinking content and pass through
            // Ensure event.data is a string to avoid [object Object] issues
            const thinkingData = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
            thinkingContent += thinkingData;
            hasThinkingContent = true;
            yield event;

          } else if (event.type === 'tool_progress') {
            // Pass through tool progress events
            yield event;

          } else if (event.type === 'tool_timeout') {
            // Pass through tool timeout events
            yield event;

          } else if (event.type === 'result') {
            // Pass through token usage result
            yield event;
          }
        }

        logger.debug(`[Agent] Turn ${turnCount}: LLM stream ended, total events=${llmEventCount}`);

        // Track iteration for skill self-improvement
        const validToolNames = new Set(tools.map(t => t.name));
        this.selfImprover.onIterationComplete(validToolNames, toolCallCountThisTurn);

        // Trigger background skill review at the turn boundary
        // (not just at conversation exit). The check inside is
        // idempotent: if it doesn't fire, this is a no-op.
        // We do this BEFORE the max-turns / done checks so the
        // spawn can race the user-facing done event.
        yield* this._triggerBackgroundReviewWithEvents(validToolNames);

        // Check if the Curator should run (7-day interval).
        // Fire-and-forget — never blocks the conversation.
        void this._maybeRunCurator();

        // Check max turns limit
        if (turnCount >= maxTurns) {
          // Update this.messages BEFORE yielding done event
          this.messages = persistableMessages(messages);
          this.sessionInfo.messageCount = this.messages.length;
          this.sessionInfo.updatedAt = Date.now();

          // Trigger background skill review if needed
          yield* this._triggerBackgroundReviewWithEvents(validToolNames);

          // Trigger background memory review
          const assistantLength = assistantContent
            .filter(b => b.type === 'text')
            .reduce((sum, b) => sum + ((b as { text: string }).text?.length || 0), 0)
          this._syncMemoryReview(messages, assistantLength)

          yield { type: 'done', reason: 'max_turns' };
          return;
        }

        // If no tool_use blocks were emitted, we're done
        // Note: assistant message was already added in 'done' event handler
        if (!needsFollowUp) {
          const completedNotificationXml = await waitForBackgroundTaskNotifications(this.sessionId)
          if (completedNotificationXml.length > 0) {
            for (const xml of completedNotificationXml) {
              messages.push({
                id: crypto.randomUUID(),
                role: 'user',
                content: xml,
                timestamp: Date.now(),
                metadata: { isTaskNotification: true },
              })
            }
            continue
          }

          // A message can arrive while the model is producing its final text.
          // Re-check before finalising so in-run guidance is not limited to
          // tool-heavy flows that naturally create another model turn.
          const finalMailboxDecision = await this._claimMailboxAtCheckpoint(
            runId,
            messages,
            seqIndex,
            'before_final_answer',
          );
          if (finalMailboxDecision.action === 'hard_replace') {
            messages.push({
              id: crypto.randomUUID(),
              role: 'user',
              content: `<runtime-user-replacement>\n${finalMailboxDecision.replacement || 'The user replaced the previous instruction.'}\n</runtime-user-replacement>`,
              timestamp: Date.now(),
              seq_index: seqIndex,
              metadata: { mailboxRuntimeInstruction: true },
            });
            continue;
          }
          if (finalMailboxDecision.action === 'continue' && finalMailboxDecision.absorbed) {
            continue;
          }

          // Update this.messages BEFORE yielding done event
          // so API route can retrieve the final state
          this.messages = persistableMessages(messages);
          this.sessionInfo.messageCount = this.messages.length;
          this.sessionInfo.updatedAt = Date.now();

          // Trigger background skill review if needed
          yield* this._triggerBackgroundReviewWithEvents(validToolNames);

          // Trigger background memory review
          const assistantLength = assistantContent
            .filter(b => b.type === 'text')
            .reduce((sum, b) => sum + ((b as { text: string }).text?.length || 0), 0)
          this._syncMemoryReview(messages, assistantLength)

          yield { type: 'done', reason: 'completed' };
          return;
        }

        // Loop continues - next LLM call will include tool results
        // Note: assistant message and tool results were already added in 'done' event handler

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`[Agent] Turn ${turnCount}: Error in LLM stream`, error instanceof Error ? error : new Error(errorMessage));

        // Check for context length exceeded errors and attempt reactive compaction
        const isContextLengthError =
          errorMessage.includes('context_length_exceeded') ||
          errorMessage.includes('context window exceeds limit') ||
          errorMessage.includes('prompt_too_long') ||
          errorMessage.includes('exceeds limit');

        if (isContextLengthError && !this.compactionManager.isCircuitBreakerTriggered()) {
          logger.warn(`[Agent] Turn ${turnCount}: Context length exceeded, attempting reactive compaction`);
          try {
            const triggerError = errorMessage.includes('prompt_too_long')
              ? 'prompt_too_long' as const
              : 'context_length_exceeded' as const;
            const reactiveResult = await this.compactionManager.reactiveCompact(messages, triggerError);
            messages = reactiveResult.messages;
            logger.info(`[Agent] Turn ${turnCount}: Reactive compaction succeeded, strategy=${reactiveResult.strategy}, retained=${reactiveResult.tokensRetained} tokens`);
            // Retry this turn with compacted messages
            executor.discard();
            turnCount--; // Decrement so the next iteration uses the same turn number
            continue;
          } catch (reactiveError) {
            const reactiveErrorMsg = reactiveError instanceof Error ? reactiveError.message : String(reactiveError);
            logger.error(`[Agent] Turn ${turnCount}: Reactive compaction failed: ${reactiveErrorMsg}`);
          }
        }

        executor.discard();

        // Clean up incomplete tool_use/tool_result pairs before saving
        // This prevents "tool call result does not follow tool call" errors on next message
        const lastAssistantIdx = messages.map((m, i) => m.role === 'assistant' ? i : -1).filter(i => i >= 0).pop();
        if (lastAssistantIdx !== undefined && lastAssistantIdx >= 0) {
          const lastAssistant = messages[lastAssistantIdx];
          if (Array.isArray(lastAssistant.content)) {
            const hasUnmatchedToolUse = lastAssistant.content.some(
              block => block.type === 'tool_use' && 'id' in block
            );
            if (hasUnmatchedToolUse) {
              // Remove the incomplete assistant message to avoid saving partial state
              messages.splice(lastAssistantIdx, 1);
                          }
          }
        }

        // Update this.messages BEFORE yielding error/done events
        this.messages = persistableMessages(messages);
        this.sessionInfo.messageCount = this.messages.length;
        this.sessionInfo.updatedAt = Date.now();

        if (error instanceof Error && error.name === 'AbortError') {
          // Generate synthetic tool_results for any pending tool_use blocks
          // This prevents "missing tool_result" API errors on the next turn
          const lastAssistantMsg = messages.at(-1);
          if (lastAssistantMsg && lastAssistantMsg.role === 'assistant' && Array.isArray(lastAssistantMsg.content)) {
            for (const block of lastAssistantMsg.content) {
              if (block.type === 'tool_use' && 'id' in block && typeof block.id === 'string') {
                const toolId = block.id;
                const hasResult = messages.some(m =>
                  (m.role === 'tool' && m.tool_call_id === toolId) ||
                  (Array.isArray(m.content) && m.content.some(
                    (c: MessageContent) =>
                      c.type === 'tool_result' &&
                      'tool_use_id' in c &&
                      (c as { tool_use_id: string }).tool_use_id === toolId
                  ))
                );
                if (!hasResult) {
                  messages.push({
                    id: crypto.randomUUID(),
                    role: 'user',
                    content: [{
                      type: 'tool_result',
                      tool_use_id: toolId,
                      content: 'Interrupted by user',
                      is_error: true,
                    }],
                    timestamp: Date.now(),
                  });
                }
              }
            }
          }
          yield { type: 'done', reason: 'aborted' };
        } else {
          yield {
            type: 'error',
            data: error instanceof Error ? error.message : 'Unknown error',
          };
          yield { type: 'done', reason: 'error' };
        }
        return;
      }
    }

    // User interrupted - executor already created in current turn
    // Update this.messages BEFORE yielding done event
    this.messages = persistableMessages(messages);
    this.sessionInfo.messageCount = this.messages.length;
    this.sessionInfo.updatedAt = Date.now();
    yield { type: 'done', reason: 'aborted' };
  }

  // === streamChat helpers (Phase F1 of Plan 211) =========================
  //
  // The body of `streamChat` historically packed mode dispatch, tool
  // resolution, prompt assembly, permission wiring, and message-history
  // selection into a single 1000+ line method. The five helpers below pull
  // each concern out so the main loop reads as orchestration rather than
  // implementation. Helpers are private; they are not part of the public
  // surface and may be reorganized freely.

  private async _claimMailboxAtCheckpoint(
    runId: string,
    messages: Message[],
    seqIndex: number,
    checkpoint: 'before_model_turn' | 'before_final_answer',
  ): Promise<RuntimeMailboxDecision> {
    if (!this.sessionId) {
      return { action: 'continue', absorbed: false };
    }

    let claim: RuntimeMailboxClaim;
    try {
      claim = await mailboxDb.claimBatch({
        sessionId: this.sessionId,
        runId,
        checkpoint,
        limit: 10,
      }) as RuntimeMailboxClaim;
    } catch (err) {
      logger.warn(
        `[AgentMailbox] ${checkpoint} claim failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return { action: 'continue', absorbed: false };
    }

    if (!claim.rows.length) {
      return { action: 'continue', absorbed: false };
    }

    const applyRow = async (row: MailboxRow, index: number, summary: string): Promise<void> => {
      const claimToken = claim.claimTokens[index];
      if (!claimToken) return;
      await mailboxDb.apply({
        id: row.id,
        claimToken,
        mode: chooseMailboxApplyMode(row),
        checkpoint,
        summary,
      });
    };

    const abort = claim.rows.find((row) => row.kind === 'abort_and_replace');
    if (abort) {
      await applyRow(abort, claim.rows.indexOf(abort), 'hard replacement requested before model turn');
      return { action: 'hard_replace', replacement: abort.content.trim() };
    }

    const stop = claim.rows.find((row) => row.kind === 'stop');
    if (stop) {
      await applyRow(stop, claim.rows.indexOf(stop), 'soft stop requested before model turn');
      return { action: 'soft_stop', summary: stop.content.trim() || 'Stopped as requested.' };
    }

    const usableRows = claim.rows.filter((row) => row.content.trim().length > 0);
    if (!usableRows.length) {
      return { action: 'continue', absorbed: false };
    }

    for (const row of usableRows) {
      await applyRow(row, claim.rows.indexOf(row), 'absorbed as runtime instruction before model turn');
    }

    messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      content: formatMailboxRuntimeInstruction(usableRows),
      timestamp: Date.now(),
      seq_index: seqIndex,
      metadata: {
        mailboxRuntimeInstruction: true,
        mailboxRowIds: usableRows.map((row) => row.id),
      },
    });

    logger.info(`[AgentMailbox] absorbed ${usableRows.length} row(s) at ${checkpoint}`);
    return { action: 'continue', absorbed: true };
  }

  /**
   * Resolve the agent profile requested by `options.agentProfileId`.
   *
   * Returns `undefined` when no profile id was supplied, the profile is
   * missing, or the service has not been initialized. Profile-driven mode
   * selection (e.g. `promptSystem: 'research'`) is intentionally not
   * resolved here — callers handle profile -> mode mapping.
   */
  private _resolveAgentProfile(options?: ChatOptions): AgentProfile | undefined {
    if (!options?.agentProfileId) {
      return undefined;
    }
    const profileService = getAgentProfileService();
    const profile = profileService.get(options.agentProfileId);
    if (profile) {
      logger.info(
        `[Agent] Applying agent profile: ${profile.name} (${profile.id}), promptSystem=${profile.promptSystem || 'general'}`
      );
      return profile;
    }
    logger.warn(`[Agent] Agent profile not found: ${options.agentProfileId}`);
    return undefined;
  }

  /**
   * Build the tool list for this turn.
   *
   * Three layers of filtering are applied in order:
   *   0. `options.allowedTools` — caller-supplied hard allowlist (most restrictive)
   *   1. `options.disabledTools` — caller-supplied hard denylist
   *   2. `appliedProfile.allowedTools/disallowedTools` — agent profile policy
   *
   * Returns the filtered `tools` array along with the underlying
   * `registry` and the loaded `agentDefinitions`, because the main
   * loop needs all three: `tools` for the LLM, `registry` to construct
   * the `StreamingToolExecutor`, and `agentDefinitions` to populate
   * `ToolUseContext.options.agentDefinitions` (so the SubagentTool can
   * validate sub-agent invocations).
   *
   * The built-in registry is loaded with a dynamic `import()` rather
   * than a static one to break the load-time cycle through
   * `tool/SubagentTool/runAgent.ts:15` (`import { duyaAgent }`). See Plan 211
   * Phase D for the full explanation.
   */
  private async _resolveTools(
    options?: ChatOptions,
    appliedProfile?: AgentProfile,
  ): Promise<{
    tools: Tool[];
    registry: ToolRegistry;
    agentDefinitions: AgentDefinition[];
  }> {
    logger.info(`[Agent] streamChat: Loading tools...`);
    let registry = options?.toolRegistry;
    if (!registry) {
      const { createBuiltinRegistry } = await import('../tool/builtin.js');
      let enabledPluginIds: Set<string> | undefined;
      try {
        const installed = await pluginDb.registryList() as Array<{ id?: unknown; enabled?: unknown }>;
        const enabledIds = installed
          .filter((item) => item.enabled === true && typeof item.id === 'string')
          .map((item) => item.id as string);
        enabledPluginIds = new Set(enabledIds);
      } catch (err) {
        logger.warn(
          `[Agent] Failed to load plugin registry; falling back to default plugin tool set: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      registry = createBuiltinRegistry(
        this.blockedDomains.length > 0 ? { blockedDomains: this.blockedDomains } : undefined,
        {
          enabledPluginIds,
          wikiAgentEnabled: options?.wikiAgentEnabled,
          mcpManagerProvider: () => this.mcpManager ?? undefined,
          browserBackendMode: this.browserBackendMode,
        }
      );
    }
    const allTools = registry.getAllTools();
    let tools: Tool[] = allTools;

    // Layer 0: caller-supplied allowlist (interagent minimal mode)
    if (options?.allowedTools?.length) {
      tools = filterToolsByAllowedTools(tools, options.allowedTools);
      logger.info(
        `[Agent] streamChat: Filtered tools by allowedTools allowlist, ${tools.length}/${allTools.length} enabled`
      );
      if (tools.length === 0) {
        logger.warn(
          `[Agent] streamChat: allowedTools allowlist matched zero tools. ` +
          `Configured names: ${options.allowedTools.join(', ')}`
        );
      }
    }

    // Layer 1: caller-supplied denylist
    if (options?.disabledTools?.length) {
      tools = tools.filter((t) => !options.disabledTools!.includes(t.name));
      logger.info(
        `[Agent] streamChat: Filtered tools by disabledTools, ${tools.length}/${allTools.length} enabled`
      );
    }

    // Layer 2: agent profile policy
    if (appliedProfile) {
      const allToolNames = tools.map((t) => t.name);
      const filterResult = resolveAllowedTools(appliedProfile, allToolNames);
      if (filterResult.isValid) {
        const allowedToolSet = new Set(filterResult.allowed);
        tools = tools.filter((t) => allowedToolSet.has(t.name));
        logger.info(`[Agent] streamChat: Tool filter applied`, {
          profileId: appliedProfile.id,
          totalTools: allToolNames.length,
          allowedCount: filterResult.allowed.length,
          deniedCount: filterResult.denied.length,
          matchedPatternCount: filterResult.diagnostics.matchedPatterns.length,
          unmatchedPatterns: filterResult.diagnostics.unmatchedPatterns,
          layerBreakdown: filterResult.diagnostics.layerBreakdown,
        });
        if (filterResult.denied.length > 0) {
          logger.info(`[Agent] streamChat: Denied tools: ${filterResult.denied.join(', ')}`);
        }
      } else {
        // Fail-fast: the profile's allowedTools patterns matched zero
        // tools. Previously this only logged a warning and silently let
        // ALL tools through — a security hole where a misconfigured
        // allowlist became an implicit wildcard. Throw so the caller knows
        // the profile is broken instead of running with unintended access.
        const unmatched = filterResult.diagnostics.unmatchedPatterns;
        throw new Error(
          `Agent profile "${appliedProfile.id}" allowedTools matched zero tools ` +
          `(all ${filterResult.denied.length} tools were denied). ` +
          `Unmatched patterns: ${unmatched.length > 0 ? unmatched.join(', ') : '(none)'}. ` +
          `This usually means allowedTools patterns don't match actual registered tool names. ` +
          `Check packages/agent/src/agent-profile/types.ts and the tool name constants.`
        );
      }
    }

    // Plan 224 Phase 3: conductor canvas tool injection + profile-filter
    // bypass moved to `applyModes` in `streamChat`. The `conductorMode`
    // option is no longer read here; `createBuiltinRegistry` no longer
    // registers canvas tools. The mode modifier's `tools.inject` +
    // `tools.overrideFilter` handle both registration and bypass.

    logger.info(`[Agent] streamChat: Loaded ${tools.length} tools`);

    // Agent definitions (sub-agents) are loaded separately for the SubagentTool
    // to register as `task` calls. They are not part of the `tools` array
    // returned to the LLM — they live behind the tool's own validation.
    logger.info(`[Agent] streamChat: Loading agent definitions...`);
    // Dynamic import breaks the load-time cycle through
    // `tool/SubagentTool/runAgent.ts:15` (`import { duyaAgent }`). See Plan 211
    // Phase D for the full explanation.
    const { getAgentDefinitions } = await import('../tool/SubagentTool/index.js');
    const agentDefinitions = getAgentDefinitions();
    logger.info(`[Agent] streamChat: Loaded ${agentDefinitions.length} agent definitions`);

    return { tools, registry, agentDefinitions };
  }

  /**
   * Build the final system prompt string for this turn.
   *
   * The composition order is:
   *   1. Profile-driven identity block (highest precedence — must lead)
   *   2. Caller-supplied `systemPromptPrefix`
   *   3. Resolved prompt system (general/research), honoring:
   *      - `disableSystemPrompt` (empty)
   *      - `systemPrompt` (raw override)
   *      - prompt system rendering (default)
   *   4. Output style injection (handled inside the prompt system context)
   *
   * Note: conversation-derived system messages (compaction summaries, etc.)
   * are merged in *after* this helper returns — see the inline block in
   * `streamChat` that reads `this.messages` post-init.
   */
  private async _buildSystemPrompt(
    tools: Tool[],
    options?: ChatOptions,
    appliedProfile?: AgentProfile,
  ): Promise<string> {
    // Apply output style config if provided
    if (options?.outputStyleConfig) {
      logger.info(`[Agent] Applying output style: ${options.outputStyleConfig.name}`);
      this.promptManager.updateOptions({ outputStyleConfig: options.outputStyleConfig });
    }

    // Resolve prompt system + profile
    const sysName = resolvePromptSystemName(appliedProfile?.promptSystem);
    const promptProfile = appliedProfile
      ? getPromptProfileForAgentProfile(appliedProfile)
      : DEFAULT_PROMPT_PROFILE;
    const promptSystem: PromptSystem =
      PromptsRegistry.getOrCreate(sysName, promptProfile)
      ?? PromptsRegistry.getOrCreate('general', promptProfile)!;
    logger.info(
      `[Agent] Using prompt system '${sysName}'${appliedProfile ? ` for profile: ${appliedProfile.name}` : ' (default)'}`
    );
    logger.info(
      `[Agent] Resolved prompt profile: base=${promptProfile.base}, overlays=${JSON.stringify(promptProfile.overlays ?? [])}, disabledSections=${JSON.stringify(promptProfile.overrides?.disableSections ?? [])}`
    );

    // Render the base system prompt
    let systemPromptContent: string;
    if (options?.disableSystemPrompt) {
      systemPromptContent = '';
      logger.info('[Agent] streamChat: System prompt disabled (empty)');
    } else if (options?.systemPrompt) {
      systemPromptContent = options.systemPrompt;
    } else {
      const enabledToolNames = tools.map((t) => t.name);
      const context = promptSystem.buildContext({
        sessionId: this.sessionId,
        workingDirectory: this.workingDirectory,
        modelId: this.model,
        modelName: this.model,
        enabledTools: new Set(enabledToolNames),
        outputStyleConfig: options?.outputStyleConfig,
        researchIntent: options?.researchIntent,
        researchProjectId: options?.researchProjectId,
        communicationPlatform: this.communicationPlatform,
      });
      const systemPromptResult = await promptSystem.buildSystemPrompt(context);
      systemPromptContent = [...systemPromptResult].join('\n\n');
    }

    // Prepend optional prefix
    if (options?.systemPromptPrefix) {
      systemPromptContent = options.systemPromptPrefix + '\n\n' + systemPromptContent;
      logger.info('[Agent] streamChat: Added system prompt prefix');
    }

    // Inject profile identity (must lead)
    if (appliedProfile) {
      const identityBlock = buildAgentIdentityBlock(appliedProfile);
      systemPromptContent = identityBlock + '\n\n' + systemPromptContent;
    }

    // Plan 224 Phase 3: conductor prompt overlay moved to `applyModes`
    // in `streamChat`. The mode modifier's `prompt.prefix` handles
    // prepending `buildConductorPrompt(widgetStyleHistory)`, and the
    // per-turn refresh loop re-evaluates it against the latest
    // `widgetStyleHistory`. `_buildSystemPrompt` now returns the base
    // prompt only — no mode-specific overlays.

    return systemPromptContent;
  }

  /**
   * Group parsed permission rules by their source for the engine's
   * `ToolPermissionRulesBySource` shape.
   */
  private groupRulesBySource(
    rules: Array<{ source: PermissionRuleSource; ruleValue: { toolName: string; ruleContent?: string } }>,
  ): ToolPermissionRulesBySource {
    const grouped: ToolPermissionRulesBySource = {};
    for (const rule of rules) {
      const serialized = permissionRuleValueToString(rule.ruleValue);
      const list = grouped[rule.source] ?? [];
      list.push(serialized);
      grouped[rule.source] = list;
    }
    return grouped;
  }

  /**
   * Build the permission context and `canUseTool` closure for this turn.
   *
   * `canUseTool` is fail-closed: when the permission check itself throws
   * (e.g. abort, classifier glitch) we return `deny`. Returning `allow`
   * would let a tool execute when the permission system is in an unknown
   * state, which is the wrong default for a security boundary.
   */
  private _buildPermissionContext(): {
    permissionContext: ToolPermissionCheckContext;
    canUseTool: CanUseToolFn;
  } {
    const permissionContext: ToolPermissionCheckContext = {
      getAppState: () => ({
        toolPermissionContext: {
          mode: this.permissionMode,
          additionalWorkingDirectories: this.additionalWorkingDirectories,
          alwaysAllowRules: this.alwaysAllowRules,
          alwaysDenyRules: this.alwaysDenyRules,
          alwaysAskRules: this.alwaysAskRules,
          isBypassPermissionsModeAvailable: true,
          defaultWorkspaceDirectory: this.defaultWorkspaceDirectory,
        } as ToolPermissionContext,
      }),
      abortController: this.abortController!,
      llmClient: this.llmClient,
      classifierModel: this.model,
      messages: this.messages,
    };

    const canUseTool: CanUseToolFn = async (
      toolName: string,
      toolInput?: Record<string, unknown>,
    ) => {
      try {
        const decision = await this.hasPermissionsToUseTool(
          toolName,
          toolInput ?? {},
          permissionContext,
        );
        // Return detailed decision so StreamingToolExecutor can skip checkPermissions
        // when permission is already granted (behavior === 'allow')
        return {
          allowed: decision.behavior !== 'deny',
          behavior: decision.behavior,
        };
      } catch (err) {
        // Fail-closed: if the permission system itself breaks, do not let
        // the tool run. Log the failure so operators can detect it.
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn(`[Agent] canUseTool check threw for ${toolName}, fail-closed with deny: ${reason}`);
        return {
          allowed: false,
          behavior: 'deny',
        };
      }
    };

    return { permissionContext, canUseTool };
  }

  /**
   * Pick the initial message history for this turn.
   *
   * `this.messages` is the source of truth — `getOrCreateAgent` is supposed
   * to have reloaded it from the DB before `streamChat` is called. We only
   * fall back to `options.messages` when `this.messages` is empty (which
   * should not happen in the normal UI flow but can happen in CLI / harness
   * scenarios).
   *
   * The `_prompt` parameter is intentionally ignored: it represents the
   * user's *current* turn input, which is appended later by the loop, not
   * part of the history to replay. It is kept in the signature so the
   * helper can be extended in the future (e.g. prepending a system note
   * derived from the prompt) without changing the call site.
   */
  private _resolveInitialMessages(
    _prompt: string | MessageContent[],
    options?: ChatOptions,
  ): Message[] {
    logger.info(
      `[Agent] streamChat start: this.messages has ${this.messages.length} messages`
    );
    if (this.messages.length > 0) {
      logger.info(
        `[Agent] Using this.messages as source of truth (${this.messages.length} messages)`
      );
      return this.messages;
    }
    if (options?.messages && options.messages.length > 0) {
      this.messages = [...options.messages];
      logger.info(
        `[Agent] Fallback: using options.messages (${this.messages.length} messages)`
      );
      return this.messages;
    }
    logger.info(`[Agent] Edge case: both empty, starting fresh`);
    return this.messages;
  }

  /**
   * Dispatch to an orchestrator-paradigm ModeModifier (plan 224 Phase 1.5+).
   *
   * Orchestrator modes (e.g. research) take over the entire stream with
   * their own multi-stage logic. They receive {@link OrchestratorDeps}
   * (llmClient, toolRegistry, sessionId, etc.) and are responsible for
   * building their own LLM calls, tool execution, and persistence —
   * they do NOT run through the agent tool loop.
   *
   * Tool registry construction is shared with the legacy path so that
   * plugin/MCP tools remain available to orchestrator modes that
   * choose to use them.
   */
  private async *_dispatchOrchestratorMode(
    mod: ModeModifier,
    prompt: string | MessageContent[],
    options?: ChatOptions,
  ): AsyncGenerator<SSEEvent, void, unknown> {
    const queryText = typeof prompt === 'string'
      ? prompt
      : prompt.map((p) => (p.type === 'text' ? p.text : '')).join('\n');

    // Build tool registry for orchestrator (same construction as legacy
    // path — plugin + MCP tools are available to orchestrator modes).
    const { createBuiltinRegistry } = await import('../tool/builtin.js');
    let enabledPluginIds: Set<string> | undefined;
    try {
      const installed = await pluginDb.registryList() as Array<{ id?: unknown; enabled?: unknown }>;
      const enabledIds = installed
        .filter((item) => item.enabled === true && typeof item.id === 'string')
        .map((item) => item.id as string);
      enabledPluginIds = new Set(enabledIds);
    } catch (err) {
      logger.warn(
        `[Agent] Orchestrator mode tool setup: Failed plugin registry; ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const toolRegistry = createBuiltinRegistry(
      this.blockedDomains.length > 0 ? { blockedDomains: this.blockedDomains } : undefined,
      {
        enabledPluginIds,
        wikiAgentEnabled: options?.wikiAgentEnabled,
        mcpManagerProvider: () => this.mcpManager ?? undefined,
        browserBackendMode: this.browserBackendMode,
      }
    );
    this.registerMCPTools(toolRegistry);

    // Plan 224 Phase 3: if a modifier mode (conductor) is active alongside
    // this orchestrator mode (research), inject the modifier's tools into
    // the orchestrator's registry so the orchestrator can call them. The
    // orchestrator manages its own prompt/loop, so we only apply the tool
    // injection — not prompt prefixes or hooks.
    const orchestratorActiveModes = collectActiveModes(options ?? {});
    const orchestratorResolved = orchestratorActiveModes.length > 0
      ? modeModifierRegistry.resolve(orchestratorActiveModes)
      : null;
    if (orchestratorResolved) {
      const orchestratorCtx: ModeModifierContext = {
        sessionId: this.sessionId ?? '',
        workingDirectory: this.workingDirectory ?? '',
        state: {
          conductorCanvasId: options?.conductorCanvasId,
          widgetStyleHistory: this.widgetStyleHistory,
        },
      };
      for (const inject of orchestratorResolved.tools.injects) {
        const items = typeof inject === 'function' ? inject(orchestratorCtx) : inject;
        for (const tr of items) {
          if (!toolRegistry.has(tr.definition.name)) {
            toolRegistry.register(tr.definition, tr.executor);
          }
        }
      }
    }

    const deps: OrchestratorDeps = {
      llmClient: this.llmClient,
      abortController: this.abortController!,
      sessionId: this.sessionId,
      workingDirectory: this.workingDirectory,
      researchMemory: this.researchMemoryRuntime,
      toolRegistry,
      chatOptions: options as Record<string, unknown> | undefined,
      blockedDomains: this.blockedDomains,
    };

    const ctx: ModeModifierContext = {
      sessionId: this.sessionId ?? '',
      workingDirectory: this.workingDirectory ?? '',
      state: {},
    };

    logger.info(`[Agent] Dispatching to orchestrator mode: ${mod.id}`);

    const orchestrator = mod.orchestrator;
    if (!orchestrator) {
      // Defensive — caller already checked mod.orchestrator before invoking
      // _dispatchOrchestratorMode, but TypeScript can't narrow across the
      // method boundary.
      yield {
        type: 'error',
        data: `Mode "${mod.id}" has no orchestrator`,
      } as SSEEvent;
      return;
    }

    try {
      yield* orchestrator.execute(queryText, ctx, deps);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[Agent] Orchestrator mode "${mod.id}" execution failed: ${message}`);
      yield {
        type: 'error',
        data: `${mod.id} mode error: ${message}`,
      } as SSEEvent;
    }
  }

  // === end streamChat helpers ===========================================

  /**
   * Trigger background skill review if the iteration threshold is reached.
   * Fire-and-forget: yields start event immediately, runs review async,
   * and does not block the main conversation's 'done' event.
   *
   * `availableToolNames` is forwarded to `shouldReview()` so the
   * gate can verify `skill_manage` is actually exposed to the LLM
   * (a hidden-disabled flag at the registry level must NOT spawn
   * a sub-agent that depends on the tool).
   */
  private async *_triggerBackgroundReviewWithEvents(
    availableToolNames?: Set<string>,
  ): AsyncGenerator<SSEEvent, void, unknown> {
    if (!this.selfImprover.shouldReview(availableToolNames)) {
      return;
    }

    // Take a snapshot of messages for the review
    const messagesSnapshot = [...this.messages];

    // Reset the counter before spawning to avoid duplicate triggers
    this.selfImprover.reset();

    // Notify UI that review has started
    yield { type: 'skill_review_started' };

    // Fire-and-forget: run review in background without blocking the generator
    this._runBackgroundReview(messagesSnapshot)
      .then(async (result) => {
        await this.onSkillReviewCompleted?.(result);
      })
      .catch((err) => {
        logger.error('[SelfImprover] Background review failed', err);
      });
  }

  private async _runBackgroundReview(messagesSnapshot: Message[]): Promise<import('../self-improver/SelfImprover.js').ImprovementResult> {
    return this.selfImprover.initiateSkillCreation(
      messagesSnapshot,
      {
        apiKey: this.apiKey,
        baseURL: this.baseURL,
        model: this._model,
        provider: this.provider,
      },
      this.workingDirectory
    );
  }

  /**
   * Run the Skill Curator if enough time has passed (default 7 days).
   * Fire-and-forget — never blocks the conversation.
   *
   * The Curator performs:
   *   1. Automatic lifecycle transitions (active → stale → archived)
   *   2. Cluster detection and auto-archival of unused duplicates
   */
  private async _maybeRunCurator(): Promise<void> {
    try {
      if (!await this.curator.shouldRun()) return;
      logger.info('[Curator] Starting periodic skill consolidation');
      const result = await this.curator.run();
      logger.info(`[Curator] Completed in ${result.duration.toFixed(1)}s: ${result.summary}`);
    } catch (err) {
      logger.error('[Curator] Failed', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Trigger background memory review when due.
   *
   * Extracts recent conversation text and fires off a lightweight LLM review
   * pass to identify durable facts worth persisting to MEMORY.md files.
   * Fire-and-forget: does not block the user's next turn.
   */
  private _syncMemoryReview(messages: Message[], assistantResponseLength: number): void {
    try {
      const memoryManager = getMemoryManager()
      if (!memoryManager.getReviewService()) return

      const conversationText = this._extractConversationText(messages, 30)
      const estimatedTokens = Math.max(1, Math.floor(assistantResponseLength / 3))

      memoryManager.syncTurn(conversationText, estimatedTokens)
    } catch {
      // Best-effort — silence all errors
    }
  }

  private _extractConversationText(messages: Message[], maxMessages: number): string {
    const recent = messages.slice(-maxMessages)
    return recent
      .map(msg => {
        const role = msg.role.toUpperCase()
        if (typeof msg.content === 'string') {
          return `[${role}]: ${msg.content.slice(0, 2000)}`
        }
        if (Array.isArray(msg.content)) {
          const textContent = msg.content
            .filter(block => block.type === 'text')
            .map(block => (block as { type: 'text'; text: string }).text)
            .join('\n')
          const toolUses = msg.content
            .filter((b: { type: string; name?: string }) => b.type === 'tool_use')
            .map((b: { type: string; name?: string }) => `[Tool: ${b.name}]`)
            .join(', ')
          let result = `[${role}]: ${textContent.slice(0, 2000)}`
          if (toolUses) result += `\n${toolUses}`
          return result
        }
        return ''
      })
      .filter(Boolean)
      .join('\n\n')
  }

  /**
   * 中断当前对话
   */
  interrupt(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * 获取消息历史
   */
  getMessages(): readonly Message[] {
    return this.messages;
  }

  setMessages(messages: Message[]): void {
    this.messages = [...messages];
    this.sessionInfo.messageCount = messages.length;
    this.sessionInfo.updatedAt = Date.now();
  }

  clearMessages(): void {
    this.messages = [];
    this.sessionInfo.updatedAt = Date.now();
  }

  async initMCPServers(configs: MCPServerConfig[]): Promise<void> {
    if (!configs || configs.length === 0) return;
    this.mcpManager = new MCPManager();
    for (const config of configs) {
      try {
        await this.mcpManager.addServer(config);
      } catch (err) {
        logger.warn(`[Agent] Failed to connect to MCP server "${config.name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private registerMCPTools(registry: ToolRegistry): void {
    if (!this.mcpManager) return;
    const tools = this.mcpManager.getAllTools();
    for (const tool of tools) {
      registry.register(
        {
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema,
        },
        {
          execute: async (input: Record<string, unknown>) => {
            return this.mcpManager!.callTool(tool.serverName, tool.name, input);
          },
        }
      );
    }
    logger.info(`[Agent] Registered ${tools.length} MCP tools from connected servers`);
  }

  // ==========================================================================
  // Phase 2A worker closure: agent-owned MCP runtime
  // ==========================================================================

  /**
   * Get the active agent profile id used for `allowedAgentIds`
   * filtering during MCP apply. `undefined` disables enforcement
   * (every resolved server is allowed). Persisted on the agent so
   * init and reload both see the same value.
   */
  getActiveAgentProfileId(): string | undefined {
    return this.activeAgentProfileId;
  }

  setActiveAgentProfileId(id: string | undefined): void {
    this.activeAgentProfileId = id;
  }

  /**
   * The set of model-visible tool names that are NOT MCP-owned.
   * This is the seed usedNames set for the providerName
   * allocator in PHASE B1: the next apply must never collide
   * with builtin / mode-specific non-MCP tool names. It
   * intentionally does NOT include currently active MCP
   * provider names — full-replace removes them before computing
   * the next state, and including them would cause
   * collision-suffix drift on every repeated reload.
   *
   * Builtin names never start with `mcp_`, so this seed is a
   * clean lower bound for the allocator. The actual
   * mode-specific non-MCP tools are dynamic per mode; we seed
   * with the canonical builtin set and rely on the allocator's
   * `usedNames` parameter to absorb whatever the caller wants.
   */
  getNonMCPModelVisibleToolNames(): Set<string> {
    const builtin = new Set<string>([
      'bash', 'powershell', 'read', 'write', 'edit', 'glob', 'grep',
      'agent', 'team_create', 'team_delete',
      'task', 'enter_worktree', 'exit_worktree',
      'enter_plan_mode', 'exit_plan_mode', 'switch_mode',
      'list_mcp_resources', 'read_mcp_resource',
      'browser', 'skill', 'brief', 'session_search',
      'vision', 'cron', 'duya_info',
      'duya_health', 'memory', 'ask_user_question',
      'module', 'skill_manage',
    ]);
    return builtin;
  }

  /**
   * Atomic install of a new MCP runtime. Called exclusively by
   * `applyMCPConfiguration` (PHASE B2). The agent owns the
   * long-lived MCP registry slot; the new entry set is committed
   * via `replaceByOwner('mcp', ...)` so non-MCP tools in the
   * same registry are untouched. After the commit the previous
   * manager (if any) is disconnected in the background.
   *
   * Returns the `replaceByOwner` bookkeeping
   * (removedKeys/addedKeys/keptKeys) so apply.ts can populate
   * `MCPApplyResult.action.toolsAdded` / `toolsRemoved` for the
   * reload log.
   */
  async setActiveMCPRuntime(install: {
    manager: MCPManager;
    providerNameToInternalKey: Map<string, string>;
    registeredMCPToolKeys: Set<string>;
    toolEntries: Map<string, { definition: Tool; executor: ToolExecutor }>;
    preparedRegistryEntries: Array<{
      key: string;
      definition: Tool;
      executor: ToolExecutor;
    }>;
    snapshot: import('../mcp/apply.js').ActiveMCPRuntimeSnapshot;
  }): Promise<{ removedKeys: string[]; addedKeys: string[]; keptKeys: string[] }> {
    const previousManager = this.mcpManager;
    const previousProviderMap = this.providerNameToInternalKey;
    const previousRegisteredKeys = this.registeredMCPToolKeys;
    const previousToolEntries = this.activeMCPToolEntries;
    const previousSnapshot = this.activeMCPRuntimeSnapshot;

    let replaceResult: { removedKeys: string[]; addedKeys: string[]; keptKeys: string[] };
    try {
      replaceResult = this.activeMCPRegistry.replaceByOwner(
        'mcp',
        install.preparedRegistryEntries,
      );
      this.providerNameToInternalKey = new Map(install.providerNameToInternalKey);
      this.registeredMCPToolKeys = new Set(install.registeredMCPToolKeys);
      this.activeMCPToolEntries = new Map(install.toolEntries);
      this.mcpManager = install.manager;
      this.activeMCPRuntimeSnapshot = install.snapshot;
    } catch (err) {
      // Roll back the partial install. `replaceByOwner` is
      // atomic — it never leaves the registry in a partial
      // state. The catch only covers failures during our
      // post-replace field updates, which require no further
      // rollback of the registry itself.
      this.providerNameToInternalKey = previousProviderMap;
      this.registeredMCPToolKeys = previousRegisteredKeys;
      this.activeMCPToolEntries = previousToolEntries;
      this.activeMCPRuntimeSnapshot = previousSnapshot;
      this.mcpManager = previousManager;
      throw err;
    }

    if (previousManager && previousManager !== install.manager) {
      void previousManager.disconnectAll().catch(() => undefined);
    }
    return replaceResult;
  }

  /**
   * Resolve a model-returned tool name to the internalKey the
   * `ToolRegistry` looks up. For MCP tools, the model returns the
   * `providerName`; this method consults the alias map installed
   * by the most recent successful apply and returns the matching
   * internalKey. For builtin tools, the model returns the
   * tool's `name` (which equals the internalKey), so the alias
   * lookup falls through and the original name is returned.
   */
  resolveMCPToolNameToInternalKey(name: string): string {
    return this.providerNameToInternalKey.get(name) ?? name;
  }

  /**
   * 获取当前工作目录
   */
  getWorkingDirectory(): string | undefined {
    return this.workingDirectory;
  }

  /**
   * 设置工作目录
   */
  setWorkingDirectory(directory: string): void {
    this.workingDirectory = directory;
    // Also update the prompt manager's working directory
    if (this.promptManager) {
      this.promptManager.setWorkingDirectory(directory);
    }
  }

  /**
   * Set permission mode for tool execution
   */
  setPermissionMode(mode: string): void {
    const validMode = permissionModeFromString(mode);
    this.permissionMode = validMode;
    logger.info(`[Agent] Permission mode set to: ${validMode}`);
  }

  /**
   * 获取会话信息
   */
  getSessionInfo(): SessionInfo {
    return { ...this.sessionInfo };
  }

  /**
   * 添加用户消息
   */
  addMessage(message: Message): void {
    this.messages.push({
      ...message,
      timestamp: message.timestamp ?? Date.now(),
    });
  }

  /**
   * 检查是否应该进行压缩
   */
  shouldCompact(): boolean {
    this.compactionManager.updateContextTokens(this.messages);
    return this.compactionManager.shouldCompact();
  }

  /**
   * 获取当前上下文统计信息
   */
  getContextStats() {
    this.compactionManager.updateContextTokens(this.messages);
    return this.compactionManager.getStats();
  }

  /**
   * Compress message history to save context window space.
   *
   * Uses an LLM to summarize older messages, preserving the system message
   * and the most recent turns, and folding the middle.
   *
   * @deprecated Prefer `compact()`. The new `CompactionManager` supports
   * multiple strategies (micro / session_memory / snip / reactive) and is
   * wired into `streamChat`'s proactive (pre-turn) and reactive (mid-turn
   * error recovery) paths. This method is kept only for external callers
   * that depend on its specific return shape (`{ messagesCompressed,
   * estimatedTokensSaved }`); new code should call `compact()` instead.
   * Will be removed in the next minor release. See Plan 211 Phase E.
   */
  async compressHistory(options?: {
    maxMessagesToKeep?: number;
    model?: string;
  }): Promise<{ messagesCompressed: number; estimatedTokensSaved: number }> {
    logger.warn('compressHistory is deprecated, use compactionManager.compact instead');
    if (this.messages.length === 0) {
      return { messagesCompressed: 0, estimatedTokensSaved: 0 };
    }

    const maxMessagesToKeep = options?.maxMessagesToKeep ?? 50;

    // Call LLM-based compactHistory with the agent's LLM summarizer
    const result = await compactHistory(this.messages, {
      summarize: async (text: string, prompt: string): Promise<string> => {
        const summaryMessages: Message[] = [
          {
            role: 'user',
            content: text,
          },
        ];

        const chunks: string[] = [];
        const stream = this.llmClient.streamChat(summaryMessages, {
          systemPrompt: prompt,
          maxTokens: 4096,
          temperature: 0.3,
          signal: new AbortController().signal,
        });

        for await (const event of stream) {
          if (event.type === 'text') {
            chunks.push(event.data);
          }
          if (event.type === 'done' || event.type === 'error') {
            break;
          }
        }

        return chunks.join('').trim();
      },
      maxMessagesToKeep,
    });

    // If no compression happened (conversation was small enough), return early
    if (result.messagesCompressed === 0) {
      return {
        messagesCompressed: 0,
        estimatedTokensSaved: 0,
      };
    }

    // Reconstruct messages: system messages + summary + recent messages
    const SYSTEM_MESSAGE_PREFIXES = ['system', 'instruction', 'You are', 'You are a', 'This session is being continued'];

    const systemMessages: Message[] = [];
    const conversationMessages: Message[] = [];

    for (const msg of this.messages) {
      const isSystem =
        msg.role === 'system' ||
        SYSTEM_MESSAGE_PREFIXES.some((prefix) =>
          typeof msg.content === 'string' && msg.content.startsWith(prefix)
        );

      if (isSystem) {
        systemMessages.push(msg);
      } else {
        conversationMessages.push(msg);
      }
    }

    const recentMessages = conversationMessages.slice(-maxMessagesToKeep);

    // Build compressed history: system + LLM summary + recent
    const summaryMessage: Message = {
      role: 'system',
      content: result.summary,
      timestamp: Date.now(),
    };

    this.messages = [...systemMessages, summaryMessage, ...recentMessages];
    this.sessionInfo.messageCount = this.messages.length;
    this.sessionInfo.updatedAt = Date.now();

    return {
      messagesCompressed: result.messagesCompressed,
      estimatedTokensSaved: result.estimatedTokensSaved,
    };
  }

  /**
   * 使用新的 CompactionManager 压缩消息历史
   * 支持多种压缩策略: micro, session_memory, snip, reactive
   */
  async compact(options?: CompactOptions): Promise<{
    strategy: string;
    tokensRemoved: number;
    tokensRetained: number;
  }> {
    if (this.messages.length === 0) {
      return { strategy: 'none', tokensRemoved: 0, tokensRetained: 0 };
    }

    // Set up summarizer if we have an LLM client
    if (!this.compactionManager) {
      return { strategy: 'none', tokensRemoved: 0, tokensRetained: 0 };
    }

    // Execute compaction
    const result = await this.compactionManager.compact(this.messages, options);

    // Update messages
    this.messages = result.messages;
    this.sessionInfo.messageCount = this.messages.length;
    this.sessionInfo.updatedAt = Date.now();

    return {
      strategy: result.strategy,
      tokensRemoved: result.tokensRemoved,
      tokensRetained: result.tokensRetained,
    };
  }
}

/**
 * Build the identity block prepended to the system prompt when an agent profile is applied.
 * This tells the LLM clearly what role it should play.
 *
 * When the profile provides `identityPrompt`, that single concise
 * sentence is used verbatim — it lets a preset express a precise role
 * (e.g. the gateway relay agent) without the generic name/description
 * scaffolding. Otherwise fall back to the generic block.
 */
function buildAgentIdentityBlock(profile: AgentProfile): string {
  if (profile.identityPrompt) {
    return profile.identityPrompt;
  }

  const lines: string[] = [
    `You are a "${profile.name}" agent.`,
  ];

  if (profile.description) {
    lines.push(`Your role: ${profile.description}.`);
  }

  return lines.join('\n');
}
