import type { WorkerProcessAssembly } from './worker-process-assembly.js';
import { definedProperties } from './worker-context/defined-properties.js';
import { randomUUID } from 'crypto';
import { readFile } from 'node:fs/promises';
import { appendFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendMessages, storeParsedDocumentAttachment } from './worker-session/persistence.js';
import { COMPACTION_CHECKPOINT_ID_SUFFIX } from '@duya/agent-core/message';
import type { WorkerSessionMessageRow as MessageRow, WorkerSessionImageAttachmentRow as AttachmentRow, WorkerSessionParsedDocumentRow as ParsedDocumentAttachment } from './worker-session/rows.js';
import { rehydrateContentWithAttachments } from './worker-session/image-attachments.js';
import type { Message, AssistantMessage, MessageContent, MCPServerConfig, Tool, TokenUsage, UsageCall, ChatOptions } from '@duya/host/worker-run-contracts';
import type { ProviderRuntimeConfig } from '@duya/ai';
import { logger } from '@duya/host/worker-logger';
import { parseUsageCall, createTurnUsageLedger, foldUsageCall } from '@duya/agent-core/usage/call-usage';
import { seedTokenUsageFromHistory, parsePersistedTokenUsage } from '@duya/agent-core/usage/seed-token-usage';
import { messageDb, attachmentDb, pluginDb, settingDb, sessionDb, toolApprovalDb, turnReviewDb, turnSuggestionDb, goalDb, pluginAppBindingDb, } from '@duya/host/worker-db-client';
import { createSurfaceAwarePermissionHandler } from '@duya/host/authorization/worker-approval-card';
import { enqueue, dequeue, hasCommandsInQueue, clearCommandQueue, getCommandQueueLength, } from '@duya/host/worker-command-queue';
import type { QueuedCommand } from '@duya/host/worker-command-queue';
import { generateSessionTitle } from '@duya/host/worker-session/title-generator';
import { generateTurnSuggestion } from '@duya/host/worker-session/turn-suggestion';
import { getSteeringConfig } from '@duya/host/worker-hooks/config';
import { classifyError, APIErrorType, computeContextComposition, normalizePromptTokens, type ContextEstimateSource } from '@duya/ai';
import type { PromptProfile } from '@duya/host/worker-prompts/modes/types';
import { isBotAgentProfile } from '@duya/host/worker-prompts/index';
import type { AppConnectionToolDescriptor } from './worker-tool-bindings/app-connection-tools.js';
let _appConnectionModule: any = null;
import type { WorkerSession } from './worker-session-runtime.js';
import { Journal } from '@duya/host/worker-journal/Journal';
import { loadSkills, getSkillRegistry, getAgentSkillDirectory } from '@duya/host/skills';
import { modeModifierRegistry } from './worker-modes/modifiers/index.js';
import { verifyRunManifestBinding, manifestRejectionProtocolCode, type WorkerCapabilitySet } from '@duya/agent-core/run-manifest-verification';
import { type RunManifest, type RunId } from '@duya/agent-protocol';
import { getBashTaskRegistry } from '@duya/host/managed-shell';
import { hookTaskRegistry } from '@duya/host/worker-hooks/task-registry';
import { backgroundAgentLifecycle } from '@duya/host/worker-subagents';
import { sendEvent, parseStdin, type WorkerCommand, buildWorkflowRunEvent, buildMessageFinalizedEvent, type WorkflowRunCommand } from '@duya/host/worker-transport';
import { convertSSEToAgentMessage } from '@duya/host/worker-frame-codec';
import { driveRunWithEngine } from '@duya/host/worker-engine-driver';
import { withWorkerDbRunContext } from './worker-db-context.js';
import { getPendingInteragentCall } from '@duya/host/worker-interagent-calls';
import { resolveTurnRunId } from '@duya/agent-runtime/turns/run-identity';
import { launchSavedWorkflow } from './worker-workflows/runner.js';
import { runWorkflowRuntimeChild } from './worker-workflows/runtime-child.js';
import { resolveChatStartAgentMode, manifestPermissionMode } from '@duya/agent-runtime/authorization/profile-bridge';
import { hydrateWorkerSessionHistory } from '@duya/host/worker-session-history';
import type { ModelContentBlock } from '@duya/agent-runtime';
import { TurnPipelinePublisher } from '@duya/agent-runtime/tools/turn-pipeline-publisher';
import { applyMCPConfiguration, type MCPApplyResult } from './connector-services/worker-permission-binding.js';
import { storePendingAnswer, takePendingAnswer } from '@duya/capabilities';
import { isCDNImageUrl } from '@duya/capabilities/utils/urlSafety';
import { isModelLikelyMultimodal } from '@duya/capabilities/utils/multimodal-detection';
import { detectModelCapability } from './worker-context/model-capability-cache.js';
import { loadAttachmentImages } from '@duya/host/worker-context/attachment-images';
import { buildImageAttachmentContext } from '@duya/host/worker-context/image-attachment-context';
import type { ProbeConfig } from './worker-context/model-capability-cache.js';
import type { ToolExecutor } from './worker-tool-registry.js';
import { estimateMessagesTokens } from './worker-compaction/token-estimate.js';
import { canReuseAgentForInit, workerInitDifferences, type WorkerInitShape } from './worker-init-fingerprint.js';
import type { ApiFormat, ModelCompat } from '@duya/ai';
import { createWorkerSelfInitMessage } from '@duya/host/worker-config/self-init';
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
    (globalThis as {
        crypto: {
            randomUUID: () => string;
        };
    }).crypto = {
        randomUUID: () => randomUUID(),
    };
}
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
        runtimeConfig?: ProviderRuntimeConfig;
    };
    workingDirectory?: string;
    currentProjectId?: string | null;
    projectHome?: string;
    defaultWorkspaceDirectory?: string;
    systemPrompt?: string;
    skillPaths?: string[];
    communicationPlatform?: string;
    language?: string;
    sandboxEnabled?: boolean;
    securityScanEnabled?: boolean;
    permissionRules?: import('@duya/host/worker-run-contracts').AgentOptions['permissionRules'];
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
    imageChunks?: Array<{
        base64: string;
        mediaType: string;
    }>;
    base64?: string;
}
interface ChatStartMessage {
    type: 'chat:start';
    sessionId: string;
    id: string;
    runId?: string;
    manifestHash?: string;
    inputRevision?: string;
    manifest?: RunManifest;
    prompt: string;
    options?: {
        messages?: Array<{
            role: string;
            content: string;
        }>;
        systemPrompt?: string;
        language?: string;
        permissionModeOverride?: 'default' | 'auto' | 'bypassPermissions';
        files?: FileAttachment[];
        agentProfileId?: string | null;
        outputStyleConfig?: {
            name: string;
            prompt: string;
            keepCodingInstructions?: boolean;
        };
        displayContent?: string;
        wakeless?: boolean;
        mode?: string;
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
        maxTurns?: number;
        allowedTools?: string[];
        permissionSurface?: 'bot' | 'default';
        backgroundTaskResume?: boolean;
        llmRequestTimeoutMs?: number;
        wakeRun?: boolean;
        clientMsgId?: string;
    };
}
interface PongMessage {
    type: 'pong';
    timestamp: number;
}
let agent: WorkerSession | null = null;
let processAssembly: WorkerProcessAssembly;
function requireWorkerSession(): WorkerSession {
    if (!agent)
        throw new Error('Worker session is not initialized');
    return agent;
}
let sessionId: string | null = null;
let initializing = false;
let chatInProgress = false;
let currentSecurityScanEnabled = true;
let lastInterruptTime = 0;
const DOUBLE_INTERRUPT_WINDOW_MS = 3000;
const AGENT_CATALOG_REVISION = '0.1.0';
function workerCapabilitySet(): WorkerCapabilitySet {
    const modeIds = modeModifierRegistry.list().map((mode) => mode.id);
    return {
        available: ['streaming', ...modeIds],
        catalogRevision: `agent@${AGENT_CATALOG_REVISION}`,
        manifestVersion: 1,
    };
}
let sessionSystemPrompt: string | undefined = undefined;
let existingMessageCount = 0;
/**
 * The init payload the CURRENT agent was built from.
 *
 * The agent server sends an `init` on every turn. When the payload is the
 * same, the agent it asks for is the agent this worker is already running in,
 * and rebuilding it would cost a tool catalog, a skill scan, the whole
 * transcript read back from the database and a fresh MCP handshake -- none of
 * which the turn needs.
 */
let currentInitShape: WorkerInitShape | null = null;
/**
 * Whether the last MCP handshake threw. The reuse path keeps the agent AND
 * skips a new handshake, so a transient failure must block reuse: the next
 * init rebuilds the agent, which is also what retries the handshake.
 */
