import type { AIClient } from '@duya/ai';
import type { ApprovalRequest, ApprovalVerdict, AssembledTurn, ExtensionPort, ModelFrame, ModelMessage, ModelRequest, RunEnginePorts, RunCommandPort, RunEventEmitter, RunInputSnapshot, TerminalCandidate, ToolCallRequest, ToolDescriptor, ToolDrainItem, ToolDispatchTicket, ToolOutcome, TransientContextFragment, TurnAssemblyInput, } from '@duya/agent-runtime';
import { attachmentDigest, canonicalJson, sha256Hex, type FileAttachment, type PermissionPolicyMode, type RunId, type RunManifest, type TokenUsage as ProtocolTokenUsage, } from '@duya/agent-protocol';
import type { TokenUsage } from '@duya/host/worker-run-contracts';
import type { AssistantMessage, Message, MessageContent, SSEEvent } from '@duya/host/worker-run-contracts';
import type { Tool } from '@duya/host/worker-run-contracts';
import type { RunHandle, RunTurnAssembly, TurnOutputSink, EngineProductSession } from '@duya/host/worker-run-session-port';
import type { TurnPipelinePublisher } from '@duya/agent-runtime/tools/turn-pipeline-publisher';
import { createClientModelPort } from '@duya/host/run-engine-model';
import { readProgressUpdateCall, PROGRESS_UPDATE_TOOL } from '@duya/agent-runtime/turns/tool-group-progress';
import { createLegacyCommandPort } from '@duya/host/worker-command-port';
import { renderSystemReminder } from '@duya/agent-core/context/reminders';
import { normalizeCanUseToolDecision } from '@duya/agent-runtime/authorization/tool-invoke-decision';
import { adaptAttachmentContext, adaptLoopNudgeContext } from '@duya/host/worker-context/runtime-context-adapters';
import { persistLargePastedAttachments } from '@duya/host/worker-context/attachment-context';
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
    readonly progressToolName?: () => string;
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
    /**
     * The turn's reasoning effort, as the Host adjudicated it.
     *
     * Forwarded to the provider by the model port, because the effort is what
     * becomes the provider's thinking budget. OMITTED means the Host resolved
     * no effort and the provider's own default applies.
     */
    readonly effort?: string;
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
    const controlResults: ToolOutcome[] = [];
    return {
        openModelStream: (request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelFrame> => createClientModelPort(agent.readModelClient(), {
            refreshDeclaredTools: host.refreshDeclaredTools,
            ...(host.onPerCallUsage === undefined
                ? {}
                : { onPerCallUsage: host.onPerCallUsage }),
            ...(host.effort === undefined ? {} : { effort: host.effort }),
        }).stream(request, signal),
        queueTool: (call: ToolCallRequest) => {
            const name = host.progressToolName?.();
            const progress = name === undefined ? null : readProgressUpdateCall(call.name, name, call.input);
            if (progress === null) {
                pipelines.queue({ id: call.callId, name: call.name, input: call.input });
                return;
            }
            if (progress.title !== undefined) host.emitter.emit({ type: 'tool.group_progress', title: progress.title, source: 'model_progress_tool' });
            controlResults.push({ kind: 'tool_result', callId: call.callId, content: progress.title === undefined ? 'Invalid progress title' : 'Progress updated', isError: progress.title === undefined, durationMs: 0 });
        },
        async *drainTools(): AsyncIterable<ToolDrainItem> {
            yield* controlResults.splice(0);
            for await (const update of pipelines.drain()) {
                const item = toDrainItem(update);
                if (item !== null)
                    yield item;
            }
        },
        discardTools: () => { controlResults.length = 0; pipelines.discard(); },
        lookup: {
            sideEffectOf: (name) => name === host.progressToolName?.() ? 'read_only' : null,
            toolNames: () => agent.activeMCPRegistry.getAllTools().map((tool: Tool) => tool.name),
            describe: (toolName: string): ToolDescriptor | null => {
                if (toolName === host.progressToolName?.()) return { name: toolName, description: PROGRESS_UPDATE_TOOL.description, inputSchema: PROGRESS_UPDATE_TOOL.input_schema };
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
/**
 * The turn's assembly: the messages and the tool surface the model sees.
 *
 * ## Why the attachments are added here
 *
 * The legacy loop injects the attachment context right before it opens the
 * provider request (`worker-session-runtime.ts`, `_injectRuntimeContext`): the
 * attached files become a hidden runtime-context message, so the model reads
 * their extracted text without the user seeing a second message about them.
 *
 * The engine path never runs that loop, and the turn's assembly is the point
 * that replaces it -- the Host assembles the turn, and the engine asks for the
 * assembled turn. So the attachment context is added here, through the SAME
 * helpers the legacy path uses (`persistLargePastedAttachments` ->
 * `adaptAttachmentContext` -> `projectRuntimeContextToProviderMessage`), rather
 * than through a second derivation of "what an attachment says to the model".
 *
 * The attachment's PAYLOAD is not the run input's business: the snapshot
 * names the attachments by reference (`attachmentPart`), and this message is
 * assembled from the same attachment list the worker received.
 */
export function createLegacyAssembleTurn(
    handle: RunTurnAssembly,
    attachments?: readonly FileAttachment[],
    maxOutputTokens?: number,
): (input: TurnAssemblyInput) => Promise<AssembledTurn> {
    return async (input: TurnAssemblyInput): Promise<AssembledTurn> => {
        await handle.prepare?.();
        const messages = handle.projectTurnMessages();
        const assembly = handle.assemble({
            turn: input.turn,
            systemPrompt: handle.systemPrompt,
            messages,
            tools: handle.tools as Tool[],
        });
        const withAttachments = await appendAttachmentContext(messages, attachments);
        return {
            systemPrompt: assembly.systemPrompt,
            ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
            messages: toModelMessages(withAttachments),
            tools: assembly.tools.map(toToolDescriptor),
            catalogRevision: String(handle.resolved.registry.getCatalogRevision()),
            revision: input.digest,
        };
    };
}
/**
 * The attachment context message, appended to the turn's messages.
 *
 * Returns the messages UNCHANGED when the turn carried no attachments, so a
 * turn without files takes the same path it took before this existed.
 */
async function appendAttachmentContext(
    messages: readonly Message[],
    attachments: readonly FileAttachment[] | undefined,
): Promise<readonly Message[]> {
    if (attachments === undefined || attachments.length === 0) return messages;
    // The same preparation the legacy path does: a pasted text too large to
    // inline is persisted and referenced by path instead.
    const prepared = await persistLargePastedAttachments(attachments);
    const context = adaptAttachmentContext(prepared);
    if (context === null) return messages;
    const projected = projectRuntimeContextToProviderMessage(context);
    if (projected === null || projected === undefined) return messages;
    return [...messages, projected];
}
export function toModelMessages(messages: readonly Message[]): ModelMessage[] {
    return messages.map((message, index) => ({
        role: message.role as ModelMessage['role'],
        content: message.content as ModelMessage['content'],
        id: message.id ?? `m${index}`,
        ...(message.tool_call_id === undefined ? {} : { toolCallId: message.tool_call_id }),
        // The rows the SYSTEM attached keep their identity across this
        // boundary. `runtimeContext: true` is the marker every producer of
        // such a row already sets -- the volatile-context rail, a hook's
        // block, an attachment's extracted text -- and it is what tells the
        // engine where the conversation ends and the system's own context
        // begins. Without it the two are one flat list of `user` rows.
        ...(message.metadata?.runtimeContext === true ? { origin: 'context' as const } : {}),
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
    /**
     * The turn's attachments, as the worker received them.
     *
     * They are already durable — the attachment store holds them and the user
     * message carries them — so the run input names them BY REFERENCE, with
     * the same digest the turn's own input revision uses. The payloads never
     * enter the snapshot: a turn may carry 50 MB of base64, and a record
     * that copies it decides nothing about the turn's identity.
     */
    readonly attachments?: readonly FileAttachment[];
    /**
     * The run layer's own bag for this turn.
     *
     * The worker's options mix the turn's configuration with the worker's
     * ports, and only the first is the run layer's; see
     * {@link runLayerOptions}.
     */
    readonly options?: Readonly<Record<string, unknown>>;
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
        attachments: attachmentPart(facts.attachments, facts.sessionId),
        catalog: {
            kind: 'by_ref',
            digest: `catalog-rev-${facts.catalogRevision}`,
            locator: `catalog://${facts.catalogRevision}`,
        },
        steering: [],
        options: { ...(facts.options ?? {}), permissionMode: facts.permissionMode },
    } as unknown as RunInputSnapshot;
}
/**
 * The attachments part of a run's input.
 *
 * BY REFERENCE, with the digest the turn's own input revision uses, so the
 * snapshot and the digest name the same attachments. The alternative — the
 * payloads inline — would make every snapshot as large as the turn's
 * attachments and would make the record a second copy of the bytes rather
 * than a name for them.
 *
 * An empty list stays INLINE, because "this turn carried nothing" is a fact
 * and not a reference to a store that was never written to.
 */
function attachmentPart(
    attachments: readonly FileAttachment[] | undefined,
    sessionId: string,
): { readonly kind: 'by_ref'; readonly digest: string; readonly locator: string } | { readonly kind: 'inline'; readonly value: readonly never[] } {
    if (attachments === undefined || attachments.length === 0) {
        return { kind: 'inline', value: [] };
    }
    return {
        kind: 'by_ref',
        digest: attachmentDigest(attachments),
        locator: `attachments://${sessionId}`,
    };
}
/**
 * The run layer's own view of the turn's options.
 *
 * The worker hands the driver a `ChatOptions` that mixes two different
 * things: the turn's CONFIGURATION (data — the effort, the profile, the
 * mode) and the worker's own PORTS (functions and class instances — the
 * permission bridge, the tool registry, the IPC channel).
 *
 * Only the first is the run layer's bag, and a snapshot is a record: it
 * cannot hold a function. So the ports are dropped by what they ARE rather
 * than by a list of their names — a list would go stale the moment a port is
 * added, and the stale entry would be a silent drop of real configuration.
 *
 * The attachments are excluded here because the snapshot has a part for
 * them, and a second copy of the same files would be a second answer to
 * "which attachments did this turn carry".
 */
export function runLayerOptions(options: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(options)) {
        if (key === 'attachments' || key === 'files') continue;
        if (isRunLayerData(value)) out[key] = value;
    }
    return out;
}
/**
 * Whether a value is DATA the run layer may record.
 *
 * A plain object, an array, or a primitive — and nothing deeper. A class
 * instance is not data: it serialises to `{}` and would make a populated
 * registry indistinguishable from an empty one.
 */
function isRunLayerData(value: unknown, depth = 0): boolean {
    if (depth > 4) return false;
    if (value === null) return true;
    switch (typeof value) {
        case 'string':
        case 'boolean':
            return true;
        case 'number':
            return Number.isFinite(value);
        case 'undefined':
            return false;
        case 'object':
            break;
        default:
            return false;
    }
    if (Array.isArray(value)) {
        return value.every((item) => isRunLayerData(item, depth + 1));
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(value as Record<string, unknown>).every(
        (nested) => nested === undefined || isRunLayerData(nested, depth + 1),
    );
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
