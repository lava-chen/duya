/**
 * duyaAgent - AI Agent 核心类
 * 提供流式对话、工具调用、会话管理能力
 *
 * Implementation home for the `duyaAgent` class. The public surface
 * (type re-exports, supporting utilities) lives in `src/index.ts`,
 * which re-exports `duyaAgent` from this file. Pure helpers
 * (`extractTextFromContent`, `persistableMessages`,
 * `buildAgentIdentityBlock`, etc.) live in `./utils/agent-helpers.ts`.
 */

import {
  DEFAULT_MAX_OUTPUT_TOKENS,
} from '../types.js';
import type {
  AgentOptions,
  AgentRuntimeMode,
  ChatOptions,
  FileAttachment,
  Message,
  MessageContent,
  Tool,
  ToolUse,
  SSEEvent,
  SessionInfo,
  ToolUseContext,
  ToolResultContent,
  AgentProgressEvent,
} from '../types.js';
import { asSystemPrompt, DEFAULT_PROMPT_PROFILE, getPromptProfileForAgentProfile, PromptsRegistry, resolvePromptSystemName } from '../prompts/index.js';
import type { PromptSystem } from '../prompts/index.js';
import { getAgentsMdManager } from '../agentsmd/index.js';
import { DEFAULT_CONTEXT_WINDOW } from '../compact/compact.js';
import { microCleanupMessages } from '../compact/microCompactCleanup.js';
import { compressHistoricalCanvasToolCalls } from '../compact/canvasHistoryCompress.js';
import { createAIClient, createAIClientWithRetry, inferProvider } from '@duya/ai';
import type { AIClient, AIClientOptions, RetryConfig } from '@duya/ai';
import { resolveLlmClientDiscriminator } from '@duya/ai';
import { stripPastedContentMarkers } from '../utils/pasted-content.js';
import { StreamingToolExecutor } from '../tool/StreamingToolExecutor.js';
import type { CanUseToolFn } from '../tool/StreamingToolExecutor.js';
import type { WidgetStyleSignature, CanvasFreshnessState } from '../types.js';
import { createHasPermissionsToUseTool } from '../permissions/permissions.js';
import type { ToolPermissionCheckContext } from '../permissions/permissions.js';
import type { ToolPermissionContext, PermissionMode, ToolPermissionRulesBySource, AdditionalWorkingDirectory, PermissionRuleSource } from '../permissions/types.js';
import { permissionModeFromString } from '../permissions/policy.js';
import { settingsJsonToRules } from '../permissions/rules.js';
import { permissionRuleValueToString } from '../permissions/rules.js';
import { logger } from '../utils/logger.js';
import { createChildAbortController } from '../abort/index.js';
import { getAgentProfileService } from '../agent-profile/AgentProfileService.js';
import type { AgentProfile } from '../agent-profile/types.js';
import { isToolVisible, type ToolVisibilityConstraints } from '../agent-profile/ToolFilter.js';
import { mailboxDb, pluginDb } from '../ipc/db-client.js';
import { MCPManager } from '../mcp/index.js';
import { buildMCPCapabilityCatalog } from '../mcp/capability-catalog.js';
import type { MailboxRow } from '../session/db.js';
import path from 'node:path';

// Mode System imports (the class is the only consumer in this file;
// the public re-exports live in src/index.ts).
import { modeModifierRegistry } from '../modes/index.js';
import type { ModeModifier, ModeModifierContext, OrchestratorDeps, ResolvedMode, ToolRegistration } from '../modes/index.js';
import { applyModes, collectActiveModes } from '../modes/apply-modes.js';

import { ToolRegistry } from '../tool/registry.js';
import type { ToolExecutor } from '../tool/registry.js';
import { toolSearchTool } from '../tool/ToolSearchTool/ToolSearchTool.js';
import { searchToolsFromRegistry } from '../tool/ToolSearchTool/searchTools.js';
import {
  getDiscoveredToolPrompts,
  harvestDiscoveredTools,
} from './tool-search-discovery.js';
import type { AgentDefinition } from '../tool/SubagentTool/index.js';
import { CompactionManager, createCompactionManager } from '../compact/CompactionManager.js';
import type { CompactOptions } from '../compact/types.js';

// New message domain framework (plan 315)
import {
  MessageTimeline,
  buildAgentContext,
  ingestMessage,
  ingestMessages,
  projectModelMessages,
  extractLegacySystemSegments,
  projectTimelinePersistenceMessages,
  getLegacyCompactionCheckpoint,
  type CompactionEntry,
  type RuntimeContextAgentMessage,
  type AgentMessage,
} from '../message/index.js';
import { MessageCompactionController } from '../message/message-compaction-controller.js';
import {
  adaptAttachmentContext,
  adaptBackgroundNotification,
  adaptMailboxRows,
  projectRuntimeContextToProviderMessage,
  RUNTIME_CONTEXT_METADATA_KEYS,
} from '../message/runtime-context-adapters.js';
import { persistLargePastedAttachments } from '../utils/attachment-context.js';
import {
  EMPTY_DISCOVERED,
  extractTextFromContent,
  collectRecentImageAttachments,
  persistableMessages,
  computeCachePlanFingerprint,
  chooseMailboxApplyMode,
  buildAgentIdentityBlock,
  type RuntimeMailboxDecision,
  type RuntimeMailboxClaim,
} from './utils/agent-helpers.js';
import { VisualAnalysisService } from './visual-analysis.js';

/**
 * duyaAgent 类
 */
