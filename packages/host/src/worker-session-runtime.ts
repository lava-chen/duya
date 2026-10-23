import { createGoalModeToolPorts, createResearchModeToolPorts } from './worker-modes/child-run-ports.js';
import { definedProperties } from './worker-context/defined-properties.js';
/** Host product session state and assembly; RunEngine owns model/tool scheduling. */
import type { TurnOutputSink, ResolvedTurnTools, TurnPipelineRequest, TurnAssemblyRequest, TurnAssembly, RunStartRequest, RunHandle, RunAssemblyRequest, PromptUserRowCommit, LegacyTurnDelta, TurnModelProjection, RunTurnAssembly } from './worker-run-session-port.js';
import type { WorkerSessionAssemblyPorts } from './worker-session-assembly-ports.js';
import { prepareMailboxGuidance } from '@duya/host/worker-context/mailbox-attachment-context';
import { parseMailboxAttachments } from '@duya/host/worker-context/attachment-images';
import { isModelLikelyMultimodal } from '@duya/capabilities/utils/multimodal-detection';
import { resolveTurnRunId } from '@duya/agent-runtime/turns/run-identity';
import { DEFAULT_MAX_OUTPUT_TOKENS, } from '@duya/host/worker-run-contracts';
import type { PluginAppInvocationResult, PluginAppMcpDescriptor } from '@duya/agent-protocol';
import { validateCatalogToolArguments } from '@duya/agent-runtime/tools/discovery/dispatcherFromRegistry';
import type { ToolCatalogEntry } from '@duya/agent-runtime/tools/catalog/catalog-types';
import type { AgentOptions, AgentRuntimeMode, ChatOptions, FileAttachment, Message, AssistantMessage, MessageContent, ToolUseContent, Tool, ToolUse, SSEEvent, SessionInfo, ToolUseContext, ToolResultContent, AgentProgressEvent, AppState, } from '@duya/host/worker-run-contracts';
import { asSystemPrompt, DEFAULT_PROMPT_PROFILE, getPromptProfileForAgentProfile, PromptsRegistry, resolvePromptSystemName, hasPromptObserver, reportPromptDigests, sectionDigest, } from '@duya/host/worker-prompts/index';
import { handleGoalCommand, isGoalControlCommand } from '@duya/host/worker-modes/goal/goal-commands';
import { handleTranscriptCommand, isTranscriptControlCommand, } from '@duya/host/worker-session/transcript-commands';
import { sendEvent, buildClipboardWriteEvent } from '@duya/host/worker-transport';
import type { PromptSystem } from '@duya/host/worker-prompts/index';
import { createBotPromptAssembly, loadBotPromptContext, isBotAgentProfile, computeBotContentHash, countTimelineCompactions, buildProfileUpdateEnvelope, detectProfileUpdate, isProfileUpdateFolded, mergeProfileUpdate, type ProfileBaseline, } from '@duya/host/worker-prompts/index';
import type { BotPromptAssembly } from '@duya/host/worker-prompts/index';
import { getAgentsMdManager } from '@duya/host/worker-agents-md/index';
import { extractTriggerPaths } from '@duya/host/worker-agents-md/nested-loader';
import { isNestedAgentsMdEnabled } from '@duya/host/worker-config/feature-flags';
import { getCachedAppConnectionDescriptors } from '@duya/host/worker-tool-bindings/app-connection-tools';
import { projectForProvider } from '@duya/plugin-core/mcp/core/projection';
import { buildAppsSystemSection, collectConnectorActivationInjection, collectPluginInjections, collectSkillInjections, extractExplicitSkillMentions, mergeSkillMentionSources } from '@duya/host/worker-mentions';
import { matchSkillsForPrompt, buildSkillSuggestionInjection } from '@duya/host/skills';
import { compressProjectedToolMessages } from '@duya/agent-runtime/context/compact/projectionCompress';
import { createAIClient, createAIClientWithRetry, inferProvider, findModelCompat, estimateContextTextTokens } from '@duya/ai';
import type { AIClient, AIClientOptions, RetryConfig, ApiFormat } from '@duya/ai';
import { resolveDefaultBaseURL, resolveLlmClientDiscriminator } from '@duya/ai';
import type { TurnOutputSummary } from '@duya/agent-runtime';
import { shouldReplayStreamAfterError, streamReplayDelayMs, STREAM_REPLAY_MAX_ATTEMPTS, } from '@duya/host/worker-execution/stream-retry';
import { stripPastedContentMarkers } from '@duya/agent-core/context/pasted-content';
import { StreamingToolExecutor } from '@duya/host/worker-execution/streaming-tool-executor';
import { ToolExecutionPipeline } from '@duya/host/worker-execution/tool-execution-pipeline';
import type { CanUseToolFn } from '@duya/host/worker-execution/streaming-tool-executor';
import { createHasPermissionsToUseTool } from '@duya/host/authorization/worker-permission-evaluator';
import { resolveCacheRetention } from '@duya/host/worker-config/cache-config';
import { readToolExposureConfig } from '@duya/host/worker-config/tool-exposure';
import type { ToolPermissionCheckContext } from '@duya/host/authorization/worker-permission-evaluator';
import type { ToolPermissionContext, PermissionMode, ToolPermissionRulesBySource, AdditionalWorkingDirectory, PermissionRuleSource, LocalToolPermission } from '@duya/capabilities/permissions';
import type { CommunicationPlatform } from '@duya/host/worker-prompts/types';
import type { AgentRuntime } from '@duya/agent-runtime/turns/AgentRuntime';
import { TurnAssembler } from '@duya/agent-runtime/turns/TurnAssembler';
import type { TurnContext } from '@duya/agent-runtime/turns/TurnContext';
import { permissionModeFromString } from '@duya/capabilities/permissions';
import { buildPermissions } from '@duya/host/authorization/worker-permission-gate';
import { normalizeCanUseToolDecision } from '@duya/agent-runtime/authorization/tool-invoke-decision';
import { CompactionCoordinator, type CompactionRunResult } from '@duya/host/worker-compaction/coordinator';
import { PendingHookMessages } from '@duya/agent-runtime/turns/PendingHookMessages';
import { deriveSingleCallUsage } from '@duya/agent-core/usage/seed-token-usage';
import { createOneShotTextPort, fromProviderMessages } from '@duya/host/run-engine-model';
import { buildCoordinatorCompactionSources } from '@duya/host/worker-compaction/engine-sources';
import type { CompactionSources } from '@duya/agent-runtime/adapters/run-engine-ports';
import { settingsJsonToRules } from '@duya/agent-runtime/authorization/permissions/rules';
import { permissionRuleValueToString } from '@duya/agent-runtime/authorization/permissions/rules';
import { logger } from '@duya/host/worker-logger';
import { createChildAbortController } from '@duya/agent-runtime/abort';
import { getAgentProfileService } from '@duya/host/worker-profiles/AgentProfileService';
import { readConfigAgents, toAgentProfile } from '@duya/host/worker-profiles/config-agents';
import { parseAgentMentions, buildMentionedAgentsContext } from '@duya/agent-core/message/agent-mentions';
import type { AgentProfile } from '@duya/agent-core';
import { isToolVisible, type ToolVisibilityConstraints } from '@duya/agent-runtime/authorization/tool-filter';
import { mailboxDb, modeStateDb, pluginDb } from '@duya/host/worker-db-client';
import { MCPManager } from '@duya/host/connector-services/worker-mcp';
import { buildMCPCapabilityCatalog } from '@duya/capabilities/MCP/capability-catalog';
import type { MailboxRow } from '@duya/host/worker-mailbox-row';
import { LoopHookBus, applyLoopHookEffect, type LoopHookDispatchContext } from '@duya/host/worker-hooks/loop';
import { applyHookInjection, renderHookContextEnvelope, type InjectableMessage, } from '@duya/host/worker-hooks/injection';
import { createBuiltinLoopHooks } from '@duya/host/worker-hooks/builtin';
import { createConfiguredLoopHooks } from '@duya/host/worker-hooks/config-loop';
import { ConfigHooksRunner } from '@duya/host/worker-hooks/events';
import type { EventHookInput, EventHookMatcherTargets, EventHookRunResult, } from '@duya/host/worker-hooks/events';
import { readHooksConfig } from '@duya/host/worker-hooks/config';
import type { BaseHookInput } from '@duya/host/worker-hooks/types';
import path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { isMemoryEnabled } from '@duya/memory/wakeup';
import { getDuyaMemoryRoot } from '@duya/memory/memory_paths';
import { modeModifierRegistry, modeTrackerEngine } from '@duya/host/worker-modes/modifiers';
import type { ModeModifier, ModeModifierContext, OrchestratorDeps, ResolvedMode, ToolRegistration } from '@duya/host/worker-modes/modifiers';
import type { SubagentRunDeps } from '@duya/host/worker-subagents/run-agent';
import { ModeCoordinator } from '@duya/host/worker-modes/engine';
import { applyModes, collectActiveModes, runExitHooks } from '@duya/host/worker-modes/modifiers/apply-modes';
import { planModeTracker } from '@duya/host/worker-modes/plan/plan-tracker';
import { ToolRegistry } from '@duya/host/worker-tool-registry';
import type { ToolExecutor } from '@duya/host/worker-tool-registry';
import { invalidateToolCatalogSchemaReads, recordToolCatalogSchemaRead, ToolCatalogTool, type ToolCatalogView } from '@duya/agent-runtime/tools/discovery/ToolCatalogTool';
import { ToolInvokeTool } from '@duya/agent-runtime/tools/discovery/ToolInvokeTool';
import { createToolInvokeDispatcherFromRegistry } from '@duya/host/worker-execution/deferred-dispatcher';
import { recordUndeclaredCall, evaluateVisibilityGuard, } from '@duya/host/worker-execution/visibility-guard';
import { getOSContextBridge, injectOSContextFragment, } from '@duya/host/worker-context/os-context-binding';
import { injectTurnTimestampReminders } from '@duya/agent-core/context/turn-time-reminder';
import type { AgentDefinition } from '@duya/host/worker-subagents/built-in-agents';
import type { TurnPipelinePublisher } from '@duya/agent-runtime/tools/turn-pipeline-publisher';
import { CompactionManager, createCompactionManager, type CompactionProbe } from '@duya/host/worker-compaction/bound-manager';
import { resolveCompactionContextWindow } from '@duya/host/worker-compaction/context-window';
import { PROGRESS_UPDATE_TOOL, PROGRESS_UPDATE_TOOL_NAME, ToolGroupProgressTracker, readProgressUpdateCall, } from '@duya/agent-runtime/turns/tool-group-progress';
import type { CompactOptions } from '@duya/agent-runtime/context/compact/types';
import { MessageTimeline, buildAgentContext, ingestMessage, ingestMessages, projectModelMessages, extractLegacySystemSegments, projectTimelinePersistenceMessages, getLegacyCompactionCheckpoint, type CompactionEntry, type RuntimeContextAgentMessage, type AgentMessage, } from '@duya/agent-core/message';
import { AgentMessageFactory } from '@duya/agent-runtime/message/message-factories';
import { THREAD_METADATA_KEY, applyReplyQuoteContext, collectMessageIds, isBranchedMessage, mergeThreadMetadata, messageToQuoteText, readThreadMeta, resolveReplyMeta, } from '@duya/agent-core/message/threads';
import { MessageCompactionController } from '@duya/host/worker-compaction/bound-controller';
import { adaptAttachmentContext, adaptBackgroundNotification, adaptLoopNudgeContext, projectRuntimeContextToProviderMessage, RUNTIME_CONTEXT_METADATA_KEYS, } from '@duya/host/worker-context/runtime-context-adapters';
import { renderSystemReminder } from '@duya/agent-core/context/reminders';
import { persistLargePastedAttachments } from '@duya/host/worker-context/attachment-context';
import { EMPTY_DISCOVERED, extractTextFromContent, collectRecentImageAttachments, persistableMessages, computeCachePlanFingerprint, chooseMailboxApplyMode, buildAgentIdentityBlock, type RuntimeMailboxDecision, type RuntimeMailboxClaim, } from '@duya/host/worker-session/agent-helpers';
import { VisualAnalysisService } from '@duya/host/worker-visual-analysis';
interface ToolResultOutcome {
    readonly id: string;
    readonly content: string;
    readonly isError: boolean;
}
const TOOL_GROUP_PROGRESS_INSTRUCTIONS = [
    'Tool-group progress: before a tool batch, provide one concise plain-text title for the work.',
    'Use the provider structured commentary channel when it is explicitly available; otherwise call the private progress-title tool shown in the available tools with {title}.',
    'Never derive a title from hidden reasoning or ordinary assistant prose. The progress-title call is private and does not perform work.',
].join(' ');

/**
 * A catalog row is an MCP tool when it carries MCP identity. The catalog
 * source kind records ownership, not transport: a plugin-owned MCP server
 * reports `plugin`, a bundled one reports `mcp`.
 */
function isMcpCatalogEntry(entry: ToolCatalogEntry): boolean {
    if (!entry.definition.mcpInfo) return false;
    return entry.source.kind === 'mcp' || entry.source.kind === 'plugin';
}

