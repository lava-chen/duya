/**
 * duyaAgent - AI Agent 核心类
 * 提供流式对话、工具调用、会话管理能力
 */

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
} from './types.js';
import { PromptManager, asSystemPrompt, getPromptProfileForAgentProfile, PromptsRegistry, resolvePromptSystemName } from './prompts/index.js';
import type { PromptSystem } from './prompts/index.js';
import { getMemoryManager } from './memory/index.js';
import { compactHistory } from './compact/compact.js';
import type { CompactResult, TokenEstimation } from './compact/compact.js';
import { estimateContextTokens, needsCompression, DEFAULT_CONTEXT_WINDOW, COMPRESSION_THRESHOLD } from './compact/compact.js';
import { createLLMClient, createRetryableLLMClient, inferProvider, isMiniMaxURL, LLMClientWrapper } from './llm/index.js';
import type { LLMClient, RetryConfig } from './llm/index.js';
import { StreamingToolExecutor } from './tool/StreamingToolExecutor.js';
import type { CanUseToolFn } from './tool/StreamingToolExecutor.js';
import { createHasPermissionsToUseTool } from './permissions/permissions.js';
import type { ToolPermissionCheckContext } from './permissions/permissions.js';
import type { ToolPermissionContext, PermissionMode } from './permissions/types.js';
import { permissionModeFromString } from './permissions/PermissionMode.js';
import { logger } from './utils/logger.js';
import { getAgentProfileService } from './agent-profile/AgentProfileService.js';
import type { AgentProfile } from './agent-profile/types.js';
import { resolveAllowedTools } from './agent-profile/ToolFilter.js';

// Compaction system exports
export type {
  CompactionStats,
  CompactionResult,
  CompactionStrategy,
  CompactionEvent,
  TokenBudget,
  TokenBudgetConfig,
  CompactOptions,
  CompactionManagerConfig,
} from './compact/index.js';
export {
  CompactionManager,
  createCompactionManager,
  createTokenBudget,
  MicroCompactStrategy,
  SessionMemoryCompactStrategy,
  SnipCompactStrategy,
  ReactiveCompactStrategy,
  estimateMessageTokens,
  estimateMessagesTokens,
  DEFAULT_BUDGET_CONFIG,
  COMPACTION_THRESHOLDS,
} from './compact/index.js';

export type { Message, Tool, ToolUse, SSEEvent, AgentOptions, ChatOptions, MCPServerConfig, MCPConnectionStatus, CompactResult, TokenEstimation };
export { compactHistory, estimateContextTokens, needsCompression, DEFAULT_CONTEXT_WINDOW, COMPRESSION_THRESHOLD };

// 导出工具相关
export { ToolRegistry } from './tool/registry.js';
export { createBuiltinRegistry } from './tool/builtin.js';
export { StreamingToolExecutor } from './tool/StreamingToolExecutor.js';

// Sandbox exports
export { setSandboxEnabled, buildSandboxImage } from './sandbox/index.js';
export type {
  ToolStatus,
  TrackedTool,
  ToolProgress,
  ToolExecutionContext,
  ToolExecutionResult,
  MessageUpdate,
  CanUseToolFn,
  CanUseToolDecision,
} from './tool/StreamingToolExecutor.js';

// Export MCP related
export { MCPManager, MCPClient } from './mcp/index.js';
export { loadMCPConfigs, loadMCPConfigsFromSettings, getSettingsPath, validateMCPConfig } from './mcp/config.js';
export type { MCPConfigItem, MCPConfigLoadResult } from './mcp/config.js';
export { MCPStatusManager, getMCPStatusManager, resetMCPStatusManager } from './mcp/status.js';
export type { MCPStatusInfo, StatusChangeCallback } from './mcp/status.js';
export { CircuitBreaker, CircuitBreakerManager, getCircuitBreakerManager, resetCircuitBreakerManager, DEFAULT_CIRCUIT_CONFIG } from './mcp/circuit-breaker.js';
export type { CircuitState, CircuitBreakerConfig } from './mcp/circuit-breaker.js';
export { discoverMCPTools, registerMCPTools, getToolSource, isMCPTool, getToolsByServer } from './mcp/discovery.js';
export type { ToolDiscoveryResult, ToolRegistrationResult, ConflictStrategy } from './mcp/discovery.js';
export { MCPNotificationHandler, createNotificationHandler } from './mcp/notifications.js';
export type { NotificationHandlerOptions } from './mcp/notifications.js';

