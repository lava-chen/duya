import type { AgentOptions, ChatOptions, Message, AssistantMessage, MessageContent, Tool, SSEEvent, SessionInfo, ToolUseContext } from '@duya/host/worker-run-contracts';
import type { AIClient } from '@duya/ai';
import type { TurnOutputSummary } from '@duya/agent-runtime';
import { ToolExecutionPipeline } from '@duya/host/worker-execution/tool-execution-pipeline';
import type { CanUseToolFn } from '@duya/host/worker-execution/streaming-tool-executor';
import type { PermissionMode, AdditionalWorkingDirectory, LocalToolPermission } from '@duya/capabilities/permissions';
import type { CommunicationPlatform } from '@duya/host/worker-prompts/types';
import type { AgentRuntime } from '@duya/agent-runtime/turns/AgentRuntime';
import type { TurnContext } from '@duya/agent-runtime/turns/TurnContext';
import type { CompactionSources } from '@duya/agent-runtime/adapters/run-engine-ports';
import type { AgentProfile } from '@duya/agent-core';
import { type ToolVisibilityConstraints } from '@duya/agent-runtime/authorization/tool-filter';
import { MCPManager } from '@duya/host/connector-services/worker-mcp';
import type { EventHookInput, EventHookMatcherTargets, EventHookRunResult } from '@duya/host/worker-hooks/events';
import type { ModeModifier } from '@duya/host/worker-modes/modifiers';
import { ToolRegistry } from '@duya/host/worker-tool-registry';
import type { ToolExecutor } from '@duya/host/worker-tool-registry';
import { ToolCatalogTool, type ToolCatalogView } from '@duya/agent-runtime/tools/discovery/ToolCatalogTool';
import { ToolInvokeTool } from '@duya/agent-runtime/tools/discovery/ToolInvokeTool';
import { createToolInvokeDispatcherFromRegistry } from '@duya/host/worker-execution/deferred-dispatcher';
import type { AgentDefinition } from '@duya/host/worker-subagents/built-in-agents';
import type { TurnPipelinePublisher } from '@duya/agent-runtime/tools/turn-pipeline-publisher';
import type { CompactOptions } from '@duya/agent-runtime/context/compact/types';
import { type RuntimeMailboxDecision } from '@duya/host/worker-session/agent-helpers';
export interface TurnOutputSink {
    readonly publish: (event: SSEEvent) => void;
    readonly finishTurn: (summary: TurnOutputSummary) => void;
}
export interface ResolvedTurnTools {
    readonly tools: Tool[];
    readonly registry: ToolRegistry;
    readonly agentDefinitions: AgentDefinition[];
    readonly constraints: ToolVisibilityConstraints;
    readonly catalogTool: ToolCatalogTool;
    readonly catalogView: ToolCatalogView;
    readonly toolInvokeExecutor: ToolInvokeTool;
}
export interface TurnPipelineRequest {
    readonly turn: number;
    readonly messages: Message[];
    readonly tools: Tool[];
    readonly resolved: ResolvedTurnTools;
    readonly turnContext: TurnContext;
    readonly options: ChatOptions | undefined;
    readonly canUseTool: CanUseToolFn;
    readonly toolInvokeDispatcher: ReturnType<typeof createToolInvokeDispatcherFromRegistry>;
    readonly publisher: TurnPipelinePublisher | undefined;
    readonly bindToolUseContext: (context: ToolUseContext) => void;
}
export interface TurnAssemblyRequest {
    readonly turn: number;
    readonly systemPrompt: string;
    readonly messages: Message[];
    readonly tools: Tool[];
    readonly resolved: ResolvedTurnTools;
    readonly turnContext: TurnContext;
    readonly options: ChatOptions | undefined;
    readonly canUseTool: CanUseToolFn;
    readonly toolInvokeDispatcher: ReturnType<typeof createToolInvokeDispatcherFromRegistry>;
    readonly publisher: TurnPipelinePublisher | undefined;
    readonly bindToolUseContext: (context: ToolUseContext) => void;
}
export interface TurnAssembly {
    readonly systemPrompt: string;
    readonly tools: readonly Tool[];
    readonly pipeline: ToolExecutionPipeline;
    readonly catalogView: ToolCatalogView;
}
export interface RunStartRequest {
    readonly options: ChatOptions | undefined;
    readonly prompt: string | MessageContent[];
}
export interface RunHandle {
    readonly turnId: string | null;
    readonly turnContext: TurnContext;
    readonly appliedProfile: AgentProfile | undefined;
    readonly requestedMode: string;
    readonly request: RunStartRequest;
    readonly orchestrator: ModeModifier | null;
    readonly signal: AbortSignal;
    readonly controller: AbortController;
    readonly abort: (reason?: unknown) => void;
    close(): void;
}
export interface RunAssemblyRequest {
    readonly options: ChatOptions | undefined;
    readonly prompt: string | MessageContent[];
    readonly appliedProfile?: AgentProfile;
    readonly turnContext: TurnContext;
    readonly publisher: TurnPipelinePublisher | undefined;
}
export interface PromptUserRowCommit {
    readonly committed: boolean;
    readonly messageId: string | null;
}
export interface LegacyTurnDelta {
    readonly turn: number;
    readonly messages: Message[];
    readonly tools: readonly Tool[];
    readonly systemPrompt: string;
}
export interface TurnModelProjection {
    readonly systemPrompt: string;
    readonly messages: Message[];
}
export interface RunTurnAssembly {
    readonly resolved: ResolvedTurnTools;
    readonly turnContext: TurnContext;
    readonly tools: readonly Tool[];
    readonly canUseTool: CanUseToolFn;
    readonly progressToolName: string;
    readonly systemPrompt: string;
    readonly projection: TurnModelProjection;
    projectTurnMessages(): Message[];
    refreshDeclaredTools(): Set<string>;
    assemble(input: LegacyTurnDelta): TurnAssembly;
}
/** Product session effects consumed by the Host engine driver. */
export interface EngineProductSession {
readModelClient(): AIClient;
runModeExitHooks(): Promise<void>;
beginRun(request: RunStartRequest): Promise<RunHandle>;
beginTurnAssembly(request: RunAssemblyRequest): Promise<RunTurnAssembly>;
producePromptContextRail(run: RunHandle): Promise<SSEEvent[]>;
bindTurnOutputSink(sink: TurnOutputSink | null): void;
bindRunForkMarker(marker: {
    readonly replyToId: string;
    readonly userId: string;
} | null): void;
projectRunOwnModelMessages(forkUserId: string): Message[];
recordTurnToolResult(input: {
    readonly message: Message;
    readonly toolName: string;
    readonly seqIndex: number;
}): Promise<void>;
recordTurnAssistantMessage(input: {
    readonly content: MessageContent[];
    readonly usage?: AssistantMessage['usage'];
    readonly seqIndex: number;
    readonly durationMs?: number;
}): void;
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
}): PromptUserRowCommit;
finishTurnOutput(summary: TurnOutputSummary): void;
readonly activeMCPRegistry: ToolRegistry;
claimInterTurn(input: {
    readonly runId: string;
    readonly checkpoint: 'before_model_turn' | 'before_final_answer';
    readonly messages: Message[];
    readonly seqIndex: number;
    readonly wakeRun: boolean;
    readonly imageInputSupported?: boolean;
}): Promise<RuntimeMailboxDecision>;
engineCompactionSources(input: {
    readonly systemPromptContent: () => string;
    readonly messages: () => readonly Message[];
    readonly nextCompactionId?: () => string;
}): CompactionSources;
orchestratorFramesFor(run: RunHandle): AsyncGenerator<SSEEvent, void, unknown>;
runGoalCommand(prompt: string, context: {
    readonly sessionId?: string;
    readonly workingDirectory?: string;
}): Promise<string | null>;
getMessages(): readonly Message[];
addMessage(message: Message): void;
}