export class WorkerSession implements AgentRuntime {
    readTurnSequence(): number {
        return 0;
    }
    readSessionId(): string | undefined {
        return this.sessionId;
    }
    readWorkingDirectory(): string | undefined {
        return this.workingDirectory;
    }
    readWorkerProviderConfig(): import('./worker-workflows/runner.js').WorkflowRunnerLlmConfig {
        return {
            apiKey: this.apiKey,
            model: this.model,
            provider: this.provider,
            ...(this.baseURL !== undefined ? { baseURL: this.baseURL } : {}),
            ...(this.authStyle !== undefined ? { authStyle: this.authStyle } : {}),
        };
    }
    readCommunicationPlatform(): CommunicationPlatform | undefined {
        return this.communicationPlatform;
    }
    readLanguage(): string | undefined {
        return this.language;
    }
    readPermissionMode(): PermissionMode {
        return this.permissionMode;
    }
    readHostToolPermission(): LocalToolPermission | undefined {
        return this.hostToolPermission;
    }
    readAdditionalWorkingDirectories(): ReadonlyMap<string, AdditionalWorkingDirectory> {
        return this.additionalWorkingDirectories;
    }
    readTurnAlwaysAllowTools(): readonly string[] {
        return Array.from(this._turnAlwaysAllowTools);
    }
    assembleTurnContext(options: ChatOptions | undefined, prompt: string | MessageContent[]): TurnContext {
        return TurnAssembler.build(this, options, prompt);
    }
    readModelClient(): AIClient {
        return this.llmClient;
    }
    buildTurnPipeline(request: TurnPipelineRequest): ToolExecutionPipeline {
        const { resolved, turnContext, options } = request;
        const abortController = this.abortController;
        if (!abortController) {
            throw new Error('buildTurnPipeline called with no run in progress: the abort controller has already been cleared');
        }
        let turnAppState: AppState = {};
        const toolUseContext: ToolUseContext = {
            toolUseId: crypto.randomUUID(),
            abortController: abortController,
            getAppState: () => turnAppState,
            setAppState: (updater) => { turnAppState = updater(turnAppState); },
            currentProjectId: this.currentProjectId ?? null,
            options: {
                recentImageAttachments: collectRecentImageAttachments(request.messages).map(definedProperties),
                tools: request.tools,
                commands: [],
                mainLoopModel: this._model,
                mcpClients: [],
                apiKey: this.apiKey,
                ...definedProperties({ baseURL: this.baseURL }),
                ...definedProperties({ authStyle: this.authStyle }),
                provider: this.provider,
                ...definedProperties({ sessionId: turnContext.sessionId ?? undefined }),
                agentProfileId: options?.agentProfileId ?? null,
                ...definedProperties({ workingDirectory: turnContext.workingDirectory ?? undefined }),
                ...definedProperties({ projectHome: this.projectHome }),
                ...definedProperties({ language: turnContext.language ?? undefined }),
                agentDefinitions: {
                    activeAgents: resolved.agentDefinitions,
                    allAgents: resolved.agentDefinitions,
                },
                analyzeImage: this.visualAnalysis.analyzeImage.bind(this.visualAnalysis),
                resolveMCPProviderToolName: (name: string) => this.resolveMCPToolNameToInternalKey(name),
                mcpToolExecutors: this.buildMCPToolExecutors(request.tools)
            },
            ...definedProperties({ requestPermission: options?.requestPermission }),
            ...definedProperties({ sendToMain: options?.hostIpc?.sendToMain }),
            ...definedProperties({ ipcRequest: options?.hostIpc?.ipcRequest }),
        };
        this.currentToolUseContext = toolUseContext;
        request.bindToolUseContext(toolUseContext);
        resolved.catalogTool.setContextView(toolUseContext, resolved.catalogView);
        resolved.toolInvokeExecutor.setDispatcherForContext(toolUseContext, request.toolInvokeDispatcher);
        const executor = new ToolExecutionPipeline(resolved.registry, request.canUseTool, toolUseContext);
        request.publisher?.publish(request.turn, executor);
        return executor;
    }
    assembleTurn(request: TurnAssemblyRequest): TurnAssembly {
        const systemPrompt = this.refreshTurnSystemPrompt(request.systemPrompt);
        request.resolved.catalogView.currentRound = request.turn;
        const pipeline = this.buildTurnPipeline({
            turn: request.turn,
            messages: request.messages,
            tools: request.tools,
            resolved: request.resolved,
            turnContext: request.turnContext,
            options: request.options,
            canUseTool: request.canUseTool,
            toolInvokeDispatcher: request.toolInvokeDispatcher,
            publisher: request.publisher,
            bindToolUseContext: request.bindToolUseContext,
        });
        return {
            systemPrompt,
            tools: request.tools,
            pipeline,
            catalogView: request.resolved.catalogView,
        };
    }
    private refreshTurnSystemPrompt(systemPrompt: string): string {
        if (!this.resolvedModes ||
            !this.modeCtx ||
            this.baseSystemPromptWithoutModes === undefined ||
            this.resolvedModes.prompt.prefixes.length === 0) {
            return systemPrompt;
        }
        let prefix = '';
        for (const p of this.resolvedModes.prompt.prefixes) {
            prefix += typeof p === 'function' ? p(this.modeCtx, this.baseSystemPromptWithoutModes) : p;
        }
        return `${prefix}\n\n${this.baseSystemPromptWithoutModes}`;
    }
    async runModeExitHooks(): Promise<void> {
        if (!this.resolvedModes || !this.modeCtx)
            return;
        await runExitHooks(this.resolvedModes, this.modeCtx);
    }
    private async applyTurnModes(input: {
        readonly options: ChatOptions | undefined;
        readonly turnContext: TurnContext;
        readonly systemPrompt: string;
        readonly resolved: ResolvedTurnTools;
    }): Promise<{
        readonly systemPrompt: string;
        readonly resolved: ResolvedTurnTools;
    }> {
        const { options, turnContext } = input;
        const { registry, constraints, catalogView } = input.resolved;
        const activeModeIds = collectActiveModes(options ?? {});
        this.resolvedModes = activeModeIds.length > 0
            ? modeModifierRegistry.resolve(activeModeIds)
            : undefined;
        if (!this.resolvedModes || this.resolvedModes.modes.length === 0) {
            this.resolvedModes = undefined;
            this.modeCtx = undefined;
            this.baseSystemPromptWithoutModes = undefined;
            return { systemPrompt: input.systemPrompt, resolved: input.resolved };
        }
        this.baseSystemPromptWithoutModes = input.systemPrompt;
        this.modeCtx = {
            sessionId: turnContext.sessionId ?? '',
            workingDirectory: turnContext.workingDirectory ?? '',
            subagentDeps: this.subagentDeps,
            workerModeToolPorts: { goal: createGoalModeToolPorts(this.subagentDeps), research: createResearchModeToolPorts(this.subagentDeps) },
            state: {
            },
        };
        const baseToolRegistrations: ToolRegistration[] = input.resolved.tools.map((t) => ({
            definition: t,
            executor: registry.getExecutor(t.name)!,
        }));
        const modeResult = await applyModes({
            basePrompt: input.systemPrompt,
            baseTools: baseToolRegistrations,
            ctx: this.modeCtx,
            resolved: this.resolvedModes,
        });
        for (const tr of modeResult.tools) {
            if (!registry.has(tr.definition.name)) {
                registry.register(tr.definition, tr.executor);
            }
        }
        const tools = modeResult.tools.map((t) => t.definition);
        const modeToolPolicy = this.resolvedModes.tools;
        const modeAllowsTarget = (name: string): boolean => modeToolPolicy.overrideFilter || (!modeToolPolicy.blocked.includes(name) &&
            (modeToolPolicy.allowed === null || modeToolPolicy.allowed.includes(name)));
        const modeAllowsRouter = (name: string): boolean => modeToolPolicy.overrideFilter || !modeToolPolicy.blocked.includes(name);
        const canCatalog = isToolVisible('tool_catalog', 'eager', EMPTY_DISCOVERED, constraints) &&
            modeAllowsRouter('tool_catalog');
        const canInvoke = isToolVisible('tool_invoke', 'eager', EMPTY_DISCOVERED, constraints) &&
            modeAllowsRouter('tool_invoke');
        const directNames = new Set(tools.map((tool) => tool.name));
        const eligibleAfterMode = catalogView.snapshot.catalogEntries.filter((entry) => {
            if (!catalogView.eligibleToolIds.has(entry.toolId) || !modeAllowsTarget(entry.definition.name))
                return false;
            if (entry.exposure !== 'deferred' || directNames.has(entry.definition.name))
                return true;
            return canCatalog && canInvoke;
        });
        catalogView.eligibleToolIds = new Set(eligibleAfterMode.map((entry) => entry.toolId));
        catalogView.directToolIds = new Set(eligibleAfterMode
            .filter((entry) => directNames.has(entry.definition.name))
            .map((entry) => entry.toolId));
        const withRouters: Tool[] = [...tools];
        if (canCatalog && !directNames.has('tool_catalog')) {
            const definition = catalogView.snapshot.tools.find((tool) => tool.name === 'tool_catalog');
            if (definition)
                withRouters.push(definition);
        }
        const hasRoutableDeferred = eligibleAfterMode.some((entry) => entry.exposure === 'deferred' && !directNames.has(entry.definition.name));
        if (canInvoke && hasRoutableDeferred && !directNames.has('tool_invoke')) {
            const definition = catalogView.snapshot.tools.find((tool) => tool.name === 'tool_invoke');
            if (definition)
                withRouters.push(definition);
        }
        logger.info(`[Agent] applyTurnModes: Applied ${this.resolvedModes.modes.length} mode modifier(s): ${this.resolvedModes.modes.map((m) => m.id).join(', ')}`);
        return {
            systemPrompt: modeResult.systemPrompt,
            resolved: { ...input.resolved, tools: withRouters },
        };
    }
    invalidateTurnCatalogSchemaReads(resolved: ResolvedTurnTools): void {
        invalidateToolCatalogSchemaReads(resolved.catalogView);
    }
    recordTurnCatalogSchemaRead(resolved: ResolvedTurnTools, message: Message): boolean {
        if (message.role !== 'tool')
            return false;
        return recordToolCatalogSchemaRead(resolved.catalogView, message.metadata);
    }
    async beginRun(request: RunStartRequest): Promise<RunHandle> {
        const { options, prompt } = request;
        const controller = new AbortController();
        this.abortController = controller;
        this.currentTurnId = options?.turnId ?? null;
        this.currentRunId = options?.runId ?? null;
        this.forkTurn = null;
        this.turnOutputSink = null;
        this._consumeApprovedEffect = options?.consumeApprovedEffect;
        this._turnAlwaysAllowTools = new Set(options?.approvedAlwaysAllowTools ?? []);
        this.promptContexts = [];
        this.promptContextBlocks = [];
        this.injectedSkillParts.clear();
        const turnContext = this.assembleTurnContext(options, prompt);
        const appliedProfile = await this._resolveAgentProfile(options);
        this.lastAppliedAgentProfile = appliedProfile;
        let closed = false;
        return {
            turnId: this.currentTurnId,
            turnContext,
            appliedProfile,
            requestedMode: options?.mode || 'normal',
            request,
            orchestrator: this._readOrchestratorMode(options),
            signal: controller.signal,
            controller,
            abort: (reason?: unknown) => { controller.abort(reason); },
            close: () => {
                if (closed)
                    return;
                closed = true;
                if (this.abortController === controller)
                    this.abortController = null;
                if (this.currentToolUseContext?.abortController === controller)
                    this.currentToolUseContext = undefined;
                if (this.currentRunId === (options?.runId ?? null))
                    this.currentRunId = null;
                this.currentTurnId = null;
                this.forkTurn = null;
                this.turnOutputSink = null;
                this._consumeApprovedEffect = undefined;
                this._turnAlwaysAllowTools = new Set();
                this.promptContexts = [];
                this.promptContextBlocks = [];
                this.injectedSkillParts.clear();
            },
        };
    }
    private _readOrchestratorMode(options?: ChatOptions): ModeModifier | null {
        const requestedMode = options?.mode || 'normal';
        if (requestedMode === 'normal')
            return null;
        const mod = modeModifierRegistry.get(requestedMode);
        return mod?.orchestrator ? mod : null;
    }
    async beginTurnAssembly(request: RunAssemblyRequest): Promise<RunTurnAssembly> {
        const { options, prompt, appliedProfile, publisher, turnContext } = request;
        const resolvedBase = await this._resolveTools(options, appliedProfile);
        const { registry, catalogView } = resolvedBase;
        let systemPrompt = await this._buildSystemPrompt(resolvedBase.tools, options, appliedProfile);
        systemPrompt = systemPrompt
            ? `${systemPrompt}\n\n${TOOL_GROUP_PROGRESS_INSTRUCTIONS}`
            : TOOL_GROUP_PROGRESS_INSTRUCTIONS;
        if (this.messages.length === 0 && options?.messages?.length) {
            this.setMessages([...options.messages]);
        }
        const projected = this._projectModelMessages(systemPrompt, { injectHookContexts: true });
        const projection: TurnModelProjection = {
            systemPrompt: projected.systemPromptContent,
            messages: projected.messages,
        };
        const moded = await this.applyTurnModes({
            options,
            turnContext,
            systemPrompt: projection.systemPrompt,
            resolved: resolvedBase,
        });
        systemPrompt = moded.systemPrompt;
        let progressToolName = PROGRESS_UPDATE_TOOL_NAME;
        while (moded.resolved.tools.some((tool) => tool.name === progressToolName)) {
            progressToolName = `duya_${progressToolName}`;
        }
        const resolved: ResolvedTurnTools = {
            ...moded.resolved,
            tools: [...moded.resolved.tools, { ...PROGRESS_UPDATE_TOOL, name: progressToolName }],
        };
        const resolvedTools: Tool[] = resolved.tools;
        const { canUseTool } = buildPermissions({
            getPermissionMode: () => this.getPermissionMode(),
            ...definedProperties({ hostToolPermission: this.hostToolPermission }),
            alwaysAllowRules: this.alwaysAllowRules,
            alwaysDenyRules: this.alwaysDenyRules,
            alwaysAskRules: this.alwaysAskRules,
            additionalWorkingDirectories: this.additionalWorkingDirectories,
            ...definedProperties({ defaultWorkspaceDirectory: this.defaultWorkspaceDirectory }),
            getAbortController: () => this.abortController,
            llmClient: this.llmClient,
            model: this.model,
            getMessages: () => this.messages,
            hasPermissionsToUseTool: this.hasPermissionsToUseTool,
            getModeCoordinator: () => this.modeCoordinator
        }, turnContext, registry);
        let declaredToolsForRequest = new Set<string>();
        const guardedCanUseTool: typeof canUseTool = async (toolName, toolInput, invocationId) => {
            const decision = evaluateVisibilityGuard({
                declaredTools: declaredToolsForRequest,
                toolName,
            });
            if (decision.undeclared) {
                recordUndeclaredCall(toolName);
                return {
                    allowed: false,
                    behavior: 'deny' as const,
                    message: decision.message!,
                };
            }
            return canUseTool(toolName, toolInput, invocationId);
        };
        let turnToolUseContext: ToolUseContext | undefined;
        const toolInvokeDispatcher = createToolInvokeDispatcherFromRegistry({
            registry,
            getSnapshot: () => catalogView.snapshot,
            getLoadedSchemaRevision: (toolId) => catalogView.loadedSchemaRevisions.get(toolId),
            getLoadedSchemaRound: (toolId) => catalogView.loadedSchemaRounds.get(toolId),
            getCurrentRound: () => catalogView.currentRound,
            isEligibleTool: (toolId) => catalogView.eligibleToolIds.has(toolId),
            ...definedProperties({ workingDirectory: turnContext.workingDirectory ?? undefined }),
            contextProvider: () => turnToolUseContext,
            checkPermission: async (toolName, args, invocationId) => normalizeCanUseToolDecision(await canUseTool(toolName, args, invocationId))
        });
        let currentTools: readonly Tool[] = resolvedTools;
        return {
            resolved,
            turnContext,
            tools: resolvedTools,
            canUseTool: guardedCanUseTool,
            progressToolName,
            systemPrompt,
            projection,
            projectTurnMessages: (): Message[] => this._projectModelMessages('', { injectHookContexts: true }).messages,
            refreshDeclaredTools: () => {
                declaredToolsForRequest = new Set(currentTools.map((t) => t.name));
                return declaredToolsForRequest;
            },
            assemble: (input) => {
                currentTools = input.tools;
                const assembly = this.assembleTurn({
                    turn: input.turn,
                    systemPrompt: input.systemPrompt,
                    messages: input.messages,
                    tools: input.tools as Tool[],
                    resolved,
                    turnContext,
                    options,
                    canUseTool: guardedCanUseTool,
                    toolInvokeDispatcher,
                    publisher,
                    bindToolUseContext: (context) => {
                        turnToolUseContext = context;
                    },
                });
                return assembly;
            },
        };
    }
    async producePromptContextRail(run: RunHandle): Promise<SSEEvent[]> {
        const { options, prompt } = run.request;
        const turnContext = run.turnContext;
        const promptText = typeof prompt === 'string' ? prompt : '';
        const sessionId = turnContext.sessionId ?? '';
        const frames: SSEEvent[] = [];
        const runner = new ConfigHooksRunner({
            cwd: turnContext.workingDirectory ?? process.cwd(),
            vars: { sessionId, cwd: turnContext.workingDirectory ?? '', prompt: promptText },
            onHookInvoked: (hookEvent) => {
                frames.push({
                    type: 'agent_progress',
                    data: { type: 'hook_invoked', hookEvent, sessionId },
                });
                const hookContext = hookEvent.additionalContext;
                if (typeof hookContext === 'string' && hookContext.trim().length > 0) {
                    this.pendingHookMessages.push(buildHookMessage(hookEvent, sessionId));
                }
            },
        });
        const dispatch = async (event: import('@duya/host/worker-hooks/types').HookEvent, input: EventHookInput, targets?: EventHookMatcherTargets): Promise<EventHookRunResult | null> => {
            try {
                return await runner.run(event, input, targets);
            }
            catch (err) {
                logger.warn(`[Hooks] ${event} dispatch failed (skipped): ${err instanceof Error ? err.message : String(err)}`);
                return null;
            }
        };
        const submitCtx = await dispatch('UserPromptSubmit', {
            session_id: sessionId,
            cwd: turnContext.workingDirectory ?? '',
            hook_event_name: 'UserPromptSubmit',
            prompt: promptText,
        });
        if (submitCtx && submitCtx.contexts.length > 0) {
            this.promptContexts = submitCtx.contexts.slice();
            this.promptContextBlocks = [];
            logger.info(`[Hooks] UserPromptSubmit produced ${submitCtx.contexts.length} context line(s) - queued for first-turn injection`);
        }
        const startCtx = await dispatch('SessionStart', {
            session_id: sessionId,
            cwd: turnContext.workingDirectory ?? '',
            hook_event_name: 'SessionStart',
            source: 'startup',
        });
        if (startCtx && startCtx.contexts.length > 0) {
            logger.info(`[Hooks] SessionStart produced ${startCtx.contexts.length} context line(s)`);
            for (const [i, contextLine] of startCtx.contexts.entries()) {
                this.promptContexts.push(renderHookContextEnvelope({ event: 'SessionStart', hookName: 'session-start', seq: i }, contextLine));
            }
        }
        if (options?.mentionedProviders?.length) {
            const descriptors = getCachedAppConnectionDescriptors();
            const injection = collectConnectorActivationInjection(options.mentionedProviders, descriptors);
            if (injection) {
                this.promptContexts.push(`<${injection.envelope}>\n${injection.body}\n</${injection.envelope}>`);
                logger.info(`[Agent] Connector activation: ${options.mentionedProviders.join(', ')}`);
            }
        }
        if (options?.mentionedSkills?.length || promptText) {
            const explicitSkills = extractExplicitSkillMentions(promptText);
            const mergedMentionedSkills = mergeSkillMentionSources(options?.mentionedSkills ?? [], explicitSkills);
            const skillInjections = await collectSkillInjections(mergedMentionedSkills);
            this.injectedSkillParts.clear();
            for (const injection of skillInjections) {
                const rendered = `<${injection.envelope}>\n${injection.body}\n</${injection.envelope}>`;
                this.promptContexts.push(rendered);
                if (injection.envelope === 'skill' && injection.skillName) {
                    this.injectedSkillParts.set(`skill:${injection.skillName}`, estimateContextTextTokens(rendered));
                }
            }
            if (skillInjections.length > 0) {
                logger.info(`[Agent] Skill injection: ${skillInjections.length} skill fragment(s) queued`);
            }
        }
        if (promptText) {
            const excludeSkills = new Set(options?.mentionedSkills ?? []);
            const skillHits = matchSkillsForPrompt(promptText, {
                ...definedProperties({ workingDirectory: turnContext.workingDirectory ?? undefined }),
                exclude: excludeSkills
            });
            const skillSuggestion = buildSkillSuggestionInjection(skillHits);
            if (skillSuggestion) {
                this.promptContexts.push(`<${skillSuggestion.envelope}>\n${skillSuggestion.body}\n</${skillSuggestion.envelope}>`);
                logger.info(`[Agent] Skill suggestion: ${skillHits.length} skill(s) matched (${skillHits.map((h) => h.skill.name).join(', ')})`);
            }
        }
        if (options?.mentionedPlugins?.length) {
            const descriptors = getCachedAppConnectionDescriptors();
            const injection = collectPluginInjections(options.mentionedPlugins, descriptors);
            if (injection) {
                this.promptContexts.push(`<${injection.envelope}>\n${injection.body}\n</${injection.envelope}>`);
                logger.info(`[Agent] Plugin activation: ${options.mentionedPlugins.map((p) => p.pluginId).join(', ')}`);
            }
        }
        if (promptText) {
            try {
                const agents = await readConfigAgents();
                const roster = Object.entries(agents)
                    .filter(([id]) => id !== options?.agentProfileId)
                    .map(([id, entry]) => ({ id, name: entry.name || id }));
                const mentionedContext = buildMentionedAgentsContext(parseAgentMentions(promptText, roster));
                if (mentionedContext) {
                    this.promptContexts.push(mentionedContext);
                    logger.info('[Agent] Injected mentioned-agents context into first turn');
                }
            }
            catch (err) {
                logger.warn(`[Agent] Agent mention parse skipped: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        return frames;
    }
    bindTurnOutputSink(sink: TurnOutputSink | null): void {
        this.turnOutputSink = sink;
    }
    readTurnOutputSink(): TurnOutputSink | null {
        return this.turnOutputSink;
    }
    bindRunForkMarker(marker: {
        readonly replyToId: string;
        readonly userId: string;
    } | null): void {
        this.forkTurn = marker === null ? null : { replyToId: marker.replyToId, userId: marker.userId };
    }
    readRunForkMarker(): {
        readonly replyToId: string;
        readonly userId: string;
    } | null {
        return this.forkTurn === null ? null : { replyToId: this.forkTurn.replyToId, userId: this.forkTurn.userId };
    }
    projectRunOwnModelMessages(forkUserId: string): Message[] {
        const context = buildAgentContext(this.timeline.snapshot());
        return [...projectModelMessages(context.messages, { runBranch: { forkUserId } }).messages];
    }
    async recordTurnToolResult(input: {
        readonly message: Message;
        readonly toolName: string;
        readonly seqIndex: number;
    }): Promise<void> {
        const { message } = input;
        message.seq_index = input.seqIndex;
        if (!message.id)
            message.id = crypto.randomUUID();
        this._commitDurable(message);
        const outcome = this._readToolResultOutcome(message);
        this._publishTurnFrame(this._buildToolResultFrame(message, outcome));
        if (outcome.isError) {
            await this.dispatchPostToolUseFailure({
                session_id: this.sessionId ?? '',
                cwd: this.workingDirectory ?? '',
                hook_event_name: 'PostToolUseFailure',
                tool_name: input.toolName,
                tool_input: {},
                tool_use_id: outcome.id,
                error: outcome.content.slice(0, 2048),
            }, { ...definedProperties({ toolName: input.toolName || undefined }) });
        }
        const modeChanged = this._buildModeChangedFrame(input.toolName, outcome);
        if (modeChanged !== null)
            this._publishTurnFrame(modeChanged);
    }
    recordTurnAssistantMessage(input: {
        readonly content: MessageContent[];
        readonly usage?: AssistantMessage['usage'];
        readonly seqIndex: number;
        readonly durationMs?: number;
    }): void {
        const row: Message = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: input.content,
            timestamp: Date.now(),
            duration_ms: input.durationMs ?? 0,
            seq_index: input.seqIndex,
            ...this.modelAttribution,
        };
        if (input.usage !== undefined)
            (row as AssistantMessage).usage = input.usage;
        this._commitDurable(row);
    }
    commitTurnPromptUserRow(input: {
        readonly prompt: string | MessageContent[];
        readonly messages: Message[];
        readonly seqIndex: number;
        readonly clientMsgId?: string;
        readonly displayContent?: string;
        readonly attachments?: ChatOptions['attachments'];
        readonly wakeRun?: boolean;
        readonly replyToId?: string;
        readonly branched?: boolean;
    }): PromptUserRowCommit {
        const { messages } = input;
        const lastMessage = messages[messages.length - 1];
        const persistedPromptContent = input.prompt as string | MessageContent[];
        const displayContent = input.displayContent !== undefined ? input.displayContent : undefined;
        if (!this._isDuplicatePrompt(lastMessage, input.prompt)) {
            const userMessage = {
                id: input.clientMsgId ?? crypto.randomUUID(),
                role: 'user',
                content: persistedPromptContent,
                displayContent: displayContent !== undefined ? displayContent : undefined,
                timestamp: Date.now(),
                seq_index: input.seqIndex,
                attachments: input.attachments,
                ...(input.wakeRun ? { source: 'system' as const } : {}),
            } as Message;
            const replyMeta = resolveReplyMeta(input.replyToId, input.branched, collectMessageIds(this.timeline.snapshot()));
            if (replyMeta) {
                userMessage.metadata = mergeThreadMetadata(userMessage.metadata, replyMeta);
                if (replyMeta.branched === true && userMessage.id) {
                    this.forkTurn = {
                        replyToId: replyMeta.replyToId ?? userMessage.id,
                        userId: userMessage.id,
                    };
                }
            }
            this._pushDurable(messages, userMessage);
            return { committed: true, messageId: userMessage.id ?? null };
        }
        if (lastMessage) {
            lastMessage.seq_index = input.seqIndex;
            lastMessage.content = persistedPromptContent;
            if (displayContent === undefined)
                delete lastMessage.displayContent;
            else
                lastMessage.displayContent = displayContent;
            if (input.attachments && input.attachments.length > 0) {
                lastMessage.attachments = input.attachments;
            }
            return { committed: false, messageId: lastMessage.id ?? null };
        }
        return { committed: false, messageId: null };
    }
    private _isDuplicatePrompt(candidate: Message | undefined, prompt: string | MessageContent[]): boolean {
        if (!candidate || candidate.role !== 'user')
            return false;
        const compareContent = typeof prompt === 'string'
            ? prompt
            : (Array.isArray(prompt)
                ? prompt.filter((b: unknown) => (b as Record<string, unknown>).type === 'text')
                    .map((b: unknown) => (b as Record<string, string>).text || '')
                    .join('')
                : '');
        const candidateContent = typeof candidate.content === 'string'
            ? candidate.content
            : (Array.isArray(candidate.content)
                ? (candidate.content as Array<{
                    type: string;
                    text?: string;
                }>)
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text || '')
                    .join('')
                : '');
        const normalizedCandidate = stripPastedContentMarkers(candidateContent).trim();
        const normalizedCompare = stripPastedContentMarkers(compareContent).trim();
        return normalizedCandidate === normalizedCompare || candidateContent.trim() === compareContent.trim();
    }
    finishTurnOutput(summary: TurnOutputSummary): void {
        this.turnOutputSink?.finishTurn(summary);
    }
    async dispatchPostToolUseFailure(input: EventHookInput, targets?: EventHookMatcherTargets): Promise<EventHookRunResult | null> {
        const runner = new ConfigHooksRunner({
            cwd: this.workingDirectory ?? process.cwd(),
            vars: { sessionId: this.sessionId ?? '', cwd: this.workingDirectory ?? '' },
        });
        try {
            return await runner.run('PostToolUseFailure', input, targets);
        }
        catch (err) {
            logger.warn(`[Hooks] PostToolUseFailure dispatch failed (skipped): ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
    }
    private turnOutputSink: TurnOutputSink | null = null;
    private _publishTurnFrame(event: SSEEvent): void {
        this.turnOutputSink?.publish(event);
    }
    private llmClient: AIClient;
    private compactClient: AIClient | undefined;
    get messages(): Message[] {
        return projectTimelinePersistenceMessages(this.timeline.snapshot());
    }
    private timeline = new MessageTimeline();
    private syncedMessageIds: Set<string> = new Set();
    private compactionController!: MessageCompactionController;
    private abortController: AbortController | null = null;
    private currentToolUseContext: ToolUseContext | undefined;
    private sessionInfo: SessionInfo;
    private compactionManager: CompactionManager;
    private apiKey: string;
    private baseURL: string | undefined;
    private authStyle: ('api_key' | 'auth_token') | undefined;
    private provider: 'anthropic' | 'openai' | 'ollama';
    private sessionId: string | undefined;
    private workingDirectory: string | undefined;
    private currentProjectId: (string | null) | undefined;
    private projectHome: string | undefined;
    private defaultWorkspaceDirectory: string | undefined;
    private communicationPlatform: import('@duya/host/worker-prompts/types').CommunicationPlatform | undefined;
    private language: string | undefined;
    private permissionMode: PermissionMode = 'default';
    private hostToolPermission: LocalToolPermission | undefined;
    private hasPermissionsToUseTool: ReturnType<typeof createHasPermissionsToUseTool>;
    private _consumeApprovedEffect: ((toolName: string, toolInput?: Record<string, unknown>) => Promise<boolean>) | undefined;
    private _turnAlwaysAllowTools: Set<string> = new Set();
    private alwaysAllowRules: ToolPermissionRulesBySource = {};
    private alwaysDenyRules: ToolPermissionRulesBySource = {};
    private alwaysAskRules: ToolPermissionRulesBySource = {};
    private additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory> = new Map();
    private visualAnalysis: VisualAnalysisService;
    private blockedDomains: string[] = [];
    private browserBackendMode: 'auto' | 'extension' | 'built-in' | 'human-like' = 'auto';
    private mcpManager: MCPManager | null = null;
    private mcpReadyResolve: (() => void) | null = null;
    private mcpReady: Promise<void> = new Promise((resolve) => {
        this.mcpReadyResolve = resolve;
    });
    private promptContexts: string[] = [];
    private promptContextBlocks: string[] = [];
    private injectedSkillParts: Map<string, number> = new Map();
    getInjectedSkillParts(): Array<{
        label: string;
        tokens: number;
    }> {
        return [...this.injectedSkillParts.entries()].map(([label, tokens]) => ({ label, tokens }));
    }
    private lastCompactionTurn = -Infinity;
    private compactionCoordinator: CompactionCoordinator;
    private lastCompactionObservedTokens: number | undefined = undefined;
    static readonly MIN_TURNS_SINCE_COMPACT = 3;
    static readonly MIN_TOKENS_GROWTH_SINCE_COMPACT = 30000;
    private readonly pendingHookMessages = new PendingHookMessages();
    private baseSystemPromptWithoutModes: string | undefined;
    private resolvedModes: ResolvedMode | undefined;
    private lastSystemContextTokensEstimate = 0;
    private lastSystemTokensEstimate = 0;
    private lastToolsTokensEstimate = 0;
    private resolvedWindow: {
        contextWindow: number;
        windowSource: 'capability' | 'catalog' | 'default';
    } = {
        contextWindow: 0,
        windowSource: 'default',
    };
    private modeCtx: ModeModifierContext | undefined;
    private subagentDeps!: SubagentRunDeps;
    private modeCoordinator: ModeCoordinator | undefined;
    readonly runtimeConfig: AgentOptions['runtimeConfig'] | undefined;
    private readonly modelAttribution: {
        providerId: string;
        model: string;
        api: ApiFormat;
    };
    onMessagesCompacted: ((newMessageCount: number) => void) | undefined;
    readonly activeMCPRegistry: ToolRegistry = new ToolRegistry();
    activeMCPRuntimeSnapshot: import('@duya/host/connector-services/apply').ActiveMCPRuntimeSnapshot | null = null;
    private providerNameToInternalKey: Map<string, string> = new Map();
    private activeAgentProfileId: string | undefined;
    private lastAppliedAgentProfile: AgentProfile | undefined;
    private readonly omitAgentsMd: boolean = false;
    private botAssembly: BotPromptAssembly | null = null;
    constructor(options: AgentOptions, private readonly assembly: WorkerSessionAssemblyPorts) {
        let provider: 'anthropic' | 'openai' | 'ollama';
        let resolvedFromRuntime = false;
        if (options.runtimeConfig) {
            provider = resolveLlmClientDiscriminator(options.runtimeConfig.apiFormat);
            resolvedFromRuntime = true;
        }
        else {
            provider = options.provider || inferProvider(options.baseURL || '');
        }
        this.provider = provider;
        this.sessionId = options.sessionId;
        this.omitAgentsMd = options.omitAgentsMd === true;
        if (!options.model) {
            throw new Error(`Model is required. Please specify a model in your provider settings. ` +
                `Provider: ${provider}, BaseURL: ${options.baseURL || 'not provided'}`);
        }
        const baseURL = options.baseURL || resolveDefaultBaseURL(provider);
        const model = options.model;
        const enableRetry = options.enableRetry !== false;
        if (resolvedFromRuntime && options.runtimeConfig) {
            logger.debug('[duyaAgent] LLM client selected from runtimeConfig.apiFormat', {
                apiFormat: options.runtimeConfig.apiFormat,
                provider,
                headerKeys: Object.keys(options.runtimeConfig.headers ?? {}),
            });
        }
        const llmClientOptions: AIClientOptions = {
            apiKey: options.apiKey,
            baseURL,
            model,
            ...definedProperties({ authStyle: options.authStyle }),
            apiFormat: options.runtimeConfig?.apiFormat ?? (provider === 'ollama' ? 'ollama' : provider === 'anthropic' ? 'anthropic' : 'openai-chat'),
            providerId: options.runtimeConfig?.providerId ?? provider,
            ...definedProperties({ modelCapabilities: options.runtimeConfig?.modelCompat }),
            cacheRetention: resolveCacheRetention(provider)
        };
        if (enableRetry) {
            logger.debug('[duyaAgent] Using retryable LLM client');
            this.llmClient = createAIClientWithRetry({
                ...llmClientOptions,
                ...definedProperties({ retryConfig: options.retryConfig })
            });
        }
        else {
            logger.debug('[duyaAgent] Using standard LLM client (retry disabled)');
            this.llmClient = createAIClient(llmClientOptions);
        }
        this.modelAttribution = {
            providerId: llmClientOptions.providerId,
            model: llmClientOptions.model,
            api: llmClientOptions.apiFormat,
        };
        this.apiKey = options.apiKey;
        this.baseURL = options.baseURL;
        this.authStyle = options.authStyle;
        this.workingDirectory = options.workingDirectory;
        this.currentProjectId = options.currentProjectId ?? null;
        this.projectHome = options.projectHome;
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
        this.visualAnalysis = new VisualAnalysisService(options.visionConfig, resolveDefaultBaseURL);
        this.compactClient = buildCompactClient(options.compactModelConfig);
        const resolvedContextWindow = resolveCompactionContextWindow({
            ...definedProperties({ capabilityContextWindow: options.runtimeConfig?.modelCapabilities?.contextWindow }),
            modelId: options.runtimeConfig?.model ?? options.model
        });
        if (resolvedContextWindow.source === 'default') {
            logger.warn('[Agent] compaction contextWindow fallback to 200000 — neither runtimeConfig.modelCapabilities.contextWindow nor the @duya/ai catalog declares a window for this model. ' +
                'Add [options].model_context[modelId] = N in config.toml or a DB override row to recover the real window.', {
                runtimeConfigHasCapabilities: options.runtimeConfig?.modelCapabilities !== undefined,
                model: options.runtimeConfig?.model ?? options.model,
                apiFormat: options.runtimeConfig?.apiFormat,
            }, 'AgentCore');
        }
        this.compactionManager = createCompactionManager({
            enableReinjection: true,
            maxTokens: resolvedContextWindow.contextWindow,
        });
        this.resolvedWindow = {
            contextWindow: resolvedContextWindow.contextWindow,
            windowSource: resolvedContextWindow.source,
        };
        this.compactionManager.getContextLedger().noteModelSwitch({
            contextWindow: resolvedContextWindow.contextWindow,
            windowSource: resolvedContextWindow.source,
        }, options.runtimeConfig?.model ?? options.model);
        this.compactionManager.addEventHandler((event) => {
            if (event.type === 'compaction_over_threshold') {
                logger.warn(`[Agent] Compaction over threshold: retained=${event.tokensRetained}, available=${event.available} — ` +
                    `auto-compaction suppressed until next successful shrink`);
            }
            if (event.type === 'compaction_complete') {
                const released = getAgentsMdManager().releaseNestedMemoryForReinject(this.workingDirectory);
                if (released > 0) {
                    logger.info(`[Agent] Compaction released ${released} nested AGENTS.md path(s) for re-injection`, undefined, 'AgentsMd');
                }
            }
        });
        this.compactionManager.setSummarizer(async (text: string, prompt: string): Promise<string> => {
            const summaryMessages: Message[] = [
                {
                    role: 'user',
                    content: prompt,
                },
            ];
            const childController = this.abortController
                ? createChildAbortController(this.abortController)
                : new AbortController();
            try {
                const result = await createOneShotTextPort(this.compactClient ?? this.llmClient).complete({
                    systemPrompt: 'You are a summarization assistant. Follow the instructions embedded in the user message.',
                    messages: fromProviderMessages(summaryMessages),
                    maxOutputTokens: 8192,
                    temperature: 0.3,
                }, childController.signal);
                if (result.kind === 'completed') {
                    return result.text.trim();
                }
                if (result.kind === 'failed') {
                    throw new Error(result.error.message);
                }
                throw childController.signal.reason instanceof Error
                    ? childController.signal.reason
                    : new Error('Compaction summarization was cancelled');
            }
            finally {
                const disposable = childController as AbortController & {
                    dispose?: () => void;
                };
                disposable.dispose?.();
            }
        });
        this.compactionManager.setMemoryFlushFn(async (summary: string) => {
            if (!isMemoryEnabled())
                return;
            const session = this.sessionId;
            if (!session)
                return;
            const sessionsRoot = this.sessionsRootPath();
            if (!sessionsRoot)
                return;
            const now = new Date();
            const yyyy = String(now.getUTCFullYear()).padStart(4, '0');
            const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
            const dd = String(now.getUTCDate()).padStart(2, '0');
            const stamp = now.toISOString().replace(/[:.]/g, '-');
            const dayDir = path.join(sessionsRoot, yyyy, mm, dd);
            fs.mkdirSync(dayDir, { recursive: true });
            const file = path.join(dayDir, `${session}-${stamp}-compaction.md`);
            fs.writeFileSync(file, `# Compaction summary\n\n${summary}\n`, 'utf8');
        });
        this.permissionMode = options.permissionMode || 'default';
        this.hostToolPermission = options.hostToolPermission;
        this.hasPermissionsToUseTool = createHasPermissionsToUseTool();
        const ruleSource: PermissionRuleSource = 'userSettings';
        const allRules = settingsJsonToRules(options.permissionRules ?? null, ruleSource);
        this.alwaysAllowRules = this.groupRulesBySource(allRules.filter((r) => r.ruleBehavior === 'allow'));
        this.alwaysDenyRules = this.groupRulesBySource(allRules.filter((r) => r.ruleBehavior === 'deny'));
        this.alwaysAskRules = this.groupRulesBySource(allRules.filter((r) => r.ruleBehavior === 'ask'));
        const additionalDirs = options.permissionRules?.permissions?.additionalDirectories ?? [];
        for (const dir of additionalDirs) {
            const resolved = path.resolve(dir);
            this.additionalWorkingDirectories.set(resolved, { path: resolved, source: ruleSource });
        }
        this.blockedDomains = options.blockedDomains ?? [];
        this.browserBackendMode = options.browserBackendMode ?? 'auto';
        this.compactionController = new MessageCompactionController({
            timeline: this.timeline,
            compactionManager: this.compactionManager,
        });
        this.compactionCoordinator = new CompactionCoordinator({
            compactionController: this.compactionController,
            compactionManager: this.compactionManager,
            projectModelMessages: (systemPrompt, options) => this._projectModelMessages(systemPrompt, options),
            ...definedProperties({ onMessagesCompacted: this.onMessagesCompacted }),
            getMessages: () => this.messages,
            getLastCompactionTurn: () => this.lastCompactionTurn,
            setLastCompactionTurn: (turn) => {
                this.lastCompactionTurn = turn;
            },
            getLastCompactionObservedTokens: () => this.lastCompactionObservedTokens,
            setLastCompactionObservedTokens: (tokens) => {
                this.lastCompactionObservedTokens = tokens;
            },
            getMinTurnsSinceCompact: () => WorkerSession.MIN_TURNS_SINCE_COMPACT,
            getMinTokensGrowthSinceCompact: () => WorkerSession.MIN_TOKENS_GROWTH_SINCE_COMPACT
        });
    }
    private _model!: string;
    private _lastSeenModel: string | undefined;
    get model(): string {
        return this._model;
    }
    set model(value: string) {
        this._model = value;
    }
    private sessionsRootPath(): string | null {
        if (process.env.DUYA_SESSIONS_ROOT)
            return process.env.DUYA_SESSIONS_ROOT;
        const home = os.homedir();
        if (!home)
            return null;
        return path.join(home, '.duya', 'sessions');
    }
    private memoryRootPath(): string | null {
        return getDuyaMemoryRoot();
    }
    drainPendingHookMessages(): Message[] {
        return this.pendingHookMessages.drain();
    }
    private _commitMessages(): void {
        this.sessionInfo.messageCount = this.messages.length;
        this.sessionInfo.updatedAt = Date.now();
    }
    private _appendMessageToTimeline(message: Message): void {
        if (!message.id || this.syncedMessageIds.has(message.id))
            return;
        if (message.timestamp == null) {
            message.timestamp = Date.now();
        }
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
    private _appendRuntimeContextToTimeline(message: RuntimeContextAgentMessage): boolean {
        if (!message.id || this.syncedMessageIds.has(message.id))
            return false;
        if (message.source === 'attachment') {
            const ids = (message.metadata?.[RUNTIME_CONTEXT_METADATA_KEYS.attachmentIds as string] ?? []) as unknown[];
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
        this.sessionInfo.messageCount = this.messages.length;
        return true;
    }
    private _hasAttachmentRuntimeContext(attachmentIds: readonly string[]): boolean {
        if (attachmentIds.length === 0)
            return false;
        const snapshot = this.timeline.snapshot();
        for (const entry of snapshot) {
            if (entry.type !== 'message')
                continue;
            const msg = entry.message as unknown as Record<string, unknown>;
            if (msg.role !== 'runtime_context' && msg.kind !== 'runtime_context')
                continue;
            if ((msg as {
                source?: string;
            }).source !== 'attachment')
                continue;
            const md = (msg as {
                metadata?: Readonly<Record<string, unknown>>;
            }).metadata;
            const ids = (md?.[RUNTIME_CONTEXT_METADATA_KEYS.attachmentIds as string] ?? []) as unknown[];
            const existingIds = Array.isArray(ids)
                ? ids.filter((x): x is string => typeof x === 'string')
                : [];
            if (existingIds.length === attachmentIds.length &&
                existingIds.every((id) => attachmentIds.includes(id))) {
                return true;
            }
        }
        return false;
    }
    journal: import('@duya/host/worker-journal/Journal').Journal | undefined;
    private currentTurnId: string | null = null;
    private currentRunId: string | null = null;
    private forkTurn: {
        replyToId: string;
        userId: string;
    } | null = null;
    private _pushDurable(messages: Message[], message: Message): void {
        messages.push(message);
        this._commitDurable(message);
    }
    private _readToolResultOutcome(message: Message): ToolResultOutcome {
        const content = message.content;
        if (message.role === 'tool') {
            const text = typeof content === 'string' ? content : JSON.stringify(content);
            return {
                id: message.tool_call_id || '',
                content: text,
                isError: text.includes('<tool_error>'),
            };
        }
        const contentBlock = (content as MessageContent[])[0] as ToolResultContent;
        return {
            id: contentBlock.tool_use_id,
            content: typeof contentBlock.content === 'string'
                ? contentBlock.content
                : JSON.stringify(contentBlock.content),
            isError: contentBlock.is_error ?? false,
        };
    }
    private _buildToolResultFrame(message: Message, outcome: ToolResultOutcome): SSEEvent {
        return {
            type: 'tool_result',
            data: {
                id: outcome.id,
                name: '',
                result: outcome.content,
                error: outcome.isError,
                duration_ms: message.duration_ms,
                metadata: message.metadata,
            },
        } as SSEEvent;
    }
    private _buildModeChangedFrame(toolName: string, outcome: ToolResultOutcome): SSEEvent | null {
        if (outcome.isError)
            return null;
        if (toolName !== 'SwitchMode' &&
            toolName !== 'EnterPlanMode' &&
            toolName !== 'ExitPlanMode') {
            return null;
        }
        let nextMode: AgentRuntimeMode | undefined;
        let reason: string | undefined;
        try {
            const parsed = JSON.parse(outcome.content) as Record<string, unknown>;
            if (toolName === 'SwitchMode') {
                nextMode = parsed.currentMode as AgentRuntimeMode | undefined;
                reason = parsed.reason as string | undefined;
            }
            else {
                const planMode = parsed.planMode;
                nextMode = planMode ? 'plan' : 'general';
            }
        }
        catch {
            return null;
        }
        if (!nextMode)
            return null;
        return {
            type: 'mode_changed',
            data: { mode: nextMode, source: 'agent', reason },
        } as SSEEvent;
    }
    private _commitDurable(message: Message): void {
        if (message.role !== 'user' && this.forkTurn && !isBranchedMessage(message)) {
            message.metadata = mergeThreadMetadata(message.metadata, {
                replyToId: this.forkTurn.userId,
                branched: true,
            });
        }
        this._appendMessageToTimeline(message);
        if (this.journal && message.id) {
            switch (message.role) {
                case 'user':
                    this.journal.userMsgAdded(message, this.currentTurnId);
                    break;
                case 'assistant':
                    this.journal.assistantMsgFinalized(message, this.currentTurnId);
                    break;
                case 'tool':
                    this.journal.toolResultAdded(message, this.currentTurnId);
                    break;
            }
        }
    }
    async claimInterTurn(input: {
        readonly runId: string;
        readonly checkpoint: 'before_model_turn' | 'before_final_answer';
        readonly messages: Message[];
        readonly seqIndex: number;
        readonly wakeRun: boolean;
        readonly imageInputSupported?: boolean;
    }): Promise<RuntimeMailboxDecision> {
        return this._claimMailboxAtCheckpoint(input.runId, input.messages, input.seqIndex, input.checkpoint, input.wakeRun, input.imageInputSupported);
    }
    private async _sweepInterTurn(runId: string, messages: Message[], seqIndex: number, checkpoint: 'before_model_turn' | 'before_final_answer', options?: ChatOptions): Promise<RuntimeMailboxDecision> {
        return this._claimMailboxAtCheckpoint(runId, messages, seqIndex, checkpoint, options?.wakeRun === true, options?.imageInputSupported);
    }
    engineCompactionSources(input: {
        readonly systemPromptContent: () => string;
        readonly messages: () => readonly Message[];
        readonly nextCompactionId?: () => string;
    }): CompactionSources {
        return buildCoordinatorCompactionSources({
            coordinator: this.compactionCoordinator,
            systemPromptContent: input.systemPromptContent,
            messages: input.messages,
            ...(input.nextCompactionId === undefined
                ? {}
                : { nextCompactionId: input.nextCompactionId }),
            noteUsage: (anchor) => {
                this.compactionManager.setObservedUsageForEpoch(anchor.inputTokens, anchor.outputTokens, anchor.epoch);
            },
        });
    }
    private async _claimMailboxAtCheckpoint(runId: string, messages: Message[], seqIndex: number, checkpoint: 'before_model_turn' | 'before_final_answer', wakeRun = false, imageInputSupported = isModelLikelyMultimodal(this.model)): Promise<RuntimeMailboxDecision> {
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
        }
        catch (err) {
            logger.warn(`[AgentMailbox] ${checkpoint} claim failed: ${err instanceof Error ? err.message : String(err)}`);
            return { action: 'continue', absorbed: false };
        }
        if (!claim.rows.length) {
            return { action: 'continue', absorbed: false };
        }
        const applyRow = async (row: MailboxRow, index: number, summary: string): Promise<void> => {
            const claimToken = claim.claimTokens[index];
            if (!claimToken)
                return;
            await mailboxDb.apply({
                id: row.id,
                claimToken,
                mode: chooseMailboxApplyMode(row),
                checkpoint,
                summary,
            });
        };
        const usableRows = claim.rows.filter((row) => row.content.trim().length > 0 || parseMailboxAttachments(row.attachments_json).length > 0);
        if (!usableRows.length) {
            return { action: 'continue', absorbed: false };
        }
        for (const row of usableRows) {
            await applyRow(row, claim.rows.indexOf(row), 'absorbed as runtime instruction before model turn');
        }
        const injectableRows = wakeRun
            ? usableRows.filter((row) => row.kind !== 'agent_dm')
            : usableRows;
        const backgroundNotificationRows = injectableRows.filter((row) => row.kind === 'background_notification');
        const guidanceRows = injectableRows.filter((row) => row.kind !== 'background_notification');
        for (const row of backgroundNotificationRows) {
            const ctx = adaptBackgroundNotification(row, { seqIndex });
            const wrappedContent = typeof ctx.content === 'string'
                ? renderSystemReminder([
                    'Automated background-task notification — system context, not a user message.',
                    'Do not greet the user or announce this notification; silently fold it into the ongoing work where relevant.',
                    ctx.content,
                ].join('\n'), 'background_notification')
                : ctx.content;
            const projected = projectRuntimeContextToProviderMessage({ ...ctx, content: wrappedContent });
            if (projected)
                messages.push(projected);
        }
        if (guidanceRows.length > 0) {
            const guidanceTokens = guidanceRows.map((row) => {
                const token = claim.claimTokens[claim.rows.indexOf(row)];
                if (token === undefined) throw new Error('Claimed mailbox guidance is missing its claim token');
                return token;
            });
            const adapted = await prepareMailboxGuidance(guidanceRows, guidanceTokens, {
                seqIndex, imageInputSupported, analyzeImage: this.visualAnalysis.analyzeImage.bind(this.visualAnalysis),
            });
            for (const ctx of adapted) {
                const projected = projectRuntimeContextToProviderMessage(ctx);
                if (projected)
                    messages.push(projected);
            }
        }
        logger.info(`[AgentMailbox] absorbed ${usableRows.length} row(s) at ${checkpoint}`);
        return { action: 'continue', absorbed: true };
    }
    private async _resolveAgentProfile(options?: ChatOptions): Promise<AgentProfile | undefined> {
        if (!options?.agentProfileId) {
            return undefined;
        }
        const profileService = getAgentProfileService();
        const preset = profileService.get(options.agentProfileId);
        if (preset) {
            logger.info(`[Agent] Applying agent profile: ${preset.name} (${preset.id}), promptSystem=${preset.promptSystem || 'general'}`);
            return preset;
        }
        try {
            const agents = await readConfigAgents();
            const entry = agents[options.agentProfileId];
            if (!entry) {
                logger.warn(`[Agent] Agent profile not found: ${options.agentProfileId}`);
                return undefined;
            }
            const profile = await toAgentProfile(options.agentProfileId, entry);
            logger.info(`[Agent] Applying config agent profile: ${profile.name} (${profile.id})`);
            return profile;
        }
        catch (err) {
            logger.warn(`[Agent] Failed to resolve config agent profile ${options.agentProfileId}: ${err instanceof Error ? err.message : String(err)}`);
            return undefined;
        }
    }
    private async _resolveTools(options?: ChatOptions, appliedProfile?: AgentProfile): Promise<ResolvedTurnTools> {
        logger.info(`[Agent] streamChat: Loading tools...`);
        let registry = options?.toolRegistry;
        if (!registry) {
            registry = this.activeMCPRegistry;
            try {
                const { getCachedAppConnectionDescriptors, registerAppConnectionTools } = await import('@duya/host/worker-tool-bindings/app-connection-tools');
                const appConnDescriptors = getCachedAppConnectionDescriptors();
                if (appConnDescriptors.length > 0) {
                    registerAppConnectionTools(registry, appConnDescriptors);
                }
            }
            catch (err) {
                logger.warn(`[Agent] Failed to merge App Connection tools: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        const selectedProviders = options?.mentionedProviders?.filter((p) => typeof p === 'string' && p) ?? [];
        const preExposedConnectorTools = new Set<string>(selectedProviders.length
            ? getCachedAppConnectionDescriptors()
                .filter((d) => selectedProviders.includes(d.provider))
                .map((d) => d.name)
            : []);
        const constraints: ToolVisibilityConstraints = {
            ...definedProperties({ disabledTools: options?.disabledTools }),
            ...definedProperties({ allowedTools: options?.allowedTools }),
            ...definedProperties({ profileAllowedPatterns: appliedProfile?.allowedTools }),
            ...definedProperties({ profileDisallowedPatterns: appliedProfile?.disallowedTools })
        };
        if (!registry.has('tool_catalog')) {
            const catalog = new ToolCatalogTool();
            registry.register(catalog.toTool(), catalog, { exposure: 'eager' });
        }
        if (!registry.has('tool_invoke')) {
            const invoke = new ToolInvokeTool();
            registry.register(invoke.toTool(), invoke, { exposure: 'eager' });
        }
        const catalogTool = registry.getExecutor('tool_catalog');
        const toolInvokeExecutor = registry.getExecutor('tool_invoke');
        if (!(catalogTool instanceof ToolCatalogTool) || !(toolInvokeExecutor instanceof ToolInvokeTool)) {
            throw new Error('Tool catalog executors are missing or have incompatible registrations.');
        }
        const snapshot = registry.snapshot(this.providerNameToInternalKey);
        const allTools = snapshot.tools;
        const mcpToolCount = allTools.filter((t) => registry.getOwner(t.name) === 'mcp').length;
        logger.debug(`[Agent] Tool snapshot: ${allTools.length} total (${mcpToolCount} MCP, ${allTools.length - mcpToolCount} non-MCP)`);
        const discoveredSeed = preExposedConnectorTools.size > 0
            ? new Set([...EMPTY_DISCOVERED, ...preExposedConnectorTools])
            : EMPTY_DISCOVERED;
        const directToolIds = new Set(snapshot.catalogEntries
            .filter((entry) => isToolVisible(entry.definition.name, entry.exposure, discoveredSeed, constraints))
            .map((entry) => entry.toolId));
        const catalogAllowed = isToolVisible('tool_catalog', 'eager', EMPTY_DISCOVERED, constraints);
        const invokeAllowed = isToolVisible('tool_invoke', 'eager', EMPTY_DISCOVERED, constraints);
        const eligibleToolIds = new Set(snapshot.catalogEntries
            .filter((entry) => isToolVisible(entry.definition.name, 'eager', discoveredSeed, constraints) &&
            (entry.exposure !== 'deferred' || directToolIds.has(entry.toolId) || (catalogAllowed && invokeAllowed)))
            .map((entry) => entry.toolId));
        const catalogView: ToolCatalogView = {
            snapshot,
            registry,
            eligibleToolIds,
            directToolIds,
            loadedSchemaRevisions: new Map(),
            loadedSchemaRounds: new Map(),
            currentRound: 0,
        };
        catalogTool.setView(catalogView);
        const tools: Tool[] = [];
        for (const t of allTools) {
            const exposure = snapshot.getExposure(t.name);
            if (!isToolVisible(t.name, exposure, discoveredSeed, constraints))
                continue;
            const projection = projectForProvider(t.input_schema);
            tools.push(projection.downgraded ? { ...t, input_schema: projection.schema } : t);
        }
        logger.info(`[Agent] streamChat: ${tools.length}/${allTools.length} tools visible after visibility filter`);
        if (appliedProfile?.allowedTools?.length && tools.length === 0) {
            throw new Error(`Agent profile "${appliedProfile.id}" allowedTools matched zero tools ` +
                `(all ${allTools.length} tools were denied). ` +
                `Patterns: ${appliedProfile.allowedTools.join(', ')}. ` +
                `Check packages/agent/src/agent-profile/types.ts and the tool name constants.`);
        }
        logger.info(`[Agent] streamChat: Loaded ${tools.length} tools`);
        logger.info(`[Agent] streamChat: Loading agent definitions...`);
        const { getAgentDefinitions } = await import('@duya/host/worker-subagents/built-in-agents');
        const agentDefinitions = getAgentDefinitions();
        logger.info(`[Agent] streamChat: Loaded ${agentDefinitions.length} agent definitions`);
        return { tools, registry, agentDefinitions, constraints, catalogTool, catalogView, toolInvokeExecutor };
    }
    private async _buildSystemPrompt(tools: Tool[], options?: ChatOptions, appliedProfile?: AgentProfile): Promise<string> {
        const sysName = resolvePromptSystemName(appliedProfile?.promptSystem);
        const promptProfile = appliedProfile
            ? getPromptProfileForAgentProfile(appliedProfile)
            : DEFAULT_PROMPT_PROFILE;
        const promptSystem: PromptSystem = PromptsRegistry.getOrCreate(sysName, promptProfile)
            ?? PromptsRegistry.getOrCreate('general', promptProfile)!;
        logger.info(`[Agent] Using prompt system '${sysName}'${appliedProfile ? ` for profile: ${appliedProfile.name}` : ' (default)'}`);
        logger.info(`[Agent] Resolved prompt profile: enableSections=${JSON.stringify(promptProfile.enableSections ?? [])}, disableSections=${JSON.stringify(promptProfile.disableSections ?? [])}`);
        let systemPromptContent: string;
        // Host-appended blocks, tracked separately from the PromptSystem
        // sections: they are concatenated into the same string but they do
        // not come from a profile, and plan 619 Phase 0 needs to tell the
        // two apart when asking "what changed between turns".
        const hostBlocks: { name: string; content: string }[] = [];
        if (options?.disableSystemPrompt) {
            systemPromptContent = '';
            logger.info('[Agent] streamChat: System prompt disabled (empty)');
        }
        else if (options?.systemPrompt) {
            systemPromptContent = options.systemPrompt;
        }
        else {
            const enabledToolNames = tools.map((t) => t.name);
            const context = promptSystem.buildContext({
                ...definedProperties({ sessionId: this.sessionId }),
                ...definedProperties({ workingDirectory: this.workingDirectory }),
                modelId: this.model,
                modelName: this.model,
                enabledTools: new Set(enabledToolNames),
                ...definedProperties({ outputStyleConfig: options?.outputStyleConfig }),
                ...definedProperties({ researchIntent: options?.researchIntent }),
                ...definedProperties({ researchProjectId: options?.researchProjectId }),
                ...definedProperties({ communicationPlatform: this.communicationPlatform }),
                ...definedProperties({ language: this.language }),
                ...definedProperties({ projectHome: this.projectHome })
            });
            const systemPromptResult = await promptSystem.buildSystemPrompt(context);
            systemPromptContent = [...systemPromptResult].join('\n\n');
        }
        if (!options?.disableSystemPrompt) {
            if (readToolExposureConfig().exposure === 'search') {
                const mcpCatalog = buildMCPCapabilityCatalog(this.activeMCPRegistry.getAllTools().filter((tool) => this.activeMCPRegistry.getOwner(tool.name) === 'mcp'), { entryPoint: 'tool_catalog' });
                if (mcpCatalog) {
                    hostBlocks.push({ name: 'host:mcp_catalog', content: mcpCatalog });
                    systemPromptContent = systemPromptContent
                        ? `${systemPromptContent}\n\n${mcpCatalog}`
                        : mcpCatalog;
                }
            }
            const appsSection = buildAppsSystemSection(getCachedAppConnectionDescriptors());
            if (appsSection) {
                hostBlocks.push({ name: 'host:apps', content: appsSection });
                systemPromptContent = systemPromptContent
                    ? `${systemPromptContent}\n\n${appsSection}`
                    : appsSection;
            }
        }
        if (options?.systemPromptPrefix) {
            hostBlocks.push({ name: 'host:prefix', content: options.systemPromptPrefix });
            systemPromptContent = options.systemPromptPrefix + '\n\n' + systemPromptContent;
            logger.info('[Agent] streamChat: Added system prompt prefix');
        }
        if (appliedProfile) {
            const identityBlock = buildAgentIdentityBlock(appliedProfile);
            hostBlocks.push({ name: 'host:identity', content: identityBlock });
            systemPromptContent = identityBlock + '\n\n' + systemPromptContent;
        }
        if (!this.omitAgentsMd && !options?.disableSystemPrompt) {
            const agentsMdSection = getAgentsMdManager().buildAgentsMdSection();
            if (agentsMdSection) {
                hostBlocks.push({ name: 'host:agents_md', content: agentsMdSection });
                systemPromptContent = systemPromptContent
                    ? `${systemPromptContent}\n\n${agentsMdSection}`
                    : agentsMdSection;
            }
        }
        if (!options?.disableSystemPrompt && isBotAgentProfile(appliedProfile) && appliedProfile) {
            try {
                const botContext = await loadBotPromptContext(appliedProfile.id);
                const summaryEpoch = countTimelineCompactions(this.timeline.snapshot());
                const botSections = await this.getBotAssembly().renderSections(botContext, {
                    snapshot: {
                        botId: appliedProfile.id,
                        contentHash: computeBotContentHash(botContext),
                        summaryEpoch,
                    },
                });
                this._syncBotProfileBaseline(appliedProfile.id, botContext, summaryEpoch);
                if (botSections) {
                    hostBlocks.push({ name: 'host:bot', content: botSections });
                    systemPromptContent = systemPromptContent
                        ? `${systemPromptContent}\n\n${botSections}`
                        : botSections;
                }
            }
            catch (err) {
                logger.warn(`[Agent] bot prompt sections skipped: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        if (!options?.disableSystemPrompt &&
            tools.some((tool) => tool.name === 'tool_catalog') &&
            tools.some((tool) => tool.name === 'tool_invoke')) {
            const deferredToolProtocol = [
                '## Deferred tool schema protocol',
                '- Search for a needed tool with `tool_catalog({ query })`. If there are no matches, retry with a shorter, broader query or a suggested namespace.',
                '- When a search result says `invocation` uses `tool_invoke`, call `tool_catalog({ tool_id })` for that exact stable ID and wait for its complete schema result.',
                '- Do not call `tool_invoke` in the same assistant response or parallel batch as the schema lookup. Invoke it only in a later provider round, using arguments that match the returned `input_schema`.',
                '- Never guess a deferred tool\'s arguments from its name, description, or search summary. If the schema is missing or stale, read it again before invoking.',
                '- A catalog or invocation configuration error describes current-session tool availability; it does not prove that the user\'s connector is unauthorized.',
            ].join('\n');
            hostBlocks.push({ name: 'host:deferred_tool_protocol', content: deferredToolProtocol });
            systemPromptContent = systemPromptContent
                ? `${systemPromptContent}\n\n${deferredToolProtocol}`
                : deferredToolProtocol;
        }
        this._reportHostBlockDigests(hostBlocks);
        return systemPromptContent;
    }

    /**
     * Report digests for the host-appended prompt blocks (plan 619 Phase 0).
     * No-op unless a digest sink is installed.
     */
    private _reportHostBlockDigests(blocks: readonly { name: string; content: string }[]): void {
        if (blocks.length === 0 || !hasPromptObserver()) return;
        reportPromptDigests(
            blocks.map((block) => sectionDigest(block.name, block.content, true)),
        );
    }
    private botProfileBaselines = new Map<string, {
        baseline: ProfileBaseline;
        summaryEpoch: number;
    }>();
    private _syncBotProfileBaseline(botId: string, ctx: {
        botName?: string;
        botDescription?: string;
    }, summaryEpoch: number): void {
        try {
            const state = this.botProfileBaselines.get(botId);
            if (!state) {
                this.botProfileBaselines.set(botId, {
                    baseline: { ...definedProperties({ name: ctx.botName }), ...definedProperties({ description: ctx.botDescription }) },
                    summaryEpoch,
                });
                return;
            }
            const baseline = summaryEpoch > state.summaryEpoch
                ? definedProperties({ ...state.baseline, foldedUntil: undefined })
                : state.baseline;
            const update = detectProfileUpdate(baseline, { ...definedProperties({ name: ctx.botName }), ...definedProperties({ description: ctx.botDescription }) });
            if (update && !isProfileUpdateFolded(baseline, update)) {
                const envelope = buildProfileUpdateEnvelope(update);
                const message = new AgentMessageFactory().createRuntimeContextMessage({
                    source: 'custom',
                    content: envelope,
                    visibility: 'hidden',
                    metadata: {
                        botProfileUpdate: true,
                        changedAt: update.changedAt,
                    },
                });
                const appended = this._appendRuntimeContextToTimeline(message as unknown as RuntimeContextAgentMessage);
                if (appended) {
                    logger.info(`[Agent] bot profile update announced (id=${botId}, changedAt=${update.changedAt})`);
                }
            }
            this.botProfileBaselines.set(botId, {
                baseline: mergeProfileUpdate(baseline, update),
                summaryEpoch
            });
        }
        catch (err) {
            logger.warn(`[Agent] bot profile baseline sync skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    private getBotAssembly(): BotPromptAssembly {
        if (!this.botAssembly) {
            this.botAssembly = createBotPromptAssembly();
        }
        return this.botAssembly;
    }
    private groupRulesBySource(rules: Array<{
        source: PermissionRuleSource;
        ruleValue: {
            toolName: string;
            ruleContent?: string;
        };
    }>): ToolPermissionRulesBySource {
        const grouped: ToolPermissionRulesBySource = {};
        for (const rule of rules) {
            const serialized = permissionRuleValueToString(rule.ruleValue);
            const list = grouped[rule.source] ?? [];
            list.push(serialized);
            grouped[rule.source] = list;
        }
        return grouped;
    }
    private async _injectRuntimeContext(llmMessages: Message[], options: ChatOptions | undefined, deferredContexts: Array<{
        toolUseId: string;
        toolName: string;
        promise: Promise<unknown>;
    }>): Promise<void> {
        const attachments = (options as ChatOptions & {
            attachments?: FileAttachment[];
        } | undefined)
            ?.attachments;
        if (attachments && attachments.length > 0) {
            const prepared = await persistLargePastedAttachments(attachments);
            const ctx = adaptAttachmentContext(prepared);
            if (ctx) {
                const appended = this._appendRuntimeContextToTimeline(ctx);
                if (appended) {
                    const projected = projectRuntimeContextToProviderMessage(ctx);
                    if (projected)
                        llmMessages.push(projected);
                }
            }
        }
        if (deferredContexts.length > 0) {
            const pending = deferredContexts.splice(0);
            const settled = await Promise.allSettled(pending.map(async (deferred) => {
                const value = await deferred.promise;
                const content = typeof value === 'string' ? value : JSON.stringify(value);
                return `<deferred-tool-context>\n${content}\n</deferred-tool-context>`;
            }));
            for (const item of settled) {
                if (item.status !== 'fulfilled')
                    continue;
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
    orchestratorFramesFor(run: RunHandle): AsyncGenerator<SSEEvent, void, unknown> {
        const mod = run.orchestrator;
        if (!mod) {
            throw new Error(`orchestratorFramesFor: run requested mode "${run.requestedMode}", which resolved to no orchestrator; ` +
                'this run is an ordinary turn and must be assembled, not dispatched');
        }
        return this._dispatchOrchestratorMode(mod, run.request.prompt, run.request.options, run.controller);
    }
    private async *_dispatchOrchestratorMode(mod: ModeModifier, prompt: string | MessageContent[], options: ChatOptions | undefined, runController: AbortController): AsyncGenerator<SSEEvent, void, unknown> {
        const queryText = typeof prompt === 'string'
            ? prompt
            : prompt.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
        const toolRegistry = this.activeMCPRegistry;
        const orchestratorActiveModes = collectActiveModes(options ?? {});
        const orchestratorResolved = orchestratorActiveModes.length > 0
            ? modeModifierRegistry.resolve(orchestratorActiveModes)
            : null;
        if (orchestratorResolved) {
            const orchestratorCtx: ModeModifierContext = {
                sessionId: this.sessionId ?? '',
                workingDirectory: this.workingDirectory ?? '',
                subagentDeps: this.subagentDeps,
            workerModeToolPorts: { goal: createGoalModeToolPorts(this.subagentDeps), research: createResearchModeToolPorts(this.subagentDeps) },
                state: {
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
        const catalogExecutor = toolRegistry.getExecutor('tool_catalog');
        if (catalogExecutor instanceof ToolCatalogTool) {
            const snapshot = toolRegistry.snapshot(this.providerNameToInternalKey);
            const constraints: ToolVisibilityConstraints = {
                ...definedProperties({ disabledTools: options?.disabledTools }),
                ...definedProperties({ allowedTools: options?.allowedTools })
            };
            const eligibleToolIds = new Set(snapshot.catalogEntries
                .filter((entry) => isToolVisible(entry.definition.name, entry.exposure === 'hidden' ? 'hidden' : 'eager', EMPTY_DISCOVERED, constraints))
                .map((entry) => entry.toolId));
            const directToolIds = new Set(snapshot.catalogEntries
                .filter((entry) => isToolVisible(entry.definition.name, entry.exposure, EMPTY_DISCOVERED, constraints))
                .map((entry) => entry.toolId));
            catalogExecutor.setView({
                snapshot,
                registry: toolRegistry,
                eligibleToolIds,
                directToolIds,
                loadedSchemaRevisions: new Map(),
                loadedSchemaRounds: new Map(),
                currentRound: 0,
            });
        }
        const deps: OrchestratorDeps = {
            llmClient: this.llmClient,
            abortController: runController,
            ...definedProperties({ sessionId: this.sessionId }),
            ...definedProperties({ workingDirectory: this.workingDirectory }),
            toolRegistry,
            ...definedProperties({ chatOptions: options as Record<string, unknown> | undefined }),
            blockedDomains: this.blockedDomains
        };
        const ctx: ModeModifierContext = {
            sessionId: this.sessionId ?? '',
            workingDirectory: this.workingDirectory ?? '',
            subagentDeps: this.subagentDeps,
            workerModeToolPorts: { goal: createGoalModeToolPorts(this.subagentDeps), research: createResearchModeToolPorts(this.subagentDeps) },
            state: {},
        };
        logger.info(`[Agent] Dispatching to orchestrator mode: ${mod.id}`);
        const orchestrator = mod.orchestrator;
        if (!orchestrator) {
            yield {
                type: 'error',
                data: `Mode "${mod.id}" has no orchestrator`,
            } as unknown as SSEEvent;
            return;
        }
        try {
            yield* orchestrator.execute(queryText, ctx, deps);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(`[Agent] Orchestrator mode "${mod.id}" execution failed: ${message}`);
            yield {
                type: 'error',
                data: `${mod.id} mode error: ${message}`,
            } as unknown as SSEEvent;
        }
    }
    async runGoalCommand(prompt: string, context: {
        readonly sessionId?: string;
        readonly workingDirectory?: string;
    }): Promise<string | null> {
        if (!prompt.startsWith('/goal') || !isGoalControlCommand(prompt))
            return null;
        const result = await handleGoalCommand(prompt, {
            ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
            ...(context.workingDirectory === undefined
                ? {}
                : { workingDirectory: context.workingDirectory }),
        });
        return result.reply;
    }
    interrupt(): void {
        if (this.abortController) {
            this.abortController.abort();
        }
    }
    getMessages(): readonly Message[] {
        return this.messages;
    }
    async sideQuestion(question: string): Promise<string> {
        const trimmed = question.trim();
        if (!trimmed) {
            throw new Error('Side question cannot be empty');
        }
        const profile = await this._resolveAgentProfile({});
        const systemPromptBase = await this._buildSystemPrompt([], {}, profile);
        const { systemPromptContent, messages } = this._projectModelMessages(systemPromptBase);
        let llmMessages = messages;
        while (llmMessages.length > 0 &&
            llmMessages.at(-1)?.role === 'assistant' &&
            Array.isArray(llmMessages.at(-1)?.content) &&
            (llmMessages.at(-1)!.content as MessageContent[]).some((block) => block.type === 'tool_use')) {
            llmMessages = llmMessages.slice(0, -1);
        }
        const sidePrompt = [
            trimmed,
            '',
            'This is a side question. Respond with a concise, direct text answer only.',
            'Do not call any tools. Do not promise follow-up actions. Answer once, then stop.',
        ].join('\n');
        const llmMessagesWithQuestion: Message[] = [
            ...llmMessages,
            { role: 'user', content: sidePrompt },
        ];
        const abortController = new AbortController();
        try {
            const result = await createOneShotTextPort(this.llmClient).complete({
                systemPrompt: systemPromptContent,
                messages: fromProviderMessages(llmMessagesWithQuestion),
                maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
                temperature: 0.7,
            }, abortController.signal);
            if (result.kind === 'completed') {
                return result.text.trim();
            }
            if (result.kind === 'failed') {
                throw new Error(result.error.message);
            }
            throw abortController.signal.reason instanceof Error
                ? abortController.signal.reason
                : new Error('Side question was cancelled');
        }
        finally {
            abortController.abort();
        }
    }
    setMessages(messages: Message[]): void {
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
                    ...definedProperties({ tokensAfter: checkpoint.tokensAfter }),
                    strategy: checkpoint.strategy,
                    ...definedProperties({ previousCompactionId: checkpoint.previousCompactionId }),
                    ...definedProperties({ reinjectedSystemMessages: checkpoint.reinjectedSystemMessages }),
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
            if (message.id)
                this.syncedMessageIds.add(message.id);
        }
        if (compaction) {
            this.timeline.appendCompaction(compaction);
        }
        this.compactionController.setTimeline(this.timeline);
        this.sessionInfo.messageCount = this.messages.length;
        this.sessionInfo.updatedAt = Date.now();
    }
    clearMessages(): void {
        this.timeline = new MessageTimeline();
        this.syncedMessageIds = new Set();
        this.compactionController.setTimeline(this.timeline);
        this.sessionInfo.updatedAt = Date.now();
    }
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
            if (timer)
                clearTimeout(timer);
        });
    }
    notifyMcpReady(): void {
        if (this.mcpReadyResolve) {
            const resolve = this.mcpReadyResolve;
            this.mcpReadyResolve = null;
            resolve();
        }
    }
    getActiveAgentProfileId(): string | undefined {
        return this.activeAgentProfileId;
    }
    setActiveAgentProfileId(id: string | undefined): void {
        this.activeAgentProfileId = id;
    }
    getLastAppliedAgentProfile(): AgentProfile | undefined {
        return this.lastAppliedAgentProfile;
    }
    async initToolCatalog(): Promise<void> {
        const createBuiltinRegistry = this.assembly.createRegistry;
        this.subagentDeps = {
            createSubAgent: (agentOptions) => new WorkerSession(agentOptions, this.assembly),
            createToolRegistry: () => createBuiltinRegistry(this.subagentDeps),
        };
        let enabledPluginIds: Set<string> | undefined;
        try {
            const installed = await pluginDb.registryList() as Array<{
                id?: unknown;
                enabled?: unknown;
            }>;
            const enabledIds = installed
                .filter((item) => item.enabled === true && typeof item.id === 'string')
                .map((item) => item.id as string);
            enabledPluginIds = new Set(enabledIds);
        }
        catch {
        }
        const temp = createBuiltinRegistry(this.subagentDeps, this.blockedDomains.length > 0 ? { blockedDomains: this.blockedDomains } : undefined, {
            ...definedProperties({ enabledPluginIds: enabledPluginIds }),
            browserBackendMode: this.browserBackendMode
        });
        for (const tool of temp.getAllTools()) {
            const executor = temp.getExecutor(tool.name);
            const meta = temp.getMeta(tool.name);
            if (executor)
                this.activeMCPRegistry.register(tool, executor, meta);
        }
    }
    getNonMCPModelVisibleToolNames(): Set<string> {
        const names = new Set<string>();
        for (const tool of this.activeMCPRegistry.getAllTools()) {
            if (this.activeMCPRegistry.getOwner(tool.name) !== 'mcp') {
                names.add(tool.name);
            }
        }
        return names;
    }
    getPermissionMode(): PermissionMode {
        return this.permissionMode;
    }
    getActiveMCPManager(): MCPManager | null {
        return this.mcpManager;
    }
    async setActiveMCPRuntime(install: {
        manager: MCPManager;
        providerNameToInternalKey: Map<string, string>;
        preparedRegistryEntries: Array<{
            key: string;
            definition: Tool;
            executor: ToolExecutor;
            meta?: import('@duya/host/worker-tool-registry').ToolMetaInput;
        }>;
        snapshot: import('@duya/host/connector-services/apply').ActiveMCPRuntimeSnapshot;
    }): Promise<{
        removedKeys: string[];
        addedKeys: string[];
        keptKeys: string[];
    }> {
        const previousManager = this.mcpManager;
        const previousProviderMap = this.providerNameToInternalKey;
        const previousSnapshot = this.activeMCPRuntimeSnapshot;
        let replaceResult: {
            removedKeys: string[];
            addedKeys: string[];
            keptKeys: string[];
        };
        try {
            replaceResult = this.activeMCPRegistry.replaceByOwner('mcp', install.preparedRegistryEntries);
            this.providerNameToInternalKey = new Map(install.providerNameToInternalKey);
            this.mcpManager = install.manager;
            this.activeMCPRuntimeSnapshot = install.snapshot;
        }
        catch (err) {
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
    describePluginAppMcpTools(runId: string): PluginAppMcpDescriptor[] {
        if (!this.abortController || this.abortController.signal.aborted || this.currentRunId !== runId) {
            throw new Error('Plugin App tool catalog requires the active Host run.');
        }
        return this.activeMCPRegistry.snapshot(this.providerNameToInternalKey).catalogEntries
            .filter((entry) => isMcpCatalogEntry(entry))
            .map((entry) => {
                const info = entry.definition.mcpInfo!;
                return {
                    toolId: entry.toolId,
                    schemaRevision: entry.schemaRevision,
                    descriptor: {
                        source: info.source,
                        serverName: info.serverName,
                        toolName: info.toolName,
                        ...(info.connectionId === undefined ? {} : { connectionId: info.connectionId }),
                        ...(info.pluginId === undefined ? {} : { pluginId: info.pluginId }),
                    },
                };
            });
    }
    async invokePluginAppMcpTool(input: {
        runId: string;
        toolId: string;
        schemaRevision: string;
        arguments: Record<string, unknown>;
        isBindingCurrent(): Promise<boolean>;
    }): Promise<PluginAppInvocationResult> {
        const fail = (code: string, message: string): PluginAppInvocationResult => ({ ok: false, code, message });
        const controller = this.abortController;
        const parentContext = this.currentToolUseContext;
        if (!controller || controller.signal.aborted || this.currentRunId !== input.runId ||
            !parentContext || parentContext.abortController !== controller ||
            !parentContext.requestPermission) {
            return fail('attempt_fenced', 'Plugin App invocation requires the active run permission context.');
        }
        const entry = this.activeMCPRegistry.getCatalogEntryById(input.toolId);
        if (!entry || !isMcpCatalogEntry(entry)) {
            return fail('tool_unavailable', 'The requested MCP tool is not in the live worker catalog.');
        }
        if (entry.schemaRevision !== input.schemaRevision) {
            return fail('schema_changed', 'The live MCP tool schema changed after binding.');
        }
        const validation = validateCatalogToolArguments(entry, input.arguments);
        if (validation !== 'valid') {
            return fail(validation === 'invalid' ? 'invalid_arguments' : 'schema_unavailable',
                'Tool arguments do not match the live MCP descriptor schema.');
        }
        let bindingIsCurrent = false;
        try { bindingIsCurrent = await input.isBindingCurrent(); } catch { /* Fail closed on a Host check failure. */ }
        if (!bindingIsCurrent) {
            return fail('binding_revoked', 'The Plugin App binding is no longer current.');
        }
        const executor = entry.executor;
        if (!executor) return fail('tool_unavailable', 'The live MCP executor is unavailable.');
        const invocationContext: ToolUseContext = {
            ...parentContext,
            toolUseId: crypto.randomUUID(),
            pluginAppInvocationGuard: input.isBindingCurrent,
        };
        try {
            const result = await executor.execute(input.arguments, this.workingDirectory, invocationContext);
            if (result.error) {
                const reason = (result as { metadata?: { reason?: string } }).metadata?.reason;
                return fail(reason === 'authority_revoked' ? 'binding_revoked' : 'tool_denied', result.result);
            }
            return {
                ok: true,
                result: { id: result.id, name: result.name, result: result.result },
            };
        } catch {
            return fail('tool_failed', 'The MCP executor failed.');
        }
    }
    resolveMCPToolNameToInternalKey(name: string): string {
        return this.providerNameToInternalKey.get(name) ?? name;
    }
    private buildMCPToolExecutors(tools: Tool[]): Map<string, ToolExecutor> {
        const map = new Map<string, ToolExecutor>();
        for (const tool of tools) {
            if (!tool.mcpInfo)
                continue;
            const executor = this.activeMCPRegistry.getExecutor(tool.name);
            if (executor)
                map.set(tool.name, executor);
        }
        return map;
    }
    getWorkingDirectory(): string | undefined {
        return this.workingDirectory;
    }
    setWorkingDirectory(directory: string): void {
        this.workingDirectory = directory;
    }
    setCurrentProjectId(projectId: string | null | undefined): void {
        this.currentProjectId = projectId ?? null;
    }
    setLanguage(language: string): void {
        this.language = language;
    }
    setPermissionMode(mode: string): void {
        const validMode = permissionModeFromString(mode);
        this.permissionMode = validMode;
        logger.info(`[Agent] Permission mode set to: ${validMode}`);
    }
    setHostToolPermission(value: LocalToolPermission): void {
        this.hostToolPermission = value;
        logger.info(`[Agent] Host tool permission set to: ${value}`);
    }
    getSessionInfo(): SessionInfo {
        return { ...this.sessionInfo };
    }
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
    shouldCompact(): boolean {
        return this.compactionController.shouldCompact();
    }
    private _projectModelMessages(systemPromptContent: string, opts: {
        injectHookContexts?: boolean;
    } = {}): {
        systemPromptContent: string;
        messages: Message[];
    } {
        const snapshot = this.timeline.snapshot();
        const context = buildAgentContext(snapshot);
        const systemSegments = extractLegacySystemSegments(context.messages, context.compaction);
        const projection = projectModelMessages(context.messages, { systemSegments });
        const messages: Message[] = [...projection.messages];
        if (opts.injectHookContexts === true) {
            const freshFrom = this.promptContextBlocks.length;
            if (this.promptContexts.length > 0) {
                logger.info(`[Agent] injecting ${this.promptContexts.length} hook context block(s) into first turn (source='custom')`);
                this.promptContextBlocks.push(...this.promptContexts);
                this.promptContexts = [];
            }
            let restored = 0;
            for (const [i, contextLine] of this.promptContextBlocks.entries()) {
                const action = applyHookInjection(messages as unknown as InjectableMessage[], undefined, renderSystemReminder(contextLine, 'hook_context_rail'), 'custom', { now: Date.now() });
                if (action === 'injected' && i < freshFrom) {
                    restored += 1;
                }
            }
            if (restored > 0) {
                logger.info(`[Agent] restored ${restored} hook context block(s) after re-projection`);
            }
        }
        const systemFromProjection = typeof projection.system === 'string'
            ? projection.system
            : '';
        const merged = systemPromptContent && systemFromProjection
            ? `${systemPromptContent}\n\n---\n\n## Conversation Context\n\n${systemFromProjection}`
            : (systemPromptContent || systemFromProjection);
        logger.info(`[Agent] projectModelMessages: ${context.messages.length} agent messages 鈫?${messages.length} model messages, ${systemSegments.length} system segments`);
        return { systemPromptContent: merged, messages };
    }
    private _applyProviderThreadBoundary(messages: Message[]): void {
        if (messages.length === 0)
            return;
        let sourceById: Map<string, AgentMessage> | null = null;
        const lookupQuoteText = (id: string): string => {
            if (!sourceById) {
                sourceById = new Map<string, AgentMessage>();
                for (const entry of this.timeline.snapshot()) {
                    if (entry.type === 'message' && typeof entry.message.id === 'string') {
                        sourceById.set(entry.message.id, entry.message);
                    }
                }
            }
            return messageToQuoteText(sourceById.get(id));
        };
        let hasReplyUser = false;
        for (const m of messages) {
            if (m.role === 'user' && readThreadMeta(m)?.replyToId) {
                hasReplyUser = true;
                break;
            }
        }
        const projected = hasReplyUser
            ? applyReplyQuoteContext(messages as readonly AgentMessage[], lookupQuoteText)
            : messages;
        for (let i = 0; i < messages.length; i += 1) {
            const source = (projected as readonly AgentMessage[])[i] ?? messages[i];
            if (!source || typeof source !== 'object')
                continue;
            const { threadMeta: _, ...cleaned } = source as unknown as Record<string, unknown>;
            const cleanedMsg = cleaned as unknown as Message;
            if (cleanedMsg !== messages[i]) {
                messages[i] = cleanedMsg;
            }
        }
    }
    getContextStats() {
        return this.compactionManager.getStats(this.messages);
    }
    getSystemContextTokensEstimate(): number {
        return this.lastSystemContextTokensEstimate;
    }
    isLastContextObservationPostShrink(): boolean {
        return this.compactionManager.wasLastObservationPostShrink();
    }
    getContextLedgerSnapshot(): ReturnType<import('@duya/agent-runtime/context/compact').ContextLedger['getSnapshot']> {
        return this.compactionManager.getContextLedger().getSnapshot();
    }
    getContextSnapshot(messages: readonly Message[] = this.messages) {
        return this.compactionManager.getContextSnapshot(messages);
    }
    getContextWindowResolved(): {
        contextWindow: number;
        windowSource: 'capability' | 'catalog' | 'default';
    } {
        return { ...this.resolvedWindow };
    }
    getSystemTokensEstimate(): number {
        return this.lastSystemTokensEstimate;
    }
    getToolsTokensEstimate(): number {
        return this.lastToolsTokensEstimate;
    }
    private _estimateSystemAndToolsTokens(systemPrompt: string, tools: Tool[]): {
        system: number;
        tools: number;
        total: number;
    } {
        const systemTokens = systemPrompt ? estimateContextTextTokens(systemPrompt) : 0;
        const contract = tools.map(({ name, description, input_schema }) => ({
            name,
            description,
            input_schema,
        }));
        const toolsText = contract.length > 0 ? JSON.stringify(contract) : '';
        const toolsTokens = toolsText ? estimateContextTextTokens(toolsText) : 0;
        return { system: systemTokens, tools: toolsTokens, total: systemTokens + toolsTokens };
    }
    async compact(options?: CompactOptions): Promise<{
        strategy: string;
        tokensRemoved: number;
        tokensRetained: number;
        removedCount: number;
    }> {
        if (this.messages.length === 0) {
            throw new Error('Compaction failed: conversation is empty (timeline not hydrated?)');
        }
        const compactEntry = await this.compactionController.compactProactive({
            ...(options ?? {}),
            trigger: options?.trigger ?? 'manual',
        });
        if (!compactEntry) {
            return { strategy: 'none', tokensRemoved: 0, tokensRetained: 0, removedCount: 0 };
        }
        this.sessionInfo.messageCount = this.messages.length;
        this.sessionInfo.updatedAt = Date.now();
        this.onMessagesCompacted?.(this.messages.length);
        return {
            strategy: compactEntry.strategy,
            tokensRemoved: compactEntry.tokensBefore - (compactEntry.tokensAfter ?? 0),
            tokensRetained: compactEntry.tokensAfter ?? 0,
            removedCount: compactEntry.compactedMessageIds.length,
        };
    }
}
function buildHookMessage(event: import('@duya/host/worker-hooks/types').HookInvokedEvent, sessionId: string): Message {
    return {
        id: `hook-${event.seq}-${event.toolUseId ?? event.hookEventName}-${Date.now()}`,
        role: 'system',
        content: event.additionalContext ?? '',
        timestamp: Date.now(),
        msg_type: 'hook_invocation',
        tool_name: event.hookEventName,
        tool_input: JSON.stringify({
            hookType: event.hookType,
            hookName: event.hookName,
            matcher: event.matcher,
            exitCode: event.exitCode,
            async: event.async,
            backgroundTaskId: event.backgroundTaskId,
            durationMs: event.durationMs,
            status: event.status,
            errorMessage: event.errorMessage,
            seq: event.seq,
            toolName: event.toolName,
            toolUseId: event.toolUseId,
        }),
        duration_ms: event.durationMs,
        status: event.status === 'ok' || event.status === 'skipped' ? 'done' : 'failed',
        ...definedProperties({ parent_tool_call_id: event.toolUseId }),
        metadata: {
            sessionId,
            hookEventName: event.hookEventName,
        }
    };
}
function buildCompactClient(config: import('@duya/host/worker-run-contracts').CompactModelConfig | undefined): AIClient | undefined {
    if (!config?.enabled)
        return undefined;
    const provider = inferProvider(config.baseURL || '', config.provider);
    const apiFormat: ApiFormat = provider === 'anthropic' ? 'anthropic' : 'openai-chat';
    const modelCapabilities = findModelCompat(apiFormat, config.model);
    try {
        return createAIClient({
            apiKey: config.apiKey,
            baseURL: config.baseURL || resolveDefaultBaseURL(provider),
            model: config.model,
            apiFormat,
            providerId: config.provider,
            ...definedProperties({ modelCapabilities: modelCapabilities })
        });
    }
    catch {
        return undefined;
    }
}
export type { TurnOutputSink, ResolvedTurnTools, TurnPipelineRequest, TurnAssemblyRequest, TurnAssembly, RunStartRequest, RunHandle, RunAssemblyRequest, PromptUserRowCommit, LegacyTurnDelta, TurnModelProjection, RunTurnAssembly } from './worker-run-session-port.js';