export class duyaAgent {
  private llmClient: AIClient;
  /**
   * Plan 315: durable persistence projection derived from the append-only
   * timeline (single source of truth). Recomputes on every read and excludes
   * transient runtime-only entries (mailbox, background notifications).
   * Kept as a getter so the write path never double-writes a separate array
   * (the old field would drift from the timeline).
   */
  get messages(): Message[] {
    return projectTimelinePersistenceMessages(this.timeline.snapshot());
  }
  /**
   * Plan 315: append-only message timeline. The runtime authority for the
   * conversation history. `messages` (above) is the durable provider-shaped
   * projection of this timeline for legacy callers.
   */
  private timeline = new MessageTimeline();
  /** Plan 315: tracks message ids already appended to timeline, O(1) dedup. */
  private syncedMessageIds: Set<string> = new Set();
  /**
   * Plan 315: bridges the legacy CompactionManager to the append-only
   * timeline, so compaction appends a checkpoint entry instead of mutating
   * the history in place.
   */
  private compactionController!: MessageCompactionController;
  private abortController: AbortController | null = null;
  private sessionInfo: SessionInfo;
  private compactionManager: CompactionManager;
  private apiKey: string;
  private baseURL?: string;
  private authStyle?: 'api_key' | 'auth_token';
  private provider: 'anthropic' | 'openai' | 'ollama';
  private sessionId?: string; // Session ID for task persistence
  private workingDirectory?: string; // Working directory for tool execution
  private defaultWorkspaceDirectory?: string; // Default workspace directory for permission checking
  private communicationPlatform?: import('../prompts/types.js').CommunicationPlatform; // Communication platform for prompt injection
  private language?: string; // Language preference for agent responses
  private permissionMode: PermissionMode = 'default'; // Permission mode for tool execution
  private hasPermissionsToUseTool: ReturnType<typeof createHasPermissionsToUseTool>;
  private alwaysAllowRules: ToolPermissionRulesBySource = {};
  private alwaysDenyRules: ToolPermissionRulesBySource = {};
  private alwaysAskRules: ToolPermissionRulesBySource = {};
  private additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory> = new Map();
  private visualAnalysis: VisualAnalysisService;
  private blockedDomains: string[] = [];
  private browserBackendMode: 'auto' | 'extension' | 'built-in' | 'human-like' = 'auto';
  private mcpManager: MCPManager | null = null;
  /**
   * Plan 314: mcpReady gate. First chat:start awaits this promise
   * (with timeout) so MCP tools are registered into the catalog
   * before streamChat resolves tools. Resolved by notifyMcpReady()
   * after applyMCPConfiguration completes (success or failure).
   * `mcpReadyResolve` is assigned synchronously by the Promise
   * constructor, so it is non-null after field init.
   */
  private mcpReadyResolve: (() => void) | null = null;
  private mcpReady: Promise<void> = new Promise((resolve) => {
    this.mcpReadyResolve = resolve;
  });
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

  // Plan 314: `activeMCPRegistry` is the long-lived ToolCatalog.
  // It holds ALL tools (builtin + mcp + plugin + app-connection)
  // registered once at init via `initToolCatalog()` (builtin) and
  // via `replaceByOwner('mcp', ...)` (MCP). Per-turn snapshots
  // are taken via `snapshot()` so the streaming loop sees a stable
  // view even if the catalog mutates mid-turn (tools/list_changed).
  // `activeMCPRuntimeSnapshot` is the post-commit diagnostic
  // snapshot; the alias map converts model-returned providerNames
  // to internalKeys; `activeAgentProfileId` is used by
  // `filterResolvedMCPServersForAgent` to apply allowedAgentIds
  // filtering consistently across init and reload.
  readonly activeMCPRegistry: ToolRegistry = new ToolRegistry();
  activeMCPRuntimeSnapshot: import('../mcp/apply.js').ActiveMCPRuntimeSnapshot | null = null;
  private providerNameToInternalKey: Map<string, string> = new Map();
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

    // Build extended options including @duya/ai fields from runtimeConfig.
    // apiFormat/providerId/modelCompat flow: ProviderRuntimeAdapter →
    // runtimeConfig → DuyaAgent → createAIClient → @duya/ai createAIClient.
    const llmClientOptions: AIClientOptions = {
      apiKey: options.apiKey,
      baseURL,
      model,
      authStyle: options.authStyle,
      apiFormat: options.runtimeConfig?.apiFormat ?? (provider === 'ollama' ? 'ollama' : provider === 'anthropic' ? 'anthropic' : 'openai-chat'),
      providerId: options.runtimeConfig?.providerId ?? provider,
      modelCapabilities: options.runtimeConfig?.modelCompat,
    };