let mcpHandshakeFailed = false;
let pendingCompactCommand: unknown = null;
let compactedPending = false;
let liveTotalInput = 0;
let liveTotalInputRaw = 0;
let liveTotalOutput = 0;
let liveTotalCacheHit = 0;
let liveTotalCacheCreation = 0;
let lastEmittedUsageKey: string | null = null;
type LastCallUsageBlock = {
    input_tokens?: number;
    output_tokens?: number;
    cache_hit_tokens?: number;
    cache_creation_tokens?: number;
};
function persistedUsageBlock(turnUsage: {
    cumulative: TokenUsage | null;
    lastCall: (LastCallUsageBlock & {
        output_tokens: number;
    }) | null;
}): AssistantMessage['usage'] | null {
    const cumulative = turnUsage.cumulative;
    if (cumulative === null)
        return null;
    return {
        input_tokens: cumulative.input_tokens,
        output_tokens: cumulative.output_tokens,
        ...(cumulative.total_tokens === undefined ? {} : { total_tokens: cumulative.total_tokens }),
        ...(cumulative.cache_hit_tokens === undefined
            ? {}
            : { cache_hit_tokens: cumulative.cache_hit_tokens }),
        ...(cumulative.cache_creation_tokens === undefined
            ? {}
            : { cache_creation_tokens: cumulative.cache_creation_tokens }),
        ...(cumulative.calls === undefined ? {} : { calls: cumulative.calls }),
        ...(turnUsage.lastCall === null ? {} : { last_call: turnUsage.lastCall }),
    };
}
export function admitChatFrame(event: {
    readonly type: string;
    readonly [field: string]: unknown;
}): Record<string, unknown> | null {
    if (event.type.startsWith('chat:'))
        return { ...event };
    return convertSSEToAgentMessage(event);
}
export function refreshesLiveRing(chatFrame: Record<string, unknown> | null): boolean {
    const type = chatFrame?.type;
    return type === 'chat:tool_result' || type === 'chat:done';
}
export function isTurnLevelUsageFrame(frame: {
    readonly type?: unknown;
}): boolean {
    return frame.type === 'result';
}
export interface TurnDoneLatch {
    latch(agentMsg: Record<string, unknown> | null): boolean;
    readonly latched: boolean;
    readonly reason: string | undefined;
    release(sessionId: string, finalized: Record<string, unknown> | null): Record<string, unknown>[];
}
export function createTurnDoneLatch(): TurnDoneLatch {
    let latched = false;
    let reason: string | undefined;
    return {
        latch(agentMsg) {
            if (agentMsg === null || agentMsg['type'] !== 'chat:done')
                return false;
            latched = true;
            const stated = agentMsg['reason'];
            reason = typeof stated === 'string' ? stated : undefined;
            return true;
        },
        get latched() {
            return latched;
        },
        get reason() {
            return reason;
        },
        release(sessionId, finalized) {
            if (!latched)
                return [];
            return [
                ...(finalized === null ? [] : [finalized]),
                { type: 'chat:done', sessionId, reason },
            ];
        },
    };
}
const RING_TRACE_FILE = (() => {
    const dir = process.env.DUYA_WORKER_LOG_DIR
        ?? process.env.DUYA_CLI_USER_DATA_DIR
        ?? process.env.TMPDIR
        ?? process.env.TEMP
        ?? process.env.TMP
        ?? '/tmp';
    return path.join(dir, 'context-ring.log');
})();
const ringTrace = (line: string): void => {
    if (!RING_TRACE_FILE)
        return;
    try {
        mkdirSync(path.dirname(RING_TRACE_FILE), { recursive: true });
        appendFileSync(RING_TRACE_FILE, `${new Date().toISOString()} ${line}
`);
    }
    catch {
    }
};
const emitLiveUsage = (targetSessionId: string | null, systemFallbackTokens?: number): void => {
    if (!targetSessionId)
        return;
    const msgs: readonly Message[] = agent?.getMessages?.() ?? [];
    const contextSnapshot = typeof agent?.getContextSnapshot === 'function'
        ? agent.getContextSnapshot(msgs)
        : null;
    const ledgerSnapshot = contextSnapshot ??
        (typeof agent?.getContextLedgerSnapshot === 'function'
            ? agent.getContextLedgerSnapshot()
            : null);
    const observedLatest = ledgerSnapshot?.observation?.inputTokens ?? 0;
    const observedOutput = ledgerSnapshot?.observation?.outputTokens ?? 0;
    const observedPeak = ledgerSnapshot?.accounting?.peakInputTokens ?? 0;
    const agentSystemTokens = typeof agent?.getSystemTokensEstimate === 'function'
        ? agent.getSystemTokensEstimate()
        : agent?.getSystemContextTokensEstimate?.() ?? 0;
    const agentToolsTokens = typeof agent?.getToolsTokensEstimate === 'function' ? agent.getToolsTokensEstimate() : 0;
    const systemPrefix = agentSystemTokens || systemFallbackTokens || 0;
    const { estimate, composition } = computeContextComposition(msgs, {
        systemPrefixTokens: systemPrefix,
        toolDefinitionsTokens: agentToolsTokens,
        skillParts: typeof agent?.getInjectedSkillParts === 'function'
            ? agent.getInjectedSkillParts()
            : [],
    });
    const usedForRing = contextSnapshot?.accounting?.projectedNextInputTokens ?? estimate.usedTokens ?? 0;
    const estimateSource: ContextEstimateSource | 'unknown' = contextSnapshot?.estimateSource ??
        (estimate.anchored ? 'anchor_projection' : estimate.usedTokens ? 'heuristic' : 'unknown');
    const anchored = contextSnapshot
        ? estimateSource !== 'heuristic' && estimateSource !== 'unknown' && !compactedPending
        : estimate.anchored && !compactedPending;
    const anchorTokensForRing = estimate.anchorTokens;
    const trailingForRing = estimate.trailingTokens;
    const compositionBuckets = [
        composition.system,
        composition.conversation,
        composition.injectedContext,
        composition.skills,
        composition.toolDefinitions,
        composition.toolResults,
        composition.attachments,
        composition.memory,
        composition.providerOverhead ?? [],
    ];
    const sumCompositionParts = (): number => compositionBuckets.reduce((sum, parts) => sum + parts.reduce((partSum, part) => partSum + part.tokens, 0), 0);
    const compositionParts = sumCompositionParts();
    if (compositionParts > usedForRing && compositionParts > 0) {
        const scale = Math.max(0, usedForRing) / compositionParts;
        for (const parts of compositionBuckets) {
            const scaledParts = parts.map((part) => ({
                ...part,
                tokens: Math.floor(part.tokens * scale),
            }));
            parts.splice(0, parts.length, ...scaledParts);
        }
    }
    composition.unattributedObservedTokens = Math.max(0, usedForRing - sumCompositionParts());
    logger.tokenTrace('emitLiveUsage', {
        sessionId: targetSessionId,
        anchor: estimate.anchorIndex,
        anchorMsgId: estimate.anchorIndex !== null ? msgs[estimate.anchorIndex]?.id : null,
        anchored,
        systemPrefix,
        msgs: msgs.length,
        latestInput: observedLatest > 0 ? observedLatest : null,
        peakInput: observedPeak > 0 ? observedPeak : null,
        projectedNext: usedForRing,
        estimateSource,
        result: {
            used: estimate.usedTokens,
            anchorTokens: estimate.anchorTokens,
            trailing: estimate.trailingTokens,
        },
        cumulative: {
            input: liveTotalInput,
            output: liveTotalOutput,
            cacheRead: liveTotalCacheHit,
            cacheCreate: liveTotalCacheCreation,
        },
    });
    ringTrace(`[${targetSessionId.slice(0, 8)}] emit msgs=${msgs.length} anchored=${anchored} anchorIdx=${estimate.anchorIndex} anchor=${anchorTokensForRing} trailing=${trailingForRing} used=${usedForRing} systemPrefix=${systemPrefix} totalsIn=${liveTotalInput} cacheHit=${liveTotalCacheHit}`);
    const bucketLine = ([
        ['unattributed', composition.unattributedObservedTokens],
        ['conversation', composition.conversation],
        ['toolResults', composition.toolResults],
        ['toolDefs', composition.toolDefinitions],
        ['injected', composition.injectedContext],
        ['skills', composition.skills],
        ['system', composition.system],
        ['memory', composition.memory],
        ['attachments', composition.attachments],
    ] as const)
        .map(([label, parts]) => typeof parts === 'number'
        ? `${label}=${parts}`
        : `${label}=${parts.reduce((s, p) => s + p.tokens, 0)}`)
        .join(' ');
    ringTrace(`[${targetSessionId.slice(0, 8)}] composition: ${bucketLine} (anchored=${anchored ? 1 : 0})`);
    const anchorMsg = estimate.anchorIndex !== null
        ? (msgs[estimate.anchorIndex] as {
            usage?: LastCallUsageBlock;
            tokenUsage?: LastCallUsageBlock;
        } | undefined)
        : undefined;
    const anchorUsage = anchorMsg?.usage ?? anchorMsg?.tokenUsage;
    const { prompt: lastInput, output: lastOutput } = normalizePromptTokens(anchorUsage);
    const windowInfo = contextSnapshot?.contextWindow
        ? { contextWindow: contextSnapshot.contextWindow, windowSource: contextSnapshot.windowSource }
        : agent?.getContextWindowResolved?.() ?? null;
    const emitKey = `${usedForRing}|${anchored ? 1 : 0}|${liveTotalInput}|${liveTotalInputRaw}|${liveTotalCacheHit}|${liveTotalCacheCreation}|${liveTotalOutput}|${observedLatest}|${observedPeak}|${estimateSource}|${agent?.model ?? mainModelName}|${currentProviderId}|${ledgerSnapshot?.epoch ?? -1}|${ledgerSnapshot?.observedAt ?? 0}|${windowInfo?.windowSource ?? '?'}`;
    if (emitKey === lastEmittedUsageKey) {
        ringTrace(`[${targetSessionId.slice(0, 8)}] emit-skip (no change) used=${usedForRing}`);
        return;
    }
    lastEmittedUsageKey = emitKey;
    sendToMain({
        type: 'chat:token_usage',
        sessionId: targetSessionId,
        anchored,
        usedTokens: usedForRing,
        latestInputTokens: observedLatest > 0 ? observedLatest : undefined,
        peakInputTokens: observedPeak > 0 ? observedPeak : undefined,
        projectedNextInputTokens: usedForRing,
        currentEstimatedInputTokens: usedForRing,
        contextSnapshot: contextSnapshot ?? undefined,
        estimateSource,
        epoch: ledgerSnapshot?.epoch,
        confidence: ledgerSnapshot?.confidence,
        observedAt: ledgerSnapshot?.observedAt,
        contextWindow: windowInfo?.contextWindow,
        windowSource: windowInfo?.windowSource,
        inputTokens: observedLatest || lastInput,
        outputTokens: observedOutput || lastOutput,
        cacheHitTokens: anchorUsage?.cache_hit_tokens,
        cacheCreationTokens: anchorUsage?.cache_creation_tokens,
        systemTokens: systemPrefix,
        toolDefinitionsTokens: agentToolsTokens || undefined,
        composition: {
            unattributedObservedTokens: composition.unattributedObservedTokens,
            system: composition.system,
            conversation: composition.conversation,
            injectedContext: composition.injectedContext,
            skills: composition.skills,
            toolDefinitions: composition.toolDefinitions,
            toolResults: composition.toolResults,
            attachments: composition.attachments,
            memory: composition.memory,
            providerOverhead: composition.providerOverhead ?? [],
        },
        totalInput: liveTotalInput,
        totalInputRaw: liveTotalInputRaw,
        totalOutput: liveTotalOutput,
        totalCacheHit: liveTotalCacheHit,
        totalCacheCreation: liveTotalCacheCreation,
        model: agent?.model ?? mainModelName,
        providerId: currentProviderId,
        debugBreakdown: {
            anchorIndex: estimate.anchorIndex,
            anchorMsgId: estimate.anchorIndex !== null ? msgs[estimate.anchorIndex]?.id : null,
            anchorTokens: anchorTokensForRing,
            trailingTokens: trailingForRing,
            observedLatest,
            observedPeak,
            estimateSource,
            msgs: msgs.length,
            compactedPending,
        },
    });
};
let mainModelName = '';
let currentProviderId = '';
let probeConfig: ProbeConfig | null = null;
let visionTool: any = null;
const titleGeneratedBySession = new Map<string, string>();
let titleGenerationModelConfig: {
    provider: string;
    apiKey: string;
    baseURL: string;
    model: string;
    apiFormat?: string;
    modelCompat?: ModelCompat;
} | null = null;
const DEBUG_IPC = process.env.DUYA_DEBUG_IPC === 'true';
let lastPongTime = Date.now();
const HEARTBEAT_INTERVAL = 5000;
let chatHeartbeatTimer: NodeJS.Timeout | null = null;
const CHAT_HEARTBEAT_INTERVAL = 8000;
const PERMISSION_CARD_EXPIRY_MS = 300000;
const BASH_TASK_PUSH_THROTTLE_MS = 300;
let bashTaskPushScheduled = false;
function pushBashTaskSnapshot(): void {
    const activeSessionId = sessionId;
    if (!activeSessionId)
        return;
    const tasks = getBashTaskRegistry().listTasks();
    sendToMain({ type: 'bash_task:update', sessionId: activeSessionId, tasks });
}
function scheduleBashTaskPush(): void {
    if (bashTaskPushScheduled)
        return;
    bashTaskPushScheduled = true;
    setTimeout(() => {
        bashTaskPushScheduled = false;
        pushBashTaskSnapshot();
    }, BASH_TASK_PUSH_THROTTLE_MS);
}
getBashTaskRegistry().onAnyChange(scheduleBashTaskPush);
const HOOK_TASK_PUSH_THROTTLE_MS = 300;
let hookTaskPushScheduled = false;
function pushHookTaskSnapshot(): void {
    const activeSessionId = sessionId;
    if (!activeSessionId)
        return;
    const tasks = hookTaskRegistry.listTasks();
    sendToMain({ type: 'hook_task:update', sessionId: activeSessionId, tasks });
}
function scheduleHookTaskPush(): void {
    if (hookTaskPushScheduled)
        return;
    hookTaskPushScheduled = true;
    setTimeout(() => {
        hookTaskPushScheduled = false;
        pushHookTaskSnapshot();
    }, HOOK_TASK_PUSH_THROTTLE_MS);
}
hookTaskRegistry.onAnyChange(scheduleHookTaskPush);
backgroundAgentLifecycle.onInFlightChange = (inFlight: number) => {
    const activeSessionId = sessionId;
    if (!activeSessionId)
        return;
    try {
        process.send?.({
            type: 'background_tasks:update',
            sessionId: activeSessionId,
            inFlight,
        });
    }
    catch (err) {
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
type PendingPermissionEntry = {
    resolve: (decision: 'allow' | 'deny') => void;
    reject: (error: Error) => void;
    timeoutHandle: ReturnType<typeof setTimeout>;
    toolName?: string;
};
const pendingPermissions = new Map<string, PendingPermissionEntry>();
const permissionScopes = new Map<string, {
    scopeType: 'bot' | 'session';
    scopeId: string;
}>();
function pendingPermissionKey(sessionId: string, id: string): string {
    return `${sessionId}::${id}`;
}
const pendingIpcRequests = new Map<string, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timeoutHandle?: ReturnType<typeof setTimeout>;
}>();
function appConnectionIpcRequest<T = unknown>(_channel: string, payload: unknown, options?: {
    timeout?: number;
}): Promise<{
    success: boolean;
    data?: T;
    error?: {
        code: string;
        message: string;
    };
}> {
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
            resolve: (v) => resolve(v as {
                success: boolean;
                data?: T;
                error?: {
                    code: string;
                    message: string;
                };
            }),
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
function appConnectionCatalogIpcRequest<T = unknown>(_channel: string, _payload: unknown, options?: {
    timeout?: number;
}): Promise<{
    success: boolean;
    data?: T;
    error?: {
        code: string;
        message: string;
    };
}> {
    return new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        const timeout = options?.timeout || 15000;
        const timeoutHandle = setTimeout(() => {
            if (pendingIpcRequests.has(requestId)) {
                pendingIpcRequests.delete(requestId);
                resolve({ success: false, error: { code: 'TIMEOUT', message: `appConnection catalog IPC request timeout after ${timeout}ms` } });
            }
        }, timeout);
        pendingIpcRequests.set(requestId, {
            resolve: (v) => resolve(v as {
                success: boolean;
                data?: T;
                error?: {
                    code: string;
                    message: string;
                };
            }),
            reject: (e) => resolve({ success: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } }),
            timeoutHandle,
        });
        sendToMain({ type: 'appConnection:catalog', requestId });
    });
}
function memoryTierIpcRequest<T = unknown>(_channel: string, payload: unknown, options?: {
    timeout?: number;
}): Promise<{
    success: boolean;
    data?: T;
    error?: {
        code: string;
        message: string;
    };
}> {
    return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const timeout = options?.timeout || 15000;
        const timeoutHandle = setTimeout(() => {
            if (pendingIpcRequests.has(requestId)) {
                pendingIpcRequests.delete(requestId);
                resolve({ success: false, error: { code: 'TIMEOUT', message: `memory-tier IPC request timeout after ${timeout}ms` } });
            }
        }, timeout);
        pendingIpcRequests.set(requestId, {
            resolve: (v) => resolve(v as {
                success: boolean;
                data?: T;
                error?: {
                    code: string;
                    message: string;
                };
            }),
            reject: (e) => reject(e),
            timeoutHandle,
        });
        const outerPayload = payload as {
            action?: string;
            payload?: unknown;
            sessionId?: string;
        } | undefined;
        sendToMain({
            type: 'memory-tier:rpc',
            requestId,
            action: outerPayload?.action,
            payload: outerPayload?.payload,
            sessionId: outerPayload?.sessionId,
        });
    });
}
function botIdentityIpcRequest<T = unknown>(_channel: string, payload: unknown, options?: {
    timeout?: number;
}): Promise<{
    success: boolean;
    data?: T;
    error?: {
        code: string;
        message: string;
    };
}> {
    return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const timeout = options?.timeout || 15000;
        const timeoutHandle = setTimeout(() => {
            if (pendingIpcRequests.has(requestId)) {
                pendingIpcRequests.delete(requestId);
                resolve({ success: false, error: { code: 'TIMEOUT', message: `bot-identity IPC request timeout after ${timeout}ms` } });
            }
        }, timeout);
        pendingIpcRequests.set(requestId, {
            resolve: (v) => resolve(v as {
                success: boolean;
                data?: T;
                error?: {
                    code: string;
                    message: string;
                };
            }),
            reject: (e) => reject(e),
            timeoutHandle,
        });
        const outerPayload = payload as {
            subaction?: string;
            payload?: unknown;
            sessionId?: string;
        } | undefined;
        sendToMain({
            type: 'bot-identity:rpc',
            requestId,
            subaction: outerPayload?.subaction,
            payload: outerPayload?.payload,
            sessionId: outerPayload?.sessionId,
        });
    });
}
function toolIpcRequest<T = unknown>(channel: string, payload: unknown, options?: {
    timeout?: number;
}): Promise<{
    success: boolean;
    data?: T;
    error?: {
        code: string;
        message: string;
    };
}> {
    if (channel === 'appConnection:invoke') {
        return appConnectionIpcRequest<T>(channel, payload, options);
    }
    if (channel === 'appConnection:catalog') {
        return appConnectionCatalogIpcRequest<T>(channel, payload, options);
    }
    if (channel === 'memory-tier:rpc') {
        return memoryTierIpcRequest<T>(channel, payload, options);
    }
    if (channel === 'bot-identity:rpc') {
        return botIdentityIpcRequest<T>(channel, payload, options);
    }
    return Promise.resolve({ success: false, error: { code: 'UNSUPPORTED_CHANNEL', message: `Unsupported host IPC channel: ${channel}` } });
}
function fetchAppConnectionDescriptors(): Promise<{
    success: boolean;
    descriptors?: unknown[];
    connectedConnectionIds?: string[];
    discoveryFailedConnectionIds?: string[];
    error?: {
        code: string;
        message: string;
    };
}> {
    return new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        const timeout = 10000;
        const timeoutHandle = setTimeout(() => {
            if (pendingIpcRequests.has(requestId)) {
                pendingIpcRequests.delete(requestId);
                resolve({ success: false, error: { code: 'TIMEOUT', message: `fetch descriptors timeout after ${timeout}ms` } });
            }
        }, timeout);
        pendingIpcRequests.set(requestId, {
            resolve: (v) => resolve(v as {
                success: boolean;
                descriptors?: unknown[];
                connectedConnectionIds?: string[];
                discoveryFailedConnectionIds?: string[];
                error?: {
                    code: string;
                    message: string;
                };
            }),
            reject: (e) => resolve({ success: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } }),
            timeoutHandle,
        });
        sendToMain({ type: 'appConnection:listDescriptors', requestId });
    });
}
async function getAppConnection(): Promise<any> {
    if (!_appConnectionModule)
        _appConnectionModule = await import('./worker-tool-bindings/app-connection-tools.js');
    return _appConnectionModule;
}
async function reloadAppConnectionTools(): Promise<void> {
    try {
        const { setCachedAppConnectionDescriptors } = await getAppConnection();
        const response = await fetchAppConnectionDescriptors();
        if (!response.success || !response.descriptors) {
            log('[Agent-Process] App Connection: descriptor fetch failed:', response.error?.message);
            return;
        }
        setCachedAppConnectionDescriptors(response.descriptors as AppConnectionToolDescriptor[], response.connectedConnectionIds, response.discoveryFailedConnectionIds);
        log(`[Agent-Process] App Connection: ${response.descriptors.length} descriptors cached`);
    }
    catch (err) {
        warn('[Agent-Process] App Connection: reload failed:', err);
    }
}
class TokenBucket {
    private tokens: number;
    private refillTimer: NodeJS.Timeout;
    constructor(private capacity: number, private refillRate: number) {
        this.tokens = capacity;
        this.refillTimer = setInterval(() => {
            this.tokens = Math.min(this.capacity, this.tokens + this.refillRate);
        }, 1000);
    }
    async consume(cost = 1): Promise<void> {
        while (this.tokens < cost) {
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
const toolBucket = new TokenBucket(5, 2);
function messageRowToMessage(row: MessageRow, attachmentMap?: Map<string, AttachmentRow[]>, parsedDocMap?: Map<string, ParsedDocumentAttachment[]>): Message {
    let content: string | MessageContent[];
    let toolCallId = row.tool_call_id || undefined;
    if (row.msg_type === 'thinking' && row.thinking) {
        content = [{ type: 'thinking', thinking: row.thinking }];
    }
    else if (row.msg_type === 'tool_use' && row.tool_name) {
        let input: Record<string, unknown> = {};
        let toolId = row.id;
        try {
            const parsed = JSON.parse(row.content);
            if (Array.isArray(parsed) && parsed.length > 0) {
                const block = parsed[0];
                if (block.id)
                    toolId = block.id;
                if (block.input)
                    input = block.input;
            }
        }
        catch (err) {
            try {
                input = row.tool_input ? JSON.parse(row.tool_input) : {};
            }
            catch (parseErr) {
                input = {};
            }
        }
        content = [{ type: 'tool_use', id: toolId, name: row.tool_name, input }];
        toolCallId = toolId;
    }
    else {
        try {
            const parsed = JSON.parse(row.content);
            if (Array.isArray(parsed)) {
                content = parsed as MessageContent[];
            }
            else {
                content = row.content;
            }
        }
        catch {
            content = row.content;
        }
    }
    if (attachmentMap && Array.isArray(content)) {
        content = rehydrateContentWithAttachments(content, attachmentMap) as MessageContent[];
    }
    let parsedAttachments: import('@duya/host/worker-run-contracts').FileAttachment[] | undefined;
    if (row.attachments) {
        try {
            parsedAttachments = JSON.parse(row.attachments) as import('@duya/host/worker-run-contracts').FileAttachment[];
        }
        catch {
        }
    }
    if (parsedAttachments && parsedDocMap) {
        for (const att of parsedAttachments) {
            const docs = parsedDocMap.get(row.id);
            if (docs) {
                const doc = docs.find(d => d.filename === att.name);
                if (doc) {
                    att.path = doc.filePath;
                    att.text = doc.text;
                    if (doc.extractMethod)
                        att.extractMethod = doc.extractMethod as 'text' | 'vision' | 'hybrid';
                    if (doc.imageChunks) {
                        try {
                            const parsed = JSON.parse(doc.imageChunks) as Array<{
                                base64: string;
                                mediaType: string;
                            }>;
                            if (parsed.length > 0) {
                                att.imageChunks = parsed;
                            }
                        }
                        catch {
                        }
                    }
                }
            }
        }
    }
    const tokenUsage = parsePersistedTokenUsage(row.token_usage);
    let threadMeta: {
        replyToId?: string;
        branched?: boolean;
    } | undefined;
    if (row.reply_to_id != null || row.branched != null) {
        threadMeta = {
            ...(row.reply_to_id != null ? { replyToId: row.reply_to_id } : {}),
            ...(row.branched != null ? { branched: row.branched === true } : {}),
        };
    }
    return definedProperties({
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
        ...(threadMeta ? { metadata: { threadMeta } } : {}),
    });
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
function getToolUseIds(message: Message): string[] {
    if (message.role !== 'assistant')
        return [];
    if (message.msg_type === 'tool_use' && message.tool_call_id) {
        return [message.tool_call_id];
    }
    if (!Array.isArray(message.content))
        return [];
    return message.content.flatMap((block) => (block.type === 'tool_use' && 'id' in block && typeof block.id === 'string' && block.id
        ? [block.id]
        : []));
}
function getToolResultIds(message: Message): string[] {
    if (message.role === 'tool' && message.tool_call_id) {
        return [message.tool_call_id];
    }
    if (!Array.isArray(message.content))
        return [];
    return message.content.flatMap((block) => (block.type === 'tool_result' && 'tool_use_id' in block && typeof block.tool_use_id === 'string' && block.tool_use_id
        ? [block.tool_use_id]
        : []));
}
function assistantContentBlocks(message: Message): MessageContent[] {
    if (Array.isArray(message.content))
        return message.content;
    if (message.msg_type === 'tool_use' && message.tool_call_id) {
        let input: Record<string, unknown> = {};
        if (message.tool_input) {
            try {
                const parsed = JSON.parse(message.tool_input);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    input = parsed as Record<string, unknown>;
                }
            }
            catch {
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
    if (messages.length === 1)
        return messages[0]!;
    const first = messages[0];
    if (!first)
        throw new Error('Cannot merge an empty tool round');
    const { msg_type, tool_call_id, tool_name, tool_input, ...metadata } = first;
    return { ...metadata, content: messages.flatMap(assistantContentBlocks) };
}
function reorderCompleteToolRounds(messages: Message[]): Message[] {
    const reordered: Message[] = [];
    let repairedRounds = 0;
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index]!;
        const pendingToolUseIds = getToolUseIds(message);
        const pendingIds = new Set(pendingToolUseIds);
        if (pendingIds.size === 0) {
            reordered.push(message);
            continue;
        }
        const assistantRound = [message];
        let firstNonAssistantIndex = index + 1;
        while (firstNonAssistantIndex < messages.length) {
            const candidate = messages[firstNonAssistantIndex]!;
            const candidateIds = getToolUseIds(candidate);
            if (candidateIds.length === 0)
                break;
            assistantRound.push(candidate);
            pendingToolUseIds.push(...candidateIds);
            candidateIds.forEach((id) => pendingIds.add(id));
            firstNonAssistantIndex++;
        }
        const unresolvedIds = new Set(pendingIds);
        const resultMessages: Array<{
            message: Message;
            order: number;
        }> = [];
        const deferredMessages: Message[] = [];
        let resultEndIndex = -1;
        for (let cursor = firstNonAssistantIndex; cursor < messages.length && unresolvedIds.size > 0; cursor++) {
            const candidate = messages[cursor]!;
            if (candidate.role === 'assistant')
                break;
            const matchingIds = getToolResultIds(candidate).filter((id) => unresolvedIds.has(id));
            if (matchingIds.length > 0) {
                matchingIds.forEach((id) => unresolvedIds.delete(id));
                resultMessages.push({
                    message: candidate,
                    order: Math.min(...matchingIds.map((id) => pendingToolUseIds.indexOf(id))),
                });
                resultEndIndex = cursor;
            }
            else {
                deferredMessages.push(candidate);
            }
        }
        if (unresolvedIds.size > 0 || resultEndIndex === -1) {
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
                    if (filteredContent.length === 0)
                        return null;
                    if (filteredContent.length === msg.content.length)
                        return msg;
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
            reordered.push(messages[resultEndIndex]!);
        }
        else {
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
function validateMessageHistory(messages: Message[]): Message[] {
    if (messages.length === 0)
        return messages;
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const msg of messages) {
        if (msg.msg_type === 'tool_use' && msg.tool_call_id) {
            toolUseIds.add(msg.tool_call_id);
        }
        else if (msg.role === 'tool' && msg.tool_call_id) {
            toolResultIds.add(msg.tool_call_id);
        }
        else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (block.type === 'tool_use' && 'id' in block && typeof block.id === 'string') {
                    toolUseIds.add(block.id);
                }
                else if (block.type === 'tool_result' && 'tool_use_id' in block && typeof block.tool_use_id === 'string') {
                    toolResultIds.add(block.tool_use_id);
                }
            }
        }
    }
    const unmatchedToolUseIds = new Set<string>();
    for (const id of toolUseIds) {
        if (!toolResultIds.has(id)) {
            unmatchedToolUseIds.add(id);
        }
    }
    const orphanToolResultIds = new Set<string>();
    for (const id of toolResultIds) {
        if (!toolUseIds.has(id)) {
            orphanToolResultIds.add(id);
        }
    }
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
    const cleanedMessages: Message[] = [];
    for (const msg of messages) {
        if (msg.role === 'tool' && !msg.tool_call_id) {
            log(`[Agent-Process] Removing unpaired tool_result with empty tool_call_id (tool_name=${msg.tool_name || 'unknown'})`);
            continue;
        }
        if (msg.role === 'tool' && msg.tool_call_id && orphanToolResultIds.has(msg.tool_call_id)) {
            log(`[Agent-Process] Removing orphan tool_result: ${msg.tool_call_id}`);
            continue;
        }
        if (msg.msg_type === 'tool_use' && msg.tool_call_id && unmatchedToolUseIds.has(msg.tool_call_id)) {
            log(`[Agent-Process] Removing incomplete tool_use: ${msg.tool_call_id} (${msg.tool_name})`);
            continue;
        }
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
            cleanedMessages.push({
                ...msg,
                content: filteredContent.length > 0 ? filteredContent : '',
            });
        }
        else {
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
        .map((block) => (block as {
        type: 'text';
        text: string;
    }).text)
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
            .map((block) => (block as {
            type: 'text';
            text: string;
        }).text)
            .join('\n')
            .trim();
        return text ? `[${role}] ${text.slice(0, 1000)}` : '';
    })
        .filter(Boolean)
        .join('\n\n');
}
async function initAgent(config: InitMessage['providerConfig'] | null | undefined, workDir?: string, defaultWorkspaceDir?: string, sysPrompt?: string, language?: string, sandboxEnabled?: boolean, communicationPlatform?: string, permissionRules?: InitMessage['permissionRules'], currentProjectId?: string | null, projectHome?: string): Promise<void> {
    sessionSystemPrompt = sysPrompt;
    if (!config) {
        throw new Error('No provider config available. Please configure an API provider in Settings.');
    }
    mainModelName = config.model;
    currentProviderId = config.runtimeConfig?.providerId ?? '';
    if (config.runtimeConfig) {
        log('[Agent-Process] runtimeConfig present (Phase 2)', {
            providerId: config.runtimeConfig.providerId,
            apiFormat: config.runtimeConfig.apiFormat,
            baseUrl: config.runtimeConfig.baseUrl,
            model: config.runtimeConfig.model,
            headerKeys: Object.keys(config.runtimeConfig.headers ?? {}),
        });
    }
    probeConfig = {
        model: config.model,
        provider: (config.provider || 'openai') as ProbeConfig['provider'],
        apiKey: config.apiKey || '',
        baseURL: config.baseURL || '',
        ...(config.authStyle !== undefined ? { authStyle: config.authStyle } : {}),
    };
    agent = processAssembly.createSession(definedProperties({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        model: config.model,
        authStyle: config.authStyle,
        provider: config.provider,
        sessionId: sessionId!,
        communicationPlatform: (communicationPlatform as 'cli' | 'duya-app' | 'weixin' | 'feishu' | 'telegram' | 'web' | 'api') ?? 'duya-app',
        workingDirectory: workDir,
        currentProjectId: currentProjectId ?? null,
        projectHome,
        visionConfig: config.visionConfig,
        compactModelConfig: config.compactModelConfig,
        language,
        defaultWorkspaceDirectory: defaultWorkspaceDir,
        permissionRules,
        runtimeConfig: config.runtimeConfig,
    }));
    agent.journal = new Journal({
        sessionId: sessionId!,
        onError: (kind, err) => {
            log(`[Agent-Process] journal ${kind} persist failed:`, err instanceof Error ? err.message : String(err));
        },
    });
    const initializedSession = agent;
    initializedSession.onMessagesCompacted = (newMessageCount: number): void => {
        log(`[Agent-Process] Messages compacted, new count=${newMessageCount}`);
        if (!initializedSession.journal)
            return;
        const currentMessages = initializedSession.getMessages();
        initializedSession.journal.appendRebase(`compact:${Date.now()}:${currentMessages.length}`, null, [...currentMessages]);
        log(`[Agent-Process] Compaction rebase emitted, newMessages=${currentMessages.length}`);
        compactedPending = true;
        emitLiveUsage(sessionId);
    };
    if (sandboxEnabled !== false) {
        const { prepareWorkerSandbox } = await import('@duya/capabilities/shell/prepare-sandbox');
        prepareWorkerSandbox((message) => log(message));
    }
    log('[Agent-Process] Agent core initialized');
}
async function loadAgentSkills(workDir?: string, skillPaths?: string[], securityScanEnabled?: boolean): Promise<void> {
    try {
        const loadOptions: {
            additionalPaths?: string[];
            agentSkillsDir?: string;
            syncBundled?: boolean;
            securityBypassSkills?: string[];
            skipSecurityScan?: boolean;
        } = {
            syncBundled: false,
        };
        if (sessionId?.startsWith('bot:')) {
            const botId = sessionId.slice('bot:'.length);
            if (botId)
                loadOptions.agentSkillsDir = getAgentSkillDirectory(botId);
        }
        const pluginSkillPaths = await discoverPluginSkillPaths();
        const allSkillPaths = [...(skillPaths || []), ...pluginSkillPaths];
        if (allSkillPaths.length > 0) {
            loadOptions.additionalPaths = allSkillPaths;
        }
        const bypassSkillsEnv = process.env.DUYA_SECURITY_BYPASS_SKILLS;
        if (bypassSkillsEnv) {
            loadOptions.securityBypassSkills = bypassSkillsEnv.split(',').map(s => s.trim()).filter(Boolean);
        }
        if (securityScanEnabled === false) {
            loadOptions.skipSecurityScan = true;
        }
        const skillsCwd = workDir || process.cwd();
        await loadSkills(skillsCwd, loadOptions);
        const registry = getSkillRegistry();
        try {
            const overridesRaw = await settingDb.getJson<Record<string, boolean>>('skillEnabledOverrides', {});
            const overrides = (overridesRaw && typeof overridesRaw === 'object')
                ? overridesRaw as Record<string, boolean>
                : {};
            const disabledNames = new Set<string>(Object.entries(overrides)
                .filter(([, enabled]) => enabled === false)
                .map(([name]) => name));
            if (disabledNames.size > 0) {
                for (const skill of registry.list()) {
                    if (disabledNames.has(skill.name) && skill.source !== 'system') {
                        registry.unregister(skill.name);
                    }
                }
                log(`[Agent-Process] Disabled ${disabledNames.size} skill(s) via user overrides`);
            }
        }
        catch (overrideErr) {
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
    }
    catch (err) {
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
/**
 * Read the attempt epoch the run's start command carries.
 *
 * The field is supplied by the Host on `input.options.attemptEpoch`. It is read
 * by narrowing rather than by declaring it on `ChatStartMessage['options']` so
 * that an older Host that omits it still works, and so an absent epoch is never
 * replaced by a default: the Host rejects a mismatched epoch, and it must
 * reject a missing one just as firmly.
 */
function readAttemptEpoch(options: ChatStartMessage['options']): number | undefined {
    if (options === undefined || !('attemptEpoch' in options)) {
        return undefined;
    }
    const raw = options.attemptEpoch;
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}
function sendToMain(msg: Record<string, unknown>): void {
    process.send?.(msg);
    sendEvent(msg);
}

/**
 * Announce a refused run on the native channel, so the ledger records WHY it ended.
 *
 * ## Why the refusal needs an event of its own
 *
 * The durable `run_events` ledger is written by the native `run:event` channel
 * only. A manifest refusal happens BEFORE the engine starts, so the emitter
 * that mints every other event never runs — and without this the row is
 * settled while the ledger behind it stays empty.
 *
 * That is the state this layer's own sibling path calls the worst outcome:
 * `RunOrchestrator.#closeAbandonedRun` appends the terminal EVENT as well as
 * the terminal STATE, and says why — "settling the row alone leaves
 * `run_events` with no record of how the run ended". A reconciler reading the
 * ledger has to be able to tell a refusal from a run that never started.
 *
 * ## Why the sequence is 1
 *
 * The refusal is decided before `run.started` is minted, so this is the FIRST
 * event of the run and the sequence starts at 1. `(runId, seq)` is the event
 * identity, so the number is not free — it is the run's first claim on its own
 * ledger.
 *
 * ## Why the epoch is required
 *
 * `run:event` is a FENCED write: the Host refuses an envelope whose attempt
 * does not match the run's. An absent epoch is therefore refused rather than
 * defaulted, and this announcement is skipped when the Host did not supply one
 * — the legacy `chat:error` below still carries the refusal to the client, so
 * the turn is not silently dropped.
 */
function announceRefusedRun(
    runId: string | undefined,
    sessionId: string,
    epoch: number | undefined,
    error: { code: string; message: string },
): void {
    if (runId === undefined || runId === '' || epoch === undefined) {
        log('[chat:start] refused run was not announced on the native channel — no run id or attempt epoch');
        return;
    }
    sendToMain({
        type: 'run:event',
        epoch,
        envelope: {
            runId,
            sessionId,
            seq: 1,
            timestamp: Date.now(),
            traceId: `refused-${runId}`,
            payload: { type: 'run.failed', error },
        },
    });
}
/**
 * The in-flight suggestion generation per session.
 *
 * A new turn makes the previous suggestion irrelevant, so the previous call is
 * aborted when the next turn starts rather than left to answer for a turn that
 * is already over.
 */
const turnSuggestionAbortBySession = new Map<string, AbortController>();

function abortTurnSuggestion(currentSessionId: string): void {
    const controller = turnSuggestionAbortBySession.get(currentSessionId);
    if (!controller)
        return;
    turnSuggestionAbortBySession.delete(currentSessionId);
    controller.abort();
}

/**
 * Predict the next prompt the user would type and persist it.
 *
 * The row is written even when there is no suggestion (an empty suggestion),
 * so a surface can tell "this turn produced nothing" from "the answer is not
 * here yet" without guessing.
 */
async function persistTurnSuggestion(
    currentSessionId: string,
    turnId: string,
    messages: readonly Message[],
    llmClient: Parameters<typeof generateTurnSuggestion>[1],
): Promise<void> {
    const controller = new AbortController();
    turnSuggestionAbortBySession.set(currentSessionId, controller);
    try {
        const { suggestion } = await generateTurnSuggestion(messages, llmClient, controller.signal, currentSessionId);
        await turnSuggestionDb.save({
            id: randomUUID(),
            sessionId: currentSessionId,
            turnId,
            suggestion: suggestion ?? '',
            createdAt: Date.now(),
        });
    }
    catch (error) {
        warn('[Agent-Process] Failed to persist turn suggestion:', error instanceof Error ? error.message : String(error));
    }
    finally {
        if (turnSuggestionAbortBySession.get(currentSessionId) === controller) {
            turnSuggestionAbortBySession.delete(currentSessionId);
        }
    }
}
async function persistTurnReview(currentSessionId: string, turnId: string, baseline: unknown): Promise<void> {
    if (!baseline)
        return;
    const { completeTurnReview } = await import('./worker-session/turn-review.js');
    const review = completeTurnReview(baseline as Parameters<typeof completeTurnReview>[0]);
    if (!review)
        return;
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
    }
    catch (error) {
        warn('[Agent-Process] Failed to persist turn review:', error instanceof Error ? error.message : String(error));
    }
}
function createPermissionHandler(sessId: string): (request: {
    id: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    mode?: string;
    expiresAt: number;
    /**
     * Why the request was raised, in the executor's words.
     *
     * A producer fact: only the executor knows what made the tool need
     * approval. Dropping it here left every client with a generic prompt
     * and no reason, and neither can be reconstructed from the tool name.
     */
    decisionReason?: string;
    metadata?: {
        toolParamsDisplay?: Array<{
            name: string;
            label: string;
            value: string;
        }>;
    };
}) => Promise<'allow' | 'deny'> {
    return async (request) => {
        const descriptor = (await getAppConnection()).getCachedAppConnectionDescriptors().find((d: any) => d.name === request.toolName);
        return new Promise<'allow' | 'deny'>((resolve, reject) => {
            const key = pendingPermissionKey(sessId, request.id);
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
            if (typeof (timeoutHandle as {
                unref?: () => void;
            }).unref === 'function') {
                (timeoutHandle as {
                    unref: () => void;
                }).unref();
            }
            pendingPermissions.set(key, { resolve, reject, timeoutHandle, toolName: request.toolName });
            sendToMain({
                type: 'chat:permission',
                sessionId: sessId,
                request: {
                    id: request.id,
                    toolName: request.toolName,
                    toolInput: request.toolInput,
                    mode: request.mode,
                    expiresAt: request.expiresAt,
                    ...(request.decisionReason === undefined
                        ? {}
                        : { reason: request.decisionReason }),
                    ...(descriptor
                        ? {
                            connector: {
                                provider: descriptor.provider,
                                riskTier: descriptor.riskTier,
                                preApproved: descriptor.preApproved === true,
                            },
                        }
                        : {}),
                    ...(request.metadata
                        ? { metadata: { toolParamsDisplay: request.metadata.toolParamsDisplay } }
                        : {}),
                },
            });
        });
    };
}
function toEngineContent(content: string | MessageContent[]): string | ModelContentBlock[] {
    if (typeof content === 'string')
        return content;
    const blocks: ModelContentBlock[] = [];
    for (const block of content) {
        if (block.type === 'text' && typeof (block as {
            text?: unknown;
        }).text === 'string') {
            blocks.push({ type: 'text', text: (block as {
                    text: string;
                }).text });
        }
    }
    return blocks;
}
async function handleChatStart(msg: ChatStartMessage): Promise<void> {
    if (!agent) {
        sendToMain({ type: 'chat:error', message: 'Agent not initialized', sessionId: msg.sessionId });
        return;
    }
    if (msg.options?.wakeless === true) {
        if (!msg.sessionId.startsWith('wakeless-')) {
            log(`[Agent-Process] WARN: wakeless=true but sessionId=${msg.sessionId} lacks 'wakeless-' prefix`);
        }
        log(`[Agent-Process] wakeless=true; journal + timeline-persist disabled for sessionId=${msg.sessionId}`);
        agent.journal = undefined;
    }
    await agent.waitForMcpReady(3000);
    let savedCheckoutRevision = 0;
    try {
        const row = (msg.options?.wakeless === true ? undefined : await sessionDb.get(msg.sessionId)) as { executionLocation?: { revision?: number; pending?: unknown } } | undefined;
        savedCheckoutRevision = row?.executionLocation?.revision ?? 0;
    } catch (error) {
        sendToMain({ type: 'chat:error', sessionId: msg.sessionId, message: `Cannot verify the saved execution location: ${error instanceof Error ? error.message : String(error)}` });
        return;
    }
    if (savedCheckoutRevision > 0 || (msg.options && 'checkoutExecutionRevision' in msg.options && typeof msg.options.checkoutExecutionRevision === 'number')) {
        try { await agent.restoreExecutionLocation(); }
        catch (error) {
            sendToMain({ type: 'chat:error', sessionId: msg.sessionId, message: error instanceof Error ? error.message : String(error) });
            return;
        }
    }
    const workingDirectory = agent.readWorkingDirectory() ?? '';
    // A new turn makes the previous turn's suggestion irrelevant; the call
    // still in flight for it is stopped here.
    abortTurnSuggestion(msg.sessionId);
    const { captureTurnReviewBaseline } = await import('./worker-session/turn-review.js');
    const turnReviewBaseline = captureTurnReviewBaseline(workingDirectory);
    const titleModelOption = msg.options?.titleGenerationModel;
    const titleModelConfigOption = msg.options?.titleGenerationModelConfig;
    if (titleModelConfigOption) {
        titleGenerationModelConfig = {
            provider: titleModelConfigOption.provider,
            apiKey: titleModelConfigOption.apiKey,
            baseURL: titleModelConfigOption.baseURL,
            model: titleModelConfigOption.model,
            ...(titleModelConfigOption.apiFormat !== undefined ? { apiFormat: titleModelConfigOption.apiFormat } : {}),
            ...(titleModelConfigOption.modelCompat !== undefined ? { modelCompat: titleModelConfigOption.modelCompat } : {}),
        };
        log('[Agent-Process] Title generation model configured from options:', titleModelConfigOption.model);
    }
    else if (titleModelOption) {
        const parts = titleModelOption.split(':');
        if (parts.length >= 2) {
            const model = parts.slice(1).join(':');
            titleGenerationModelConfig = {
                provider: agent.readWorkerProviderConfig().provider || 'openai',
                apiKey: agent.readWorkerProviderConfig().apiKey || '',
                baseURL: agent.readWorkerProviderConfig().baseURL || '',
                model: model,
            };
            log('[Agent-Process] Title generation model configured from agent config:', titleGenerationModelConfig.model);
        }
    }
    else {
        titleGenerationModelConfig = null;
    }
    if (msg.options?.language && agent) {
        agent.setLanguage(msg.options.language);
    }
    log('[Agent-Process] handleChatStart:', {
        sessionId: msg.sessionId,
        promptLength: msg.prompt.length,
        agentProfileId: msg.options?.agentProfileId || '(none)',
    });
    if (agent) {
        log('[Agent-Process] Agent LLM config:', {
            model: agent.readWorkerProviderConfig().model,
            provider: agent.readWorkerProviderConfig().provider,
            baseURL: agent.readWorkerProviderConfig().baseURL,
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
    if (msg.manifest !== undefined && msg.manifestHash !== undefined) {
        const verdict = verifyRunManifestBinding({
            manifest: msg.manifest,
            manifestHash: msg.manifestHash,
            inputRevision: msg.inputRevision ?? '',
            received: {
                sessionId: msg.sessionId,
                prompt: msg.prompt,
                options: (msg.options ?? {}) as Record<string, unknown>,
            },
            worker: workerCapabilitySet(),
        });
        if (!verdict.ok) {
            log(`[chat:start] refused ${verdict.code}: ${verdict.detail} (runId=${msg.runId ?? 'none'}, session=${msg.sessionId})`);
            const protocolCode = manifestRejectionProtocolCode(verdict.code);
            const refusalMessage = `run refused (${verdict.code}): ${verdict.detail}`;
            // The ledger must say how this run ended, not just the row.
            announceRefusedRun(
                msg.runId,
                msg.sessionId,
                readAttemptEpoch(msg.options),
                { code: protocolCode, message: refusalMessage },
            );
            sendToMain({
                type: 'chat:error',
                sessionId: msg.sessionId,
                message: refusalMessage,
                code: protocolCode,
            } as never);
            return;
        }
        if (verdict.unsatisfiedOptional.length > 0) {
            log(`[chat:start] catalog skew: ${verdict.unsatisfiedOptional.length} optional capabilit(ies) unavailable ` +
                `(${verdict.unsatisfiedOptional.join(', ')}); continuing against the frozen manifest`);
        }
        log(`[chat:start] manifest verified (runId=${msg.manifest.runId}, hash=${msg.manifestHash.slice(0, 12)}…, ` +
            `catalog=${verdict.catalogRevision.worker}, adopted=${String(verdict.catalogRevision.adopted)})`);
    }
    const turnPipelines = new TurnPipelinePublisher();
    try {
        startChatHeartbeat();
        const permissionSurface = msg.options?.permissionSurface === 'bot' ? 'bot' : 'default';
        const botAgentId = msg.options?.agentProfileId || null;
        const grantScope = {
            scopeType: (permissionSurface === 'bot' ? 'bot' : 'session') as 'bot' | 'session',
            scopeId: (permissionSurface === 'bot' ? botAgentId : msg.sessionId) || msg.sessionId,
        };
        permissionScopes.set(msg.sessionId, grantScope);
        const requestPermission = createSurfaceAwarePermissionHandler(createPermissionHandler(msg.sessionId), { sessionId: msg.sessionId, surface: permissionSurface, botAgentId });
        let approvedAlwaysAllowTools: string[] = [];
        try {
            approvedAlwaysAllowTools = (await toolApprovalDb.listRules(grantScope)) as string[];
        }
        catch {
        }
        if (approvedAlwaysAllowTools.length > 0) {
            try {
                const { rememberSessionApproval } = await import('./authorization/connector-approval-cache.js');
                for (const tool of approvedAlwaysAllowTools)
                    rememberSessionApproval(tool);
            }
            catch {
            }
        }
        const consumeApprovedEffect = async (toolName: string, toolInput?: Record<string, unknown>): Promise<boolean> => {
            try {
                return Boolean(await toolApprovalDb.consumeApproved({
                    sessionId: msg.sessionId,
                    toolName,
                    ...definedProperties({ toolInput: toolInput })
                }));
            }
            catch {
                return false;
            }
        };
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
        sendI18nStatus('streaming.preparing');
        const effectiveSystemPrompt = sessionSystemPrompt || msg.options?.systemPrompt;
        const systemPromptTokensEstimate = effectiveSystemPrompt
            ? estimateMessagesTokens([{ role: 'assistant', content: effectiveSystemPrompt }])
            : 0;
        let rowProfile: string | null = null;
        try {
            const sessionRow = sessionDb.get(msg.sessionId);
            rowProfile = (sessionRow as {
                permission_profile?: string | null;
            } | null)?.permission_profile ?? null;
        }
        catch {
        }
        const resolved = resolveChatStartAgentMode({
            rowProfile,
            optionOverride: msg.options?.permissionModeOverride,
        });
        log('[chat:start] agentMode:', resolved.agentMode, 'fromRow:', resolved.fromRow, 'override:', resolved.override);
        agent.setPermissionMode(resolved.agentMode);
        const files = msg.options?.files;
        const docFiles = (files || []).filter(f => f.path || f.text);
        const imageFiles = (files || []).filter(f => f.type.startsWith('image/') || f.type.startsWith('img/'));
        const modelIsMultimodal = probeConfig
            ? await detectModelCapability(probeConfig)
            : isModelLikelyMultimodal(mainModelName);
        log(`[Image-Processing] Model multimodal detection: ${mainModelName} → ${modelIsMultimodal} (${probeConfig ? 'probed' : 'regex-only fallback'})`);
        const imageDataCache = await loadAttachmentImages(imageFiles);
        const readFailedFiles = new Set<string>();
        const cdnSkippedFiles = new Set<string>();
        const visionFailedFiles = new Set<string>();
        const markVisionFailed = (name: string) => {
            if (name)
                visionFailedFiles.add(name);
        };
        for (const file of imageFiles) {
            if (imageDataCache.has(file))
                continue;
            if (isCDNImageUrl(file.url))
                cdnSkippedFiles.add(file.name);
            else
                readFailedFiles.add(file.name);
        }
        let preAnalysisText = '';
        let visionAnalysisFailed = false;
        let visionAnalysisError: string | null = null;
        const analyzedImageNames = new Set<string>();
        const hasVisionAnalyzer = agent && 'analyzeImage' in agent && typeof agent.analyzeImage === 'function';
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
                const cached = imageDataCache.get(file);
                if (!cached)
                    continue;
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
                    const result = await (agent as unknown as {
                        analyzeImage: (b64: string, mt: string, prompt?: string) => Promise<string>;
                    }).analyzeImage(cached.base64, cached.mediaType, quickVisionPrompt);
                    preAnalysisText += `\n\n[Image: "${file.name}"]\n${result}`;
                    analyzedImageNames.add(file.name);
                    log(`[Agent-Process] Vision analysis: "${file.name}" — ${result.length} chars`);
                }
                catch (err) {
                    visionAnalysisFailed = true;
                    visionAnalysisError = err instanceof Error ? err.message : String(err);
                    markVisionFailed(file.name);
                    logger.warn('Vision pre-analysis failed', {
                        phase: 'image-pre-analysis',
                        fileName: file.name,
                        reason: visionAnalysisError,
                    }, 'ImageProcessing');
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
        if (imageFiles.length > 0 &&
            !modelIsMultimodal &&
            (!preAnalysisText || visionAnalysisFailed)) {
            sendI18nStatus('streaming.visionFallback');
            const toolPassResults: string[] = [];
            for (const file of imageFiles) {
                const cached = imageDataCache.get(file);
                const imagePath = (file.path || file.url || '').trim();
                if (isCDNImageUrl(imagePath)) {
                    continue;
                }
                try {
                    let toolResult: {
                        error?: boolean;
                        result?: unknown;
                    };
                    if (cached) {
                        if (visionFailedFiles.has(file.name)) {
                            continue;
                        }
                        const analyzeImage = (agent as unknown as {
                            analyzeImage?: (b64: string, mt: string, prompt?: string) => Promise<string>;
                        })?.analyzeImage?.bind(agent);
                        if (!analyzeImage) {
                            continue;
                        }
                        const question = msg.prompt?.trim()
                            ? `Analyze this image for the user's request: ${msg.prompt.trim()}`
                            : 'Describe this image in detail.';
                        const analysis = await analyzeImage(cached.base64, cached.mediaType, question);
                        toolResult = { result: analysis };
                    }
                    else if (imagePath && !imagePath.startsWith('data:')) {
                        visionTool ??= new (await import('@duya/capabilities/VisionTool/VisionTool')).VisionTool();
                        toolResult = await visionTool.execute({
                            image_path: imagePath,
                            question: msg.prompt?.trim()
                                ? `Analyze this image for the user's request: ${msg.prompt.trim()}`
                                : 'Describe this image in detail.',
                        }, undefined, {
                            options: {
                                analyzeImage: (agent as unknown as {
                                    analyzeImage?: (b64: string, mt: string, prompt?: string) => Promise<string>;
                                })?.analyzeImage?.bind(agent),
                            },
                        } as unknown as import('@duya/host/worker-run-contracts').ToolUseContext);
                    }
                    else {
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
                            analyzedImageNames.add(file.name);
                        }
                    }
                }
                catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    markVisionFailed(file.name);
                    visionAnalysisFailed = true;
                    if (!visionAnalysisError)
                        visionAnalysisError = errMsg;
                    logger.warn('Vision tool fallback failed', {
                        phase: 'vision-tool-fallback',
                        fileName: file.name,
                        reason: errMsg,
                    }, 'ImageProcessing');
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
        if (imageFiles.length > 0) {
            const ctx = buildImageAttachmentContext({
                imageFiles,
                analyzedFileNames: analyzedImageNames,
                cdnSkipped: cdnSkippedFiles,
                readFailed: readFailedFiles,
                visionFailed: visionFailedFiles,
                modelIsMultimodal,
                hasVisionAnalyzer,
                visionAnalysisError,
            });
            if (ctx.appendText) {
                effectivePrompt = effectivePrompt
                    ? `${effectivePrompt}${ctx.appendText}`
                    : ctx.appendText.trimStart();
            }
        }
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
            if (effectivePrompt && effectivePrompt.trim()) {
                contentBlocks.push({ type: 'text', text: effectivePrompt });
            }
            for (const file of files) {
                if (file.type.startsWith('image/') || file.type.startsWith('img/')) {
                    const cached = imageDataCache.get(file);
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
                        }
                        else {
                            log(`[Agent-Process] Skipping image block, model not multimodal: "${file.name}"`);
                        }
                    }
                    else if (isCDNImageUrl(file.url)) {
                        warn('[Agent-Process] Skipping CDN image URL:', file.name);
                    }
                    else {
                        warn('[Agent-Process] Image file has no cached base64 data:', file.name);
                    }
                }
            }
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
            messageContent = [...contentBlocks, ...imageBlocks];
        }
        else if (docFiles.some(d => d.imageChunks?.length)) {
            const contentBlocks: MessageContent[] = [];
            const imageBlocks: MessageContent[] = [];
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
        const agentMsgCountBeforeSync = agent.getMessages().length;
        log(`[Agent-Process] Before sync: agent has ${agentMsgCountBeforeSync} messages, existingMessageCount=${existingMessageCount}`);
        if (existingMessageCount > 0) {
            try {
                const dbCount = await messageDb.getCount(msg.sessionId) as number;
                log(`[Agent-Process] DB message count: ${dbCount}`);
                if (dbCount > existingMessageCount) {
                    log(`[Agent-Process] DB has ${dbCount} messages but agent has ${existingMessageCount}, syncing...`);
                    const loaded = await messageDb.loadMessages(msg.sessionId) as {
                        messages: MessageRow[];
                    };
                    const allRows = loaded.messages;
                    if (allRows.length > existingMessageCount) {
                        const attachmentMap = await attachmentDb.getImagesForSession(msg.sessionId);
                        const allMsgs = allRows.map(row => messageRowToMessage(row, attachmentMap));
                        const validated = validateMessageHistory(allMsgs);
                        agent.setMessages(validated);
                        existingMessageCount = validated.length;
                        log(`[Agent-Process] Synced ${validated.length} messages from DB`);
                    }
                }
            }
            catch (syncErr) {
                log('[Agent-Process] Message resync failed (non-critical):', syncErr);
            }
        }
        else if (agentMsgCountBeforeSync === 0) {
            try {
                const dbCount = await messageDb.getCount(msg.sessionId) as number;
                if (dbCount > 0) {
                    log(`[Agent-Process] Agent has no messages but DB has ${dbCount}, loading...`);
                    const loaded = await messageDb.loadMessages(msg.sessionId) as {
                        messages: MessageRow[];
                    };
                    const allRows = loaded.messages;
                    const attachmentMap = await attachmentDb.getImagesForSession(msg.sessionId);
                    const allMsgs = allRows.map(row => messageRowToMessage(row, attachmentMap));
                    const validated = validateMessageHistory(allMsgs);
                    agent.setMessages(validated);
                    existingMessageCount = validated.length;
                    log(`[Agent-Process] Loaded ${validated.length} messages from DB`);
                }
            }
            catch (loadErr) {
                log('[Agent-Process] Message load failed (non-critical):', loadErr);
            }
        }
        {
            const seeded = seedTokenUsageFromHistory(agent.getMessages());
            liveTotalInput = seeded.totalInput;
            liveTotalInputRaw = seeded.totalInputRaw;
            liveTotalOutput = seeded.totalOutput;
            liveTotalCacheHit = seeded.totalCacheHit;
            liveTotalCacheCreation = seeded.totalCacheCreation;
            lastEmittedUsageKey = null;
        }
        const steering = getSteeringConfig();
        const mentionedProviders = msg.options?.mentionedProviders?.filter((p: unknown): p is string => typeof p === 'string' && p.length > 0);
        if (mentionedProviders && mentionedProviders.length > 0) {
            const cachedProviders = new Set((await import('./worker-tool-bindings/app-connection-tools.js')).getCachedAppConnectionDescriptors().map((d) => d.provider));
            if (mentionedProviders.some((p: string) => !cachedProviders.has(p))) {
                log('[Agent-Process] App Connection: mentioned provider missing from descriptor cache — refetching');
                await reloadAppConnectionTools();
            }
        }
        const turnUsage: ReturnType<typeof createTurnUsageLedger> & {
            lastCall: (LastCallUsageBlock & {
                output_tokens: number;
            }) | null;
        } = createTurnUsageLedger();
        log('[Agent-Process] engine driver starting, agentProfileId:', msg.options?.agentProfileId || '(none)');
        const turnDone = createTurnDoneLatch();
        let eventCount = 0;
        const turnStartMessageCount = agent.getMessages().length;
        const emitTokenUsage = (): void => emitLiveUsage(msg.sessionId, systemPromptTokensEstimate);
        emitTokenUsage();
        const handleStreamEvent = (event: {
            type: string;
            data?: unknown;
            [field: string]: unknown;
        }): void => {
            eventCount++;
            if (eventCount <= 5) {
                log(`[Agent-Process] Event ${eventCount}:`, event.type, event.data ? String((event as {
                    data?: unknown;
                }).data).substring(0, 100) : '');
            }
            if (DEBUG_IPC && (event.type === 'tool_use'
                || event.type === 'tool_result'
                || event.type === 'agent_progress'
                || event.type === 'error'
                || event.type === 'done')) {
                debugLog('stream event', {
                    sessionId: msg.sessionId,
                    eventCount,
                    type: event.type,
                    hasData: event.data !== undefined,
                });
            }
            if (eventCount % 10 === 0 && Date.now() - lastPongTime > HEARTBEAT_INTERVAL) {
                lastPongTime = Date.now();
                sendToMain({ type: 'pong', timestamp: lastPongTime });
                debugLog('Sent heartbeat pong during streaming');
            }
            const agentMsg = admitChatFrame(event);
            if (event.type === 'result' && event.data) {
                const call = parseUsageCall(event.data as Record<string, unknown>);
                if (call) {
                    const volumes = foldUsageCall(turnUsage, call, {
                        model: agent?.model ?? mainModelName,
                        providerId: currentProviderId,
                    });
                    ringTrace(`[${(msg.sessionId ?? sessionId ?? '?').slice(0, 8)}] result call: input=${call.input_tokens}, output=${call.output_tokens}, cacheHit=${call.cache_hit_tokens ?? 0}, cacheWrite=${call.cache_creation_tokens ?? 0}, normalizedInput=${volumes.normalizedInput}, model=${call.model ?? '?'}`);
                    compactedPending = false;
                    liveTotalInput += volumes.onlyNewInput;
                    liveTotalInputRaw += call.input_tokens;
                    liveTotalOutput += call.output_tokens;
                    liveTotalCacheHit += call.cache_hit_tokens ?? 0;
                    liveTotalCacheCreation += call.cache_creation_tokens ?? 0;
                    emitTokenUsage();
                }
                else {
                    warn('[Agent-Process] Received all-zero usage, ignoring to avoid empty context ring');
                }
            }
            else if (refreshesLiveRing(agentMsg)) {
                emitTokenUsage();
            }
            if (agentMsg) {
                if (turnDone.latch(agentMsg)) {
                    return;
                }
                if (DEBUG_IPC && (agentMsg.type === 'chat:tool_use'
                    || agentMsg.type === 'chat:tool_result'
                    || agentMsg.type === 'chat:agent_progress'
                    || agentMsg.type === 'chat:error'
                    || agentMsg.type === 'chat:done')) {
                    debugLog('forward event->main', {
                        sessionId: msg.sessionId,
                        from: event.type,
                        to: agentMsg.type,
                    });
                }
                sendToMain({ ...agentMsg, sessionId: msg.sessionId });
            }
            else if (DEBUG_IPC) {
                debugLog('event dropped by converter', {
                    sessionId: msg.sessionId,
                    type: event.type,
                });
            }
        };
        const chatOptions: ChatOptions = {
            systemPrompt: effectiveSystemPrompt,
            requestPermission,
            consumeApprovedEffect,
            approvedAlwaysAllowTools,
            agentProfileId: msg.options?.agentProfileId,
            outputStyleConfig: msg.options?.outputStyleConfig,
            mode: msg.options?.mode,
            mentionedProviders: msg.options?.mentionedProviders,
            mentionedSkills: msg.options?.mentionedSkills,
            mentionedPlugins: msg.options?.mentionedPlugins,
            attachments: files,
            imageInputSupported: modelIsMultimodal,
            displayContent: msg.options?.displayContent,
            turnId: msg.id,
            runId: msg.runId,
            effort: msg.options?.effort,
            maxTurns: msg.options?.maxTurns,
            allowedTools: msg.options?.allowedTools,
            hostIpc: { sendToMain, ipcRequest: toolIpcRequest },
            backgroundTaskResume: msg.options?.backgroundTaskResume,
            llmRequestTimeoutMs: msg.options?.llmRequestTimeoutMs,
            wakeRun: msg.options?.wakeRun === true,
            clientMsgId: msg.options?.clientMsgId,
            todoGate: { enabled: steering.todoGateEnabled },
            antiDeadLoop: { ...steering.antiDeadLoop },
            disabledLoopHooks: steering.disabledLoopHooks,
        } as ChatOptions;
        const attemptEpoch = readAttemptEpoch(msg.options);
        const engineAgent = agent;
        const engineRun = await withWorkerDbRunContext(
          msg.runId && attemptEpoch !== undefined
            ? { sessionId: msg.sessionId, runId: msg.runId, epoch: attemptEpoch }
            : undefined,
          () => driveRunWithEngine({
            agent: engineAgent,
            sessionId: msg.sessionId,
            runId: resolveTurnRunId(msg.runId).runId as RunId,
            seqIndex: Date.now(),
            options: chatOptions,
            prompt: messageContent,
            ...(msg.inputRevision === undefined ? {} : { inputRevision: msg.inputRevision }),
            // The Control Plane's fingerprint of the frozen manifest, verified
            // against the manifest it sent above. `run.started` must carry
            // THIS hash: it is the one the `runs` row recorded, and the ledger's
            // first event is what a reader ties back to that row.
            ...(msg.manifestHash === undefined ? {} : { manifestHash: msg.manifestHash }),
            model: engineAgent.readWorkerProviderConfig().model,
            providerId: currentProviderId,
            workingDirectory,
            permissionMode: manifestPermissionMode(resolved.agentMode),
            ...(msg.options?.maxTurns === undefined ? {} : { maxTurns: msg.options.maxTurns }),
            wakeRun: msg.options?.wakeRun === true,
            imageInputSupported: modelIsMultimodal,
            turnPipelines,
            askApproval: async (approval) => {
                if (requestPermission === undefined) {
                    return { allowed: false, reason: 'unavailable' } as const;
                }
                const verdict = await requestPermission({
                    id: approval.callId,
                    toolName: approval.toolName,
                    toolInput: approval.input as Record<string, unknown>,
                    mode: 'generic',
                    expiresAt: Date.now() + PERMISSION_CARD_EXPIRY_MS,
                });
                if (verdict === 'allow')
                    return { allowed: true, scope: 'once' } as const;
                return {
                    allowed: false,
                    reason: verdict === 'paused' ? 'cancelled' : 'denied',
                } as const;
            },
            legacyFrameCodec: convertSSEToAgentMessage,
            onPerCallUsage: (usage) => handleStreamEvent({ type: 'result', data: usage as unknown }),
            turnUsageBlock: () => persistedUsageBlock(turnUsage),
            // Native channel (plan 610 S1). The envelope travels VERBATIM on
            // its own message type -- same object the emitter minted, not a
            // re-sequenced or re-projected copy -- so the Host can stop
            // re-deriving runs from the lossy `chat:*` frames the drain below
            // still emits for the TUI and Desktop. `epoch` is passed through
            // as given; `undefined` serializes to an absent key, which the
            // Host rejects, exactly as it rejects a wrong number.
            onNativeEnvelope: (envelope) => {
                // Standalone Host receives IPC; Desktop receives stdout.
                // Mirror the same Runtime identity to each transport owner.
                sendToMain({ type: 'run:event', epoch: attemptEpoch, envelope });
            },
        }, (frame) => {
            if (isTurnLevelUsageFrame(frame))
                return;
            handleStreamEvent(frame as {
                type: string;
                data?: unknown;
            });
        }, async (frames) => {
            for await (const frame of frames) {
                handleStreamEvent(frame as unknown as {
                    type: string;
                    data?: unknown;
                });
            }
        })
        );
        for (const frame of engineRun.railFrames) {
            handleStreamEvent(frame as unknown as {
                type: string;
                data?: unknown;
            });
        }
        log('[Agent-Process] engine run settled:', engineRun.terminal?.status ?? '(orchestrator)', 'proposed:', engineRun.proposed?.state.status ?? '(none)', 'announced:', engineRun.announced.length);
        let agentMessages = agent.getMessages();
        try {
            const hookMessages = agent.drainPendingHookMessages();
            if (hookMessages.length > 0) {
                const hookRes = await appendMessages(msg.sessionId, hookMessages);
                existingMessageCount += hookRes.count;
                log(`[Agent-Process] Persisted ${hookRes.count}/${hookMessages.length} hook invocation message(s)`);
            }
        }
        catch (hookErr) {
            warn('[Agent-Process] Failed to persist hook messages:', hookErr instanceof Error ? hookErr : new Error(String(hookErr)));
        }
        let lastAssistant: (typeof agentMessages)[number] | undefined;
        log(`[Agent-Process] Stream ended, tokenUsage present=${!!turnUsage.cumulative}, agentMessages=${agentMessages.length}, existingMessageCount=${existingMessageCount}`);
        if (agentMessages.length > 0) {
            if (turnUsage.cumulative) {
                lastAssistant = [...agentMessages].reverse().find(m => m.role === 'assistant');
                if (lastAssistant) {
                    if (turnUsage.lastCallModel) {
                        lastAssistant.model = turnUsage.lastCallModel;
                    }
                    if (turnUsage.lastCallProviderId) {
                        lastAssistant.providerId = turnUsage.lastCallProviderId;
                    }
                    log(`[Agent-Process] Attributed last assistant message: id=${lastAssistant.id}, lastCallInput=${turnUsage.lastCall?.input_tokens ?? 'n/a'}, model=${turnUsage.lastCallModel || 'n/a'}`);
                }
                else {
                    warn('[Agent-Process] No assistant message found to attribute');
                }
            }
            else {
                warn('[Agent-Process] No tokenUsage received during stream');
            }
            try {
                if (turnUsage.cumulative) {
                    const turnTokens = turnUsage.cumulative.total_tokens ??
                        (turnUsage.cumulative.input_tokens + turnUsage.cumulative.output_tokens);
                    if (turnTokens > 0) {
                        await goalDb.updateBudget(msg.sessionId, { tokensUsedDelta: turnTokens });
                        log(`[Agent-Process] Persisted token budget delta: +${turnTokens} for session ${msg.sessionId}`);
                    }
                }
                const stats = agent.getContextStats();
                if (stats.totalTokens >= stats.maxTokens) {
                    await goalDb.setStatus(msg.sessionId, 'usage_limited');
                    log(`[Agent-Process] Session ${msg.sessionId} marked usage_limited (context exhausted: ${stats.totalTokens}/${stats.maxTokens})`);
                }
                else {
                    await goalDb.setStatus(msg.sessionId, 'active');
                }
            }
            catch (err) {
                warn('[Agent-Process] Failed to persist token budget delta:', err);
            }
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
                                await storeParsedDocumentAttachment(userMsgId, msg.sessionId, definedProperties({
                                    filename: att.name,
                                    filePath: att.path || att.url || '',
                                    charCount: att.text.length,
                                    text: att.text,
                                    extractMethod: att.extractMethod,
                                    imageChunks: att.imageChunks,
                                }));
                            }
                            catch (storeErr) {
                                warn('[Agent-Process] Failed to store parsed document:', storeErr);
                            }
                        }
                    }
                }
            }
            await persistTurnReview(msg.sessionId, msg.id, turnReviewBaseline);
            existingMessageCount = agentMessages.length;
            log(`[Agent-Process] Updated existingMessageCount to ${existingMessageCount}`);
        }
        else {
            warn(`[Agent-Process] No messages to save for session ${msg.sessionId}`);
            await persistTurnReview(msg.sessionId, msg.id, turnReviewBaseline);
        }
        await agent.journal?.flush();
        sendToMain({
            type: 'chat:db_persisted',
            sessionId: msg.sessionId,
            success: true,
            messageCount: agentMessages.length,
        });
        if (turnDone.latched) {
            const finalized = buildMessageFinalizedEvent(msg.sessionId, lastAssistant, turnDone.reason);
            for (const frame of turnDone.release(msg.sessionId, finalized as unknown as Record<string, unknown> | null)) {
                sendToMain(frame);
            }
        }
        const hasGeneratedTitle = titleGeneratedBySession.has(msg.sessionId);
        const userMessageCount = agentMessages.filter((m: Message) => m.role === 'user').length;
        const assistantMessageCount = agentMessages.filter((m: Message) => m.role === 'assistant').length;
        const isBotPipeline = msg.sessionId.startsWith('bot:')
            || isBotAgentProfile(agent.getLastAppliedAgentProfile());
        const shouldGenerate = !isBotPipeline
            && !hasGeneratedTitle
            && userMessageCount >= 1
            && userMessageCount <= 3
            && assistantMessageCount >= 1;
        log(`[Agent-Process] Title generation check: hasGenerated=${hasGeneratedTitle}, userMsg=${userMessageCount}, assistantMsg=${assistantMessageCount}, shouldGenerate=${shouldGenerate}`);
        log(`[Agent-Process] Title generation config: ${titleGenerationModelConfig ? JSON.stringify({ provider: titleGenerationModelConfig.provider, model: titleGenerationModelConfig.model }) : 'null'}`);
        log(`[Agent-Process] Agent LLM client available: ${!!agent.readModelClient()}`);
        if (agent.readModelClient()) {
            log(`[Agent-Process] Agent LLM config: provider=${agent.readWorkerProviderConfig().provider}, model=${agent.readWorkerProviderConfig().model}, baseURL=${agent.readWorkerProviderConfig().baseURL}`);
        }
        log(`[Agent-Process] Title generation model config: ${titleGenerationModelConfig
            ? JSON.stringify({
                provider: titleGenerationModelConfig.provider,
                baseURL: titleGenerationModelConfig.baseURL,
                model: titleGenerationModelConfig.model,
                hasApiKey: Boolean(titleGenerationModelConfig.apiKey),
            })
            : 'null'}`);
        if (shouldGenerate) {
            void (async () => {
                try {
                    let titleLLMClient = agent.readModelClient();
                    if (titleGenerationModelConfig) {
                        const isMiniMaxEndpoint = titleGenerationModelConfig.baseURL?.includes('minimax');
                        if (isMiniMaxEndpoint) {
                            log(`[Agent-Process] Title model is MiniMax endpoint, using agent LLM client (has correct X-Api-Key auth)`);
                            titleLLMClient = agent.readModelClient();
                        }
                        else {
                            try {
                                const { createAIClient } = await import('@duya/ai');
                                const { findModelCompat } = await import('@duya/ai');
                                const titleApiFormat = (titleGenerationModelConfig.apiFormat
                                    ?? (titleGenerationModelConfig.provider === 'anthropic' ? 'anthropic' : 'openai-chat')) as ApiFormat;
                                const titleModelCompat = titleGenerationModelConfig.modelCompat
                                    ?? findModelCompat(titleApiFormat, titleGenerationModelConfig.model);
                                titleLLMClient = createAIClient({
                                    apiKey: titleGenerationModelConfig.apiKey,
                                    baseURL: titleGenerationModelConfig.baseURL,
                                    model: titleGenerationModelConfig.model,
                                    apiFormat: titleApiFormat,
                                    providerId: titleGenerationModelConfig.provider,
                                    ...definedProperties({ modelCapabilities: titleModelCompat })
                                });
                                log(`[Agent-Process] Using custom title model: ${titleGenerationModelConfig.model}`);
                            }
                            catch (createErr) {
                                warn('[Agent-Process] Failed to create title model client, falling back to agent LLM:', createErr);
                                titleLLMClient = agent.readModelClient();
                            }
                        }
                    }
                    log(`[Agent-Process] Title LLM client ready: provider=${titleLLMClient ? 'yes' : 'no'}`);
                    log('[Agent-Process] Calling generateSessionTitle...');
                    log(`[Agent-Process] Messages to pass: count=${agentMessages.length}, firstRole=${agentMessages[0]?.role}, firstContentType=${typeof agentMessages[0]?.content}`);
                    const result = await generateSessionTitle(agentMessages, titleLLMClient, undefined, msg.sessionId);
                    log(`[Agent-Process] generateSessionTitle returned: title="${result.title}"`);
                    if (result.title) {
                        titleGeneratedBySession.set(msg.sessionId, result.title);
                        try {
                            await sessionDb.update(msg.sessionId, { title: result.title });
                        }
                        catch (dbErr) {
                            warn('[Agent-Process] Failed to persist title to DB:', dbErr instanceof Error ? dbErr.message : String(dbErr));
                        }
                        sendToMain({ type: 'chat:title_generated', sessionId: msg.sessionId, title: result.title });
                        log(`[Agent-Process] Title generated and sent: "${result.title}"`);
                    }
                    else {
                        log('[Agent-Process] Title generation returned null, not sending');
                    }
                }
                catch (titleErr) {
                    log('[Agent-Process] Title generation error:', titleErr);
                }
            })();
        }
        // End-of-turn suggestion: predict the next prompt the user would type.
        // It runs on the agent's own model client and never blocks the turn —
        // the row lands after the turn ended, and every surface reads it back
        // through the Host.
        const shouldSuggest = !isBotPipeline && assistantMessageCount >= 1;
        if (shouldSuggest) {
            void (async () => {
                try {
                    await persistTurnSuggestion(msg.sessionId, msg.id, agentMessages, agent.readModelClient());
                }
                catch (suggestionErr) {
                    warn('[Agent-Process] Turn suggestion failed:', suggestionErr instanceof Error ? suggestionErr.message : String(suggestionErr));
                }
            })();
        }
    }
    catch (err) {
        log('[Agent-Process] Chat error:', err);
        const errMsg = err instanceof Error ? err.message : String(err);
        const errType = classifyError(err);
        let code: string | undefined;
        if (errType === APIErrorType.RATE_LIMIT) {
            code = 'rate_limit_error';
        }
        else if (errType === APIErrorType.USAGE_LIMIT) {
            code = 'usage_limit_exceeded';
        }
        else if (errType === APIErrorType.PROVIDER_SAFETY_FILTER) {
            code = 'provider_safety_filter';
        }
        sendToMain({
            type: 'chat:error',
            sessionId: msg.sessionId,
            message: errMsg,
            code,
        });
        try {
            const hookMessages = agent.drainPendingHookMessages();
            if (hookMessages.length > 0) {
                await appendMessages(msg.sessionId, hookMessages);
                log(`[Agent-Process] Persisted ${hookMessages.length} hook message(s) on error path`);
            }
        }
        catch (hookErr) {
            warn('[Agent-Process] Failed to persist hook messages on error path:', hookErr instanceof Error ? hookErr : new Error(String(hookErr)));
        }
        await persistTurnReview(msg.sessionId, msg.id, turnReviewBaseline);
        sendToMain({ type: 'chat:done', sessionId: msg.sessionId });
    }
    finally {
        stopChatHeartbeat();
        permissionScopes.delete(msg.sessionId);
        turnPipelines.close();
    }
}
async function drainQueuedChatStart(): Promise<void> {
    if (chatInProgress)
        return;
    const next = dequeue<ChatStartMessage>((cmd: QueuedCommand<ChatStartMessage>) => cmd.agentId === undefined && cmd.mode === 'prompt');
    if (!next)
        return;
    log('[Agent-Process] Draining queued chat:start from priority queue');
    chatInProgress = true;
    try {
        await handleChatStart(next.rawMessage);
    }
    finally {
        chatInProgress = false;
        if (hasCommandsInQueue()) {
            setImmediate(() => { void drainQueuedChatStart(); });
        }
    }
}
const log = (message: unknown, ...details: unknown[]): void => { logger.info(String(message), { details }, 'AgentProcess'); };
const warn = (message: unknown, ...details: unknown[]): void => { logger.warn(String(message), { details }, 'AgentProcess'); };
async function discoverPluginSkillPaths(): Promise<string[]> {
    const paths: string[] = [];
    try {
        const installed = await pluginDb.registryList() as Array<{
            id?: unknown;
            enabled?: unknown;
            installPath?: unknown;
        }>;
        const enabledPlugins = installed.filter((item) => item.enabled === true && typeof item.id === 'string' && typeof item.installPath === 'string');
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
    }
    catch (err) {
        warn('[Agent-Process] Failed to discover plugin skill paths:', err);
    }
    return paths;
}
async function reloadSkills(): Promise<void> {
    try {
        const registry = getSkillRegistry();
        const allSkills = registry.list();
        for (const skill of allSkills) {
            if (skill.source !== 'bundled' && skill.source !== 'system') {
                registry.unregister(skill.name);
            }
        }
        await loadAgentSkills(agent?.readWorkingDirectory(), [], currentSecurityScanEnabled);
        sendToMain({ type: 'skills:reloaded', count: registry.list().length });
    }
    catch (err) {
        warn('[Agent-Process] Failed to reload skills:', err);
        sendToMain({ type: 'skills:reload:error', error: err instanceof Error ? err.message : String(err) });
    }
}
function buildMcpReloadedEvent(result: MCPApplyResult): Record<string, unknown> {
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
function collectMcpStatusByServer(manager: ReturnType<NonNullable<typeof agent>['getActiveMCPManager']>): Record<string, {
    connectionStatus: 'connected' | 'disconnected' | 'connecting' | 'error' | 'degraded';
    toolCount: number;
    tools: Array<{
        name: string;
        description: string;
        annotations: Record<string, unknown> | undefined;
    }>;
    ledger?: {
        discoveryStatus: 'complete' | 'refreshing' | 'failed' | 'stale';
        pagesFetched: number;
        discoveredTotal: number;
        inventoryRevision: number;
        layers: {
            discovered: number;
            descriptors: number;
            aliases: number;
            registered: number;
            discoverable: number;
        };
        fetchedAt: number;
    };
}> {
    if (!manager)
        return {};
    const out: Record<string, {
        connectionStatus: 'connected' | 'disconnected' | 'connecting' | 'error' | 'degraded';
        toolCount: number;
        tools: Array<{
            name: string;
            description: string;
            annotations: Record<string, unknown> | undefined;
        }>;
        ledger?: {
            discoveryStatus: 'complete' | 'refreshing' | 'failed' | 'stale';
            pagesFetched: number;
            discoveredTotal: number;
            inventoryRevision: number;
            layers: {
                discovered: number;
                descriptors: number;
                aliases: number;
                registered: number;
                discoverable: number;
            };
            fetchedAt: number;
        };
    }> = {};
    for (const client of manager.getAllClients()) {
        const status = client.getStatus();
        const tools = client.getTools();
        out[client.getName()] = {
            connectionStatus: status,
            toolCount: tools.length,
            tools: tools.map((t: {
                name: string;
                description: string;
                annotations?: Record<string, unknown>;
            }) => ({
                name: t.name,
                description: t.description,
                annotations: t.annotations,
            })),
            ledger: client.getLedgerSnapshot(),
        };
    }
    return out;
}
async function reloadMCP(): Promise<void> {
    if (!agent)
        return;
    try {
        const result = await applyMCPConfiguration({
            agent,
            reason: 'manual',
            ...definedProperties({ agentProfileId: agent.getActiveAgentProfileId() })
        });
        log(`[Agent-Process] Reloaded MCP: ${result.action.clientsConnected} connected, ` +
            `${result.action.toolsAdded} tools added, ${result.action.toolsRemoved} removed ` +
            `(${result.loadResult.inventory.length} inventory rows, ${result.loadResult.issues.length} issues)`);
        for (const issue of result.loadResult.issues) {
            log(`[Agent-Process] MCP issue [${issue.phase}] ${issue.serverName ?? '(unknown)'}: ${issue.humanMessage}` +
                (issue.suggestedAction ? ` (action: ${issue.suggestedAction})` : ''));
        }
        sendToMain(buildMcpReloadedEvent(result));
        await reloadAppConnectionTools();
    }
    catch (err) {
        warn('[Agent-Process] Failed to reload MCP:', err);
        sendToMain({ type: 'mcp:reload:error', error: err instanceof Error ? err.message : String(err) });
    }
}

/**
 * Start the MCP handshake for the session's agent.
 *
 * WHY IT IS STARTED BEFORE THE QUEUED CHAT START IS DRAINED
 *
 * `handleChatStart` waits for MCP to be ready before it may ask the model
 * anything (`waitForMcpReady`). When the handshake started AFTER that wait,
 * the wait had nothing to wait for: it sat out its whole timeout and the turn
 * began without MCP tools, while the handshake was still running in the
 * background. The worker's own log said so on every turn:
 *
 *   [Agent] MCP ready timeout after 3000ms; proceeding without MCP tools
 *
 * Starting the handshake first makes the wait mean something: it either
 * returns as soon as the servers are connected (and the turn gets their
 * tools) or it times out on a handshake that was genuinely still running.
 *
 * The handshake is fire-and-forget: the caller does not wait for it.
 */
function startMcpInitialization(): void {
    void (async () => {
        let sessionForMcp: ReturnType<typeof requireWorkerSession> | null = null;
        try {
            sessionForMcp = requireWorkerSession();
        }
        catch (err) {
            warn('[Agent-Process] Cannot initialize MCP servers: no agent', err);
            return;
        }
        try {
            sessionForMcp.setActiveAgentProfileId(undefined);
            log('[Agent-Process] Initializing MCP servers (applyMCPConfiguration)...');
            const result = await applyMCPConfiguration({
                agent: sessionForMcp,
                reason: 'initialization',
            });
            mcpHandshakeFailed = false;
            log(`[Agent-Process] Initialized MCP servers: ${result.action.clientsConnected} connected, ` +
                `${result.action.toolsAdded} tools, ${result.action.toolsRemoved} removed ` +
                `(${result.loadResult.inventory.length} inventory rows, ${result.loadResult.issues.length} issues)`);
            for (const issue of result.loadResult.issues) {
                log(`[Agent-Process] MCP issue [${issue.phase}] ${issue.serverName ?? '(unknown)'}: ${issue.humanMessage}` +
                    (issue.suggestedAction ? ` (action: ${issue.suggestedAction})` : ''));
            }
        }
        catch (mcpErr) {
            mcpHandshakeFailed = true;
            warn('[Agent-Process] Failed to initialize MCP servers after ready:', mcpErr);
        }
        finally {
            sessionForMcp.notifyMcpReady();
        }
    })();
}
function buildSelfInitMessage(msg: ChatStartMessage): InitMessage | null {
    const result = createWorkerSelfInitMessage(msg);
    if (!result.ok) {
        sendToMain({
            type: 'chat:error',
            message: result.message,
            sessionId: msg.sessionId,
        });
        return null;
    }
    return result.message;
}
async function handleCommand(msg: WorkerCommand): Promise<void> {
    const msgType = msg.type as string;
    if (msgType !== 'db:response') {
        log('[Agent-Process] Received command:', msgType, 'sessionId:', (msg as Record<string, unknown>).sessionId);
    }
    if (msgType === 'chat:start' && !agent && !chatInProgress) {
        const selfInit = buildSelfInitMessage(msg as ChatStartMessage);
        if (selfInit !== null) {
            log('[Agent-Process] No init received; self-initializing from config.toml');
            await handleCommand(selfInit);
            if (agent !== null) {
                // Use the normal non-blocking admission path so stdin can
                // continue delivering approval and interrupt commands.
                await handleCommand(msg);
            }
            else {
                sendToMain({
                    type: 'chat:error',
                    message: 'worker self-initialization from config.toml failed; see worker logs',
                    sessionId: (msg as ChatStartMessage).sessionId,
                });
            }
            return;
        }
    }
    switch (msgType) {
        case 'init': {
            const initMsg = msg as unknown as InitMessage;
            log('[Agent-Process] Received init for session:', initMsg.sessionId);
            if (chatInProgress) {
                log('[Agent-Process] Rejecting init: chat in progress, cannot reinit now');
                sendToMain({ type: 'ready', sessionId: initMsg.sessionId, status: 'deferred', reason: 'chat_in_progress' });
                break;
            }
            const previousSessionId = sessionId;
            sessionId = initMsg.sessionId;
            // The agent server sends an `init` on EVERY turn. When the payload
            // asks for the agent this worker is already running in, rebuilding
            // it costs the tool catalog, the skill scan, the whole transcript
            // read back out of the database, and a fresh MCP handshake -- and
            // the handshake is what the turn waits for before it may ask the
            // model anything. So the agent is kept when nothing about it
            // changed.
            if (
                agent !== null
                && previousSessionId === sessionId
                && !mcpHandshakeFailed
                && canReuseAgentForInit(currentInitShape, initMsg)
            ) {
                log('[Agent-Process] Re-init skipped: the agent configuration is unchanged');
                sendToMain({ type: 'ready', sessionId });
                // A chat:start that arrived while this init was in flight is
                // still queued, and the skip must not strand it.
                void drainQueuedChatStart();
                break;
            }
            existingMessageCount = 0;
            if (previousSessionId !== sessionId) {
                compactedPending = false;
                liveTotalInput = 0;
                liveTotalInputRaw = 0;
                liveTotalOutput = 0;
                liveTotalCacheHit = 0;
                liveTotalCacheCreation = 0;
                lastEmittedUsageKey = null;
            }
            if (agent) {
                log('[Agent-Process] Re-init: destroying existing agent and creating new one', {
                    changed: workerInitDifferences(currentInitShape, initMsg),
                });
                try {
                    agent.interrupt();
                }
                catch (err) {
                    warn('[Agent-Process] Error destroying old agent:', err);
                }
                agent = null;
            }
            if (initializing) {
                log('[Agent-Process] Init in progress, waiting...');
                const INIT_POLL_TIMEOUT_MS = 30000;
                const initPollStartTime = Date.now();
                const waitForInit = setInterval(() => {
                    if (!initializing) {
                        clearInterval(waitForInit);
                        sendToMain({ type: 'ready', sessionId });
                    }
                    else if (Date.now() - initPollStartTime >= INIT_POLL_TIMEOUT_MS) {
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
                await initAgent(initMsg.providerConfig, initMsg.workingDirectory, initMsg.defaultWorkspaceDirectory, initMsg.systemPrompt, initMsg.language, initMsg.sandboxEnabled, initMsg.communicationPlatform, initMsg.permissionRules, initMsg.currentProjectId, initMsg.projectHome);
                const restoredSession = requireWorkerSession();
                let restoreOk = false;
                try {
                    currentSecurityScanEnabled = initMsg.securityScanEnabled !== false;
                    const [_, __, history] = await Promise.all([
                        restoredSession.initToolCatalog(),
                        loadAgentSkills(initMsg.workingDirectory, initMsg.skillPaths, initMsg.securityScanEnabled),
                        hydrateWorkerSessionHistory(sessionId!, {
                            load: async (id) => await messageDb.loadMessages(id) as {
                                messages: MessageRow[];
                                parsedDocuments?: ParsedDocumentAttachment[];
                            },
                            loadAttachments: async (id) => attachmentDb.getImagesForSession(id),
                            toMessage: (row, attachments, parsedDocuments) => messageRowToMessage(row, attachments, parsedDocuments),
                            validate: validateMessageHistory,
                            messageId: (message) => message.id,
                            replace: async (id, messages, generation) => await messageDb.replace(id, [...messages], generation) as {
                                success?: boolean;
                                reason?: string;
                            },
                            checkpointIdSuffix: COMPACTION_CHECKPOINT_ID_SUFFIX,
                        }),
                    ]);
                    debugLog('loaded history rows', { sessionId, rows: history.rowCount });
                    if (history.rowCount > 0) {
                        if (history.repairAttempted) {
                            if (history.repairResult?.success) {
                                log(`[Agent-Process] Repaired persisted message history for session ${sessionId}`);
                            }
                            else {
                                warn(`[Agent-Process] Could not persist repaired message history for session ${sessionId}: ${history.repairResult?.reason ?? 'unknown error'}`);
                            }
                        }
                        const existingMessages = history.messages;
                        restoredSession.setMessages(existingMessages);
                        existingMessageCount = existingMessages.length;
                        log(`[Agent-Process] Loaded ${existingMessages.length} messages from DB for session ${sessionId}`);
                        debugLog('loaded message roles', existingMessages.map(m => ({ role: m.role, type: m.msg_type || (Array.isArray(m.content) ? m.content.map((c: {
                                type: string;
                            }) => c.type).join(',') : 'string') })));
                        try {
                            const existingGoal = await goalDb.get(sessionId!) as Record<string, unknown> | undefined;
                            if (!existingGoal) {
                                const { randomUUID } = await import('node:crypto');
                                await goalDb.create({
                                    id: randomUUID(),
                                    session_id: sessionId!,
                                });
                                log(`[Agent-Process] Created new session_goals row for ${sessionId}`);
                            }
                            else {
                                log(`[Agent-Process] Restored session_goals for ${sessionId}: tokens_used=${existingGoal.tokens_used}, status=${existingGoal.status}`);
                            }
                        }
                        catch (err) {
                            warn('[Agent-Process] Failed to restore/create session goal:', err);
                        }
                    }
                    else {
                        log(`[Agent-Process] No existing messages found in DB for session ${sessionId}`);
                        try {
                            const existingGoal = await goalDb.get(sessionId!) as Record<string, unknown> | undefined;
                            if (existingGoal) {
                                log(`[Agent-Process] Restored session_goals for ${sessionId}: tokens_used=${existingGoal.tokens_used}, status=${existingGoal.status}`);
                            }
                            else {
                                const { randomUUID } = await import('node:crypto');
                                await goalDb.create({
                                    id: randomUUID(),
                                    session_id: sessionId!,
                                });
                                log(`[Agent-Process] Created new session_goals row for ${sessionId} (new session)`);
                            }
                        }
                        catch (err) {
                            warn('[Agent-Process] Failed to restore/create session goal:', err);
                        }
                    }
                    restoreOk = true;
                }
                catch (err) {
                    warn('[Agent-Process] Failed to load messages from DB:', err);
                }
                // The agent exists, was configured from THIS payload, and its
                // history was restored. A later init that asks for the same
                // agent may therefore keep it. It is set HERE rather than
                // right after `initAgent` so that a failed history restore
                // still leaves the next turn rebuilding -- that failure is
                // recoverable, and a rebuild is how it recovers.
                if (restoreOk) currentInitShape = initMsg;
            }
            catch (err) {
                initError = err instanceof Error ? err.message : String(err);
                warn('[Agent-Process] Agent initialization failed:', err);
            }
            finally {
                initializing = false;
                // The MCP handshake has to START before the queued chat start
                // is drained. `handleChatStart` waits for MCP to be ready
                // before it may ask the model anything, so a drain that runs
                // first waits out its whole timeout for a handshake that had
                // not started yet.
                startMcpInitialization();
                await drainQueuedChatStart();
            }
            sendToMain({
                type: 'ready',
                sessionId,
                ...(initError ? { status: 'error', error: initError } : {}),
            });
            if (pendingCompactCommand) {
                const pending = pendingCompactCommand;
                pendingCompactCommand = null;
                if (initError) {
                    sendToMain({
                        type: 'compact:error',
                        sessionId,
                        message: `Worker initialization failed: ${initError}; please retry the chat session to recover.`,
                        reason: 'init-failed',
                    });
                }
                else {
                    log('[Agent-Process] Replaying pending compact after init');
                    handleCompactMessage(pending).catch((err) => {
                        warn('[Agent-Process] Deferred compact failed:', err);
                    });
                }
            }
            if (!initError) {
                void reloadAppConnectionTools();
            }
            if (!initError) {
                void import('@duya/memory/wakeup').then(({ sendMemoryWakeup }) => {
                    try {
                        sendMemoryWakeup((event) => sendToMain(event as unknown as Record<string, unknown>), {
                            ...definedProperties({ sessionId: sessionId ?? undefined }),
                            onError: (err) => logger.warn('memory:wakeup send failed (shadow mode tolerates this)', {
                                error: err instanceof Error ? err.message : String(err),
                            })
                        });
                    }
                    catch (wakeupErr) {
                        log('[Agent-Process] sendMemoryWakeup failed (ignored):', wakeupErr);
                    }
                }).catch((importErr) => {
                    log('[Agent-Process] Lazy memory-rollout import failed (ignored):', importErr);
                });
            }
            // The MCP handshake is started by `startMcpInitialization()` above,
            // BEFORE the queued chat start is drained -- the turn waits for it.
            break;
        }
        case 'plugin-app:describe-tools': {
            const command = msg as unknown as import('@duya/agent-protocol/worker-protocol').PluginAppDescribeToolsCommand;
            if (command.sessionId !== sessionId || typeof command.runId !== 'string' ||
                !Number.isSafeInteger(command.epoch) || typeof command.requestId !== 'string') break;
            try {
                const tools = requireWorkerSession().describePluginAppMcpTools(command.runId);
                sendToMain({
                    type: 'plugin-app:tools', sessionId: command.sessionId, runId: command.runId,
                    epoch: command.epoch, requestId: command.requestId, tools,
                });
            } catch (error) {
                log(`[Agent-Process] Plugin App tool catalog unavailable: ${error instanceof Error ? error.message : String(error)}`);
                sendToMain({
                    type: 'plugin-app:tools', sessionId: command.sessionId, runId: command.runId,
                    epoch: command.epoch, requestId: command.requestId, tools: [],
                });
            }
            break;
        }
        case 'plugin-app:invoke': {
            const command = msg as unknown as import('@duya/agent-protocol/worker-protocol').PluginAppInvokeCommand;
            if (command.sessionId !== sessionId || typeof command.runId !== 'string' ||
                !Number.isSafeInteger(command.epoch) || typeof command.requestId !== 'string' ||
                typeof command.bindingId !== 'string' || typeof command.nonce !== 'string' ||
                typeof command.toolId !== 'string' || typeof command.schemaRevision !== 'string' ||
                typeof command.capabilityId !== 'string' || command.arguments === null ||
                typeof command.arguments !== 'object' || Array.isArray(command.arguments)) break;
            const result = await withWorkerDbRunContext({ sessionId: command.sessionId, runId: command.runId, epoch: command.epoch }, () =>
              requireWorkerSession().invokePluginAppMcpTool({
                runId: command.runId,
                toolId: command.toolId,
                schemaRevision: command.schemaRevision,
                arguments: command.arguments,
                isBindingCurrent: () => pluginAppBindingDb.isCurrent(command.bindingId, command.nonce, command.toolId),
              }));
            sendToMain({
                type: 'plugin-app:result', sessionId: command.sessionId, runId: command.runId,
                epoch: command.epoch, requestId: command.requestId, result,
            });
            break;
        }
        case 'plugin-app:read-resource': {
            const command = msg as unknown as import('@duya/agent-protocol/worker-protocol').PluginAppReadResourceCommand;
            if (command.sessionId !== sessionId || typeof command.requestId !== 'string' ||
                typeof command.pluginId !== 'string' || typeof command.server !== 'string' ||
                typeof command.resourceUri !== 'string' || !command.resourceUri.startsWith('ui://')) break;
            try {
                const result = await requireWorkerSession().readPluginUiSurfaceResource({
                    pluginId: command.pluginId,
                    server: command.server,
                    resourceUri: command.resourceUri,
                });
                sendToMain({
                    type: 'plugin-app:resource', sessionId: command.sessionId,
                    requestId: command.requestId, result,
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                sendToMain({
                    type: 'plugin-app:resource', sessionId: command.sessionId,
                    requestId: command.requestId,
                    error: message.startsWith('plugin_app_') ? message : 'plugin_app_resource_read_failed',
                });
            }
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
                    rawMessage: chatMsg,
                });
                break;
            }
            chatInProgress = true;
            handleChatStart(chatMsg).catch((err) => {
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
            const pMode = (msg as {
                mode?: string;
            }).mode;
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
                if (agent && agent.interrupt) {
                    agent.interrupt();
                }
                lastInterruptTime = now;
                break;
            }
            if (hasCommandsInQueue() && (now - lastInterruptTime < DOUBLE_INTERRUPT_WINDOW_MS || !chatInProgress)) {
                log('[Agent-Process] Double interrupt: clearing command queue');
                clearCommandQueue();
                lastInterruptTime = 0;
            }
            else if (hasCommandsInQueue()) {
                const popped = dequeue<ChatStartMessage>((cmd: QueuedCommand<ChatStartMessage>) => cmd.agentId === undefined);
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
            void handleCompactMessage(msg);
            break;
        }
        case 'side:question': {
            const sideMsg = msg as unknown as import('@duya/host/worker-transport').SideQuestionCommand;
            log('[Agent-Process] Received side:question for session:', sideMsg.sessionId);
            if (!agent) {
                sendToMain({
                    type: 'side:answer',
                    sessionId: sideMsg.sessionId,
                    id: sideMsg.id,
                    answer: '',
                    error: 'Agent not initialized',
                } satisfies import('@duya/host/worker-transport').SideQuestionResponse);
                break;
            }
            try {
                const answer = await agent.sideQuestion(sideMsg.question);
                sendToMain({
                    type: 'side:answer',
                    sessionId: sideMsg.sessionId,
                    id: sideMsg.id,
                    answer,
                } satisfies import('@duya/host/worker-transport').SideQuestionResponse);
            }
            catch (err) {
                warn('[Agent-Process] side:question failed:', err);
                sendToMain({
                    type: 'side:answer',
                    sessionId: sideMsg.sessionId,
                    id: sideMsg.id,
                    answer: '',
                    error: err instanceof Error ? err.message : String(err),
                } satisfies import('@duya/host/worker-transport').SideQuestionResponse);
            }
            break;
        }
        case 'reload:skills': {
            log('[Agent-Process] Received reload:skills');
            void reloadSkills();
            break;
        }
        case 'appConnection:reload': {
            log('[Agent-Process] Received appConnection:reload');
            await reloadAppConnectionTools();
            break;
        }
        case 'reload:mcp': {
            log('[Agent-Process] Received reload:mcp');
            void reloadMCP();
            break;
        }
        case 'mcp:status:get': {
            sendToMain(buildMcpStatusSnapshot());
            break;
        }
        case 'workflow:run': {
            const wf = msg as unknown as WorkflowRunCommand;
            log('[Agent-Process] Received workflow:run', { sessionId, runId: wf.runId, workflowName: wf.workflowName });
            if (!agent) {
                sendToMain(buildWorkflowRunEvent(wf.sessionId, 'error', {
                    runId: wf.runId ?? 'unstarted',
                    workflowName: wf.workflowName ?? 'unknown',
                    status: 'failed',
                    startedAt: Date.now(),
                    finishedAt: Date.now(),
                    error: 'agent worker not initialized (no init command received)',
                    stoppedReason: 'not_initialized',
                }) as unknown as Record<string, unknown>);
                break;
            }
            const workflowLlm = agent.readWorkerProviderConfig();
            void launchSavedWorkflow({
                sessionId: wf.sessionId,
                emit: sendToMain as (msg: unknown) => void,
                requestPermission: createPermissionHandler(wf.sessionId),
                takePendingAnswer,
                llm: workflowLlm,
                workingDirectory: wf.projectDir || agent.readWorkingDirectory() || process.cwd(),
                execution: { createPorts: (workingDirectory) => processAssembly.createWorkflowExecutionPorts({ sessionId: wf.sessionId, llm: workflowLlm, workingDirectory }) },
            }, {
                runId: wf.runId,
                workflowName: wf.workflowName,
                ...(wf.params !== undefined ? { params: wf.params } : {}),
                ...(wf.projectDir !== undefined ? { projectDir: wf.projectDir } : {}),
                ...(wf.resumeFromRunId !== undefined ? { resumeFromRunId: wf.resumeFromRunId } : {}),
            }).catch((err) => {
                warn('[Agent-Process] workflow:run failed:', err);
                sendToMain(buildWorkflowRunEvent(wf.sessionId, 'error', {
                    runId: wf.runId ?? 'unstarted',
                    workflowName: wf.workflowName ?? 'unknown',
                    status: 'failed',
                    startedAt: Date.now(),
                    finishedAt: Date.now(),
                    error: err instanceof Error ? err.message : String(err),
                    stoppedReason: 'unknown',
                }) as unknown as Record<string, unknown>);
            });
            break;
        }
        case 'permission:resolve': {
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
            if (updatedInput?.answers) {
                storePendingAnswer(id, updatedInput.answers as Record<string, string>);
            }
            const key = pendingPermissionKey(resolveSessionId, id);
            const pending = pendingPermissions.get(key);
            if (pending) {
                clearTimeout(pending.timeoutHandle);
                pendingPermissions.delete(key);
                if (decision === 'allow' || decision === 'allow_once' || decision === 'allow_for_session') {
                    if (decision === 'allow_for_session' && pending.toolName) {
                        const scope = permissionScopes.get(resolveSessionId) ?? {
                            scopeType: 'session' as const,
                            scopeId: resolveSessionId,
                        };
                        try {
                            const written = (await toolApprovalDb.upsertRule({
                                scopeType: scope.scopeType,
                                scopeId: scope.scopeId,
                                toolName: pending.toolName,
                            })) as {
                                ok?: boolean;
                            } | undefined;
                            if (written?.ok === false) {
                                warn('[Agent-Process] session grant could not be persisted; scope stays one-shot', {
                                    sessionId: resolveSessionId,
                                    toolName: pending.toolName,
                                });
                            }
                        }
                        catch (err) {
                            warn('[Agent-Process] session grant write failed; scope stays one-shot', {
                                sessionId: resolveSessionId,
                                toolName: pending.toolName,
                                error: err instanceof Error ? err.message : String(err),
                            });
                        }
                        const connectorDescriptor = (await getAppConnection()).getCachedAppConnectionDescriptors().find((d: any) => d.name === pending.toolName);
                        if (connectorDescriptor) {
                            (await import('./authorization/connector-approval-cache.js')).rememberSessionApproval(pending.toolName);
                        }
                    }
                    pending.resolve('allow');
                }
                else {
                    pending.resolve('deny');
                }
            }
            else {
                log('[Agent-Process] No pending permission for resolved id (likely already resolved or expired):', resolveSessionId, id);
            }
            break;
        }
        case 'subagent:kill': {
            const killMsg = msg as unknown as {
                type: 'subagent:kill';
                taskId?: string;
                sessionId?: string;
                reason?: string;
            };
            if (typeof killMsg.taskId !== 'string' || !killMsg.taskId.trim()) {
                warn('[Agent-Process] subagent:kill missing taskId, ignoring:', killMsg.sessionId);
                break;
            }
            try {
                const outcome = backgroundAgentLifecycle.tryKill(killMsg.taskId, 'user_kill');
                log('[Agent-Process] subagent:kill', killMsg.taskId, '->', outcome);
            }
            catch (err) {
                warn('[Agent-Process] subagent:kill threw (ignored):', killMsg.taskId, err);
            }
            break;
        }
        case 'interagent:event': {
            const eventMsg = msg as unknown as {
                type: 'interagent:event';
                id: string;
                event: import('@duya/host/worker-transport').WorkerEvent;
            };
            const call = getPendingInteragentCall(eventMsg.id);
            if (!call) {
                break;
            }
            call.events.push(eventMsg.event);
            if (eventMsg.event.type === 'chat:done') {
                call.resolveDone(eventMsg.event);
            }
            else if (eventMsg.event.type === 'chat:error') {
                call.resolveError(eventMsg.event);
            }
            break;
        }
        case 'db:response': {
            break;
        }
        case 'appConnection:invoke:response': {
            const { requestId, success, data, error } = msg as unknown as {
                requestId: string;
                success: boolean;
                data?: unknown;
                error?: {
                    code: string;
                    message: string;
                };
            };
            const pending = pendingIpcRequests.get(requestId);
            if (pending) {
                if (pending.timeoutHandle) {
                    clearTimeout(pending.timeoutHandle);
                }
                pendingIpcRequests.delete(requestId);
                if (success) {
                    pending.resolve({ success: true, data });
                }
                else {
                    pending.resolve({ success: false, error: error || { code: 'UNKNOWN', message: 'Unknown error' } });
                }
            }
            else {
                warn('[Agent-Process] No pending appConnection IPC request found for requestId:', requestId);
            }
            break;
        }
        case 'appConnection:listDescriptors:response': {
            const { requestId, success, descriptors, error } = msg as unknown as {
                requestId: string;
                success: boolean;
                descriptors?: unknown[];
                error?: {
                    code: string;
                    message: string;
                };
            };
            const pending = pendingIpcRequests.get(requestId);
            if (pending) {
                if (pending.timeoutHandle) {
                    clearTimeout(pending.timeoutHandle);
                }
                pendingIpcRequests.delete(requestId);
                if (success) {
                    pending.resolve({ success: true, descriptors });
                }
                else {
                    pending.resolve({ success: false, error: error || { code: 'UNKNOWN', message: 'Unknown error' } });
                }
            }
            else {
                warn('[Agent-Process] No pending appConnection descriptor request found for requestId:', requestId);
            }
            break;
        }
        case 'appConnection:catalog:response': {
            const { requestId, success, data, error } = msg as unknown as {
                requestId: string;
                success: boolean;
                data?: unknown;
                error?: {
                    code: string;
                    message: string;
                };
            };
            const pending = pendingIpcRequests.get(requestId);
            if (pending) {
                if (pending.timeoutHandle) {
                    clearTimeout(pending.timeoutHandle);
                }
                pendingIpcRequests.delete(requestId);
                if (success) {
                    pending.resolve({ success: true, data });
                }
                else {
                    pending.resolve({ success: false, error: error || { code: 'UNKNOWN', message: 'Unknown error' } });
                }
            }
            else {
                warn('[Agent-Process] No pending appConnection catalog request found for requestId:', requestId);
            }
            break;
        }
        case 'memory-tier:rpc:response': {
            const { requestId, success, data, error } = msg as unknown as {
                requestId: string;
                success: boolean;
                data?: unknown;
                error?: {
                    code: string;
                    message: string;
                };
            };
            const pending = pendingIpcRequests.get(requestId);
            if (pending) {
                if (pending.timeoutHandle) {
                    clearTimeout(pending.timeoutHandle);
                }
                pendingIpcRequests.delete(requestId);
                if (success) {
                    pending.resolve({ success: true, data });
                }
                else {
                    pending.resolve({ success: false, error: error || { code: 'UNKNOWN', message: 'Unknown error' } });
                }
            }
            else {
                warn('[Agent-Process] No pending memory-tier IPC request found for requestId:', requestId);
            }
            break;
        }
        case 'bot-identity:rpc:response': {
            const { requestId, success, data, error } = msg as unknown as {
                requestId: string;
                success: boolean;
                data?: unknown;
                error?: {
                    code: string;
                    message: string;
                };
            };
            const pending = pendingIpcRequests.get(requestId);
            if (pending) {
                if (pending.timeoutHandle) {
                    clearTimeout(pending.timeoutHandle);
                }
                pendingIpcRequests.delete(requestId);
                if (success) {
                    pending.resolve({ success: true, data });
                }
                else {
                    pending.resolve({ success: false, error: error || { code: 'UNKNOWN', message: 'Unknown error' } });
                }
            }
            else {
                warn('[Agent-Process] No pending bot-identity IPC request found for requestId:', requestId);
            }
            break;
        }
        default:
            warn('[Agent-Process] Unknown message type:', msgType);
    }
}
async function handleCompactMessage(msg: unknown): Promise<void> {
    log('[Agent-Process] Received compact for session:', sessionId);
    if (!agent && initializing) {
        log('[Agent-Process] Compact received during init, deferring until ready');
        pendingCompactCommand = msg;
        return;
    }
    if (!agent) {
        sendToMain({
            type: 'compact:error',
            sessionId,
            message: 'Worker initialization previously failed; please retry the chat session to recover.',
            reason: 'init-failed',
        });
        return;
    }
    if (chatInProgress || initializing) {
        const compactBusyStart = Date.now();
        const COMPACT_BUSY_WAIT_MS = 5000;
        log('[Agent-Process] Chat in progress, waiting before compact');
        while ((chatInProgress || initializing) && Date.now() - compactBusyStart < COMPACT_BUSY_WAIT_MS) {
            await new Promise((r) => setTimeout(r, 100));
        }
        if (chatInProgress || initializing) {
            sendToMain({
                type: 'compact:error',
                sessionId,
                message: 'Chat turn still in progress after 5s; please retry after the turn completes',
            });
            return;
        }
    }
    chatInProgress = true;
    try {
        if (sessionId) {
            const dbCount = await messageDb.getCount(sessionId) as number;
            if (dbCount > 0 && agent.getMessages().length === 0) {
                const loaded = await messageDb.loadMessages(sessionId) as {
                    messages: MessageRow[];
                };
                const attachmentMap = await attachmentDb.getImagesForSession(sessionId);
                const allMsgs = loaded.messages.map(row => messageRowToMessage(row, attachmentMap));
                const validated = validateMessageHistory(allMsgs);
                agent.setMessages(validated);
                existingMessageCount = validated.length;
                log('[Agent-Process] Compact: lazy-loaded ' + validated.length + ' messages from DB');
            }
        }
    }
    catch (loadErr) {
        log('[Agent-Process] Compact: lazy-load failed (continuing):', loadErr);
    }
    try {
        const compactMsg = msg as unknown as {
            strategy?: string;
            maxMessagesToKeep?: number;
            customInstructions?: string;
            keepRecentTokens?: number;
        };
        const result = await agent.compact({
            ...definedProperties({ strategy: compactMsg.strategy }),
            ...definedProperties({ maxMessagesToKeep: compactMsg.maxMessagesToKeep }),
            ...definedProperties({ customInstructions: compactMsg.customInstructions })
        });
        log('[Agent-Process] Compaction complete:', result);
        existingMessageCount = agent.getMessages().length;
        log(`[Agent-Process] Compaction: rebase emitted, new count=${existingMessageCount}`);
        compactedPending = true;
        emitLiveUsage(sessionId);
        sendToMain({ type: 'compact:done', sessionId, result });
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log('[Agent-Process] Compaction failed:', errorMessage);
        sendToMain({ type: 'compact:error', sessionId, message: errorMessage });
    }
    finally {
        chatInProgress = false;
    }
}
async function main(options: WorkerProcessStartOptions): Promise<void> {
    log('Process started, session:', process.env.SESSION_ID);
    log('cwd:', process.cwd());
    if (process.env.DUYA_AGENT_ROLE === 'workflow-runtime') {
        try {
            await runWorkflowRuntimeChild({ execution: (init) => ({ createPorts: (workingDirectory) => processAssembly.createWorkflowExecutionPorts({ sessionId: '', llm: init.llm, workingDirectory }) }) });
        }
        catch (err) {
            warn('[Workflow-Runtime] child failed:', err);
            exitAfterCleanup(1);
            return;
        }
        exitAfterCleanup(0);
        return;
    }
    process.on('message', (msg: unknown) => {
        if (msg && typeof msg === 'object') {
            void handleCommand(msg as WorkerCommand);
        }
    });
    try {
        for await (const msg of options.commands ?? parseStdin()) {
            await handleCommand(msg);
        }
    }
    catch (err) {
        log('[Agent-Process] Fatal error in main loop:', err);
        writeAgentCrashLog(err, 'main-loop');
        exitAfterCleanup(1);
    }
}
let isShuttingDown = false;
async function performCleanup(): Promise<void> {
    if (isShuttingDown)
        return;
    isShuttingDown = true;
    log('[Agent-Process] Starting cleanup...');
    stopChatHeartbeat();
    toolBucket.destroy();
    try {
        const { shutdownWorkerPool } = await import('./worker-tool-pool.js');
        shutdownWorkerPool();
        log('[Agent-Process] Worker pool shut down');
    }
    catch (err) {
        warn('[Agent-Process] Failed to shut down worker pool:', err);
    }
    titleGeneratedBySession.clear();
    try {
        const { closeDbClient } = await import('@duya/host/worker-db-client');
        await closeDbClient();
        log('[Agent-Process] DB client closed');
    }
    catch (err) {
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
function writeAgentCrashLog(err: unknown, origin: string): void {
    try {
        const crashDir = path.join(os.tmpdir(), 'duya-agent-crash');
        mkdirSync(crashDir, { recursive: true });
        const crashPath = path.join(crashDir, `agent-${sessionId || 'unknown'}-${origin}-${Date.now()}.log`);
        writeFileSync(crashPath, `[${new Date().toISOString()}] sessionId=${sessionId} origin=${origin}\n${err instanceof Error ? (err.stack || err.toString()) : String(err)}\n`, 'utf-8');
        log(`[Agent-Process] Crash log written to ${crashPath}`);
    }
    catch (writeErr) {
        warn('[Agent-Process] Failed to write crash log:', writeErr);
    }
}
const swallowPipeError = (err: unknown): void => {
    const code = (err as {
        code?: string;
    } | null)?.code;
    if (code === 'EPIPE' || code === 'ERR_STREAM_WRITE_AFTER_END') {
        log('[Agent-Process] Ignoring broken pipe on process output:', code);
        return;
    }
    log('[Agent-Process] Fatal process output error:', err);
    writeAgentCrashLog(err, 'output-stream');
    exitAfterCleanup(1);
};
export interface WorkerProcessStartOptions {
    assembly: WorkerProcessAssembly;
    commands?: AsyncIterable<WorkerCommand>;
}
function installProcessLifecycleHandlers(): void {
    process.on('SIGTERM', () => {
        log('[Agent-Process] Received SIGTERM');
        exitAfterCleanup(0);
    });
    process.on('SIGINT', () => {
        log('[Agent-Process] Received SIGINT');
        exitAfterCleanup(0);
    });
    process.on('disconnect', () => {
        log('[Agent-Process] Parent disconnected, shutting down...');
        exitAfterCleanup(0);
    });
    process.stdout.on('error', swallowPipeError);
    process.stderr.on('error', swallowPipeError);
    process.on('uncaughtException', (err) => {
        log('[Agent-Process] Uncaught exception:', err);
        writeAgentCrashLog(err, 'uncaught-exception');
        exitAfterCleanup(1);
    });
    process.on('unhandledRejection', (reason) => {
        log('[Agent-Process] Unhandled rejection:', reason);
    });
}
export async function startWorkerProcess(options: WorkerProcessStartOptions): Promise<void> {
    processAssembly = options.assembly;
    installProcessLifecycleHandlers();
    await main(options);
}