// 导出 Session 相关
export { SessionManager } from './session/index.js';
export type { SessionStore, SessionManagerOptions } from './session/index.js';

// 导出 Permissions 相关
export type {
  PermissionMode,
  PermissionBehavior,
  PermissionDecision,
  PermissionResult,
  PermissionRule,
  ToolPermissionContext,
} from './permissions/index.js';
export { createHasPermissionsToUseTool } from './permissions/permissions.js';
export type { ToolPermissionCheckContext } from './permissions/permissions.js';

// 导出 Prompt 相关
export { PromptManager, getPlatformHint, hasPlatformCapability, PLATFORM_HINTS } from './prompts/index.js';
export type { CommunicationPlatform } from './prompts/types.js';

// 导出 AGENTS.md 相关
export {
  AgentsMdManager,
  getAgentsMdManager,
  resetAgentsMdManager,
  createAgentsMdManager,
  loadAgentsMdFiles,
  buildAgentsMdPrompt,
  isAgentsMdFile,
} from './agentsmd/index.js';
export type {
  AgentsFileInfo,
  AgentsMemoryType,
  AgentsMdConfig,
} from './agentsmd/index.js';

// 导出 Skill 相关
export {
  SkillRegistry,
  getSkillRegistry,
  resetSkillRegistry,
  loadSkills,
  loadMcpSkills,
  getSkillDirectories,
  SkillManager,
  skillManage,
} from './skills/index.js';
export type {
  SkillArgument,
  SkillSource,
  SkillResult,
  SkillMetadata,
  SkillFrontmatter,
  BundledSkillDefinition,
  PromptSkill,
  SkillLoadOptions,
  SkillManageParams,
} from './skills/index.js';

// 导出 Task 相关
export {
  getDatabaseTaskStore,
  type Task,
  type TaskStatus,
  type TaskStore
} from './session/task-store.js';

// 导出 SelfImprover 相关
export {
  SelfImprover,
  getDefaultSelfImprover,
  resetDefaultSelfImprover,
} from './self-improver/SelfImprover.js';
export type { SkillReviewResult } from './self-improver/SelfImprover.js';
import { SelfImprover } from './self-improver/SelfImprover.js';

// Agent Profile exports
export type {
  AgentProfile,
  AgentProfileDbRow,
  ToolFilterContext,
  ToolFilterResult,
} from './agent-profile/index.js';
export {
  PRESET_AGENT_PROFILES,
  InMemoryAgentProfileService,
  getAgentProfileService,
  resetAgentProfileService,
  setAgentProfileService,
  rowToAgentProfile,
  profileToRow,
  filterTools,
  resolveAllowedTools,
  validateToolAccess,
  matchToolPattern,
  expandToolGroups,
  getEmojiForProfile,
  getColorForProfile,
  getIdentityLabel,
} from './agent-profile/index.js';