    if (enableRetry) {
      logger.debug('[duyaAgent] Using retryable LLM client');
      this.llmClient = createAIClientWithRetry({
        ...llmClientOptions,
        retryConfig: options.retryConfig,
      });
    } else {
      logger.debug('[duyaAgent] Using standard LLM client (retry disabled)');
      this.llmClient = createAIClient(llmClientOptions);
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
    this.language = options.language;

    // Initialize vision model client if configured
    this.visualAnalysis = new VisualAnalysisService(
      options.visionConfig,
      (provider) => this.getDefaultBaseURL(provider),
    );

    // AGENTS.md is loaded eagerly in streamChat via refreshForTask so it is
    // always available before the first provider request and before any prompt
    // section is resolved.

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

    // Store blocked domains for browser tool
    this.blockedDomains = options.blockedDomains ?? [];
    this.browserBackendMode = options.browserBackendMode ?? 'auto';

    // Plan 315: bridge the legacy CompactionManager to the append-only
    // timeline so compaction appends a checkpoint entry instead of mutating
    // the in-memory history in place.
    this.compactionController = new MessageCompactionController({
      timeline: this.timeline,
      compactionManager: this.compactionManager,
    });
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
    // Model id is read by _buildSystemPrompt → promptSystem.buildContext({ modelId: this.model })
    // on every turn, so no separate prompt-manager sync is needed here.
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

    const { tools: baseTools, registry, agentDefinitions, constraints } = await this._resolveTools(options, appliedProfile);
    let tools = baseTools;

    // Plan 241 Phase 1: wire tool_search to this registry so it can list
    // every tool currently registered (including MCP-injected ones).
    // The single ToolSearchTool instance is shared across the agent
    // process; the most recently set registry wins (acceptable for the
    // sequential streamChat model — concurrent streams would need a
    // per-call registry override, planned for Phase 2).
    toolSearchTool.setSearchFn((query, limit) =>
      searchToolsFromRegistry(registry, query, limit),
    );

    // Diagnostic: worker uses console.error for stderr (stdout is JSON-RPC).
    // eslint-disable-next-line no-console
    console.error(`[Agent-Process] streamChat tools (${tools.length}): conductorMode=${options?.conductorMode}, agentProfileId=${options?.agentProfileId}, mode=${options?.mode}, hasCanvasCreate=${tools.some(t => t.name === 'canvas_create_element')}`);
    // eslint-disable-next-line no-console
    console.error(`[Agent-Process] canvas tools: ${tools.filter(t => t.name.startsWith('canvas_')).map(t => t.name).join(', ') || '(none)'}`);
    let systemPromptContent = await this._buildSystemPrompt(tools, options, appliedProfile);
    const { permissionContext, canUseTool } = this._buildPermissionContext(registry);
    const contextWindow =
      this.runtimeConfig?.modelCapabilities?.contextWindow &&
      this.runtimeConfig.modelCapabilities.contextWindow > 0
        ? this.runtimeConfig.modelCapabilities.contextWindow
        : DEFAULT_CONTEXT_WINDOW;

    // Handle options.messages fallback (CLI / harness scenarios)
    if (this.messages.length === 0 && options?.messages?.length) {
      this.setMessages([...options.messages]);
    }

    // Plan 315: project the timeline to the model boundary. System content
    // from legacy system messages and compaction reinjected context is
    // extracted into PromptSegments and merged into the system prompt. The
    // resulting messages array contains only user/assistant/tool roles.
    const projected = this._projectModelMessages(systemPromptContent);
    systemPromptContent = projected.systemPromptContent;
    let messages = projected.messages;

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

    // Plan 241 Phase 3: tools discovered via `tool_search` during this
    // streamChat call are added to the next turn's tool list so the LLM
    // can invoke them without searching again. Set is local to this call,
    // so it is GC'd when streamChat finishes (no cross-session pollution).
    const discoveredTools: Set<string> = new Set();
    let discoveredToolPromptSuffix = '';

    // Generate a unique seq_index for this streamChat call
    // All messages created in this call (including multi-turn) will share this seq_index
    // This allows the UI to group all related messages into a single "round"
    const seqIndex = Date.now();
    const runId = crypto.randomUUID();

    // Deferred tool contexts collected from tool results during this
    // streamChat call. They are injected into the provider payload on the
    // next turn (transient runtime context) but never persisted to the
    // durable history.
    const deferredContexts: Array<{
      toolUseId: string;
      toolName: string;
      promise: Promise<unknown>;
    }> = [];

    // Track total elapsed time for the entire stream (including all turns and tool execution)
    const streamStartTime = Date.now();

    while (!this.abortController.signal.aborted) {
      // Remove the prior turn's dynamic guide before rebuilding this turn.
      // This prevents duplicate prompt sections when a discovered tool stays
      // active across multiple tool-use turns.
      if (
        discoveredToolPromptSuffix &&
        systemPromptContent.endsWith(discoveredToolPromptSuffix)
      ) {
        systemPromptContent = systemPromptContent.slice(
          0,
          -discoveredToolPromptSuffix.length,
        );
      }
      discoveredToolPromptSuffix = '';

      turnCount++;
      const turnStartTime = Date.now();

      // Surface tools discovered via tool_search in previous turns.
      // Discoverable tools are excluded from the base list by
      // _resolveTools; this loop merges them in once discovered,
      // respecting the same deny/allow constraints.
      if (discoveredTools.size > 0) {
        const visible = new Set(tools.map((t) => t.name));
        let added = 0;
        for (const name of discoveredTools) {
          if (visible.has(name)) continue;
          // Re-check visibility with current discovered set + constraints.
          if (!isToolVisible(name, registry.getExposeMode(name), discoveredTools, constraints)) continue;
          const def = registry.getTool(name);
          if (!def) {
            logger.warn(
              `[Agent] discovered tool '${name}' no longer registered, skipping`,
            );
            continue;
          }
          tools = [...tools, def];
          visible.add(name);
          added++;
        }
        if (added > 0) {
          logger.info(
            `[Agent] Turn ${turnCount}: added ${added} discovered tools to LLM request`,
          );
        }
      }

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

      // A discoverable tool receives the exact same full schema object that
      // an always-exposed tool receives. If its executor also provides a
      // usage guide (BrowserTool.getPrompt, for example), append that guide
      // to this turn's system prompt as well.
      const discoveredPrompts = getDiscoveredToolPrompts(registry, discoveredTools);
      if (discoveredPrompts.length > 0) {
        discoveredToolPromptSuffix = [
          '',
          '',
          '## On-Demand Tool Guides',
          '',
          ...discoveredPrompts,
        ].join('\n');
        systemPromptContent += discoveredToolPromptSuffix;
      }

      // Background results that completed after a previous turn end are
      // picked up at the mailbox checkpoint below, not here.

      // Only add user message on first turn (original prompt)
      // Subsequent turns are continuations after tool results, not new prompts
      if (turnCount === 1 && !options?.backgroundTaskResume) {
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

        const displayContent = options?.displayContent !== undefined
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
          this._pushDurable(messages, userMessage);
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
          analyzeImage: this.visualAnalysis.analyzeImage.bind(this.visualAnalysis),
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
      let thinkingSignature: string | undefined = undefined;  // Anthropic extended-thinking signature for this turn
      // Guard against providers that emit more than one `done` event per
      // stream (a protocol-layer bug duplicated every assistant message).
      // One LLM stream produces exactly one assistant message push.
      let doneEventHandled = false;
      // Plan 224 follow-up: track mode-switch tool_use ids so we can emit
      // a `mode_changed` SSE event right after their tool_result lands.
      // Keyed by tool_use_id, value is the tool name.
      const modeSwitchToolIds = new Map<string, string>();

      yield { type: 'turn_start', data: { turnCount } };

      // Lightweight tool result cleanup before each turn
      messages = microCleanupMessages(messages);

      // Proactive context compaction before each LLM call
      if (this.compactionController.shouldCompact()) {
        logger.info(`[Agent] Turn ${turnCount}: Proactive compaction triggered`);
        try {
          const compactEntry = await this.compactionController.compactProactive();
          if (compactEntry) {
            logger.info(`[Agent] Turn ${turnCount}: Compacted with strategy=${compactEntry.strategy}, removed=${compactEntry.tokensBefore} tokens, retained=${compactEntry.tokensAfter ?? 0} tokens`);
            // The controller appended a checkpoint entry to the timeline
            // instead of mutating history in place; `this.messages` is a
            // timeline-derived getter, so it already reflects the compaction.
            // Notify external listener so it can persist the compacted
            // message list and update its baseline count.
            this.onMessagesCompacted?.(this.messages.length);
            // Re-project model messages from the updated timeline.
            const reProjected = this._projectModelMessages(systemPromptContent);
            systemPromptContent = reProjected.systemPromptContent;
            messages = reProjected.messages;
          }
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
        this._pushDurable(messages, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: stopMessage,
          timestamp: Date.now(),
          duration_ms: Date.now() - streamStartTime,
          seq_index: seqIndex,
        });
        this._commitMessages();
        yield { type: 'text', data: stopMessage };
        yield { type: 'done', reason: 'completed' };
        return;
      }
      // hard_replace: the replacement runtime_context was already pushed by
      // _claimMailboxAtCheckpoint; fall through to the LLM call with it in
      // the message history.

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

        // Codex-compatible: AGENTS.md contents are injected as the first user
        // message on the first turn, not duplicated in the system prompt. This
        // message is ephemeral: it is sent to the LLM but never persisted to the
        // message history, preserving the rule that persisted user messages are
        // written by the frontend.
        if (turnCount === 1 && !options?.backgroundTaskResume) {
          const agentsMdText = getAgentsMdManager().buildAgentsMdPrompt();
          if (agentsMdText) {
            llmMessages.unshift({
              id: crypto.randomUUID(),
              role: 'user',
              content: agentsMdText,
              timestamp: Date.now(),
              metadata: { isAgentsMdContext: true },
            });
          }
        }

        // Inject transient runtime context (attachment text + deferred tool
        // contexts) into the provider payload. These are never persisted to
        // the durable history.
        await this._injectRuntimeContext(llmMessages, options, deferredContexts);
        try {
          options?.onSystemPromptReady?.({
            systemPrompt: systemPromptContent,
            // Copy only the provider contract. Tool executors and internal
            // registry metadata are deliberately not exposed to observers.
            tools: tools.map(({ name, description, input_schema }) => ({
              name,
              description,
              input_schema,
            })),
            turn: turnCount,
            // Cache plan fingerprint derived from the stable prefix (system
            // prompt + tool surface). Stable across turns while the prompt is
            // unchanged, so observers can detect a reachable provider cache
            // breakpoint.
            cachePlan: { fingerprint: computeCachePlanFingerprint(systemPromptContent, tools) },
          });
        } catch (error) {
          logger.warn('[Agent] System prompt observer failed; continuing without observer', { error });
        }
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

            // Plan 224 follow-up: remember mode-switch tool_use ids so we
            // can emit a `mode_changed` event right after their result lands.
            if (
              event.data.name === 'EnterPlanMode' ||
              event.data.name === 'ExitPlanMode' ||
              event.data.name === 'SwitchMode'
            ) {
              modeSwitchToolIds.set(event.data.id, event.data.name);
            }

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
            // Ignore duplicate `done` events from the same LLM stream.
            // The first one already pushed the assistant message and
            // drained tool results; a second would re-push identical
            // content under a fresh UUID and duplicate the reply in DB/UI.
            if (doneEventHandled) {
              logger.warn(`[Agent] Turn ${turnCount}: Ignoring duplicate done event from LLM stream`);
              continue;
            }
            doneEventHandled = true;
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
                ...(thinkingSignature ? { thinkingSignature } : {}),
              });
            }

