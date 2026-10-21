import type { AIClient } from '@duya/ai';
import type { ApprovalRequest, ApprovalVerdict, AssembledTurn, ExtensionPort, ModelFrame, ModelMessage, ModelRequest, RunEnginePorts, RunCommandPort, RunEventEmitter, RunInputSnapshot, TerminalCandidate, ToolCallRequest, ToolDescriptor, ToolDrainItem, ToolDispatchTicket, ToolOutcome, TransientContextFragment, TurnAssemblyInput, } from '@duya/agent-runtime';
import { canonicalJson, sha256Hex, type PermissionPolicyMode, type RunId, type RunManifest, type TokenUsage as ProtocolTokenUsage, } from '@duya/agent-protocol';
import type { TokenUsage } from '@duya/host/worker-run-contracts';
import type { AssistantMessage, Message, MessageContent, SSEEvent } from '@duya/host/worker-run-contracts';
import type { Tool } from '@duya/host/worker-run-contracts';
import type { RunHandle, RunTurnAssembly, TurnOutputSink, EngineProductSession } from '@duya/host/worker-run-session-port';
import type { TurnPipelinePublisher } from '@duya/agent-runtime/tools/turn-pipeline-publisher';
import { createClientModelPort } from '@duya/host/run-engine-model';
import { createLegacyCommandPort } from '@duya/host/worker-command-port';
import { renderSystemReminder } from '@duya/agent-core/context/reminders';
import { normalizeCanUseToolDecision } from '@duya/agent-runtime/authorization/tool-invoke-decision';
import { adaptLoopNudgeContext } from '@duya/host/worker-context/runtime-context-adapters';
import { projectRuntimeContextToProviderMessage } from '@duya/agent-core/message/message-projectors';
import { buildEnginePorts, toDrainItem } from '@duya/agent-runtime/adapters/run-engine-ports';
import type { CompactionSources, LegacyEngineSources } from '@duya/agent-runtime/adapters/run-engine-ports';
function toToolResultMessage(outcome: ToolOutcome): Message {
    const row: Message = {
        role: 'tool',
        tool_call_id: outcome.callId,
        content: outcome.content,
        timestamp: Date.now(),
        duration_ms: outcome.durationMs,
        ...(outcome.metadata === undefined ? {} : { metadata: outcome.metadata }),
    };
    return row;
}
function toRowUsage(usage: ProtocolTokenUsage): AssistantMessage['usage'] {
    return {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        ...(usage.totalTokens === undefined ? {} : { total_tokens: usage.totalTokens }),
    } as AssistantMessage['usage'];
}
function restoreRunOwnRows(agent: EngineProductSession, marker: {
    readonly replyToId: string;
    readonly userId: string;
}, projected: readonly ModelMessage[]): readonly ModelMessage[] {
    const own = agent.projectRunOwnModelMessages(marker.userId) as readonly ModelMessage[];
    if (own.length === 0)
        return projected;
    const ownById = new Map<string, ModelMessage>();
    for (const row of own) {
        if (row.id !== undefined)
            ownById.set(row.id, row);
    }
    const mainById = new Map<string, ModelMessage>();
    for (const row of projected) {
        if (row.id !== undefined)
            mainById.set(row.id, row);
    }
    const merged: ModelMessage[] = [];
    const placed = new Set<string>();
    for (const row of agent.getMessages()) {
        const id = row.id;
        if (id === undefined)
            continue;
        const main = mainById.get(id);
        if (main !== undefined) {
            merged.push(main);
            placed.add(id);
            continue;
        }
        const mine = ownById.get(id);
        if (mine !== undefined) {
            merged.push(mine);
            placed.add(id);
        }
    }
    for (const row of projected) {
        if (row.id !== undefined && placed.has(row.id))
            continue;
        merged.push(row);
    }
    return merged;
}
export interface LegacyRunHost {
    readonly turnPipelines: TurnPipelinePublisher;
    readonly assembleTurn: (input: TurnAssemblyInput) => Promise<AssembledTurn>;
    readonly refreshDeclaredTools: () => Set<string>;
    readonly onPerCallUsage?: (usage: TokenUsage) => void;
    readonly turnUsageBlock?: () => AssistantMessage['usage'] | null;
    readonly askApproval: (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalVerdict>;
    readonly emitter: Pick<RunEventEmitter, 'emit'>;
    readonly proposeTerminal: (candidate: TerminalCandidate) => void;
    readonly compaction: CompactionSources;
    readonly seqIndex: number;
    readonly sessionId?: string;
    readonly workingDirectory?: string;
    readonly wakeRun: boolean;
    readonly imageInputSupported?: boolean;
    readonly beginTicket?: (call: ToolCallRequest) => Promise<ToolDispatchTicket>;
    readonly settleTicket?: (input: {
        readonly attemptKey: string;
        readonly state: 'succeeded' | 'failed' | 'unknown';
        readonly detail?: string;
    }) => Promise<void>;
    readonly turnOutputSink?: TurnOutputSink;
    readonly runFork?: {
        readonly replyToId: string;
        readonly userId: string;
    };
    readonly deferFragment?: (fragment: TransientContextFragment) => void;
    readonly extensions?: ExtensionPort;
    readonly command?: RunCommandPort;
}
export function composeLegacyRunSources(agent: EngineProductSession, host: LegacyRunHost): LegacyEngineSources {
    const pipelines = host.turnPipelines;
    const runFork = host.runFork;
    return {
        openModelStream: (request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelFrame> => createClientModelPort(agent.readModelClient(), {
            refreshDeclaredTools: host.refreshDeclaredTools,
            ...(host.onPerCallUsage === undefined
                ? {}
                : { onPerCallUsage: host.onPerCallUsage }),
        }).stream(request, signal),
        queueTool: (call: ToolCallRequest) => pipelines.queue({ id: call.callId, name: call.name, input: call.input }),
        async *drainTools(): AsyncIterable<ToolDrainItem> {
            for await (const update of pipelines.drain()) {
                const item = toDrainItem(update);
                if (item !== null)
                    yield item;
            }
        },
        discardTools: () => pipelines.discard(),
        lookup: {
            sideEffectOf: () => null,
            toolNames: () => agent.activeMCPRegistry.getAllTools().map((tool: Tool) => tool.name),
            describe: (toolName: string): ToolDescriptor | null => {
                const tool = agent.activeMCPRegistry.getTool(toolName);
                if (tool === undefined)
                    return null;
                return {
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.input_schema,
                };
            },
        },
        assembleTurn: runFork === undefined
            ? host.assembleTurn
            : async (input) => {
                const assembled = await host.assembleTurn(input);
                return {
                    ...assembled,
                    messages: restoreRunOwnRows(agent, runFork, assembled.messages),
                };
            },
        askApproval: host.askApproval,
        emitter: host.emitter,
        proposeTerminal: host.proposeTerminal,
        interTurn: {
            claim: (input) => agent.claimInterTurn(input),
            seqIndex: host.seqIndex,
            wakeRun: host.wakeRun,
            ...(host.imageInputSupported === undefined ? {} : { imageInputSupported: host.imageInputSupported }),
        },
        compaction: host.compaction,
        turnOutput: {
            onToolResult: (record) => agent.recordTurnToolResult({
                message: toToolResultMessage(record.outcome),
                toolName: record.toolName,
                seqIndex: host.seqIndex,
            }),
            onAssistantMessage: (record) => {
                const hostUsage = host.turnUsageBlock?.() ?? undefined;
                const usage = hostUsage ?? (record.usage === undefined ? undefined : toRowUsage(record.usage));
                agent.recordTurnAssistantMessage({
                    content: record.content as unknown as MessageContent[],
                    seqIndex: host.seqIndex,
                    ...(usage === undefined ? {} : { usage }),
                });
            },
            onTurnResults: (summary) => {
                agent.finishTurnOutput(summary);
            },
            onInjectedMessage: (record) => {
                const projected = projectRuntimeContextToProviderMessage(adaptLoopNudgeContext(renderSystemReminder(record.text, 'loop_nudge'), 'custom', { seqIndex: host.seqIndex }));
                agent.addMessage(projected);
            },
        },
        ...(host.deferFragment === undefined ? {} : { deferFragment: host.deferFragment }),
        modeExit: { onRunExit: () => agent.runModeExitHooks() },
        ...(host.extensions === undefined ? {} : { extensions: host.extensions }),
        command: host.command ??
            createLegacyCommandPort({
                get messages(): readonly Message[] {
                    return agent.getMessages();
                },
                runGoalCommand: (prompt, context) => agent.runGoalCommand(prompt, context),
                ...(host.sessionId === undefined ? {} : { sessionId: host.sessionId }),
                ...(host.workingDirectory === undefined
                    ? {}
                    : { workingDirectory: host.workingDirectory }),
            }),
        ...(host.beginTicket === undefined || host.settleTicket === undefined
            ? {}
            : { beginTicket: host.beginTicket, settleTicket: host.settleTicket }),
    };
}
export function composeLegacyRunPorts(agent: EngineProductSession, host: LegacyRunHost): RunEnginePorts {
    agent.bindTurnOutputSink(host.turnOutputSink ?? null);
    agent.bindRunForkMarker(host.runFork ?? null);
    return buildEnginePorts(composeLegacyRunSources(agent, host));
}
export function gateRunApproval(assembly: RunTurnAssembly, askApproval: LegacyRunHost['askApproval']): LegacyRunHost['askApproval'] {
    return async (request, signal) => {
        const { behavior } = normalizeCanUseToolDecision(await assembly.canUseTool(request.toolName, { ...request.input }, request.callId));
        if (behavior === 'deny') {
            return { allowed: false, reason: 'denied' } as const;
        }
        void askApproval;
        void signal;
        return { allowed: true, scope: 'once' } as const;
    };
}
export type RunDriverLeg = {
    readonly kind: 'orchestrator';
    readonly frames: AsyncIterable<SSEEvent>;
} | {
    readonly kind: 'engine';
};
export function selectRunDriverLeg(agent: EngineProductSession, run: RunHandle): RunDriverLeg {
    if (run.orchestrator) {
        return { kind: 'orchestrator', frames: agent.orchestratorFramesFor(run) };
    }
    return { kind: 'engine' };
}
export function createLegacyAssembleTurn(handle: RunTurnAssembly): (input: TurnAssemblyInput) => Promise<AssembledTurn> {
    return async (input: TurnAssemblyInput): Promise<AssembledTurn> => {
        const messages = handle.projectTurnMessages();
        const assembly = handle.assemble({
            turn: input.turn,
            systemPrompt: handle.systemPrompt,
            messages,
            tools: handle.tools as Tool[],
        });
        return {
            systemPrompt: assembly.systemPrompt,
            messages: toModelMessages(messages),
            tools: assembly.tools.map(toToolDescriptor),
            catalogRevision: String(handle.resolved.registry.getCatalogRevision()),
            revision: input.digest,
        };
    };
}
export function toModelMessages(messages: readonly Message[]): ModelMessage[] {
    return messages.map((message, index) => ({
        role: message.role as ModelMessage['role'],
        content: message.content as ModelMessage['content'],
        id: message.id ?? `m${index}`,
        ...(message.tool_call_id === undefined ? {} : { toolCallId: message.tool_call_id }),
    }));
}
export function toToolDescriptor(tool: Tool): ToolDescriptor {
    return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input_schema as Record<string, unknown>,
    };
}
export interface LegacyRunFacts {
    readonly runId: RunId;
    readonly cwd: string;
    readonly model: string;
    readonly providerId: string;
    readonly sessionId: string;
    readonly projectId: string | null;
    readonly revision: string;
    readonly catalogRevision: number;
    readonly permissionMode: PermissionPolicyMode;
    readonly roots?: readonly string[];
    readonly maxTurns?: number;
}
const SYNTHESISED = { source: 'unsupported', synthesised: true } as const;
export function buildLegacyRunManifest(facts: LegacyRunFacts): RunManifest {
    return {
        version: 1,
        runId: facts.runId,
        projectId: facts.projectId,
        workspaceId: facts.sessionId,
        roots: facts.roots ?? [facts.cwd],
        cwd: facts.cwd,
        permissionPolicy: {
            mode: facts.permissionMode,
            hostSwitch: 'ask',
            defaultTimeoutMs: 300000,
        },
        capabilities: { profiles: [], modes: [], tools: [] },
        connectorBindings: [],
        env: { ref: 'env:worker', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
        agent: { profileId: null, model: facts.model, providerId: facts.providerId },
        budget: facts.maxTurns === undefined ? {} : { maxTurns: facts.maxTurns },
        deterministic: false,
        provenance: {
            roots: SYNTHESISED,
            cwd: SYNTHESISED,
            permissionPolicy: SYNTHESISED,
            capabilities: SYNTHESISED,
            connectorBindings: SYNTHESISED,
            env: SYNTHESISED,
            agent: SYNTHESISED,
            budget: SYNTHESISED,
            workspaceId: SYNTHESISED,
            projectId: SYNTHESISED,
            deterministic: SYNTHESISED,
        },
    } as unknown as RunManifest;
}
export function buildLegacyRunInput(facts: LegacyRunFacts, prompt: {
    readonly role: 'user';
    readonly id: string;
    readonly content: string;
}, history: readonly {
    role: 'user' | 'assistant' | 'tool';
    id: string;
    content: unknown;
}[]): RunInputSnapshot {
    return {
        revision: facts.revision,
        prompt: { role: 'user', id: prompt.id, content: prompt.content },
        history: {
            kind: 'by_ref',
            digest: historyDigest(history),
            locator: `transcript://${facts.sessionId}`,
        },
        attachments: { kind: 'inline', value: [] },
        catalog: {
            kind: 'by_ref',
            digest: `catalog-rev-${facts.catalogRevision}`,
            locator: `catalog://${facts.catalogRevision}`,
        },
        steering: [],
        options: { permissionMode: facts.permissionMode },
    } as unknown as RunInputSnapshot;
}
function historyDigest(history: readonly {
    role: 'user' | 'assistant' | 'tool';
    id: string;
    content: unknown;
}[]): string {
    const rows = history.map((row) => ({
        role: row.role,
        id: row.id,
        content: row.content as Parameters<typeof canonicalJson>[0],
    }));
    return sha256Hex(canonicalJson(rows));
}
