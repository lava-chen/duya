import { createWorkerAdapterSurface, type RunEnginePorts, type RunInputSnapshot, type RunPersistence, type TerminalCandidate, type ToolSideEffectLedger, } from '@duya/agent-runtime';
import { existsSync, readFileSync } from 'node:fs';
import { FIRST_EPOCH, firstAttemptFence, manifestFingerprint } from '@duya/agent-protocol';
import type { PermissionPolicyMode } from '@duya/agent-protocol';
import type { RunEventEnvelope, RunFence, RunId, RunManifest, RunTerminalState, } from '@duya/agent-protocol';
import type { LegacyFrameCodec } from '@duya/agent-runtime';
import type { AssistantMessage, ChatOptions, MessageContent, SSEEvent, TokenUsage } from '@duya/host/worker-run-contracts';
import type { EngineProductSession } from '@duya/host/worker-run-session-port';
import type { TurnPipelinePublisher } from '@duya/agent-runtime/tools/turn-pipeline-publisher';
import { buildLegacyRunInput, buildLegacyRunManifest, composeLegacyRunPorts, createLegacyAssembleTurn, gateRunApproval, selectRunDriverLeg, type LegacyRunFacts, type LegacyRunHost, } from '@duya/host/worker-run-composition';
import { createRunEventSpine } from '@duya/host/run-event-spine';
import { executeRunEngine } from '@duya/host/run-engine-execution';
import { createToolSideEffectLedger, defaultLedgerDir, ledgerFile } from '@duya/host/worker-tool-ledger';
const RUNTIME_IDENTITY = { name: 'duya-worker-entry', version: '0.1.0' } as const;
const PROTOCOL = { major: 1, minor: 0 } as const;
function toPromptText(prompt: string | MessageContent[]): string {
    if (typeof prompt === 'string')
        return prompt;
    return prompt
        .filter((block): block is Extract<MessageContent, {
        type: 'text';
    }> => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');
}
export interface EngineRunDriverRequest {
    readonly agent: EngineProductSession;
    readonly sessionId: string;
    readonly runId: RunId;
    readonly seqIndex: number;
    readonly options: ChatOptions;
    readonly prompt: string | MessageContent[];
    readonly inputRevision?: string;
    readonly model: string;
    readonly providerId: string;
    readonly workingDirectory: string;
    readonly permissionMode: PermissionPolicyMode;
    readonly maxTurns?: number;
    readonly wakeRun: boolean;
    readonly imageInputSupported: boolean;
    readonly turnPipelines: TurnPipelinePublisher;
    readonly askApproval: LegacyRunHost['askApproval'];
    readonly legacyFrameCodec: LegacyFrameCodec;
    readonly onPerCallUsage: (usage: TokenUsage) => void;
    readonly turnUsageBlock?: () => AssistantMessage['usage'] | null;
    readonly ledgerDir?: string;
    readonly persistence?: RunPersistence;
    /**
     * Receives every native `RunEventEnvelope` the engine announces, in
     * order and unmodified, before any legacy projection runs. Optional: a
     * caller that omits it keeps the previous behaviour exactly, because the
     * callback is the only thing that adds a publication.
     */
    readonly onNativeEnvelope?: (envelope: RunEventEnvelope) => void;
}
export interface EngineRunOutcome {
    readonly announced: readonly RunEventEnvelope[];
    readonly proposed: TerminalCandidate | null;
    readonly terminal: RunTerminalState | null;
    readonly ports: RunEnginePorts | null;
    readonly promptRowId: string | null;
    readonly railFrames: readonly SSEEvent[];
}
export function deriveFirstAttemptFence(input: {
    readonly runId: RunId;
    readonly dir?: string;
    readonly exists?: (file: string) => boolean;
}): RunFence {
    const dir = input.dir ?? defaultLedgerDir();
    const file = ledgerFile({ dir, runId: input.runId, runEpoch: FIRST_EPOCH });
    const exists = input.exists ?? existsSync;
    return firstAttemptFence({
        runId: input.runId,
        state: exists(file)
            ? { committed: true, committedFence: readCommittedFenceToken(file) }
            : { committed: false },
    });
}
function readCommittedFenceToken(file: string): number {
    let raw: string;
    try {
        raw = readFileSync(file, 'utf8');
    }
    catch {
        return 0;
    }
    let highest = 0;
    for (const line of raw.split('\n')) {
        if (line.trim() === '')
            continue;
        try {
            const entry = JSON.parse(line) as {
                fenceToken?: unknown;
            };
            if (typeof entry.fenceToken === 'number' && entry.fenceToken > highest) {
                highest = entry.fenceToken;
            }
        }
        catch {
        }
    }
    return highest;
}
export async function driveRunWithEngine(request: EngineRunDriverRequest, onFrame: (frame: Record<string, unknown>) => void, onOrchestratorFrames?: (frames: AsyncIterable<SSEEvent>) => Promise<void>): Promise<EngineRunOutcome> {
    const { agent, sessionId, runId, seqIndex, options, prompt, turnPipelines } = request;
    const run = await agent.beginRun({ options, prompt });
    const announced: RunEventEnvelope[] = [];
    let ports: RunEnginePorts | null = null;
    try {
        const railFrames = await agent.producePromptContextRail(run);
        const leg = selectRunDriverLeg(agent, run);
        if (leg.kind === 'orchestrator') {
            if (onOrchestratorFrames !== undefined)
                await onOrchestratorFrames(leg.frames);
            return {
                announced,
                proposed: null,
                terminal: null,
                ports: null,
                promptRowId: null,
                railFrames,
            };
        }
        const commit = agent.commitTurnPromptUserRow({
            prompt,
            messages: [],
            seqIndex,
            ...(options.clientMsgId === undefined ? {} : { clientMsgId: options.clientMsgId }),
            ...(options.displayContent === undefined
                ? {}
                : { displayContent: options.displayContent }),
            ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
            ...(request.wakeRun ? { wakeRun: true } : {}),
            ...(options.replyToId === undefined ? {} : { replyToId: options.replyToId }),
            ...(options.branched === true ? { branched: true } : {}),
        });
        const assembly = await agent.beginTurnAssembly({
            options,
            prompt,
            ...(run.appliedProfile === undefined ? {} : { appliedProfile: run.appliedProfile }),
            turnContext: run.turnContext,
            publisher: turnPipelines,
        });
        const promptRowId = commit.messageId ?? `prompt-${runId}`;
        const facts: LegacyRunFacts = {
            runId,
            cwd: request.workingDirectory,
            model: request.model,
            providerId: request.providerId,
            sessionId,
            projectId: null,
            revision: request.inputRevision !== undefined && request.inputRevision.length > 0
                ? request.inputRevision
                : `worker:${sessionId}:${seqIndex}`,
            catalogRevision: agent.activeMCPRegistry.getCatalogRevision(),
            permissionMode: request.permissionMode,
            ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
        };
        const manifest: RunManifest = buildLegacyRunManifest(facts);
        const input: RunInputSnapshot = buildLegacyRunInput(facts, {
            role: 'user',
            id: promptRowId,
            content: toPromptText(prompt),
        }, agent
            .getMessages()
            .filter((row) => row.id !== promptRowId)
            .map((row) => ({
            role: row.role as 'user' | 'assistant' | 'tool',
            id: row.id ?? '',
            content: row.content,
        })));
        const spine = createRunEventSpine({
            runId,
            sessionId,
            seqIndex,
            ...(request.persistence === undefined ? {} : { persistence: request.persistence }),
            onAnnounce: (envelope) => {
                announced.push(envelope as RunEventEnvelope);
            },
        });
        const started = spine.emitter.emit({
            type: 'run.started',
            manifestHash: manifestFingerprint(manifest),
            protocol: PROTOCOL,
            runtime: RUNTIME_IDENTITY,
        });
        if (!started.ok) {
            throw new Error(`run.started was refused for ${runId}: ${started.message}`);
        }
        const ledgerDir = request.ledgerDir ?? defaultLedgerDir();
        const fence = deriveFirstAttemptFence({ runId, dir: ledgerDir });
        const ledger: ToolSideEffectLedger = createToolSideEffectLedger({
            dir: ledgerDir,
            runId,
            runEpoch: FIRST_EPOCH,
            fence,
        });
        const host: LegacyRunHost = {
            turnPipelines,
            assembleTurn: createLegacyAssembleTurn(assembly),
            refreshDeclaredTools: () => assembly.refreshDeclaredTools(),
            askApproval: gateRunApproval(assembly, request.askApproval),
            emitter: spine.emitter,
            proposeTerminal: spine.proposeTerminal,
            compaction: agent.engineCompactionSources({
                systemPromptContent: () => assembly.systemPrompt,
                messages: () => agent.getMessages(),
            }),
            seqIndex,
            sessionId,
            workingDirectory: request.workingDirectory,
            wakeRun: request.wakeRun,
            imageInputSupported: request.imageInputSupported,
            beginTicket: (call) => ledger.begin(call),
            settleTicket: (settle) => ledger.settle(settle),
            onPerCallUsage: request.onPerCallUsage,
            ...(request.turnUsageBlock === undefined
                ? {}
                : { turnUsageBlock: request.turnUsageBlock }),
        };
        ports = composeLegacyRunPorts(agent, host);
        const surface = createWorkerAdapterSurface({
            emitter: spine.emitter,
            legacyFrameCodec: request.legacyFrameCodec,
        });
        const execution = await executeRunEngine({
            spine,
            manifest,
            input,
            signal: run.signal,
            ports,
            ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
            onEnvelope: (typed) => {
                // Hand the envelope to the native channel FIRST, while it is
                // still the identity the emitter minted (runId / sessionId /
                // seq / traceId / timestamp). The projection below is lossy
                // and additive; it cannot reconstruct any of this. Exactly one
                // publication per envelope -- the drain below is the only
                // other consumer and it keeps serving the legacy frames.
                if (request.onNativeEnvelope !== undefined) {
                    request.onNativeEnvelope(typed);
                }
                // Keep a machine-readable model-turn boundary alongside the
                // legacy "Turn N" status line, which has no content identity.
                if (typed.payload.type === 'turn.started') {
                    onFrame({ type: 'chat:turn_start', data: { turnCount: typed.payload.index } });
                }
                for (const result of surface.projectUsageResults(typed.payload)) {
                    onFrame(result as unknown as Record<string, unknown>);
                }
                const frame = surface.surface.projectToLegacyFrame(typed);
                if (frame != null && typeof frame === 'object' && typeof (frame as {
                    type?: unknown;
                }).type === 'string') {
                    const chatFrame = request.legacyFrameCodec(frame as {
                        readonly type: string;
                    });
                    if (chatFrame !== null) {
                        const content = typed.payload;
                        const identity = content.type === 'assistant.text_delta' || content.type === 'assistant.text_block'
                            || content.type === 'assistant.thinking_delta' || content.type === 'assistant.thinking_block'
                            ? { messageId: content.messageId, index: content.index }
                            : content.type === 'tool.progress'
                                ? { id: content.toolCallId, elapsed_ms: content.elapsedMs } : {};
                        onFrame({ ...chatFrame, ...identity } as Record<string, unknown>);
                    }
                }
            },
        });
        return {
            announced,
            proposed: execution.proposed,
            terminal: execution.terminal,
            ports,
            promptRowId,
            railFrames,
        };
    }
    finally {
        run.close();
    }
}