            // Add the rest of the content (text and tool_use blocks)
            finalAssistantContent.push(...assistantContent);

            if (finalAssistantContent.length > 0 || needsFollowUp) {
              this._pushDurable(messages, { id: crypto.randomUUID(), role: 'assistant', content: finalAssistantContent.length > 0 ? finalAssistantContent : assistantContent, timestamp: Date.now(), duration_ms: Date.now() - streamStartTime, seq_index: seqIndex });
            }

            // Now get remaining tool results and add them after assistant message
            logger.debug(`[Agent] Turn ${turnCount}: entering getRemainingResults, needsFollowUp=${needsFollowUp}`);
            let toolResultMessageCount = 0;
            for await (const result of executor.getRemainingResults()) {
              // Deferred tool context (e.g. a follow-up review payload) is
              // surfaced here. It is injected into the provider payload on
              // the next turn and never persisted to the durable history.
              if (result.deferredContext) {
                deferredContexts.push(result.deferredContext);
                continue;
              }
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
                  this._pushDurable(messages, result.message);

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

                  // Plan 224 follow-up: if this tool_result belongs to a
                  // mode-switch tool (EnterPlanMode / ExitPlanMode /
                  // SwitchMode), parse the new runtime mode out of the
                  // JSON result and emit a `mode_changed` SSE event so
                  // the renderer can sync the input-box chip + glow.
                  // Skip on error — failed switches leave the mode unchanged.
                  const modeSwitchToolName = modeSwitchToolIds.get(toolResultId);
                  if (modeSwitchToolName && !toolResultError) {
                    let nextMode: AgentRuntimeMode | undefined;
                    let reason: string | undefined;
                    try {
                      const parsed = JSON.parse(toolResultContent) as Record<string, unknown>;
                      if (modeSwitchToolName === 'SwitchMode') {
                        nextMode = parsed.currentMode as AgentRuntimeMode | undefined;
                        reason = parsed.reason as string | undefined;
                      } else if (modeSwitchToolName === 'EnterPlanMode') {
                        const planMode = parsed.planMode;
                        nextMode = planMode ? 'plan' : 'general';
                      } else if (modeSwitchToolName === 'ExitPlanMode') {
                        const planMode = parsed.planMode;
                        nextMode = planMode ? 'plan' : 'general';
                      }
                    } catch {
                      // Malformed JSON result — leave nextMode undefined.
                    }
                    if (nextMode) {
                      yield {
                        type: 'mode_changed',
                        data: {
                          mode: nextMode,
                          source: 'agent',
                          reason,
                        },
                      };
                    }
                    modeSwitchToolIds.delete(toolResultId);
                  }
                }
              }
            }
            logger.debug(
              `[Agent] Turn ${turnCount}: getRemainingResults completed, toolResultMessageCount=${toolResultMessageCount}`
            );

            // Plan 241 Phase 3: scan the tool_results we just appended
            // to `messages` for `tool_search` payloads and surface the
            // discovered tool names to the next turn's tool list.
            //
            // We re-scan `messages` from the end rather than threading
            // a separate collector through `getRemainingResults` —
            // simpler and avoids changing the executor's public surface.
            // The cost is O(N) over the new tool_result batch, which
            // is small (typically 1-3 per turn).
            if (toolResultMessageCount > 0) {
              const newToolResults = messages.slice(-toolResultMessageCount);
              const addedCount = harvestDiscoveredTools(newToolResults, discoveredTools);
              if (addedCount > 0) {
                logger.info(
                  `[Agent] Turn ${turnCount}: Plan 241 Phase 3 harvested ${addedCount} tool name(s) from tool_search results; will surface in next turn`,
                );
              }
            }

            // widgetStyleHistory and canvasFreshness are stable references
            // injected into toolUseContext; canvas tools mutate them in
            // place, so nothing to copy back here. The next turn reads the
            // same references via this.widgetStyleHistory / this.canvasFreshness.

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
            if (thinkingData) {
              thinkingContent += thinkingData;
            }
            // Capture the signature emitted at content_block_stop (empty data).
            // This is required by Anthropic to continue the thinking chain
            // across turns — without it the next request 400s with
            // "The content[].thinking in the thinking mode must be passed back to the API."
            if (event.signature) {
              thinkingSignature = event.signature;
            }
            hasThinkingContent = true;
            yield event;

          } else if (event.type === 'tool_progress') {
            // Pass through tool progress events
            yield event;

          } else if (event.type === 'tool_timeout') {
            // Pass through tool timeout events
            yield event;

          } else if (event.type === 'result') {
            // Preserve the token-usage event for cost accounting and
            // context-ring display (persisted to DB by the agent process).
            yield event;
          }
        }

        logger.debug(`[Agent] Turn ${turnCount}: LLM stream ended, total events=${llmEventCount}`);

        // Check max turns limit
        if (turnCount >= maxTurns) {
          // Refresh sessionInfo counters BEFORE yielding done event
          this._commitMessages();

          yield { type: 'done', reason: 'max_turns' };
          return;
        }

        // If no tool_use blocks were emitted, we're done
        // Note: assistant message was already added in 'done' event handler
        if (!needsFollowUp) {
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
            // Replacement runtime_context was already pushed by
            // _claimMailboxAtCheckpoint; loop to give the model a fresh turn.
            continue;
          }
          if (finalMailboxDecision.action === 'continue' && finalMailboxDecision.absorbed) {
            continue;
          }

          // Refresh sessionInfo counters BEFORE yielding done event
          // so API route can retrieve the final state
          this._commitMessages();

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
            const compactEntry = await this.compactionController.compactReactive(triggerError);
            if (compactEntry) {
              logger.info(`[Agent] Turn ${turnCount}: Reactive compaction succeeded, strategy=${compactEntry.strategy}, retained=${compactEntry.tokensAfter ?? 0} tokens`);
              const reProjected = this._projectModelMessages(systemPromptContent);
              systemPromptContent = reProjected.systemPromptContent;
              messages = reProjected.messages;
              // Retry this turn with compacted messages
              executor.discard();
              turnCount--; // Decrement so the next iteration uses the same turn number
              continue;
            }
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

        // Reconcile the timeline with the cleaned working array so the
        // incomplete assistant (removed above) is excluded from the durable
        // projection. `this.messages` is now a timeline-derived getter, so
        // the removal must be reflected in the timeline itself.
        this.setMessages(persistableMessages(messages));

        // Refresh sessionInfo counters BEFORE yielding error/done events
        this._commitMessages();

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
                  this._pushDurable(messages, {
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
    // Refresh sessionInfo counters BEFORE yielding done event
    this._commitMessages();
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

  /**
   * Refresh sessionInfo counters from the timeline. `this.messages` is a
   * timeline-derived getter, so no array assignment happens here — the
   * timeline is the single source of truth for the durable projection.
   */
  private _commitMessages(): void {
    this.sessionInfo.messageCount = this.messages.length;
    this.sessionInfo.updatedAt = Date.now();
  }

  /**
   * Append a message to the timeline if not already present. O(1) via
   * syncedMessageIds set. Called at every durable message creation site
   * so the timeline is always current — no batch reverse sync needed.
   */
  private _appendMessageToTimeline(message: Message): void {
    if (!message.id || this.syncedMessageIds.has(message.id)) return;
    const index = this.timeline.snapshot().length;
    const adapted = ingestMessage(message, { index });
    this.timeline.appendMessage({
      type: 'message',
      id: `${crypto.randomUUID()}:${index}`,
      parentId: null,
      createdAt: adapted.timestamp ?? 0,
      message: adapted,
    });
    this.syncedMessageIds.add(message.id);
  }

  /**
   * Append a native runtime_context message to the timeline with dedup.
   * For `source='attachment'`, dedup by attachmentIds metadata (the same
   * set of attachments is not recorded twice). Returns true when the message
   * was appended, false if it was deduplicated as already present.
   */
  private _appendRuntimeContextToTimeline(
    message: RuntimeContextAgentMessage,
  ): boolean {
    if (!message.id || this.syncedMessageIds.has(message.id)) return false;
    if (message.source === 'attachment') {
      const ids = (message.metadata?.[
        RUNTIME_CONTEXT_METADATA_KEYS.attachmentIds as string
      ] ?? []) as unknown[];
      const attachmentIds = Array.isArray(ids)
        ? ids.filter((x): x is string => typeof x === 'string')
        : [];
      if (attachmentIds.length > 0 && this._hasAttachmentRuntimeContext(attachmentIds)) {
        return false;
      }
    }
    this.timeline.appendMessage({
      type: 'message',
      id: `${crypto.randomUUID()}:${this.timeline.snapshot().length}`,
      parentId: null,
      createdAt: message.timestamp,
      message: message as AgentMessage,
    });
    this.syncedMessageIds.add(message.id);
    // `this.messages` is a timeline-derived getter, so the appended entry is
    // reflected automatically in the persistence output.
    this.sessionInfo.messageCount = this.messages.length;
    return true;
  }

  /**
   * True when any attachment runtime_context entry in the current timeline
   * carries every one of the supplied attachment IDs.
   */
  private _hasAttachmentRuntimeContext(attachmentIds: readonly string[]): boolean {
    if (attachmentIds.length === 0) return false;
    const snapshot = this.timeline.snapshot();
    for (const entry of snapshot) {
      if (entry.type !== 'message') continue;
      const msg = entry.message as unknown as Record<string, unknown>;
      if (msg.kind !== 'runtime_context') continue;
      if ((msg as { source?: string }).source !== 'attachment') continue;
      const md = (msg as { metadata?: Readonly<Record<string, unknown>> }).metadata;
      const ids = (md?.[RUNTIME_CONTEXT_METADATA_KEYS.attachmentIds as string] ?? []) as unknown[];
      const existingIds = Array.isArray(ids)
        ? ids.filter((x): x is string => typeof x === 'string')
        : [];
      if (
        existingIds.length === attachmentIds.length &&
        existingIds.every((id) => attachmentIds.includes(id))
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Push a durable message to both the working array and the timeline.
   * Transient messages (mailbox, background notifications) should use
   * `messages.push()` directly — they are filtered out by persistableMessages
   * and never reach the timeline.
   */
  private _pushDurable(messages: Message[], message: Message): void {
    messages.push(message);
    this._appendMessageToTimeline(message);
  }

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

    const usableRows = claim.rows.filter((row) => row.content.trim().length > 0);
    if (!usableRows.length) {
      return { action: 'continue', absorbed: false };
    }

    // Segregate terminal background-task notifications from user guidance rows
    // so each follows its own adapter. Background notifications keep the raw
    // <task-notification> XML envelope (sub-agents / background bash), while
    // followup rows collapse into a guidance block.
    const guidanceRows = usableRows.filter((row) => row.kind !== 'background_notification');
    const backgroundNotificationRows = usableRows.filter((row) => row.kind === 'background_notification');

    for (const row of usableRows) {
      await applyRow(row, claim.rows.indexOf(row), 'absorbed as runtime instruction before model turn');
    }

    for (const row of backgroundNotificationRows) {
      const ctx = adaptBackgroundNotification(row, { seqIndex });
      const projected = projectRuntimeContextToProviderMessage(ctx);
      if (projected) messages.push(projected);
    }

    if (guidanceRows.length > 0) {
      // Align claim tokens with the guidance (non-empty) rows.
      const guidanceTokens = guidanceRows.map((row) => claim.claimTokens[claim.rows.indexOf(row)]);
      const adapted = adaptMailboxRows(guidanceRows, guidanceTokens, { seqIndex });
      for (const ctx of adapted) {
        const projected = projectRuntimeContextToProviderMessage(ctx);
        if (projected) messages.push(projected);
      }
    }

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
    constraints: ToolVisibilityConstraints;
  }> {
    logger.info(`[Agent] streamChat: Loading tools...`);
    let registry = options?.toolRegistry;
    if (!registry) {
      // Plan 314: use the long-lived ToolCatalog (activeMCPRegistry).
      // Builtin tools were registered once at init via initToolCatalog();
      // MCP tools via replaceByOwner('mcp', ...). No per-turn
      // createBuiltinRegistry or mergeActiveMCPTools needed.
      registry = this.activeMCPRegistry;

      // Plan 312: merge App Connection connector tools from the cached
      // descriptor list. registerAppConnectionTools uses definition.name
      // as key so re-registration is idempotent (overwrites stale entries).
      try {
        const { getCachedAppConnectionDescriptors, registerAppConnectionTools } =
          await import('../tool/AppConnectionTool/index.js');
        const appConnDescriptors = getCachedAppConnectionDescriptors();
        if (appConnDescriptors.length > 0) {
          registerAppConnectionTools(registry, appConnDescriptors);
        }
      } catch (err) {
        logger.warn(`[Agent] Failed to merge App Connection tools: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Single-pass tool visibility filter.
    //
    // One question per tool: is it visible to the LLM this turn?
    //   1. Exposure: always-exposed, or already discovered via tool_search
    //   2. Denylist: caller exact + profile wildcard (deny wins)
    //   3. Allowlist: caller exact + profile wildcard
    //
    // discoverable tools are excluded here (empty discovered set) and
    // merged in per-turn by the streaming loop after tool_search runs.
    const constraints: ToolVisibilityConstraints = {
      disabledTools: options?.disabledTools,
      allowedTools: options?.allowedTools,
      profileAllowedPatterns: appliedProfile?.allowedTools,
      profileDisallowedPatterns: appliedProfile?.disallowedTools,
    };
    // Plan 314: take an immutable snapshot of the catalog for this
    // turn. The snapshot guarantees the tools array and lookup helpers
    // remain stable even if the catalog mutates mid-turn (e.g.
    // tools/list_changed).
    const snapshot = registry.snapshot(this.providerNameToInternalKey);
    const allTools = snapshot.tools;
    const mcpToolCount = allTools.filter((t) => registry.getOwner(t.name) === 'mcp').length;
    logger.debug(
      `[Agent] Tool snapshot: ${allTools.length} total (${mcpToolCount} MCP, ${allTools.length - mcpToolCount} non-MCP)`,
    );
    const tools: Tool[] = allTools.filter((t) =>
      isToolVisible(t.name, snapshot.getExposeMode(t.name), EMPTY_DISCOVERED, constraints),
    );
    logger.info(
      `[Agent] streamChat: ${tools.length}/${allTools.length} tools visible after visibility filter`,
    );

    // Fail-fast: profile allowlist matched zero tools.
    if (appliedProfile?.allowedTools?.length && tools.length === 0) {
      throw new Error(
        `Agent profile "${appliedProfile.id}" allowedTools matched zero tools ` +
        `(all ${allTools.length} tools were denied). ` +
        `Patterns: ${appliedProfile.allowedTools.join(', ')}. ` +
        `Check packages/agent/src/agent-profile/types.ts and the tool name constants.`,
      );
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

    return { tools, registry, agentDefinitions, constraints };
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
      `[Agent] Resolved prompt profile: enableSections=${JSON.stringify(promptProfile.enableSections ?? [])}, disableSections=${JSON.stringify(promptProfile.disableSections ?? [])}`
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
        language: this.language,
      });
      const systemPromptResult = await promptSystem.buildSystemPrompt(context);
      systemPromptContent = [...systemPromptResult].join('\n\n');
    }

    // MCP tool schemas are deliberately discoverable rather than placed in
    // every provider request. Keep the model aware of connected capability
    // families with a bounded directory, so a broad request such as "what MCP
    // tools do I have?" does not depend on arbitrary search-result ordering.
    if (!options?.disableSystemPrompt) {
      const mcpCatalog = buildMCPCapabilityCatalog(
        this.activeMCPRegistry.getAllTools().filter(
          (tool) => this.activeMCPRegistry.getOwner(tool.name) === 'mcp',
        ),
      );
      if (mcpCatalog) {
        systemPromptContent = systemPromptContent
          ? `${systemPromptContent}\n\n${mcpCatalog}`
          : mcpCatalog;
      }
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
  private _buildPermissionContext(registry?: ToolRegistry): {
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
          // Plan 312 Phase 4: wire risk-tier lookup to the tool registry
          // so connector tools are gated by their declared tier.
          getToolRiskTier: registry
            ? (toolName: string) => registry.getMeta(toolName)?.riskTier
            : undefined,
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
   * Inject runtime context at each LLM turn.
   *
   * Two categories, with different persistence semantics:
   *
   *   1. Attachment text context (from `options.attachments`) via the shared
   *      `adaptAttachmentContext` adapter. These are **durable**: appended to
   *      the timeline (so they persist across restarts) as hidden
   *      runtime_context messages. The timeline is deduplicated by attachment
   *      IDs so a re-injection after reload does not duplicate.
   *
   *   2. Deferred tool contexts collected from tool results during this
   *      streamChat call, wrapped in a `<deferred-tool-context>` block.
   *      These remain **transient**: appended only to `llmMessages` so they
   *      never land in the durable history.
   */
  private async _injectRuntimeContext(
    llmMessages: Message[],
    options: ChatOptions | undefined,
    deferredContexts: Array<{
      toolUseId: string;
      toolName: string;
      promise: Promise<unknown>;
    }>,
  ): Promise<void> {
    const attachments = (options as ChatOptions & { attachments?: FileAttachment[] } | undefined)
      ?.attachments;
    if (attachments && attachments.length > 0) {
      // Persist pasted-text attachments that exceed the inline limit to
      // `~/.duya/attachments/` and rewrite them as file pointers so the model
      // reads the full content on demand instead of blowing the input window.
      const prepared = await persistLargePastedAttachments(attachments);
      const ctx = adaptAttachmentContext(prepared);
      if (ctx) {
        // Append as a durable timeline entry (hidden runtime_context).
        // `_appendRuntimeContextToTimeline` skips when the same attachment IDs
        // are already present, so reloads don't duplicate.
        this._appendRuntimeContextToTimeline(ctx);
        const projected = projectRuntimeContextToProviderMessage(ctx);
        if (projected) llmMessages.push(projected);
      }
    }

    if (deferredContexts.length > 0) {
      const pending = deferredContexts.splice(0);
      const settled = await Promise.allSettled(
        pending.map(async (deferred) => {
          const value = await deferred.promise;
          const content =
            typeof value === 'string' ? value : JSON.stringify(value);
          return `<deferred-tool-context>\n${content}\n</deferred-tool-context>`;
        }),
      );
      for (const item of settled) {
        if (item.status !== 'fulfilled') continue;
        llmMessages.push({
          id: crypto.randomUUID(),
          role: 'user',
          content: item.value,
          timestamp: Date.now(),
          metadata: { runtimeContext: true, isDeferredToolContext: true },
        });
      }
    }
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

    // Plan 314: use the long-lived ToolCatalog for orchestrator mode
    // (same as the normal streamChat path). Builtin + MCP tools are
    // already registered; no per-turn construction needed.
    const toolRegistry = this.activeMCPRegistry;

    // Plan 241 Phase 1: wire tool_search to the orchestrator's registry
    // so it sees the same tool surface that the orchestrator's main loop
    // dispatches against.
    toolSearchTool.setSearchFn((query, limit) =>
      searchToolsFromRegistry(toolRegistry, query, limit),
    );

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
   * 中断当前对话
   */
  interrupt(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * 获取消息历史 (legacy interface)
   * Returns the durable, persistence-ready legacy Message[] shape that the
   * desktop renderer expects. Hidden runtime context is excluded.
   */
  getMessages(): readonly Message[] {
    return this.messages;
  }

  /**
   * Set the entire message history from persistence. Converts the legacy
   * Message[] to timeline entries via the legacy adapter.
   */
  setMessages(messages: Message[]): void {
    // A Plan 315 checkpoint marker is a durable projection of a CompactionEntry,
    // not a real history message. Reconstruct the entry so `buildAgentContext`
    // can restore the compaction boundary and reinjected system context after a
    // restart; otherwise the summary and system context would be lost. The entry
    // is appended AFTER the retained messages to match the in-memory order
    // (compaction follows the messages it rewrites), so `buildAgentContext`
    // finds `firstKeptIndex < compactionIndex` and emits the summary message.
    let compaction: CompactionEntry | undefined;
    this.timeline = new MessageTimeline();
    this.syncedMessageIds = new Set();
    for (const [index, message] of messages.entries()) {
      const checkpoint = getLegacyCompactionCheckpoint(message);
      if (checkpoint) {
        compaction = {
          type: 'compaction',
          id: checkpoint.id,
          parentId: null,
          createdAt: checkpoint.createdAt,
          summary: extractTextFromContent(message.content),
          firstKeptMessageId: checkpoint.firstKeptMessageId,
          compactedMessageIds: [...checkpoint.compactedMessageIds],
          tokensBefore: checkpoint.tokensBefore,
          tokensAfter: checkpoint.tokensAfter,
          strategy: checkpoint.strategy,
          previousCompactionId: checkpoint.previousCompactionId,
          reinjectedSystemMessages: checkpoint.reinjectedSystemMessages,
        };
        continue;
      }
      const adapted = ingestMessage(message, { index });
      this.timeline.appendMessage({
        type: 'message',
        id: `${crypto.randomUUID()}:${index}`,
        parentId: null,
        createdAt: adapted.timestamp ?? 0,
        message: adapted,
      });
      if (message.id) this.syncedMessageIds.add(message.id);
    }
    if (compaction) {
      this.timeline.appendCompaction(compaction);
    }
    // `this.messages` is a timeline-derived getter, so it reflects the
    // rebuilt timeline automatically.
    this.sessionInfo.messageCount = this.messages.length;
    this.sessionInfo.updatedAt = Date.now();
  }

  /**
   * Clear all messages from the timeline and projected list.
   */
  clearMessages(): void {
    this.timeline = new MessageTimeline();
    this.syncedMessageIds = new Set();
    this.sessionInfo.updatedAt = Date.now();
  }

  // ==========================================================================
  // Plan 314: long-lived ToolCatalog + per-turn snapshot
  // ==========================================================================

  /**
   * Plan 314: Block first chat:start until MCP tools are registered
   * into the catalog, or until `timeoutMs` elapses (whichever is
   * first). On timeout the chat proceeds without MCP tools — better
   * a degraded turn than a hung UI. Subsequent calls after the
   * promise has already resolved return immediately.
   */
  waitForMcpReady(timeoutMs = 8000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      this.mcpReady,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          logger.warn(`[Agent] MCP ready timeout after ${timeoutMs}ms; proceeding without MCP tools`);
          resolve();
        }, timeoutMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /**
   * Plan 314: Called by agent-process-entry after
   * `applyMCPConfiguration` completes — success OR failure. Failure
   * still resolves the gate so first chat is not permanently blocked.
   * Idempotent: subsequent calls are no-ops.
   */
  notifyMcpReady(): void {
    if (this.mcpReadyResolve) {
      const resolve = this.mcpReadyResolve;
      this.mcpReadyResolve = null;
      resolve();
    }
  }

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
   * Plan 314: Initialize the long-lived ToolCatalog by registering
   * all builtin tools once at agent init, before the first
   * `streamChat`. MCP tools are added later via
   * `applyMCPConfiguration` → `setActiveMCPRuntime` →
   * `replaceByOwner('mcp', ...)`.
   *
   * Replaces the per-turn `createBuiltinRegistry()` call that
   * previously ran inside `_resolveTools`. Builtin tools use
   * `owner='non-mcp'` so `replaceByOwner('mcp')` never touches them.
   */
  async initToolCatalog(): Promise<void> {
    const { createBuiltinRegistry } = await import('../tool/builtin.js');
    // Fetch enabled plugin IDs so plugin-declared tools are filtered
    // correctly (mirrors the per-turn logic previously in _resolveTools).
    let enabledPluginIds: Set<string> | undefined;
    try {
      const installed = await pluginDb.registryList() as Array<{ id?: unknown; enabled?: unknown }>;
      const enabledIds = installed
        .filter((item) => item.enabled === true && typeof item.id === 'string')
        .map((item) => item.id as string);
      enabledPluginIds = new Set(enabledIds);
    } catch {
      // Fallback: register all builtin tools without plugin filtering.
    }
    const temp = createBuiltinRegistry(
      this.blockedDomains.length > 0 ? { blockedDomains: this.blockedDomains } : undefined,
      {
        enabledPluginIds,
        browserBackendMode: this.browserBackendMode,
      },
    );
    // Migrate all tools from the temp registry into the long-lived
    // catalog. Builtin tools use owner='non-mcp' so replaceByOwner('mcp')
    // never touches them.
    for (const tool of temp.getAllTools()) {
      const executor = temp.getExecutor(tool.name);
      const meta = temp.getMeta(tool.name);
      if (executor) this.activeMCPRegistry.register(tool, executor, meta);
    }
  }

  /**
   * Plan 314: The set of model-visible tool names that are NOT
   * MCP-owned. Derived from the live catalog instead of a
   * hardcoded list, so plugin / app-connection tools added after
   * init are automatically included.
   *
   * This is the seed `usedNames` set for the providerName
   * allocator in PHASE B1: the next apply must never collide with
   * builtin / mode-specific non-MCP tool names. It intentionally
   * does NOT include currently active MCP provider names —
   * full-replace removes them before computing the next state, and
   * including them would cause collision-suffix drift on every
   * repeated reload.
   */
  getNonMCPModelVisibleToolNames(): Set<string> {
    const names = new Set<string>();
    for (const tool of this.activeMCPRegistry.getAllTools()) {
      if (this.activeMCPRegistry.getOwner(tool.name) !== 'mcp') {
        names.add(tool.name);
      }
    }
    return names;
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
    preparedRegistryEntries: Array<{
      key: string;
      definition: Tool;
      executor: ToolExecutor;
      meta?: import('../tool/registry.js').ToolMetaInput;
    }>;
    snapshot: import('../mcp/apply.js').ActiveMCPRuntimeSnapshot;
  }): Promise<{ removedKeys: string[]; addedKeys: string[]; keptKeys: string[] }> {
    const previousManager = this.mcpManager;
    const previousProviderMap = this.providerNameToInternalKey;
    const previousSnapshot = this.activeMCPRuntimeSnapshot;

    let replaceResult: { removedKeys: string[]; addedKeys: string[]; keptKeys: string[] };
    try {
      replaceResult = this.activeMCPRegistry.replaceByOwner(
        'mcp',
        install.preparedRegistryEntries,
      );
      this.providerNameToInternalKey = new Map(install.providerNameToInternalKey);
      this.mcpManager = install.manager;
      this.activeMCPRuntimeSnapshot = install.snapshot;
    } catch (err) {
      // Roll back the partial install. `replaceByOwner` is
      // atomic — it never leaves the registry in a partial
      // state. The catch only covers failures during our
      // post-replace field updates, which require no further
      // rollback of the registry itself.
      this.providerNameToInternalKey = previousProviderMap;
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
    // PromptSystem reads workingDirectory fresh on every streamChat via
    // _buildSystemPrompt → buildContext, so no separate sync needed.
  }

  /**
   * Update the language preference. Read by _buildSystemPrompt on every
   * streamChat via promptSystem.buildContext({ language: this.language }).
   */
  setLanguage(language: string): void {
    this.language = language;
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
    const withTimestamp: Message = {
      ...message,
      timestamp: message.timestamp ?? Date.now(),
    };
    const index = this.timeline.snapshot().length;
    const adapted = ingestMessage(withTimestamp, { index });
    this.timeline.appendMessage({
      type: 'message',
      id: `${crypto.randomUUID()}:${index}`,
      parentId: null,
      createdAt: adapted.timestamp ?? 0,
      message: adapted,
    });
    this.syncedMessageIds.add(withTimestamp.id!);
    this.sessionInfo.messageCount = this.messages.length;
    this.sessionInfo.updatedAt = Date.now();
  }

  /**
   * 检查是否应该进行压缩
   */
  shouldCompact(): boolean {
    return this.compactionController.shouldCompact();
  }

  /**
   * Project the timeline to the model boundary using `projectModelMessages`.
   *
   * Replaces `_extractSystemMessagesIntoPrompt` with the Plan 315 model
   * boundary projection. System content from legacy system messages and
   * compaction reinjected context is extracted into PromptSegments, then
   * merged into the system prompt. The resulting messages array contains
   * only user/assistant/tool roles — no system messages.
   *
   * Returns the projected model messages; it does not mutate `this.messages`,
   * which remains the durable persistence projection derived from the
   * timeline.
   */
  private _projectModelMessages(
    systemPromptContent: string,
  ): { systemPromptContent: string; messages: Message[] } {
    const snapshot = this.timeline.snapshot();
    const context = buildAgentContext(snapshot);

    // Extract system segments from legacy system messages and compaction
    const systemSegments = extractLegacySystemSegments(
      context.messages,
      context.compaction,
    );

    // Project to model boundary: { system, messages }
    const projection = projectModelMessages(context.messages, { systemSegments });

    // Merge projected system with existing system prompt
    const systemFromProjection = typeof projection.system === 'string'
      ? projection.system
      : '';
    const merged = systemPromptContent && systemFromProjection
      ? `${systemPromptContent}\n\n---\n\n## Conversation Context\n\n${systemFromProjection}`
      : (systemPromptContent || systemFromProjection);

    logger.info(
      `[Agent] projectModelMessages: ${context.messages.length} agent messages → ${projection.messages.length} model messages, ${systemSegments.length} system segments`,
    );

    return { systemPromptContent: merged, messages: [...projection.messages] };
  }

  /**
   * 获取当前上下文统计信息
   */
  getContextStats() {
    this.compactionManager.updateContextTokens(this.messages);
    return this.compactionManager.getStats();
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

    const compactEntry = await this.compactionController.compactProactive(options);
    if (!compactEntry) {
      return { strategy: 'none', tokensRemoved: 0, tokensRetained: 0 };
    }

    // `this.messages` is a timeline-derived getter; the checkpoint entry
    // appended by the controller is reflected automatically.
    this.sessionInfo.messageCount = this.messages.length;
    this.sessionInfo.updatedAt = Date.now();

    return {
      strategy: compactEntry.strategy,
      tokensRemoved: compactEntry.tokensBefore - (compactEntry.tokensAfter ?? 0),
      tokensRetained: compactEntry.tokensAfter ?? 0,
    };
  }
}
