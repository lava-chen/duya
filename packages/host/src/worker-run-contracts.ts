/** Host product-run assembly options and opaque tool invocation context. */
import type { VisionConfig } from '@duya/host/worker-config/model-config';
import type { CompactModelConfig } from '@duya/host/worker-config/model-config';
import type { FileAttachment } from '@duya/agent-protocol';
import type { AgentDefinition as CoreAgentDefinition } from '@duya/agent-core/subagents/agent-definition';
type AgentDefinition = CoreAgentDefinition<Pick<ToolUseContext, 'options'>>;
import type { PermissionMode, LocalToolPermission } from '@duya/agent-runtime/authorization/permissions/types';
import type { TurnPipelinePublisher } from '@duya/agent-runtime/tools/turn-pipeline-publisher';
import type { MessageRole, TextContent, ImageContent, ToolUseContent, ToolResultContent, ThinkingContent, MessageContent, Message, AssistantMessage, ToolUse, ToolResult, ToolResultMetadata, SSEEvent, PermissionRequestEvent, TokenUsage, UsageCall, AgentProgressEvent, StopReason, ProviderRuntimeConfig, LLMProvider, } from '@duya/ai';
export type { MessageRole, TextContent, ImageContent, ToolUseContent, ToolResultContent, ThinkingContent, MessageContent, Message, AssistantMessage, ToolUse, ToolResult, ToolResultMetadata, SSEEvent, PermissionRequestEvent, TokenUsage, UsageCall, AgentProgressEvent, StopReason, };
export type AgentRuntimeMode = 'general' | 'plan' | 'explore' | 'verify' | 'code-review';
export type Tool = import('@duya/agent-runtime/tools/catalog').RuntimeToolDefinition;
export type { VisionConfig } from '@duya/host/worker-config/model-config';
export type { CompactModelConfig } from '@duya/host/worker-config/model-config';
export interface AgentOptions {
    apiKey: string;
    baseURL?: string;
    model?: string;
    workingDirectory?: string;
    currentProjectId?: string | null;
    projectHome?: string;
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
    authStyle?: 'api_key' | 'auth_token';
    provider?: LLMProvider;
    sessionId?: string;
    permissionMode?: PermissionMode;
    hostToolPermission?: LocalToolPermission;
    communicationPlatform?: import('@duya/agent-protocol/communication-platform').CommunicationPlatform;
    omitAgentsMd?: boolean;
    enableRetry?: boolean;
    retryConfig?: import('@duya/ai').RetryConfig;
    visionConfig?: VisionConfig;
    compactModelConfig?: CompactModelConfig;
    blockedDomains?: string[];
    browserBackendMode?: 'auto' | 'extension' | 'built-in' | 'human-like';
    language?: string;
    defaultWorkspaceDirectory?: string;
    permissionRules?: {
        permissions?: {
            allow?: string[];
            deny?: string[];
            ask?: string[];
            additionalDirectories?: string[];
        };
    };
    runtimeConfig?: ProviderRuntimeConfig;
}
export interface ChatOptions {
    imageInputSupported?: boolean;
    systemPrompt?: string;
    onSystemPromptReady?: (snapshot: {
        systemPrompt: string;
        tools: Array<Pick<Tool, 'name' | 'description' | 'input_schema'>>;
        turn: number;
        cachePlan: {
            fingerprint: string;
        };
    }) => void;
    tools?: Tool[];
    toolRegistry?: import('./worker-tool-registry.js').ToolRegistry;
    maxTokens?: number;
    temperature?: number;
    parentMessageId?: string;
    replyToId?: string;
    branched?: boolean;
    maxTurns?: number;
    turnId?: string | null;
    runId?: string;
    antiDeadLoop?: {
        enabled?: boolean;
        nudgeAt?: number;
        hardNudgeAt?: number;
        hardStopAt?: number;
    };
    todoGate?: {
        enabled?: boolean;
    };
    disabledLoopHooks?: string[];
    messages?: Message[];
    requestPermission?: (request: PermissionRequestEvent) => Promise<'allow' | 'deny' | 'paused'>;
    consumeApprovedEffect?: (toolName: string, toolInput?: Record<string, unknown>) => Promise<boolean>;
    approvedAlwaysAllowTools?: string[];
    agentProfileId?: string | null;
    wakeRun?: boolean;
    mentionedProviders?: string[];
    mentionedSkills?: string[];
    mentionedPlugins?: Array<{
        pluginId: string;
        name: string;
        description?: string;
        appConnections: string[];
        mcpServers: string[];
        skillNames: string[];
    }>;
    mode?: string;
    excludeFromStage1?: boolean;
    outputStyleConfig?: {
        name: string;
        prompt: string;
        keepCodingInstructions?: boolean;
    };
    displayContent?: string;
    attachments?: FileAttachment[];
    conductorIpc?: {
        sendToMain: (msg: Record<string, unknown>) => void;
        ipcRequest: <T = unknown>(channel: string, payload: unknown, options?: {
            timeout?: number;
        }) => Promise<{
            success: boolean;
            data?: T;
            error?: {
                code: string;
                message: string;
            };
        }>;
    };
    disabledTools?: string[];
    allowedTools?: string[];
    disableSystemPrompt?: boolean;
    systemPromptPrefix?: string;
    researchIntent?: import('./worker-prompts/research/types.js').ResearchTaskIntent;
    researchProjectId?: string;
    effort?: string;
    conductorMode?: boolean;
    conductorCanvasId?: string;
    backgroundTaskResume?: boolean;
    llmRequestTimeoutMs?: number;
    clientMsgId?: string;
    cumulativeTokenUsageRef?: {
        current: TokenUsage | null;
    };
    turnPipelines?: TurnPipelinePublisher;
}
export interface SessionInfo {
    id: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
}
export interface MCPServerConfig {
    name: string;
    connectionId?: string;
    pluginId?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    transport?: 'stdio' | 'streamable-http';
    url?: string;
    headers?: Record<string, string>;
    allowedAgentIds?: string[];
    source?: 'bundled' | 'plugin' | 'local' | 'settings' | 'unknown' | 'app';
    envPassthrough?: 'allowlist' | 'inherit';
    nameOverride?: string;
    startupTimeoutSec?: number;
    toolTimeoutSec?: number;
    toolTimeouts?: Record<string, number>;
    useShell?: boolean;
    sampling?: SamplingRateLimitConfig;
}
export interface SamplingRateLimitConfig {
    maxRpm?: number;
    maxTokensCap?: number;
    maxToolRounds?: number;
}
export type MCPConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'degraded';
export type { FileAttachment } from '@duya/agent-protocol';
export interface ChatRequestBody {
    sessionId: string;
    content?: string;
    files?: FileAttachment[];
    effort?: string;
    badge?: string;
    model?: string;
    systemPrompt?: string;
}
export interface ToolUseContext {
    toolUseId: string;
    getAppState: () => AppState;
    setAppState: (f: (prev: AppState) => AppState) => void;
    abortController: AbortController;
    options: ToolUseContextOptions;
    pushApiMetricsEntry?: (ttftMs: number) => void;
    requestPermission?: (request: PermissionRequestEvent) => Promise<'allow' | 'deny' | 'paused'>;
    /** Internal Host-owned App invocation recheck; never serialized from an App. */
    pluginAppInvocationGuard?: () => Promise<boolean>;
    consumeApprovedEffect?: (toolName: string, toolInput?: Record<string, unknown>) => Promise<boolean>;
    approvedAlwaysAllowTools?: string[];
    reportAgentProgress?: (event: AgentProgressEvent) => void;
    sendToMain?: (msg: Record<string, unknown>) => void;
    ipcRequest?: <T = unknown>(channel: string, payload: unknown, options?: {
        timeout?: number;
    }) => Promise<{
        success: boolean;
        data?: T;
        error?: {
            code: string;
            message: string;
        };
    }>;
    conductorCanvasId?: string;
    canvasTarget?: CanvasTargetState;
    updateModeCanvasId?: (canvasId: string) => void;
    canvasFreshness?: CanvasFreshnessState;
    widgetStyleHistory?: WidgetStyleSignature[];
    currentProjectId?: string | null;
}
export interface CanvasFreshnessState {
    lastListElementsTime?: number;
    recentlyCreatedElementIds: Set<string>;
}
export interface CanvasTargetState {
    canvasId?: string;
    canvasName?: string;
}
export interface WidgetStyleSignature {
    backgroundColor?: string;
    textColor?: string;
    fontFamily?: string;
    layoutType?: string;
}
export interface ToolUseContextOptions {
    recentImageAttachments?: Array<{
        name: string;
        path?: string;
        url?: string;
        type: string;
    }>;
    tools: Tool[];
    commands: Command[];
    debug?: boolean;
    verbose?: boolean;
    mainLoopModel: string;
    mcpClients: MCPServerConnection[];
    mcpResources?: MCPResource[];
    agentDefinitions?: {
        activeAgents: AgentDefinition[];
        allAgents: AgentDefinition[];
    };
    isNonInteractiveSession?: boolean;
    appendSystemPrompt?: string;
    sessionId?: string;
    agentProfileId?: string | null;
    workingDirectory?: string;
    projectHome?: string;
    language?: string;
    apiKey?: string;
    baseURL?: string;
    authStyle?: 'api_key' | 'auth_token';
    provider?: 'anthropic' | 'openai' | 'ollama';
    analyzeImage?: (base64Data: string, mimeType: string, prompt?: string) => Promise<string>;
    resolveMCPProviderToolName?: (providerName: string) => string;
    mcpToolExecutors?: ReadonlyMap<string, import('./worker-tool-registry.js').ToolExecutor>;
}
export interface AppState {
    [key: string]: unknown;
}
export interface Command {
    name: string;
    description: string;
    type: 'prompt' | 'other';
}
export interface MCPServerConnection {
    name: string;
    type: 'connected' | 'disconnected' | 'connecting' | 'error';
    cleanup?: () => Promise<void>;
}
export interface MCPResource {
    uri: string;
    name?: string;
    description?: string;
    mimeType?: string;
}
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