import { ToolRegistry } from './tool/registry.js';
import { CompactionManager, createCompactionManager } from './compact/CompactionManager.js';
import type { CompactOptions } from './compact/types.js';

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
  private permissionMode: PermissionMode = 'default'; // Permission mode for tool execution
  private hasPermissionsToUseTool: ReturnType<typeof createHasPermissionsToUseTool>;
  private selfImprover: SelfImprover; // Self-improvement tracker for skill creation
  private visionClient?: LLMClient; // Optional vision model client
  private visionConfig?: import('./types.js').VisionConfig; // Vision model configuration
  private blockedDomains: string[] = [];

  constructor(options: AgentOptions) {
    const provider = options.provider || inferProvider(options.baseURL || '');
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
    this.sessionInfo = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
    };

    this.model = options.model;

    // Initialize vision model client if configured
    logger.info(`[duyaAgent] Vision config check: enabled=${options.visionConfig?.enabled}, provider=${options.visionConfig?.provider}, model=${options.visionConfig?.model}`);
    if (options.visionConfig?.enabled) {
      this.visionConfig = options.visionConfig;
      const visionProvider = inferProvider(options.visionConfig.baseURL || '', options.visionConfig.provider);
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

    this.compactionManager = createCompactionManager({
      enableReinjection: true,
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
      const stream = this.llmClient.streamChat(summaryMessages, {
        systemPrompt: prompt,
        maxTokens: 4096,
        temperature: 0.3,
        signal: new AbortController().signal,
      });

      for await (const event of stream) {
        if (event.type === 'text') {
          result.push(event.data);
        }
        if (event.type === 'done' || event.type === 'error') {
          break;
        }
      }

      return result.join('').trim();
    });

    // Initialize permission system
    this.permissionMode = options.permissionMode || 'default';
    this.hasPermissionsToUseTool = createHasPermissionsToUseTool();

    // Initialize self-improvement system
    this.selfImprover = new SelfImprover(options.skillNudgeInterval);

    // Store blocked domains for browser tool
    this.blockedDomains = options.blockedDomains ?? [];
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
   * Returns text description of the image, or empty string if vision is unavailable.
   */
  async analyzeImage(imageBase64: string, mediaType: string, customPrompt?: string): Promise<string> {
    console.log('[duyaAgent] analyzeImage called:', {
      hasVisionClient: !!this.visionClient,
      visionConfig: this.visionConfig,
      imageBase64Length: imageBase64.length,
      mediaType,
      customPrompt: customPrompt?.substring(0, 100),
    });

    if (!this.visionClient) {
      logger.warn('[duyaAgent] analyzeImage: No vision client configured');
      console.log('[duyaAgent] analyzeImage: returning empty string - no vision client');
      return '';
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
    try {
      console.log('[duyaAgent] Starting vision stream...');
      const stream = this.visionClient.streamChat([userMessage], {
        maxTokens: 1024,
        temperature: 0,
      });

      let eventCount = 0;
      for await (const event of stream) {
        eventCount++;
        console.log('[duyaAgent] Vision stream event:', event.type, eventCount);
        if (event.type === 'text') {
          result.push(event.data);
          console.log('[duyaAgent] Vision text event:', event.data?.substring(0, 100));
        }
        if (event.type === 'done' || event.type === 'error') {
          console.log('[duyaAgent] Vision stream ended:', event.type);
          break;
        }
      }
      console.log('[duyaAgent] Vision stream finished, events:', eventCount);
    } catch (err) {
      console.log('[duyaAgent] Vision analysis exception:', err instanceof Error ? err.message : String(err));
      logger.warn(`[duyaAgent] Vision analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      return '';
    }

    const analysis = result.join('').trim();
    console.log('[duyaAgent] Vision analysis complete:', { resultLength: analysis.length, preview: analysis.substring(0, 100) });
    logger.info(`[duyaAgent] Vision analysis complete: ${analysis.length} chars`);
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

    // Get tools: use provided registry or default to built-in registry
    logger.info(`[Agent] streamChat: Loading tools...`);
    let registry = options?.toolRegistry;
    if (!registry) {
      const { createBuiltinRegistry } = await import('./tool/builtin.js');
      registry = createBuiltinRegistry(
        this.blockedDomains.length > 0 ? { blockedDomains: this.blockedDomains } : undefined
      );
    }
    const allTools = registry.getAllTools();

    // Apply agent profile if provided (before tool filtering)
    let appliedProfile: AgentProfile | undefined;
    if (options?.agentProfileId) {
      const profileService = getAgentProfileService();
      const profile = profileService.get(options.agentProfileId);
      if (profile) {
        appliedProfile = profile;
        logger.info(`[Agent] Applying agent profile: ${profile.name} (${profile.id})`);
      } else {
        logger.warn(`[Agent] Agent profile not found: ${options.agentProfileId}`);
      }
    }

    // Apply tool filtering: disabledTools -> agent profile allowedTools/disallowedTools
    let tools: Tool[] = allTools;

    // Layer 1: Filter by disabledTools option
    if (options?.disabledTools?.length) {
      tools = tools.filter(t => !options.disabledTools!.includes(t.name));
      logger.info(`[Agent] streamChat: Filtered tools by disabledTools, ${tools.length}/${allTools.length} enabled`);
    }

    // Layer 2: Filter by agent profile allowedTools/disallowedTools
    if (appliedProfile) {
      const allToolNames = tools.map(t => t.name);
      const filterResult = resolveAllowedTools(appliedProfile, allToolNames);

      if (filterResult.isValid) {
        const allowedToolSet = new Set(filterResult.allowed);
        tools = tools.filter(t => allowedToolSet.has(t.name));
        logger.info(`[Agent] streamChat: Filtered tools by agent profile, ${tools.length}/${allToolNames.length} enabled`);

        if (filterResult.denied.length > 0) {
          logger.info(`[Agent] streamChat: Denied tools: ${filterResult.denied.join(', ')}`);
        }
      } else {
        logger.warn(`[Agent] streamChat: Agent profile filtering resulted in no available tools`);
      }
    }

    logger.info(`[Agent] streamChat: Loaded ${tools.length} tools`);

    // Load agent definitions
    logger.info(`[Agent] streamChat: Loading agent definitions...`);
    const { getAgentDefinitions } = await import('./tool/AgentTool/index.js');
    const agentDefinitions = getAgentDefinitions();
    logger.info(`[Agent] streamChat: Loaded ${agentDefinitions.length} agent definitions`);

    // Determine which prompt system to use based on agent profile
    // Default to 'general' prompt system if no profile is specified
    const sysName = resolvePromptSystemName(appliedProfile?.promptSystem);
    const promptSystem = PromptsRegistry.get(sysName) ?? PromptsRegistry.get('general')!;
    logger.info(`[Agent] Using prompt system '${sysName}'${appliedProfile ? ` for profile: ${appliedProfile.name}` : ' (default)'}`);

    // Apply output style config if provided
    if (options?.outputStyleConfig) {
      logger.info(`[Agent] Applying output style: ${options.outputStyleConfig.name}`);
      this.promptManager.updateOptions({ outputStyleConfig: options.outputStyleConfig });
    }

    // Build system prompt: respect disableSystemPrompt option
    let systemPromptContent: string;
    if (options?.disableSystemPrompt) {
      systemPromptContent = '';
      logger.info('[Agent] streamChat: System prompt disabled (empty)');
    } else if (options?.systemPrompt) {
      systemPromptContent = options.systemPrompt;
    } else {
      const enabledToolNames = tools.map(t => t.name);
      const context = promptSystem.buildContext({
        workingDirectory: this.workingDirectory,
        modelId: this.model,
        modelName: this.model,
        enabledTools: new Set(enabledToolNames),
        outputStyleConfig: options?.outputStyleConfig,
      });
      const systemPromptResult = await promptSystem.buildSystemPrompt(context);
      systemPromptContent = [...systemPromptResult].join('\n\n');
    }

    // Prepend system prompt prefix if provided
    if (options?.systemPromptPrefix) {
      systemPromptContent = options.systemPromptPrefix + '\n\n' + systemPromptContent;
      logger.info('[Agent] streamChat: Added system prompt prefix');
    }

    // Inject agent profile identity into system prompt
    if (appliedProfile) {
      const identityBlock = buildAgentIdentityBlock(appliedProfile);
      systemPromptContent = identityBlock + '\n\n' + systemPromptContent;
    }

    // Permission check function - use real permission system
    // Create minimal permission context for this session
    const permissionContext: ToolPermissionCheckContext = {
      getAppState: () => ({
        toolPermissionContext: {
          mode: this.permissionMode,
          additionalWorkingDirectories: new Map(),
          alwaysAllowRules: {},
          alwaysDenyRules: {},
          alwaysAskRules: {},
          isBypassPermissionsModeAvailable: true,
        } as ToolPermissionContext,
      }),
      abortController: this.abortController!,
    };

    const canUseTool: CanUseToolFn = async (toolName: string) => {
      try {
        const decision = await this.hasPermissionsToUseTool(
          toolName,
          {},
          permissionContext
        );
        // Return detailed decision so StreamingToolExecutor can skip checkPermissions
        // when permission is already granted (behavior === 'allow')
        return {
          allowed: decision.behavior !== 'deny',
          behavior: decision.behavior,
        };
      } catch {
        // On error, default to allowing (fail open for better UX)
        return true;
      }
    };

    // Build message history for this turn
    // Key insight: getOrCreateAgent (called before streamChat) guarantees
    // this.messages contains the latest messages from DB. So we always use
    // this.messages as the source of truth. Only use options.messages as fallback
    // if this.messages is empty (shouldn't happen in normal flow).
    let messages: Message[];

    if (this.messages.length > 0) {
      // Normal case: use this.messages as source of truth
      messages = this.messages;
    } else if (options?.messages && options.messages.length > 0) {
      // Fallback: this.messages is empty, use options.messages as base
      // This shouldn't happen in normal flow since getOrCreateAgent reloads from DB
      this.messages = [...options.messages];
      messages = this.messages;
    } else {
      // Edge case: both empty, start fresh
      messages = this.messages;
    }

    let turnCount = 0;
    const maxTurns = options?.maxTurns ?? 100;

    // Generate a unique seq_index for this streamChat call
    // All messages created in this call (including multi-turn) will share this seq_index
    // This allows the UI to group all related messages into a single "round"
    const seqIndex = Date.now();

    // Track total elapsed time for the entire stream (including all turns and tool execution)
    const streamStartTime = Date.now();

    while (!this.abortController.signal.aborted) {
      turnCount++;
      const turnStartTime = Date.now();

      // Only add user message on first turn (original prompt)
      // Subsequent turns are continuations after tool results, not new prompts
      if (turnCount === 1) {
        // Check if the last message is already a user message with the same content
        // This prevents duplicates when messages are pre-loaded from DB before streamChat is called
        const lastMessage = messages[messages.length - 1];
        // Use displayContent for comparison when available (original prompt without synthetic context)
        // For MessageContent[] prompts, extract text blocks for comparison
        const rawCompareContent = options?.displayContent ?? (typeof prompt === 'string' ? prompt : Array.isArray(prompt) ? prompt : '');
        const compareContent = typeof rawCompareContent === 'string'
          ? rawCompareContent
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
        const isDuplicate = lastMessage &&
          lastMessage.role === 'user' &&
          (lastMessageContent === compareContent ||
            lastMessageContent.trim() === compareContent.trim());

        if (!isDuplicate) {
          messages.push({
            id: crypto.randomUUID(),
            role: 'user',
            content: prompt as string | MessageContent[],
            timestamp: Date.now(),
            seq_index: seqIndex,
            attachments: (options as ChatOptions & { attachments?: Message['attachments'] })?.attachments,
          } as Message);
        } else if (lastMessage) {
          lastMessage.seq_index = seqIndex;
          const newAttachments = (options as ChatOptions & { attachments?: Message['attachments'] })?.attachments;
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
        options: {
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
        },
        // Permission callback - passed from ChatOptions by API route
        requestPermission: options?.requestPermission,
        // IPC for conductor executor communication
        ipcRequest: options?.conductorIpc?.ipcRequest,
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

      // Proactive context compaction before each LLM call
      if (this.shouldCompact()) {
        logger.info(`[Agent] Turn ${turnCount}: Proactive compaction triggered`);
        try {
          const compactResult = await this.compact();
          logger.info(`[Agent] Turn ${turnCount}: Compacted with strategy=${compactResult.strategy}, removed=${compactResult.tokensRemoved} tokens, retained=${compactResult.tokensRetained} tokens`);
          // Update messages reference since compact() replaces this.messages
          messages = this.messages;
        } catch (compactError) {
          const compactErrorMsg = compactError instanceof Error ? compactError.message : String(compactError);
          logger.error(`[Agent] Turn ${turnCount}: Proactive compaction failed: ${compactErrorMsg}`);
          // Continue anyway — let the API call fail if truly over limit
        }
      }

      try {
        // Stream from LLM with FULL message history
        logger.info(`[Agent] Turn ${turnCount}: Starting LLM stream, messages=${messages.length}, provider=${this.provider}`);
        let llmEventCount = 0;
        logger.info(`[Agent] Turn ${turnCount}: Calling llmClient.streamChat...`);
        const streamGenerator = this.llmClient.streamChat(messages, {
          systemPrompt: systemPromptContent,
          tools,
          maxTokens: options?.maxTokens ?? 4096,
          temperature: options?.temperature ?? 1,
          signal: this.abortController.signal,
        });
        logger.info(`[Agent] Turn ${turnCount}: Stream generator created, starting iteration...`);
        for await (const event of streamGenerator) {
          llmEventCount++;
          if (event.type === 'text' || event.type === 'thinking') {
            logger.debug(`[Agent] LLM event ${llmEventCount}: type=${event.type}, data_length=${String(event.data).length}`);
          } else {
            logger.debug(`[Agent] LLM event ${llmEventCount}: type=${event.type}`);
          }

          if (event.type === 'tool_use') {
            toolCallCountThisTurn++;

            // Track skill_manage usage for self-improvement
            if (event.data.name === 'skill_manage') {
              this.selfImprover.onSkillManageUsed();
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
                    },
                  };
                }
              }
            }
            logger.debug(
              `[Agent] Turn ${turnCount}: getRemainingResults completed, toolResultMessageCount=${toolResultMessageCount}`
            );

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

        // Check max turns limit
        if (turnCount >= maxTurns) {
          // Update this.messages BEFORE yielding done event
          this.messages = messages;
          this.sessionInfo.messageCount = this.messages.length;
          this.sessionInfo.updatedAt = Date.now();

          // Trigger background skill review if needed
          yield* this._triggerBackgroundReviewWithEvents();

          yield { type: 'done', reason: 'max_turns' };
          return;
        }

        // If no tool_use blocks were emitted, we're done
        // Note: assistant message was already added in 'done' event handler
        if (!needsFollowUp) {
          // Update this.messages BEFORE yielding done event
          // so API route can retrieve the final state
          this.messages = messages;
          this.sessionInfo.messageCount = this.messages.length;
          this.sessionInfo.updatedAt = Date.now();

          // Trigger background skill review if needed
          yield* this._triggerBackgroundReviewWithEvents();

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
        this.messages = messages;
        this.sessionInfo.messageCount = this.messages.length;
        this.sessionInfo.updatedAt = Date.now();

        if (error instanceof Error && error.name === 'AbortError') {
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
    this.messages = messages;
    this.sessionInfo.messageCount = this.messages.length;
    this.sessionInfo.updatedAt = Date.now();
    yield { type: 'done', reason: 'aborted' };
  }

  /**
   * Trigger background skill review if the iteration threshold is reached.
   * Fire-and-forget: yields start event immediately, runs review async,
   * and does not block the main conversation's 'done' event.
   */
  private async *_triggerBackgroundReviewWithEvents(): AsyncGenerator<SSEEvent, void, unknown> {
    if (!this.selfImprover.shouldReview()) {
      return;
    }

    // Take a snapshot of messages for the review
    const messagesSnapshot = [...this.messages];

    // Reset the counter before spawning to avoid duplicate triggers
    this.selfImprover.reset();

    // Notify UI that review has started
    yield { type: 'skill_review_started' };

    // Fire-and-forget: run review in background without blocking the generator
    this._runBackgroundReview(messagesSnapshot).catch((err) => {
      logger.error('[SelfImprover] Background review failed', err);
    });
  }

  private async _runBackgroundReview(messagesSnapshot: Message[]): Promise<import('./self-improver/SelfImprover.js').ImprovementResult> {
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
   * 压缩消息历史以节省上下文窗口
   * 使用 LLM 生成摘要，保留系统消息和最近的对话，折叠中间的旧消息
   */
  async compressHistory(options?: {
    maxMessagesToKeep?: number;
    model?: string;
  }): Promise<{ messagesCompressed: number; estimatedTokensSaved: number }> {
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
 */
function buildAgentIdentityBlock(profile: AgentProfile): string {
  const lines: string[] = [
    `You are a "${profile.name}" agent.`,
  ];

  if (profile.description) {
    lines.push(`Your role: ${profile.description}.`);
  }

  return lines.join('\n');
}

export default duyaAgent;
