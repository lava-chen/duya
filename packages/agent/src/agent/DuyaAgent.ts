import { prepareMailboxGuidance } from '../message/mailbox-attachment-context.js';
import { parseMailboxAttachments } from '../utils/attachment-images.js';
import { isModelLikelyMultimodal } from '../utils/multimodal-detection.js';
import { resolveTurnRunId } from './run-identity.js';
/**
 * duyaAgent - AI Agent 鏍稿績绫? * 鎻愪緵娴佸紡瀵硅瘽銆佸伐鍏疯皟鐢ㄣ€佷細璇濈鐞嗚兘鍔? *
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
  AssistantMessage,
  MessageContent,
  ToolUseContent,
  Tool,
  ToolUse,
  SSEEvent,
  SessionInfo,
  ToolUseContext,
  ToolResultContent,
  AgentProgressEvent,
  AppState,
} from '../types.js';
import { asSystemPrompt, DEFAULT_PROMPT_PROFILE, getPromptProfileForAgentProfile, PromptsRegistry, resolvePromptSystemName } from '../prompts/index.js';
import { handleGoalCommand, isGoalControlCommand } from '../modes/goal/goal-commands.js';
import {
  handleTranscriptCommand,
  isTranscriptControlCommand,
} from '../session/transcript-commands.js';
import { sendEvent, buildClipboardWriteEvent } from '../process/worker-protocol.js';
import type { PromptSystem } from '../prompts/index.js';
import {
  createBotPromptAssembly,
  loadBotPromptContext,
  isBotAgentProfile,
  computeBotContentHash,
  countTimelineCompactions,
  buildProfileUpdateEnvelope,
  detectProfileUpdate,
  isProfileUpdateFolded,
  mergeProfileUpdate,
  type ProfileBaseline,
} from '../prompts/index.js';
import type { BotPromptAssembly } from '../prompts/index.js';
import { getAgentsMdManager } from '../agentsmd/index.js';
import { extractTriggerPaths } from '../agentsmd/nested-loader.js';
import { isNestedAgentsMdEnabled } from '../config/feature-flags.js';
import { getCachedAppConnectionDescriptors } from '../tool/AppConnectionTool/index.js';
import { projectForProvider } from '@duya/plugin-core/mcp/core/projection';
import { buildAppsSystemSection, collectConnectorActivationInjection, collectPluginInjections, collectSkillInjections, extractExplicitSkillMentions, mergeSkillMentionSources } from '../mentions/index.js';
import { matchSkillsForPrompt, buildSkillSuggestionInjection } from '../skills/index.js';
import { compressProjectedToolMessages } from '../compact/projectionCompress.js';

import { createAIClient, createAIClientWithRetry, inferProvider, findModelCompat, estimateContextTextTokens } from '@duya/ai';
import type { AIClient, AIClientOptions, RetryConfig, ApiFormat } from '@duya/ai';
import { resolveDefaultBaseURL, resolveLlmClientDiscriminator } from '@duya/ai';
import type { TurnOutputSummary } from '@duya/agent-runtime';
import { sleep, createRetryEvent, createLLMAPIError, extractProviderErrorMessage, APIErrorType } from '@duya/ai';
import {
  shouldReplayStreamAfterError,
  streamReplayDelayMs,
  STREAM_REPLAY_MAX_ATTEMPTS,
} from './stream-retry.js';
import { stripPastedContentMarkers } from '../utils/pasted-content.js';
import { StreamingToolExecutor } from '../tool/StreamingToolExecutor.js';
import { ToolExecutionPipeline } from '../tool/ToolExecutionPipeline.js';
import type { CanUseToolFn } from '../tool/StreamingToolExecutor.js';
import type { WidgetStyleSignature, CanvasFreshnessState } from '../types.js';
import { createHasPermissionsToUseTool } from '../permissions/permissions.js';
import { resolveCacheRetention } from '../config/cache-config.js';
import { readToolExposureConfig } from '../config/tool-exposure.js';
import type { ToolPermissionCheckContext } from '../permissions/permissions.js';
import type { ToolPermissionContext, PermissionMode, ToolPermissionRulesBySource, AdditionalWorkingDirectory, PermissionRuleSource, LocalToolPermission } from '../permissions/types.js';
import type { CommunicationPlatform } from '../prompts/types.js';
import type { AgentRuntime } from './AgentRuntime.js';
import { TurnAssembler } from './TurnAssembler.js';
import type { TurnContext } from './TurnContext.js';
import { permissionModeFromString } from '../permissions/policy.js';
import { buildPermissions } from './PermissionsGate.js';
import { normalizeCanUseToolDecision } from './toolInvokePermission.js';
import { CompactionCoordinator, type CompactionRunResult } from './CompactionCoordinator.js';
import { DeadLoopTracker, resolveDeadLoopConfig } from './TurnLoopTracker.js';
import { SessionFinalizer } from './SessionFinalizer.js';
import { runTurnStream, type TurnStreamRunnerDeps } from './TurnStreamRunner.js';
import { buildTurnModelLeg } from './model-leg.js';
import { PendingHookMessages } from './PendingHookMessages.js';
import { deriveSingleCallUsage } from '../process/seed-token-usage.js';
import { createOneShotTextPort, fromProviderMessages } from '../process/run-engine-model.js';
import { buildCoordinatorCompactionSources } from '../process/run-engine-compaction.js';
import type { CompactionSources } from '../process/run-engine-ports.js';
import { settingsJsonToRules } from '../permissions/rules.js';
import { permissionRuleValueToString } from '../permissions/rules.js';
import { logger } from '../utils/logger.js';
import { createChildAbortController } from '../abort/index.js';
import { getAgentProfileService } from '../agent-profile/AgentProfileService.js';
import { readConfigAgents, toAgentProfile } from '../agent-profile/config-agents.js';
import { parseAgentMentions, buildMentionedAgentsContext } from './dm/index.js';
import type { AgentProfile } from '../agent-profile/types.js';
import { isToolVisible, type ToolVisibilityConstraints } from '../agent-profile/ToolFilter.js';
import { mailboxDb, modeStateDb, pluginDb } from '../ipc/db-client.js';
import { MCPManager } from '../mcp/index.js';
import { buildMCPCapabilityCatalog } from '../mcp/capability-catalog.js';
import type { MailboxRow } from '../session/db.js';
import { LoopHookBus, applyLoopHookEffect, type LoopHookDispatchContext } from '../hooks/loop.js';
import {
  applyHookInjection,
  renderHookContextEnvelope,
  type InjectableMessage,
} from '../hooks/injection.js';
import { createBuiltinLoopHooks } from '../hooks/builtin.js';
import { createConfiguredLoopHooks } from '../hooks/config-loop.js';
import { ConfigHooksRunner } from '../hooks/events.js';
import type {
  EventHookInput,
  EventHookMatcherTargets,
  EventHookRunResult,
} from '../hooks/events.js';
import { readHooksConfig } from '../hooks/config.js';
import type { BaseHookInput } from '../hooks/types.js';
import path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { isMemoryEnabled } from '../memory-rollout/wakeup.js';
import { getDuyaMemoryRoot } from '../memory-state/memory_paths.js';

// Mode System imports (the class is the only consumer in this file;
// the public re-exports live in src/index.ts).
import { modeModifierRegistry, modeTrackerEngine } from '../modes/index.js';
import type { ModeModifier, ModeModifierContext, OrchestratorDeps, ResolvedMode, ToolRegistration } from '../modes/index.js';
import { ModeCoordinator } from '../modes/engine/index.js';
import { applyModes, collectActiveModes, runExitHooks } from '../modes/apply-modes.js';
import { planModeTracker } from '../modes/plan/plan-tracker.js';

import { ToolRegistry } from '../tool/registry.js';
import type { ToolExecutor } from '../tool/registry.js';
import { invalidateToolCatalogSchemaReads, recordToolCatalogSchemaRead, ToolCatalogTool, type ToolCatalogView } from '../tool/ToolCatalogTool/ToolCatalogTool.js';
import { ToolInvokeTool } from '../tool/ToolInvokeTool/ToolInvokeTool.js';
import { createToolInvokeDispatcherFromRegistry } from '../tool/ToolInvokeTool/dispatcherFromRegistry.js';
import {
  recordUndeclaredCall,
  evaluateVisibilityGuard,
} from '../tool/visibility-guard.js';

// Plan 453 Task C: contextual-user-fragment injection channel.
import {
  getOSContextBridge,
  injectOSContextFragment,
} from '../context/os-context/index.js';
import { injectTurnTimestampReminders } from './turn-time-reminder.js';
import type { AgentDefinition } from '../tool/SubagentTool/index.js';
import type { TurnPipelinePublisher } from '../tool/turn-pipeline-publisher.js';
import { CompactionManager, createCompactionManager, type CompactionProbe } from '../compact/CompactionManager.js';
import { resolveCompactionContextWindow } from '../compact/contextWindow.js';
import {
  PROGRESS_UPDATE_TOOL,
  PROGRESS_UPDATE_TOOL_NAME,
  ToolGroupProgressTracker,
  readProgressUpdateCall,
} from './tool-group-progress.js';
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
import { AgentMessageFactory } from '../message/message-factories.js';
// Plan 486: thread/fork branched-layer helpers
import {
  THREAD_METADATA_KEY,
  applyReplyQuoteContext,
  collectMessageIds,
  isBranchedMessage,
  mergeThreadMetadata,
  messageToQuoteText,
  readThreadMeta,
  resolveReplyMeta,
} from '../message/threads.js';
import { MessageCompactionController } from '../message/message-compaction-controller.js';
import {
  adaptAttachmentContext,
  adaptBackgroundNotification,
  adaptLoopNudgeContext,
  projectRuntimeContextToProviderMessage,
  RUNTIME_CONTEXT_METADATA_KEYS,
} from '../message/runtime-context-adapters.js';
import { renderSystemReminder } from './reminders.js';
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
 * One drained tool result, read into the three values both frame builders need.
 *
 * Deliberately a VALUE rather than the message: `isError` is derived from the
 * content in one shape (`'<tool_error>'` inside the text) and read as a flag in
 * the other, and a caller that re-derived it would be free to get it wrong.
 */
interface ToolResultOutcome {
  /** The `tool_use` id this answers. `''` when the row carried none. */
  readonly id: string;
  /** The result body, stringified exactly as the legacy stringified it. */
  readonly content: string;
  readonly isError: boolean;
}

/**
 * Where a run receives the frames the legacy `streamChat` generator yields.
 *
 * ## Why this is a sink rather than a callback on each record
 *
 * The frames are `yield`s of the generator, and a caller outside `streamChat`
 * cannot consume a `yield`. Rather than change what the generator yields -- the
 * legacy's own consumer (`agent-process-entry.ts`) must keep seeing exactly the
 * frames it sees today -- the run binds a receiver and the generator's
 * counterparts publish to it through shared builders.
 *
 * ## The binding is exclusive with the legacy, and that is enforced
 *
 * `streamChat` clears the binding on entry (`duyaAgent.ts`, the `currentTurnId`
 * reset). Whoever starts the legacy generator OWNS the frames for that run, so a
 * bound sink and a legacy-driven run are mutually exclusive by construction
 * rather than by convention. See the seam block inside the class.
 */
export interface TurnOutputSink {
  /**
   * One frame the legacy would have yielded.
   *
   * `SSEEvent`, deliberately and not a narrowed union: the legacy yields the
   * whole event vocabulary (`agent_progress`, `tool_group_progress`, `turn_start`,
   * …) and a sink that only accepted two of them would be a second, partial
   * rendering of a stream the renderer already knows how to read.
   */
  readonly publish: (event: SSEEvent) => void;
  /** The drain ended; carries the counts the legacy's gates read. */
  readonly finishTurn: (summary: TurnOutputSummary) => void;
}

/**
 * duyaAgent 绫? */
/**
 * What `_resolveTools` decided was VISIBLE for a run, plus the three handles it
 * built beside that decision.
 *
 * EXTRACTED as a name because the per-turn tool-pipeline factory needs all
 * seven and must not be able to reach one of them by a different route: the
 * whole point of routing the factory through `_resolveTools`' result is that
 * profile allow/deny, exposure policy and the 8KB provider projection have
 * already been applied. Rebuilding any of it from `activeMCPRegistry` would
 * compile, run, and send users a different tool surface.
 */
export interface ResolvedTurnTools {
  readonly tools: Tool[];
  readonly registry: ToolRegistry;
  readonly agentDefinitions: AgentDefinition[];
  readonly constraints: ToolVisibilityConstraints;
  readonly catalogTool: ToolCatalogTool;
  readonly catalogView: ToolCatalogView;
  readonly toolInvokeExecutor: ToolInvokeTool;
}

/**
 * Everything `buildTurnPipeline` needs for one turn.
 *
 * Split per-run (`resolved`, `canUseTool`, `toolInvokeDispatcher`) from
 * per-turn (`turn`, `messages`, `tools`) because that is exactly the split
 * the engine needs: it re-assembles the payload every turn and resolves tools
 * once per run.
 *
 * `bindToolUseContext` is a callback rather than a returned handle because the
 * legacy's `turnToolUseContext` is a closure local its own meta-tool dispatcher
 * closes over. Returning the context and leaving the caller to wire it would
 * put that wiring in two places, and the two copies can disagree about which
 * turn is current -- the bug the surrounding comment at the call site records.
 */
export interface TurnPipelineRequest {
  /** 1-based turn number, as `publish` records it. */
  readonly turn: number;
  /** The transcript this turn is built from. Read fresh every turn. */
  readonly messages: Message[];
  /** The tool surface for this turn -- possibly promoted since the run began. */
  readonly tools: Tool[];
  /** `_resolveTools`'s decision. Never rebuilt here. */
  readonly resolved: ResolvedTurnTools;
  readonly turnContext: TurnContext;
  readonly options: ChatOptions | undefined;
  /** The assembled permission gate, including the declared-tools guard. */
  readonly canUseTool: CanUseToolFn;
  readonly toolInvokeDispatcher: ReturnType<typeof createToolInvokeDispatcherFromRegistry>;
  /** Absent when no engine is bound to this run (the CLI, the sub-agent tool). */
  readonly publisher: TurnPipelinePublisher | undefined;
  /** Receives this turn's context so the caller's own dispatcher can read it. */
  readonly bindToolUseContext: (context: ToolUseContext) => void;
}

/**
 * Plan 610 A3-2b7 (S1): what ONE turn's assembly needs.
 *
 * The same per-run / per-turn split `TurnPipelineRequest` draws, and for the
 * same reason: the engine re-assembles every turn and resolves tools once per
 * run, so a request that conflated the two would force the engine to re-resolve
 * per turn or to cache what it must not cache.
 *
 * `systemPrompt` is the run's CURRENT prompt rather than the run's base one, and
 * that is load-bearing. The legacy reassigns the local whenever a compaction
 * returns a replacement (`DuyaAgent.ts:2632`, `:3760`), so the value entering a
 * turn is not the value the run started with. A seam that recomputed from the
 * base every turn would silently undo a compaction's prompt replacement on the
 * next turn -- a regression that shows up as a prompt that grows back after a
 * compaction, which no single-turn test can see.
 */
export interface TurnAssemblyRequest {
  /** 1-based, as the publisher records it and as the catalog round is stamped. */
  readonly turn: number;
  /** The prompt as the run currently holds it. See the note above. */
  readonly systemPrompt: string;
  /** The transcript this turn is built from. Read fresh every turn. */
  readonly messages: Message[];
  /** The tool surface for this turn -- possibly promoted since the run began. */
  readonly tools: Tool[];
  /** `_resolveTools`'s decision. Never rebuilt here. */
  readonly resolved: ResolvedTurnTools;
  readonly turnContext: TurnContext;
  readonly options: ChatOptions | undefined;
  /** The assembled permission gate, including the declared-tools guard. */
  readonly canUseTool: CanUseToolFn;
  readonly toolInvokeDispatcher: ReturnType<typeof createToolInvokeDispatcherFromRegistry>;
  /** Absent when no engine is bound to this run (the CLI, the sub-agent tool). */
  readonly publisher: TurnPipelinePublisher | undefined;
  /** Receives this turn's context so the caller's own dispatcher can read it. */
  readonly bindToolUseContext: (context: ToolUseContext) => void;
}

/**
 * What one turn's assembly produced.
 *
 * `catalogView` is returned LIVE, not copied: `createToolInvokeDispatcherFromRegistry`
 * closes over the same object (`DuyaAgent.ts:1931-1942`) and reads
 * `currentRound`, `loadedSchemaRevisions` and `loadedSchemaRounds` on every
 * `tool_invoke`. A snapshot would satisfy a caller that only wanted to read the
 * advertised set while the dispatcher kept consulting a different object -- the
 * two-views failure the `discarded` hazard has the same shape as.
 */
export interface TurnAssembly {
  /** The system prompt this turn advertises, after the mode-prefix refresh. */
  readonly systemPrompt: string;
  /** The tool surface this turn advertises. */
  readonly tools: readonly Tool[];
  /** This turn's pipeline, published for the engine. Fresh per turn by construction. */
  readonly pipeline: ToolExecutionPipeline;
  /** The live catalog view, already advanced to this turn. */
  readonly catalogView: ToolCatalogView;
}

/**
 * Plan 610 A3-2b8 (S2): what establishing the RUN-scoped half of assembly needs.
 *
 * Deliberately almost nothing. Every value that can be derived from the agent
 * is derived, and the three that cannot -- the resolved-tools decision, the
 * permission gate and the meta-tool dispatcher -- are all decisions about THIS
 * run, made once.
 */
export interface RunAssemblyRequest {
  readonly options: ChatOptions | undefined;
  readonly prompt: string | MessageContent[];
  /** Resolved once by the caller; `undefined` when no profile was named. */
  readonly appliedProfile?: AgentProfile;
  /**
   * The run's turn context, ASSEMBLED BY THE CALLER and handed in.
   *
   * Not derived here, and that is a correction to a first draft of this slice
   * which built it. `streamChat` assembles the context before it reaches this
   * point and reads it ~36 times, so the handle building its own would be a
   * SECOND `TurnAssembler.build` for one run. It is pure, so the two would
   * agree -- and two agreeing constructions of one run's context is exactly the
   * kind of second account this seam exists to remove.
   */
  readonly turnContext: TurnContext;
  /** Absent when no engine is bound to this run (the CLI, the sub-agent tool). */
  readonly publisher: TurnPipelinePublisher | undefined;
}

/** What the host knows about the turn it is asking for. */
export interface TurnAssemblyInput {
  /** 1-based turn number, as the publisher records it and the catalog is stamped. */
  readonly turn: number;
  /** The transcript this turn is built from. Read fresh every turn. */
  readonly messages: Message[];
  /**
   * This turn's tool surface, which may have been PROMOTED since the run began.
   *
   * Passed per turn rather than read from the handle on purpose: promotion is
   * the legacy's decision and the reason a handle that answered "the tools"
   * once would advertise turn 1's surface for the rest of the run.
   */
  readonly tools: readonly Tool[];
  /** The prompt as the run currently holds it -- compaction may have replaced it. */
  readonly systemPrompt: string;
}

/**
 * Plan 610 A3-2b8 (S2): the run-scoped handle. Once built, a turn is one call.
 *
 * ## Why this had to exist before anything outside the loop could own a turn
 *
 * `assembleTurn` (A3-2b7) was already public and already returned a pipeline,
 * and it was still unreachable from outside `streamChat`. Its request needs
 * three things the loop built as CLOSURE LOCALS at run scope and never exposed:
 * the resolved-tools decision (private `_resolveTools`), the guarded permission
 * gate (`buildPermissions` plus the declared-tools snapshot), and the meta-tool
 * dispatcher (`createToolInvokeDispatcherFromRegistry`). Each was a local of a
 * 2300-line generator, so "the engine assembles its own turn" had no producer
 * for its own request. This is that producer.
 *
 * ## It is a HANDLE, not a builder, and that is the `discarded` defence
 *
 * `StreamingToolExecutor.discarded` is a one-way latch: it is never reset and
 * `discard()` also aborts the sibling controller. A pipeline that outlived its
 * turn therefore goes permanently mute -- it accepts tools, drains nothing,
 * raises no error, and passes every structural test. So `assemble` constructs a
 * FRESH pipeline on every call and this handle holds none: the per-turn lifetime
 * is structural, not a convention. Nothing here can be "reused" because there
 * is nothing on it to reuse.
 */
export interface RunTurnAssembly {
  /** `_resolveTools`' decision for this run. Never rebuilt. */
  readonly resolved: ResolvedTurnTools;
  /** The run's turn context. Assembled once, like every other run fact. */
  readonly turnContext: TurnContext;
  /** The tool surface the run started with. Promotion replaces it per turn. */
  readonly tools: readonly Tool[];
  /** The run's base system prompt, before any per-turn mode prefix. */
  readonly systemPrompt: string;
  /**
   * Re-snapshot the tools DECLARED on the provider request about to be opened,
   * and return the new set.
   *
   * Reads the last assembled turn's surface, which is the loop's own semantics:
   * its version closed over the live `tools` variable and was only ever called
   * from inside the turn's own provider request.
   *
   * Returns `Set`, not `ReadonlySet`, because that is the shape
   * `TurnStreamRunner`'s `RefreshDeclaredToolsHook` declares. It is the GUARD'S
   * LIVE set, not a copy: the guard closes over it, so handing back a duplicate
   * would give a caller a set that protects nothing. Treat it as read-only.
   */
  refreshDeclaredTools(): Set<string>;
  /** Assemble one turn: prompt refresh, catalog round, and a FRESH pipeline. */
  assemble(input: TurnAssemblyInput): TurnAssembly;
}

/**
 * The tool-group progress instructions appended to every run's base prompt.
 *
 * Module scope from plan 610 A3-2b8 (S2): the text used to be rebuilt inside
 * `streamChat` on every run, and `beginTurnAssembly` builds it now. A string
 * that is re-created per run is a string that can drift between two copies,
 * so there is exactly one.
 */
const TOOL_GROUP_PROGRESS_INSTRUCTIONS = [
  'Tool-group progress: before a tool batch, provide one concise plain-text title for the work.',
  'Use the provider structured commentary channel when it is explicitly available; otherwise call the private progress-title tool shown in the available tools with {title}.',
  'Never derive a title from hidden reasoning or ordinary assistant prose. The progress-title call is private and does not perform work.',
].join(' ');

export class duyaAgent implements AgentRuntime {
  // Plan 550 step 2a-3: implements the structural read-only interface the
  // `TurnAssembler` consumes. Every method delegates to the existing
  // private fields below; the interface lets the assembler reach into
  // agent state without a hard import on `DuyaAgent`. Method names
  // are prefixed with `read` so they do not collide with same-named
  // fields.
  readTurnSequence(): number {
    // Plan 441/486 use the journal id, not a counter; the assembler
    // does not actually need the sequence for any logic in this
    // commit, so 0 is the safe placeholder until plan 441 lands a
    // monotonic counter.
    return 0;
  }
  readSessionId(): string | undefined {
    return this.sessionId;
  }
  readWorkingDirectory(): string | undefined {
    return this.workingDirectory;
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

  /**
   * Plan 550 step 2a-4: assemble a `TurnContext` from the live agent
   * state. Public so tests can pin the assembly contract without
   * driving a full `streamChat` invocation. The wiring commit
   * (2a-4 follow-up) calls this at the top of `streamChat` and
   * substitutes the returned fields for the corresponding local
   * reads inside the generator body.
   */
  assembleTurnContext(
    options: ChatOptions | undefined,
    prompt: string | MessageContent[],
  ): TurnContext {
    return TurnAssembler.build(this, options, prompt);
  }

  /**
   * The provider client this agent drives, for a host binding the engine's
   * `ModelPort`.
   *
   * PUBLIC, and the same kind of seam as `claimInterTurn` (`:3689`): the run
   * composition needs the client, `llmClient` is private, and
   * `createClientModelPort` (`process/run-engine-model.ts`) already consumes
   * exactly this type. Without an accessor the model leg has no seam at all --
   * it is the one leg with no publisher, because `ModelLegPublisher` was removed
   * in step b3c when its reader went with it
   * (`agent/model-leg.ts:123-133`).
   *
   * ## Why the CLIENT and not a stream
   *
   * A stream would be a second driver. `runTurnStream` is the legacy loop's own
   * provider call and it closes over that turn's accumulators, so handing it out
   * would give the engine a provider request the legacy had not opened -- two
   * requests over one set of per-attempt state, which is the ordering defect
   * `createTurnLegModelPort` was deleted for
   * (`run-engine-model.ts:374-386`). The client opens a request the CALLER
   * describes, which is the only shape that cannot race the legacy's own call.
   *
   * Read-only by construction: the caller gets the client to call, not the field
   * to reassign, so a host cannot swap the session's provider out from under a
   * turn that is already in flight.
   */
  readModelClient(): AIClient {
    return this.llmClient;
  }

  /**
   * Build this turn's tool pipeline, and publish it for the run engine.
   *
   * ## Why this is PUBLIC, and why it is a factory rather than a getter
   *
   * `ToolExecutionPipeline` was a `const` local of the `streamChat`
   * generator, so nothing outside that generator could produce one. Once the
   * engine owns the turn loop the legacy stops being the only thing that
   * constructs a pipeline, and the tool leg would have no producer at all:
   * `TurnPipelinePublisher` exposes `queue`/`drain`/`discard`, which all
   * read one `#current` record, and that record is only ever written by
   * `publish`. No producer, no record, and a model that asks for a tool gets
   * a thrown refusal instead.
   *
   * A factory and not an accessor is the load-bearing choice. A getter over a
   * field would make the pipeline LONG-LIVED, and `discard()` is a one-way
   * latch: `StreamingToolExecutor.discarded` is never reset and `discard()`
   * also aborts the sibling controller, so a hoisted instance goes permanently
   * mute after the first model-retry `discard()` -- accepting tools, draining
   * nothing, raising no error. This method constructs a NEW pipeline on every
   * call and holds nothing on `this`, so the per-turn lifetime is structural
   * rather than a convention someone has to remember.
   *
   * ## One implementation, two callers
   *
   * The generator calls THIS, and the composition's host calls THIS. Routing
   * the legacy through the same method is what keeps it from having two: a
   * separate engine-side builder would be a second place that decides what a
   * turn's permission gate and tool-use context are, and two answers that can
   * differ is the failure this repository keeps paying for.
   *
   * ## The FILTERED catalog, not the registry
   *
   * `request.resolved` is `_resolveTools`' decision -- profile allow/deny,
   * exposure policy and the 8KB provider projection all happen there. Building
   * a tool-use context from `activeMCPRegistry` instead would compile, run,
   * and send users a different tool surface, which is the silent class of
   * defect `run-composition.ts` documents at length.
   */
  buildTurnPipeline(request: TurnPipelineRequest): ToolExecutionPipeline {
    const { resolved, turnContext, options } = request;

    // `streamChat` assigns this on entry and clears it on exit, so it is
    // non-null for every turn of a live run -- and the generator relied on
    // that narrowing without stating it. A method does not inherit it, so it
    // is stated here, and stated as a THROW rather than a default: silently
    // substituting a fresh controller would build a tool-use context wired
    // to a signal the caller cannot abort.
    const abortController = this.abortController;
    if (!abortController) {
      throw new Error(
        'buildTurnPipeline called with no run in progress: the abort controller has already been cleared',
      );
    }

    // Plan 419 P0: the tool-use AppState lives here as a real per-call object.
    // StreamingToolExecutor marks `_approvedToolUses[toolUseId]` into it after
    // a user approves a permission prompt, and the throw-path re-entry reads it
    // back to skip a second prompt. The previous no-op implementations
    // (`() => ({})` / `() => {}`) made "approve then retry" semantics
    // silently dead on the main path.
    let turnAppState: AppState = {};
    const toolUseContext: ToolUseContext = {
      toolUseId: crypto.randomUUID(),
      abortController: abortController,
      getAppState: () => turnAppState,
      setAppState: (updater) => { turnAppState = updater(turnAppState); },
      widgetStyleHistory: this.widgetStyleHistory,
      canvasFreshness: this.canvasFreshness,
      // Plan 536 L1: session-bound projectId. Project-scoped tools (plan tool,
      // etc.) read this as a fallback when the model omits projectId from its
      // input. null when cwd is outside any registered duya project.
      currentProjectId: this.currentProjectId ?? null,
      options: {
        recentImageAttachments: collectRecentImageAttachments(request.messages),
        tools: request.tools,
        commands: [],
        mainLoopModel: this._model,
        mcpClients: [],
        apiKey: this.apiKey,
        baseURL: this.baseURL,
        authStyle: this.authStyle,
        provider: this.provider,
        sessionId: turnContext.sessionId ?? undefined, // Pass sessionId for task persistence
        // Plan 481: bot identity for identity-bound tools (update_state).
        agentProfileId: options?.agentProfileId ?? null,
        workingDirectory: turnContext.workingDirectory ?? undefined, // Pass working directory for tool execution
        // Plan 525 / 408 follow-up: project-entity home directory propagated
        // into the ToolUseContext so sub-agents spawned from this turn (via
        // the SubagentTool) can hand it down into their own
        // promptSystem.buildContext -> preBuildHook -> initializeAgentsMd.
        // Undefined when no project is bound.
        projectHome: this.projectHome,
        language: turnContext.language ?? undefined, // Propagate language preference to sub-agents
        agentDefinitions: {
          activeAgents: resolved.agentDefinitions,
          allAgents: resolved.agentDefinitions,
        },
        analyzeImage: this.visualAnalysis.analyzeImage.bind(this.visualAnalysis),
        // Phase 2A worker closure: providerName -> internalKey resolver.
        // StreamingToolExecutor consults this for every model-returned tool
        // name. The closure is stable for the lifetime of the executor (per
        // turn), but the underlying map is mutated in place by
        // setActiveMCPRuntime so reload takes effect for the next turn without
        // re-creating the executor.
        resolveMCPProviderToolName: (name: string) =>
          this.resolveMCPToolNameToInternalKey(name),
        mcpToolExecutors: this.buildMCPToolExecutors(request.tools),
      },
      // Permission callback - passed from ChatOptions by API route
      requestPermission: options?.requestPermission,
      // IPC for conductor executor communication. sendToMain powers the
      // connector elicitation cards (connect_app / reauth) -- always injected
      // by agent-process-entry (plan 312), forwarded here so bot sessions can
      // surface a connect card (plan 503).
      sendToMain: options?.conductorIpc?.sendToMain,
      // IPC for conductor executor communication
      ipcRequest: options?.conductorIpc?.ipcRequest,
      // Plan 224 Phase 3: mode modifiers surface fields like
      // `conductorCanvasId` via `toolUseContextPatch` (populated by
      // `conductorMode.hooks.onEnter`). Spread it here so every canvas tool
      // sees the bound canvasId without the LLM passing it explicitly. Falls
      // back to the legacy `options.conductorCanvasId` for safety when no
      // mode modifier is active.
      conductorCanvasId:
        (this.modeCtx?.toolUseContextPatch?.conductorCanvasId as string | undefined) ??
        options?.conductorCanvasId,
      canvasTarget: {
        canvasId:
          (this.modeCtx?.toolUseContextPatch?.conductorCanvasId as string | undefined) ??
          options?.conductorCanvasId,
      },
      // Propagate canvas_manage's switch/create-with-switchTo back into the
      // persistent modeCtx so the NEXT turn's toolUseContextPatch reflects
      // the new target. Without this, intra-run cross-turn canvas switches
      // revert to the canvas bound at streamChat start.
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

    // Hand this turn's context to the meta-tool dispatcher wired before the
    // turn loop. Reassigned every turn so `tool_invoke` always sees the
    // CURRENT context (abortController, appState and sessionId are per-turn).
    request.bindToolUseContext(toolUseContext);
    resolved.catalogTool.setContextView(toolUseContext, resolved.catalogView);
    resolved.toolInvokeExecutor.setDispatcherForContext(
      toolUseContext,
      request.toolInvokeDispatcher,
    );

    const executor = new ToolExecutionPipeline(
      resolved.registry,
      request.canUseTool,
      toolUseContext,
    );

    // Plan 600 S2: hand this turn's pipeline to the run engine.
    //
    // Published per turn, beside the construction, and NOT hoisted: a hoisted
    // pipeline goes permanently mute after the first `discard()` on the
    // model-retry path and fails silently, which
    // `tool-pipeline-turn-lifetime.test.ts` pins. The publisher supersedes
    // the previous turn rather than retaining it, so no long-lived instance is
    // reachable from here.
    //
    // Absent publisher means no engine is bound to this run, which is the
    // pre-plan case (the CLI, the sub-agent tool) and is not an error.
    request.publisher?.publish(request.turn, executor);

    return executor;
  }

  /**
   * Plan 610 A3-2b7 (S1): assemble ONE turn.
   *
   * ## Why this exists
   *
   * The engine calls `ContextPort.assemble` once per turn
   * (`ports.ts:487`) and needs the provider payload for that turn. Every
   * `assembleTurn` implementation that existed was a test stub: measured over
   * `packages/`, the port had TWO declarations, TWO forwarders and ELEVEN
   * implementations, and all eleven were inside `__tests__`. The port the engine
   * calls once per turn had no production body at all, so "bind the ports and
   * flip the driver" was never a wiring change -- the assembly had to exist
   * first. This is that body.
   *
   * ## One implementation, two callers
   *
   * The generator calls THIS, and the composition's host will call THIS. Same
   * argument as `buildTurnPipeline` (`:449`) and for the same reason: a
   * separate engine-side assembler would be a second place that decides what a
   * turn advertises, and two answers that can differ is the failure this
   * repository keeps paying for. Routing the legacy through the seam is what
   * keeps there being one.
   *
   * ## The catalog round moves HERE, and that is the substance
   *
   * `catalogView.currentRound` used to be assigned mid-loop, immediately before
   * the provider request was assembled. It is assigned here instead, at the top
   * of the turn, which is the same VALUE at every point that reads it: nothing
   * between assembly and the old assignment site dispatches a tool, so
   * `recordToolCatalogSchemaRead` (`:3242`) -- the only reader, and it reads on
   * the drain -- still stamps the turn the model is actually in.
   *
   * It moved because a round that the engine cannot set is a round the engine
   * cannot honour: `tool_invoke` asks `getCurrentRound()`, and a tool dispatched
   * on an engine-driven turn would otherwise be stamped with whatever round the
   * last legacy turn happened to leave behind.
   *
   * ## What is deliberately NOT here
   *
   * First-turn prompt admission (`DuyaAgent.ts:2414-2496`) is loop bookkeeping,
   * not assembly. It decides whether the user's prompt is a NEW transcript row
   * or a re-write of the last one, which is a question about the durable
   * timeline; the engine owns its own history and admits its own prompt. Lifting
   * it here would give the engine two owners for one decision.
   */
  assembleTurn(request: TurnAssemblyRequest): TurnAssembly {
    const systemPrompt = this.refreshTurnSystemPrompt(request.systemPrompt);

    // The catalog round this turn advertises. BEFORE the pipeline is built, so
    // `catalogTool.setContextView` (inside the factory) hands the catalog tool a
    // view that is already stamped with the turn that is about to run.
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

  /**
   * Re-evaluate the function-form mode prompt prefixes for this turn.
   *
   * Plan 224 Phase 3: mode state that mutates DURING the stream has to reach
   * the prompt without rebuilding the whole base prompt -- conductor's
   * `widgetStyleHistory` grows as canvas tools push new signatures, so a prompt
   * built once at run start goes stale within the run.
   *
   * The four-clause guard is kept EXACTLY as the loop had it, including the
   * asymmetry that the recomputed prefix REPLACES rather than appends to the
   * incoming prompt. That is deliberate: the prefixes are function-valued, so
   * re-running them against a growing base would duplicate the base on every
   * turn. The guard is reproduced rather than improved because a seam that
   * "fixed" it would change what the model is sent, which is not this slice's
   * mandate.
   *
   * `baseSystemPrompt` is the run's base; it is NOT `request.systemPrompt`. The
   * mode layer is applied on top of the base every turn, which is why the two
   * differ and why passing the incoming prompt here would nest them.
   */
  private refreshTurnSystemPrompt(systemPrompt: string): string {
    if (
      !this.resolvedModes ||
      !this.modeCtx ||
      this.baseSystemPromptWithoutModes === undefined ||
      this.resolvedModes.prompt.prefixes.length === 0
    ) {
      return systemPrompt;
    }

    // Refresh ctx.state with the latest rolling state so prefix builders read
    // current values.
    this.modeCtx.state.widgetStyleHistory = this.widgetStyleHistory;
    let prefix = '';
    for (const p of this.resolvedModes.prompt.prefixes) {
      prefix += typeof p === 'function' ? p(this.modeCtx, this.baseSystemPromptWithoutModes) : p;
    }
    return `${prefix}\n\n${this.baseSystemPromptWithoutModes}`;
  }

  /**
   * Plan 610 A3-2b7 (S1): the catalog half of the schema-read protocol --
   * drop what compaction took out of provider-visible history.
   *
   * ## Why it is a method and not the bare free function at the call sites
   *
   * The three compaction sites (proactive `:2630`, preflight `:3431`, emergency
   * `:3758`) each reached for `invalidateToolCatalogSchemaReads(catalogView)`
   * directly, and the round that decides what those maps MEAN was assigned by
   * hand a fourth time. Four hand-reached pieces of one protocol is the shape
   * that lets a seam skip one of them and pass every structural test: nothing
   * malformed is produced, the dispatcher simply keeps serving a schema it
   * believes was loaded in a round whose history no longer exists.
   *
   * So the protocol gets one owner. The free function stays the implementation
   * -- this is not a reimplementation of it -- and what lives here is the
   * decision of WHEN, which is what the loop was actually expressing.
   *
   * `resolved` rather than a bare view, for the same reason `assembleTurn` takes
   * it: the view is reached through the run's resolved-tools decision, so a
   * caller cannot pair a view from one run with a round from another.
   */
  invalidateTurnCatalogSchemaReads(resolved: ResolvedTurnTools): void {
    invalidateToolCatalogSchemaReads(resolved.catalogView);
  }

  /**
   * Plan 610 A3-2b7 (S1): the drain half of the schema-read protocol.
   *
   * `recordToolCatalogSchemaRead` is called only for a committed tool-role
   * result, and only a real `tool_catalog` receipt counts -- the legacy's
   * `if (result.message.role === 'tool')` guard is INSIDE this method rather
   * than at the call site, because "is this row a tool result" is part of the
   * protocol's answer and a caller that had to remember it could forget it.
   */
  recordTurnCatalogSchemaRead(resolved: ResolvedTurnTools, message: Message): boolean {
    if (message.role !== 'tool') return false;
    return recordToolCatalogSchemaRead(resolved.catalogView, message.metadata);
  }

  /**
   * Plan 610 A3-2b8 (S2): establish the RUN-scoped half of turn assembly.
   *
   * ## One implementation, two callers
   *
   * The generator calls THIS and the composition's host will call THIS. The
   * block this lifts was ~105 lines of closure-local construction at the top of
   * `streamChat` (measured: `_resolveTools` through
   * `createToolInvokeDispatcherFromRegistry`), and all of it was unreachable
   * from outside -- which is why `assembleTurn` being public was not enough for
   * anything to own a turn.
   *
   * ## The three closures, and why each one belongs to the RUN
   *
   * - `canUseTool` + the declared-tools guard: the guard's snapshot is
   *   REPLACED per request rather than per turn (`refreshDeclaredTools`, called
   *   from `runTurnStream`), so a per-turn handle would rebuild a gate that is
   *   meant to be one gate per run holding a moving snapshot.
   * - `toolInvokeDispatcher`: deliberately wired to the UNGUARDED `canUseTool`
   *   (`DuyaAgent.ts:2134`), because a deferred tool is reached precisely by
   *   being absent from the declared set. Guarding it would deny every
   *   `tool_invoke`.
   * - the turn tool-use context cell: written by `assembleTurn` per turn,
   *   read by the dispatcher, and read by NOTHING else in the generator
   *   (measured: 3 uses, all inside this block or the `assembleTurn` call).
   *   So the cell can move here without the loop losing a handle on it.
   *
   * ## `refreshDeclaredTools` reads the LAST ASSEMBLED surface, and why that is the loop's semantics
   *
   * The loop's version closed over its live `tools` variable, which promotion
   * can move. This one reads the surface the most recent `assemble` was given.
   * They agree because the only caller is the provider request opened for that
   * turn, and on a model retry `runTurnStream` loops without a new `assemble`
   * -- so a retry re-snapshots the same turn's surface, exactly as the loop did.
   */
  async beginTurnAssembly(request: RunAssemblyRequest): Promise<RunTurnAssembly> {
    const { options, prompt, appliedProfile, publisher, turnContext } = request;

    const resolved = await this._resolveTools(options, appliedProfile);
    const { registry, catalogView, tools: resolvedTools } = resolved;

    let systemPrompt = await this._buildSystemPrompt(resolvedTools, options, appliedProfile);
    systemPrompt = systemPrompt
      ? `${systemPrompt}\n\n${TOOL_GROUP_PROGRESS_INSTRUCTIONS}`
      : TOOL_GROUP_PROGRESS_INSTRUCTIONS;

    const { canUseTool } = buildPermissions(
      {
        getPermissionMode: () => this.getPermissionMode(),
        hostToolPermission: this.hostToolPermission,
        alwaysAllowRules: this.alwaysAllowRules,
        alwaysDenyRules: this.alwaysDenyRules,
        alwaysAskRules: this.alwaysAskRules,
        additionalWorkingDirectories: this.additionalWorkingDirectories,
        defaultWorkspaceDirectory: this.defaultWorkspaceDirectory,
        getAbortController: () => this.abortController,
        llmClient: this.llmClient,
        model: this.model,
        getMessages: () => this.messages,
        hasPermissionsToUseTool: this.hasPermissionsToUseTool,
        getModeCoordinator: () => this.modeCoordinator,
      },
      turnContext,
      registry,
    );

    // Declared-tools visibility guard. Snapshot of the tools declared on the
    // current provider request. Any model call to a name outside that set is
    // rejected; deferred tools are reached through tool_catalog -> tool_invoke.
    let declaredToolsForRequest = new Set<string>();
    const guardedCanUseTool: typeof canUseTool = async (toolName, toolInput) => {
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
      return canUseTool(toolName, toolInput);
    };

    // Per-turn context handle for the meta-tool dispatcher. Wired BEFORE any
    // turn assembles, so the dispatcher takes a getter rather than the object.
    // Without it, every built-in tool reached through `tool_invoke` executed
    // with `context === undefined` and sessionId / apiKey / ipcRequest were all
    // silently dropped.
    let turnToolUseContext: ToolUseContext | undefined;
    const toolInvokeDispatcher = createToolInvokeDispatcherFromRegistry({
      registry,
      getSnapshot: () => catalogView.snapshot,
      getLoadedSchemaRevision: (toolId) => catalogView.loadedSchemaRevisions.get(toolId),
      getLoadedSchemaRound: (toolId) => catalogView.loadedSchemaRounds.get(toolId),
      getCurrentRound: () => catalogView.currentRound,
      isEligibleTool: (toolId) => catalogView.eligibleToolIds.has(toolId),
      workingDirectory: turnContext.workingDirectory ?? undefined,
      contextProvider: () => turnToolUseContext,
      // Deliberately the UNGUARDED gate: a deferred tool is reached precisely by
      // being outside the declared set, so the dispatcher applies its own
      // `isEligibleTool` check instead of the visibility guard.
      checkPermission: async (toolName, args) =>
        normalizeCanUseToolDecision(await canUseTool(toolName, args)),
    });

    // The surface the next `refreshDeclaredTools()` snapshots. Starts as the
    // run's resolved surface and is replaced by each turn's own.
    let currentTools: readonly Tool[] = resolvedTools;

    return {
      resolved,
      turnContext,
      tools: resolvedTools,
      systemPrompt,
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

  // ==========================================================================
  // Plan 610 A3-2b2: the turn-output seam.
  //
  // `ports.ts:1019-1029` makes `RunEnginePorts.turnOutput` optional and names
  // the live worker's state as the reason, and two of the effects it names had
  // NO reachable seam at all: `PostToolUseFailure` was dispatched through
  // `dispatchHooks`, a closure local of the `streamChat` generator, and the
  // `tool_result` / `mode_changed` frames are `yield`s of that same generator.
  // A composition cannot consume a `yield`.
  //
  // So this is the third instance of the same shape as `claimInterTurn` (`:3689`)
  // and `readModelClient` (`:295`): lift what the composition needs out of the
  // generator's closure onto a method it can call. The difference here is that
  // the lifted effect has TWO halves -- a durable write the host owns and a frame
  // the renderer sees -- and only one of them is a method call.
  //
  // ## The sink exists because the frame half cannot be a return value
  //
  // `_pushDurable` and `modelAttribution` are private, and the engine's
  // `AssistantMessageRecord` doc says so in the host's voice: "modelAttribution
  // -- the HOST's ... the engine has no session and must not invent one"
  // (`agent-runtime/src/engine/ports.ts:816-821`). So the durable half becomes
  // methods (`recordTurnAssistantMessage`, `recordTurnToolResult`) and the FRAME
  // half becomes a sink the run binds, because the renderer consumes those frames
  // today as generator yields and a caller outside the generator has no other way
  // to receive one.
  //
  // ## Why the legacy cannot duplicate a frame, and why the unbind is still there
  //
  // Two separate facts, because only one of them is a guard and conflating them
  // would make a dead line look load-bearing.
  //
  //  - NO DUPLICATION is structural: nothing inside `streamChat` publishes to the
  //    sink. The legacy's frames are `yield`s of the generator and its consumer
  //    is unchanged, so there is exactly one writer per frame whatever the sink
  //    is bound to. `turn-output-seam.test.ts` asserts the observable half.
  //  - LIFETIME is the unbind: the agent is long-lived and a sink is a per-run
  //    object, so a binding left behind by an engine-driven run would make a
  //    LATER legacy run address a finished run's receiver. Removing the unbind
  //    turns that file red, so it is a real guard rather than a precaution.
  // ==========================================================================

  /**
   * Bind (or unbind, with `null`) this run's receiver for the frames the legacy
   * generator yields.
   *
   * PUBLIC, for the reason the header gives. Deliberately a BIND rather than a
   * subscription a caller can observe without asking: a run either owns the
   * frames or it does not, and two observers of one run's frames is the
   * double-render this seam would otherwise permit.
   */
  bindTurnOutputSink(sink: TurnOutputSink | null): void {
    this.turnOutputSink = sink;
  }

  /** The bound sink, or `null`. Diagnostics and assertions. */
  readTurnOutputSink(): TurnOutputSink | null {
    return this.turnOutputSink;
  }

  /**
   * One landed tool result: the durable write, the `tool_result` frame, the
   * `mode_changed` frame, and `PostToolUseFailure` when it failed.
   *
   * The four effects in the order the legacy performs them
   * (`:2824-2926`), each routed through the SAME private helper the legacy's
   * own `yield` uses. That is the property worth having: the frame the engine's
   * port publishes and the frame the legacy publishes are built by one function,
   * so a second copy of this logic cannot drift away from the product's.
   *
   * ## What it deliberately does NOT do
   *
   * `recordToolCatalogSchemaRead` (`:2831`) is skipped. It needs `catalogView`,
   * which is a per-turn local built inside `_resolveTools` (`:4014`) and rebound
   * every turn; there is no field holding it and hoisting one is the driver
   * flip's decision, not a seam's. Stated here rather than left to be
   * discovered, because a schema-read ledger that silently stops recording is
   * exactly the class of defect this method's other doc comments keep refusing.
   *
   * Nor does it push into the legacy's `messages` array. That array is the
   * generator's working context and the engine seeds its own next request from
   * `assembled.messages` (`run-engine.ts:900`), so there is nothing for this to
   * push into -- and the durable half, `_commitDurable`, is the part that is
   * real.
   */
  async recordTurnToolResult(input: {
    readonly message: Message;
    /** `ToolResultRecord.toolName`; `''` when the engine did not dispatch it. */
    readonly toolName: string;
    readonly seqIndex: number;
  }): Promise<void> {
    const { message } = input;
    message.seq_index = input.seqIndex;
    if (!message.id) message.id = crypto.randomUUID();
    this._commitDurable(message);

    const outcome = this._readToolResultOutcome(message);
    this._publishTurnFrame(this._buildToolResultFrame(message, outcome));

    // Plan 426 follow-up. The legacy reads the failed tool's name off its own
    // per-turn map (`turnToolCallIds`, `:2874`); the engine carries it on the
    // record instead, which `ToolResultRecord.toolName` documents as the same
    // value including the `''` fallback.
    if (outcome.isError) {
      await this.dispatchPostToolUseFailure({
        session_id: this.sessionId ?? '',
        cwd: this.workingDirectory ?? '',
        hook_event_name: 'PostToolUseFailure',
        tool_name: input.toolName,
        tool_input: {},
        tool_use_id: outcome.id,
        error: outcome.content.slice(0, 2048),
      }, { toolName: input.toolName || undefined });
    }

    const modeChanged = this._buildModeChangedFrame(input.toolName, outcome);
    if (modeChanged !== null) this._publishTurnFrame(modeChanged);
  }

  /**
   * One turn's assistant message, in the transcript's own vocabulary.
   *
   * PUBLIC, and the reason is the one `AssistantMessageRecord` gives: `id`,
   * `timestamp` and `seq_index` are "the writer's" and `modelAttribution` is
   * "the HOST's" (`agent-runtime/src/engine/ports.ts:810-826`). The engine
   * carries content and usage; the row's identity and its model attribution come
   * from here, so this is the only place that can assemble a row the next
   * request's `transformMessages.isSameModel` will recognise.
   */
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
    if (input.usage !== undefined) (row as AssistantMessage).usage = input.usage;
    this._commitDurable(row);
  }

  /**
   * The drain ended. Forwards `TurnOutputSummary` to the bound sink.
   *
   * PUBLIC because `TurnOutputPort.finishTurn` is a port method, and it is a
   * forwarding seam rather than a decision: the legacy's `toolResultMessageCount`
   * gate reads the count the SINK reported, and there is no count to compute here.
   * A sink-less call is a no-op, which is the state of every run today.
   */
  finishTurnOutput(summary: TurnOutputSummary): void {
    this.turnOutputSink?.finishTurn(summary);
  }

  /**
   * Dispatch `PostToolUseFailure` for a caller that is not the generator.
   *
   * PUBLIC, and the same lift as the three above: the legacy dispatches through
   * `dispatchHooks` (`:1134`), a closure local holding a `ConfigHooksRunner` built
   * per `streamChat`. Without this the failure hook is unreachable outside the
   * generator, and a tool that fails under the engine would run no hook at all --
   * a silent behavioural difference from the legacy, and the kind nobody notices
   * until a hook's whole job was gating something.
   *
   * Fail-open and one-way, matching `dispatchHooks`: a hook that throws logs WARN
   * and yields `null` rather than failing the turn. The `prompt` var the legacy
   * passes is NOT reproduced -- an outside caller has no prompt -- and it is named
   * rather than defaulted to a value that would let a matcher read an empty
   * string as if it were the user's words.
   */
  async dispatchPostToolUseFailure(
    input: EventHookInput,
    targets?: EventHookMatcherTargets,
  ): Promise<EventHookRunResult | null> {
    const runner = new ConfigHooksRunner({
      cwd: this.workingDirectory ?? process.cwd(),
      vars: { sessionId: this.sessionId ?? '', cwd: this.workingDirectory ?? '' },
    });
    try {
      return await runner.run('PostToolUseFailure', input, targets);
    } catch (err) {
      logger.warn(
        `[Hooks] PostToolUseFailure dispatch failed (skipped): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** The frames this run's sink receives. Bound per run; see the header. */
  private turnOutputSink: TurnOutputSink | null = null;

  /** Hand one frame to the bound sink. A no-op while the legacy drives. */
  private _publishTurnFrame(event: SSEEvent): void {
    this.turnOutputSink?.publish(event);
  }

  private llmClient: AIClient;
  /** Dedicated compaction client when a `compact_model` is configured. */
  private compactClient?: AIClient;
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
  /**
   * Plan 536 L1: project ID resolved at session bootstrap from
   * `workingDirectory` (via the agent server's
   * `projects:resolveProject` IPC). Threaded into every
   * `ctx.options.currentProjectId` so project-scoped tools (plan tool,
   * research-memory, etc.) can pick it up without the model having to
   * pass projectId explicitly. Null when cwd is outside any registered
   * project.
   */
  private currentProjectId?: string | null;
  /**
   * Plan 525 / 408 follow-up: project-entity home directory
   * (`~/.duya/projects/<projectId>/`). Set from `AgentOptions.projectHome`
   * at construction; threaded into `promptSystem.buildContext` so the
   * AGENTS.md loader can read `<projectHome>/AGENTS.md` as a
   * `'Project entity'` source. Undefined when the session is not bound
   * to any registered duya project.
   */
  private projectHome?: string;
  private defaultWorkspaceDirectory?: string; // Default workspace directory for permission checking
  private communicationPlatform?: import('../prompts/types.js').CommunicationPlatform; // Communication platform for prompt injection
  private language?: string; // Language preference for agent responses
  private permissionMode: PermissionMode = 'default'; // Permission mode for tool execution
  /**
   * Plan 487: host-level standing permission switch. Set from
   * `options.hostToolPermission` (or the `agent:reinit-provider` IPC payload
   * in phase 2). Optional 鈥?undefined falls back to `'ask'`.
   */
  private hostToolPermission?: LocalToolPermission;
  private hasPermissionsToUseTool: ReturnType<typeof createHasPermissionsToUseTool>;
  // Plan 498: per-turn approval-ledger consume callback + "Always allow this
  // tool" grants (persisted approval cards). Set from streamChat options.
  private _consumeApprovedEffect?: (
    toolName: string,
    toolInput?: Record<string, unknown>,
  ) => Promise<boolean>;
  private _turnAlwaysAllowTools: Set<string> = new Set();
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
   * Plan 430 鈥?additionalContext lines from the UserPromptSubmit hook
   * (the DUYA memory-RAG hook among them). Captured once per `streamChat`
   * call right after the hook dispatch runs, then drained into the first
   * `_projectModelMessages` projection so the model sees the memory block
   * on its first turn instead of having to wait for an async + asyncRewake
   * notification to land at the next checkpoint (which never injected it
   * into the conversation model-side 鈥?the pre-plan-430 wire just logged
   * the contexts and threw them away). Source-tagged `custom`, hidden
   * visibility (model-only, no transcript card) 鈥?same shape as loop-hook
   * steering nudges so it goes through the same provider projection.
   *
   * Cleared after the first injection so re-projections within one
   * `streamChat` (post-compaction refresh) do not duplicate the block.
   */
  private promptContexts: string[] = [];

  /**
   * Context-injection hardening: hook context blocks already delivered to
   * the model this run (UserPromptSubmit / SessionStart). Kept after the
   * initial drain so a mid-run compaction re-projection can restore any
   * block the transient runtime-context layer lost. Reset per streamChat.
   */
  private promptContextBlocks: string[] = [];

  /**
   * Plan 579: token cost of the transient `<skill>` mention injections this
   * run, keyed by skill name (dedup across re-mentions within the run). The
   * projection rail these bodies ride is invisible to the message-timeline
   * scan, so the context composition takes them from here (skillParts
   * option) instead — same treatment as memory-recall payloads. Reset per
   * streamChat, matching promptContextBlocks' lifecycle.
   */
  private injectedSkillParts: Map<string, number> = new Map();

  /** Plan 579: labelled token parts for the run's injected skill bodies. */
  getInjectedSkillParts(): Array<{ label: string; tokens: number }> {
    return [...this.injectedSkillParts.entries()].map(([label, tokens]) => ({ label, tokens }));
  }
  /**
   * Plan 517 P2.1: turn-based cooldown to prevent the compaction-loop bug.
   * `lastCompactionTurn` is the streamChat-local turn number at which the
   * last proactive compaction succeeded; combined with `MIN_TURNS_SINCE_COMPACT`
   * it forces the next `N` turns to skip the proactive checkpoint, even
   * when `shouldCompact()` would otherwise return true. Pi/grok-style
   * design — let the agent run at least `N` tool-use turns before we
   * consider compacting again.
   */
  private lastCompactionTurn = -Infinity;
  /**
   * Plan 550 step 2c: per-session CompactionCoordinator handle. Built
   * once at construction (the deps are all session-scope); `streamChat`
   * calls `runPreTurn` once per turn and forwards the resulting SSE
   * events back to the renderer.
   */
  private compactionCoordinator: CompactionCoordinator;
  /**
   * Plan 517 P2.3: token-based cooldown. `lastCompactionObservedTokens`
   * captures the `observedPromptTokens` value at the most recent
   * successful compaction. Combined with `MIN_TOKENS_GROWTH_SINCE_COMPACT`
   * it requires the new turns to have grown the context by at least this
   * many tokens before another compaction can fire.
   */
  private lastCompactionObservedTokens: number | undefined = undefined;
  /**
   * Plan 517 P2.1: counters and thresholds are config-driven so future
   * sessions can tune them per profile / per workspace.
   */
  static readonly MIN_TURNS_SINCE_COMPACT = 3;
  static readonly MIN_TOKENS_GROWTH_SINCE_COMPACT = 30_000;
  /**
   * Plan 437: hook invocations emitted during this `streamChat` call,
   * in arrival order. Drained by `drainPendingHookMessages()` at the
   * turn-end boundary in `agent-process-entry` and persisted as
   * `msg_type: 'hook_invocation'` rows so reload / cross-device sync
   * keep the hook history visible alongside tool_use / tool_result.
   *
   * Plan 550 step 2e (TurnPreparer, side-quest slice): wrapped in
   * a `PendingHookMessages` instance so the FIFO contract is
   * unit-testable in isolation and the `push` / `drain` API surfaces
   * at named methods rather than `array.push` / `slice()`.
   */
  private readonly pendingHookMessages = new PendingHookMessages();
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
   * Estimated tokens of the system prompt + tool definitions of the last
   * LLM request (excluding message history). Used by the live context
   * ring's no-usage fallback 鈥?mirrors pi's estimateContextTokens prefix
   * accounting, which adds systemPrompt + tools when no usage block exists.
   */
  private lastSystemContextTokensEstimate = 0;
  /**
   * Plan 577 §4: the system-prompt and tool-definition halves of the
   * estimate above, kept separately so the ContextComposition diagnostics
   * can bucket them without re-stringifying the whole surface.
   */
  private lastSystemTokensEstimate = 0;
  private lastToolsTokensEstimate = 0;
  /**
   * Plan 577 §3: the compaction window + its resolution source, refreshed
   * in the constructor and on every streamChat drift check. The worker's
   * emitLiveUsage reads it so the ring and the compaction budget state the
   * same windowSource (the 200K-fallback split becomes visible).
   */
  private resolvedWindow: { contextWindow: number; windowSource: 'capability' | 'catalog' | 'default' } = {
    contextWindow: 0,
    windowSource: 'default',
  };
  /**
   * Mode context for the current streamChat call. Holds
   * `toolUseContextPatch` (consumed by the tool executor) and
   * `state` (read by mode prompt builders and hooks).
   */
  private modeCtx?: ModeModifierContext;
  /** Mode state-machine coordinator (plan 413d). Rebuilt per streamChat call. */
  private modeCoordinator?: ModeCoordinator;
  /**
   * Phase 2: optional ProviderRuntimeConfig delivered by the main
   * process. The agent currently does not consume it directly (the
   * legacy `apiKey / baseURL / provider` fields stay authoritative
   * for the LLM client factory). Future agent code can use this to
   * bypass `inferProvider(baseURL)` heuristics.
   */
  readonly runtimeConfig?: AgentOptions['runtimeConfig'];

  /**
   * Model attribution carried on every assistant message pushed by the
   * streaming loop. Values mirror the llmClientOptions below exactly (same
   * apiFormat/providerId/model expressions the @duya/ai client resolves),
   * so transformMessages.isSameModel keeps thinking blocks native (signed)
   * on mid-run replays instead of downgrading them to plain text.
   */
  private readonly modelAttribution: {
    providerId: string;
    model: string;
    api: ApiFormat;
  };

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
  /** Profile resolved by the most recent `streamChat` call (undefined if none). */
  private lastAppliedAgentProfile: AgentProfile | undefined;
  /** When true, skip the first-turn AGENTS.md injection (Plan 408 Phase 2). */
  private readonly omitAgentsMd: boolean = false;

  /**
   * Plan 474: lazily-created bot prompt assembly (identity/roster/etc.).
   * Kept per agent instance so the registered section catalog is stable
   * across streamChat calls; only the rendered output is per-build.
   */
  private botAssembly: BotPromptAssembly | null = null;

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
    this.omitAgentsMd = options.omitAgentsMd === true;

    // Model is required - no hardcoded defaults
    if (!options.model) {
      throw new Error(
        `Model is required. Please specify a model in your provider settings. ` +
        `Provider: ${provider}, BaseURL: ${options.baseURL || 'not provided'}`
      );
    }

    const baseURL = options.baseURL || resolveDefaultBaseURL(provider);
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
    // apiFormat/providerId/modelCompat flow: ProviderRuntimeAdapter 鈫?    // runtimeConfig 鈫?DuyaAgent 鈫?createAIClient 鈫?@duya/ai createAIClient.
    const llmClientOptions: AIClientOptions = {
      apiKey: options.apiKey,
      baseURL,
      model,
      authStyle: options.authStyle,
      apiFormat: options.runtimeConfig?.apiFormat ?? (provider === 'ollama' ? 'ollama' : provider === 'anthropic' ? 'anthropic' : 'openai-chat'),
      providerId: options.runtimeConfig?.providerId ?? provider,
      modelCapabilities: options.runtimeConfig?.modelCompat,
      // Prompt-cache retention per provider (anthropic/vertex 鈫?1h TTL on
      // their native endpoints; everything else falls back to 'short').
      cacheRetention: resolveCacheRetention(provider),
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

    this.modelAttribution = {
      providerId: llmClientOptions.providerId,
      model: llmClientOptions.model,
      api: llmClientOptions.apiFormat,
    };

    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL;
    this.authStyle = options.authStyle;
    this.workingDirectory = options.workingDirectory;
    // Plan 536 L1: project ID resolved at session bootstrap, propagated
    // to every ctx.options so project-scoped tools (plan tool, etc.)
    // can use it without the model having to pass projectId explicitly.
    this.currentProjectId = options.currentProjectId ?? null;
    // Plan 525 / 408 follow-up: project-entity home directory
    // (`~/.duya/projects/<projectId>/`). When the agent server resolves a
    // project from the cwd, `projects:resolveProject` returns
    // `paths.projectHome` and the main process passes it through here so
    // the agentsmd loader can read `<projectHome>/AGENTS.md` as a
    // `'Project entity'` source. Threaded into `promptSystem.buildContext`
    // in `_buildSystemPrompt`. Undefined when no project is bound.
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

    // Initialize vision model client if configured
    this.visualAnalysis = new VisualAnalysisService(
      options.visionConfig,
      resolveDefaultBaseURL,
    );

    // Initialize a dedicated compaction client when a compact_model is enabled.
    this.compactClient = buildCompactClient(options.compactModelConfig);

    // AGENTS.md is loaded eagerly in streamChat via refreshForTask so it is
    // always available before the first provider request and before any prompt
    // section is resolved.

    // Wire the model-level `contextWindow` (e.g. 1M for a 1M-context model)
    // into the compaction budget. Resolution order (plan 522): runtime
    // capability → @duya/ai catalog → 200K default. The catalog layer
    // matters because the plain chat path does not always attach a
    // capability row; without it the ring can read 1M while compaction
    // still fires at the 200K fallback.
    const resolvedContextWindow = resolveCompactionContextWindow({
      capabilityContextWindow:
        options.runtimeConfig?.modelCapabilities?.contextWindow,
      modelId: options.runtimeConfig?.model ?? options.model,
    });
    if (resolvedContextWindow.source === 'default') {
      // Plan 517 R1: surfaces the silent 200K fallback so users can fix
      // their config (custom / OpenRouter model ids need a manual marker).
      logger.warn(
        '[Agent] compaction contextWindow fallback to 200000 — neither runtimeConfig.modelCapabilities.contextWindow nor the @duya/ai catalog declares a window for this model. ' +
          'Add [options].model_context[modelId] = N in config.toml or a DB override row to recover the real window.',
        {
          runtimeConfigHasCapabilities:
            options.runtimeConfig?.modelCapabilities !== undefined,
          model: options.runtimeConfig?.model ?? options.model,
          apiFormat: options.runtimeConfig?.apiFormat,
        },
        'AgentCore',
      );
    }
    this.compactionManager = createCompactionManager({
      enableReinjection: true,
      maxTokens: resolvedContextWindow.contextWindow,
    });
    // Plan 577 §3: seed the ledger's window/model lineage from the same
    // resolution the budget used — one source of truth for windowSource.
    this.resolvedWindow = {
      contextWindow: resolvedContextWindow.contextWindow,
      windowSource: resolvedContextWindow.source,
    };
    this.compactionManager.getContextLedger().noteModelSwitch(
      {
        contextWindow: resolvedContextWindow.contextWindow,
        windowSource: resolvedContextWindow.source,
      },
      options.runtimeConfig?.model ?? options.model,
    );

    // Plan 517 P2.2: forward the over-threshold event so the renderer can
    // surface a "auto-compaction paused" hint. The loop brake itself
    // (suppress('size')) is applied synchronously inside CompactionManager;
    // this hook is informational only.
    this.compactionManager.addEventHandler((event) => {
      if (event.type === 'compaction_over_threshold') {
        logger.warn(
          `[Agent] Compaction over threshold: retained=${event.tokensRetained}, available=${event.available} — ` +
            `auto-compaction suppressed until next successful shrink`,
        );
      }
      // Plan 567 §C: compaction drops the injected one-shot nested AGENTS.md
      // user-role messages from history, but the manager's session-level
      // loaded set would keep blocking re-injection forever. Release the set
      // on compaction completion so the next file-touching turn re-injects
      // the dropped reminders through the normal trigger-path channel (the
      // content-hash dedup prevents double injection within one request).
      if (event.type === 'compaction_complete') {
        const released = getAgentsMdManager().releaseNestedMemoryForReinject(
          this.workingDirectory,
        );
        if (released > 0) {
          logger.info(
            `[Agent] Compaction released ${released} nested AGENTS.md path(s) for re-injection`,
            undefined,
            'AgentsMd',
          );
        }
      }
    });

    // Wire up the LLM summarizer so strategies can generate summaries
    this.compactionManager.setSummarizer(async (text: string, prompt: string): Promise<string> => {
      // Plan 523 P4.2: put the instructions directly inside the user message
      // (alongside the transcription) so a gateway that weakens/ignores the
      // `system` field still delivers the 9-section contract. The prompt
      // already contains the conversation plus the summarization instructions.
      const summaryMessages: Message[] = [
        {
          role: 'user',
          content: prompt,
        },
      ];

      // Use a child abort controller linked to the agent's main
      // abortController so user interrupts also cancel the summarizer.
      const childController = this.abortController
        ? createChildAbortController(this.abortController)
        : new AbortController();

      try {
        const result = await createOneShotTextPort(this.compactClient ?? this.llmClient).complete(
          {
            // Do NOT pass `prompt` here. The prompt already carries the full
            // <conversation> transcript + instructions, and Plan 523 P4.2 puts it
            // in the user message (summaryMessages above) so gateways that weaken
            // the `system` field still see the contract. Duplicating it into
            // `system` doubled the summarizer request size (~2x the conversation),
            // so near the window limit the summarizer itself failed with
            // context_length_exceeded on every attempt — compaction could never
            // succeed and the session wedged at usage_limited (bot:duya, 2026-09-23).
            systemPrompt: 'You are a summarization assistant. Follow the instructions embedded in the user message.',
            messages: fromProviderMessages(summaryMessages),
            // Plan 523 P4.3: 4096 clipped long-session summaries (unclosed-tag
            // producer). 8192 + self-trim instruction in the prompt guards the
            // new ceiling.
            //
            // Plan 523 P4.1's `toolChoice: 'none'` is no longer passed here: the
            // port sends it unconditionally, and it omits `tools` entirely
            // (`run-engine-model.ts:612-631`), which is the stronger promise.
            maxOutputTokens: 8192,
            temperature: 0.3,
          },
          // The port threads this to the provider UNWRAPPED, so the linkage
          // above is what a user interrupt travels along.
          childController.signal,
        );

        if (result.kind === 'completed') {
          // The trim stays here: it is a storage decision (what to persist as
          // the compaction summary), and the port deliberately returns the
          // provider's text untrimmed.
          return result.text.trim();
        }
        if (result.kind === 'failed') {
          // BEHAVIOUR CHANGE, owner ruling requested (plan 600 S2 step b2).
          //
          // This arm used to `break` and return the text accumulated so far,
          // so a provider `error` frame mid-summary stored a truncated
          // summary. `OneShotTextResult` carries no partial text on `failed`
          // (`ports.ts:1744-1747`), so the partial value is no
          // longer reachable, and the only remaining options were "throw" or
          // "return a bare ''". b1 chose throw (`ports.ts:1674-1680`).
          //
          // What that changes, measured through the retry ladder
          // (`compact/summaryRetry.ts:199-242`): an `error` frame after usable
          // text used to be `outcome: 'success'` and stored. Now it is
          // classified by the provider's own words, so `context_length_exceeded`
          // still shrinks the input and retries, but an unmarked message
          // (`'upstream_error'`) is `fatal` and escalates to the suppression
          // machine instead of storing a partial summary. A transport throw was
          // already on that path, so this makes the frame case join it.
          throw new Error(result.error.message);
        }
        // `cancelled`: the provider's AbortError used to propagate out of the
        // `for await`, so re-raising keeps the ladder's classification (an
        // abort message matches no retryable marker -> `fatal`) and keeps an
        // interrupt from reading as an outage.
        throw childController.signal.reason instanceof Error
          ? childController.signal.reason
          : new Error('Compaction summarization was cancelled');
      } finally {
        // Dispose the parent handler to avoid leaking it on the
        // main abortController's signal.
        const disposable = childController as AbortController & { dispose?: () => void };
        disposable.dispose?.();
      }
    });

    // Wire a memory-flush sink: after each compaction, persist the summary to
    // the DUYA sessions root (alongside rollout files, mirroring Codex's
    // `~/.codex/sessions/` layout) so important context survives the history
    // drop 鈥?without polluting the memory store with raw compaction byproducts.
    // Best-effort 鈥?gated by the same memory enable flag used by the wakeup
    // helper, and failures are swallowed (they never break compaction).
    this.compactionManager.setMemoryFlushFn(async (summary: string) => {
      if (!isMemoryEnabled()) return
      const session = this.sessionId
      if (!session) return
      const sessionsRoot = this.sessionsRootPath()
      if (!sessionsRoot) return
      // Bucket by UTC day so the file sits in `sessions/<YYYY>/<MM>/<DD>/`
      // next to that day's rollout files 鈥?matches MessageLog.resolvePath's
      // UTC date-bucketing convention.
      const now = new Date()
      const yyyy = String(now.getUTCFullYear()).padStart(4, '0')
      const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
      const dd = String(now.getUTCDate()).padStart(2, '0')
      const stamp = now.toISOString().replace(/[:.]/g, '-')
      const dayDir = path.join(sessionsRoot, yyyy, mm, dd)
      fs.mkdirSync(dayDir, { recursive: true })
      const file = path.join(dayDir, `${session}-${stamp}-compaction.md`)
      fs.writeFileSync(
        file,
        `# Compaction summary\n\n${summary}\n`,
        'utf8',
      )
    });

    // Initialize permission system
    this.permissionMode = options.permissionMode || 'default';
    this.hostToolPermission = options.hostToolPermission;
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

    // Plan 550 step 2c: per-session CompactionCoordinator wraps the
    // proactive-compaction lifecycle that previously lived inline in
    // `streamChat`. Built once at construction; the agent hands it the
    // (turnCount, systemPromptContent, messages) triple at the top of
    // each turn and receives back the projected pair plus the SSE
    // events the renderer expects to see in lifecycle order.
    this.compactionCoordinator = new CompactionCoordinator({
      compactionController: this.compactionController,
      compactionManager: this.compactionManager,
      projectModelMessages: (systemPrompt, options) =>
        this._projectModelMessages(systemPrompt, options),
      onMessagesCompacted: this.onMessagesCompacted,
      getMessages: () => this.messages,
      getLastCompactionTurn: () => this.lastCompactionTurn,
      setLastCompactionTurn: (turn) => {
        this.lastCompactionTurn = turn;
      },
      getLastCompactionObservedTokens: () => this.lastCompactionObservedTokens,
      setLastCompactionObservedTokens: (tokens) => {
        this.lastCompactionObservedTokens = tokens;
      },
      getMinTurnsSinceCompact: () => duyaAgent.MIN_TURNS_SINCE_COMPACT,
      getMinTokensGrowthSinceCompact: () =>
        duyaAgent.MIN_TOKENS_GROWTH_SINCE_COMPACT,
    });
  }

  private _model!: string;
  /**
   * Snapshot of the model id observed at the end of the previous streamChat
   * call. Used to detect model switches at the top of streamChat so the
   * grok-aligned `maybe_compact_on_model_switch` trigger fires.
   */
  private _lastSeenModel?: string;
  get model(): string {
    return this._model;
  }
  set model(value: string) {
    this._model = value;
    // Model id is read by _buildSystemPrompt 鈫?promptSystem.buildContext({ modelId: this.model })
    // on every turn, so no separate prompt-manager sync is needed here.
  }

  /**
   * Resolve the DUYA sessions root (default `~/.duya/sessions`, mirroring
   * Codex's `~/.codex/sessions/` rollout layout), honouring an optional
   * override via the `DUYA_SESSIONS_ROOT` env var. Returns null when
   * the home directory is unavailable.
   */
  private sessionsRootPath(): string | null {
    if (process.env.DUYA_SESSIONS_ROOT) return process.env.DUYA_SESSIONS_ROOT;
    const home = os.homedir();
    if (!home) return null;
    return path.join(home, '.duya', 'sessions');
  }

  /**
   * Resolve the DUYA memory root (default `~/.duya/memory`), honouring an
   * optional override via the `DUYA_MEMORY_ROOT` env var. Returns null when
   * the home directory is unavailable.
   */
  private memoryRootPath(): string | null {
    return getDuyaMemoryRoot()
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
    // Plan 441: per-turn journal propagation. _pushDurable reads this so
    // journal emits carry the turn id without each call site threading it
    // through. Reset on every streamChat so a follow-up turn gets a fresh
    // value rather than the previous turn's leftover.
    this.currentTurnId = options?.turnId ?? null;
    // Plan 486: reset the fork-turn marker every streamChat call (see the
    // field doc for semantics).
    this.forkTurn = null;
    // Plan 610 A3-2b2: the legacy OWNS this run's frames, so any turn-output
    // sink a caller bound beforehand is taken away here.
    //
    // Not about duplication -- nothing in this generator publishes to the sink,
    // so a frame has one writer either way (see the seam block's header). This
    // is the LIFETIME half: the agent outlives the run, and a sink is a per-run
    // object, so a binding that survived here would leave a later legacy turn
    // addressing a finished run's receiver.
    //
    // Same placement and same reason as the two resets above: whoever starts the
    // generator owns the turn.
    this.turnOutputSink = null;
    // Plan 498: per-turn approval-ledger consume + always-allow grants.
    this._consumeApprovedEffect = options?.consumeApprovedEffect;
    this._turnAlwaysAllowTools = new Set(options?.approvedAlwaysAllowTools ?? []);
    // Plan 550 step 2a-5: assemble the per-turn TurnContext once at
    // the top of every streamChat call. The current generator body
    // still reads from the local fields above; follow-up commits
    // replace those reads with `turnContext.xxx` one field at a time
    // so the diff stays reviewable. Until then the local store is
    // the source of truth.
    const turnContext = this.assembleTurnContext(options, prompt);
    logger.info(`[Agent] streamChat started, sessionId=${turnContext.sessionId ?? 'null'}, model=${this._model}, provider=${this.provider}, turnId=${this.currentTurnId ?? 'null'}`);

    // Plan 426 follow-up: configured [hooks] events dispatched outside the
    // loop bus (SessionStart / UserPromptSubmit / PreToolUse / Stop / 鈥?.
    // One runner per streamChat call; config is read fresh so edits
    // hot-reload on the next run. Fail-open: a throwing/failing hook never
    // breaks the run (each dispatch is individually wrapped below).
    const promptText = typeof prompt === 'string' ? prompt : '';
    // Plan 552: deterministic /goal control commands (status/pause/resume/
    // clear) never reach the LLM — the tracker is mutated directly and the
    // turn is answered synthetically. `/goal <objective>` (start) still
    // falls through so the model calls goal_start and begins working.
    if (promptText.startsWith('/goal') && isGoalControlCommand(promptText)) {
      const goalResult = await handleGoalCommand(promptText, {
        sessionId: turnContext.sessionId ?? undefined,
        workingDirectory: turnContext.workingDirectory ?? undefined,
      });
      yield { type: 'text', data: goalResult.reply };
      yield { type: 'done', reason: 'completed' };
      return;
    }
    // Plan 554: deterministic /export /copy /transcript — transcript
    // plumbing never reaches the LLM. /copy rides the chat:clipboard_write
    // SSE event so the renderer performs the clipboard write.
    if (isTranscriptControlCommand(promptText)) {
      const transcriptResult = handleTranscriptCommand(promptText, {
        messages: this.getMessages(),
        sessionId: turnContext.sessionId ?? undefined,
        workingDirectory: turnContext.workingDirectory ?? undefined,
      });
      if (transcriptResult.clipboardText && turnContext.sessionId) {
        sendEvent(buildClipboardWriteEvent(
          turnContext.sessionId,
          transcriptResult.clipboardText,
        ) as unknown as Record<string, unknown>);
      }
      yield { type: 'text', data: transcriptResult.reply };
      yield { type: 'done', reason: 'completed' };
      return;
    }
    // Plan 437: build a self-referential emitter so the runner can fire
    // `agent_progress` SSE events with `type: 'hook_invoked'`. The
    // emitter queues events into a buffer that's flushed alongside the
    // other yields further down (avoids interleaving issues with the
    // generator control flow). The closure captures the agent's
    // streaming surface; nested `yield` would require extracting each
    // call site into its own helper, which we avoid here for diff size.
    const pendingHookEvents: SSEEvent[] = [];
    const configHooks = new ConfigHooksRunner({
      cwd: turnContext.workingDirectory ?? process.cwd(),
      vars: {
        sessionId: turnContext.sessionId ?? '',
        cwd: turnContext.workingDirectory ?? '',
        prompt: promptText,
      },
      onHookInvoked: (hookEvent) => {
        // Yield-equivalent: buffer the event so the surrounding code
        // flushes them through the existing SSE pipeline.
        pendingHookEvents.push({
          type: 'agent_progress',
          data: {
            type: 'hook_invoked',
            hookEvent,
            sessionId: turnContext.sessionId ?? '',
          },
        });
        // Plan 437: also persist a Message row for this hook event so
        // reload / cross-device sync see hook rows in the message flow.
        // The renderer reads them back via MessageItem.messageToActionItems
        // using msgType === 'hook_invocation'.
        // 2026-09-26: verifier-only hooks carry no additionalContext —
        // persisting those rows produced blank `role:'system'` entries in
        // the transcript. Skip them; the live SSE `hook_invoked` progress
        // event above still surfaces the invocation for the running turn.
        const hookContext = hookEvent.additionalContext;
        if (typeof hookContext === 'string' && hookContext.trim().length > 0) {
          this.pendingHookMessages.push(buildHookMessage(hookEvent, turnContext.sessionId ?? ''));
        }
      },
    });
    const flushPendingHookEvents = (): SSEEvent[] => {
      if (pendingHookEvents.length === 0) return [];
      return pendingHookEvents.splice(0, pendingHookEvents.length);
    };

    // Plan 437: helper that runs one hook event and yields any
    // `hook_invoked` agent_progress events the runner emitted during the
    // dispatch. Async-generator-as-helper 鈥?`yield*` forwards every
    // inner yield, and the returned value becomes the value of the
    // `yield*` expression. Replaces the duplicated try/await/catch
    // blocks at every call site.
    const dispatchHooks = async function* (
      event: import('../hooks/types.js').HookEvent,
      input: import('../hooks/events.js').EventHookInput,
      targets?: import('../hooks/events.js').EventHookMatcherTargets,
    ): AsyncGenerator<SSEEvent, import('../hooks/events.js').EventHookRunResult | null, unknown> {
      try {
        const result = await configHooks.run(event, input, targets);
        const pending = flushPendingHookEvents();
        for (const ev of pending) yield ev;
        return result;
      } catch (err) {
        logger.warn(
          `[Hooks] ${event} dispatch failed (skipped): ${err instanceof Error ? err.message : String(err)}`,
        );
        const pending = flushPendingHookEvents();
        for (const ev of pending) yield ev;
        return null;
      }
    };

    // UserPromptSubmit 鈥?the user's raw prompt entered the run.
    // Plan 430: the returned additionalContext lines are stashed on the
    // agent and pumped into the first `_projectModelMessages` projection as
    // `<system-reminder>` runtime_context messages (`source: 'custom'`).
    // Without this, the memory-RAG hook output is logged and discarded 鈥?    // the model never sees the retrieved memories on its first turn.
    const submitCtx = yield* dispatchHooks(
      'UserPromptSubmit',
      { session_id: turnContext.sessionId ?? '', cwd: turnContext.workingDirectory ?? '', hook_event_name: 'UserPromptSubmit', prompt: promptText },
    );
    if (submitCtx && submitCtx.contexts.length > 0) {
      this.promptContexts = submitCtx.contexts.slice();
      // Fresh run: previous run's delivered blocks must not leak into this
      // one's restore set.
      this.promptContextBlocks = [];
      logger.info(`[Hooks] UserPromptSubmit produced ${submitCtx.contexts.length} context line(s) 鈥?queued for first-turn injection`);
    }

    // SessionStart 鈥?fired once per run (covers orchestrator modes too,
    // since this sits ahead of the mode dispatch below).
    const startCtx = yield* dispatchHooks(
      'SessionStart',
      { session_id: turnContext.sessionId ?? '', cwd: turnContext.workingDirectory ?? '', hook_event_name: 'SessionStart', source: 'startup' },
    );
    if (startCtx && startCtx.contexts.length > 0) {
      logger.info(`[Hooks] SessionStart produced ${startCtx.contexts.length} context line(s)`);
      // Context-injection hardening: SessionStart contexts used to be logged
      // and discarded 鈥?fatal for memory-RAG hooks that do their retrieval
      // exactly once per session. Route them through the same transient
      // `promptContexts` rail as UserPromptSubmit, wrapped in a provenance
      // envelope so the model can attribute the block.
      for (let i = 0; i < startCtx.contexts.length; i += 1) {
        this.promptContexts.push(
          renderHookContextEnvelope({ event: 'SessionStart', hookName: 'session-start', seq: i }, startCtx.contexts[i]),
        );
      }
    }

    // Plan 450 Phase G: connector-activation reminder 鈥?the user @-mentioned
    // apps in the composer. Codex parity: a mention changes tool exposure,
    // not the prompt's capability text; this one-shot reminder only tells the
    // model the user explicitly named these apps and to prefer their tools.
    // Rendering lives in the mentions framework (packages/agent/src/mentions).
    if (options?.mentionedProviders?.length) {
      const descriptors = getCachedAppConnectionDescriptors();
      const injection = collectConnectorActivationInjection(options.mentionedProviders, descriptors);
      if (injection) {
        this.promptContexts.push(`<${injection.envelope}>\n${injection.body}\n</${injection.envelope}>`);
        logger.info(`[Agent] Connector activation: ${options.mentionedProviders.join(', ')}`);
      }
    }

    // Plan 450 Phase H: `/skill-name` mentions 鈥?inject the SKILL.md body as
    // a `<skill>` fragment this turn (codex UserInput::Skill parity), so the
    // model executes the skill immediately instead of having to notice the
    // catalog entry and load it with a read round-trip. Resolution happens
    // against the agent's own skill registry (see collectSkillInjections).
    // Plan 535 Phase B: handwritten `$name` and `skill://name` references in
    // the raw prompt join the popover selection (deduped, popover first);
    // unresolvable tokens ($20-style prices, unknown names) drop out in the
    // extractor, and fail-closed rules stay with collectSkillInjections.
    if (options?.mentionedSkills?.length || promptText) {
      const explicitSkills = extractExplicitSkillMentions(promptText);
      const mergedMentionedSkills = mergeSkillMentionSources(
        options?.mentionedSkills ?? [],
        explicitSkills,
      );
      const skillInjections = await collectSkillInjections(mergedMentionedSkills);
      // Plan 579: attribute the transient bodies' token cost per skill
      // (cleared per run, matching promptContextBlocks' lifecycle).
      this.injectedSkillParts.clear();
      for (const injection of skillInjections) {
        const rendered = `<${injection.envelope}>\n${injection.body}\n</${injection.envelope}>`;
        this.promptContexts.push(rendered);
        if (injection.envelope === 'skill' && injection.skillName) {
          this.injectedSkillParts.set(
            `skill:${injection.skillName}`,
            estimateContextTextTokens(rendered),
          );
        }
      }
      if (skillInjections.length > 0) {
        logger.info(`[Agent] Skill injection: ${skillInjections.length} skill fragment(s) queued`);
      }
    }

    // Plan 535 Phase A-4: per-turn skill-match reminder (mcode matcher
    // parity). Scans the prompt for path-like tokens and skill names and
    // suggests up to five relevant installed skills the user never
    // explicitly mentioned. Fail-closed: hidden / disabled /
    // conditional-pending skills are never suggested, and skills already
    // injected via the popover above are excluded.
    if (promptText) {
      const excludeSkills = new Set(options?.mentionedSkills ?? []);
      const skillHits = matchSkillsForPrompt(promptText, {
        workingDirectory: turnContext.workingDirectory ?? undefined,
        exclude: excludeSkills,
      });
      const skillSuggestion = buildSkillSuggestionInjection(skillHits);
      if (skillSuggestion) {
        this.promptContexts.push(`<${skillSuggestion.envelope}>\n${skillSuggestion.body}\n</${skillSuggestion.envelope}>`);
        logger.info(`[Agent] Skill suggestion: ${skillHits.length} skill(s) matched (${skillHits.map((h) => h.skill.name).join(', ')})`);
      }
    }

    // Plugin @-mentions (the `@` popover lists installed plugins): inject a
    // one-shot `<plugin-activation>` block listing the plugin's callable
    // capabilities (connected apps / MCP servers / skills). Connected app
    // connectors already flowed into `mentionedProviders` renderer-side, so
    // their tools were exposure-promoted above; this block only adds the
    // capability map (codex `render_explicit_plugin_instructions` parity).
    if (options?.mentionedPlugins?.length) {
      const descriptors = getCachedAppConnectionDescriptors();
      const injection = collectPluginInjections(options.mentionedPlugins, descriptors);
      if (injection) {
        this.promptContexts.push(`<${injection.envelope}>\n${injection.body}\n</${injection.envelope}>`);
        logger.info(`[Agent] Plugin activation: ${options.mentionedPlugins.map((p) => p.pluginId).join(', ')}`);
      }
    }

    // Agent @-mentions in the raw text (grok-bot 0.18 port): when the user
    // writes "@Bot Name", inject the reachability block naming each
    // mentioned teammate with its SendToAgent id, so "@ that agent" style
    // references become actionable without guessing ids. Parsed here against
    // the config agent roster (minus the session's own agent) rather than
    // renderer-side, mirroring grok's host-side withMentionedAgentsContext.
    // Fail-open: a config read failure never breaks the turn.
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
      } catch (err) {
        logger.warn(`[Agent] Agent mention parse skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Resolve agent profile early so mode dispatch can use promptSystem for auto-resolution
    const appliedProfile = await this._resolveAgentProfile(options);
    // Remember it for turn-end consumers (e.g. bot-pipeline title skip).
    this.lastAppliedAgentProfile = appliedProfile;

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
        // Unknown mode 鈥?no registry entry and no conductor flag.
        yield {
          type: 'error',
          data: `Unknown mode: ${requestedMode}`,
        } as unknown as SSEEvent;
        return;
      }
      // Modifier-paradigm mode (plan-task) or conductor-only 鈥?fall
      // through to the normal agent loop; `applyModes` below composes
      // the mode overlay onto the profile-resolved base.
    }

    // === Normal Mode ===
    // Tool resolution, prompt assembly, permission wiring, and initial
    // message selection are factored into private helpers (Phase F1 of
    // Plan 211). The system-message extraction block below remains inline
    // because it mutates `messages`, `systemPromptContent`, and
    // `this.messages` together 鈥?a single bridge between helper output
    // and the main loop.

    // Plan 610 A3-2b8 (S2): ONE call establishes the run-scoped half of
    // assembly -- the resolved-tools decision, the guarded permission gate and
    // the meta-tool dispatcher. It used to be ~105 lines of closure-local
    // construction right here, and all of it was unreachable from outside this
    // generator, so `assembleTurn` being public was still not enough for
    // anything but this loop to own a turn.
    const runAssembly = await this.beginTurnAssembly({
      options,
      prompt,
      appliedProfile,
      // Handed IN, not rebuilt: `streamChat` assembled this ~36 reads ago, and
      // a handle that assembled its own would be a second `TurnAssembler.build`
      // for one run.
      turnContext,
      publisher: options?.turnPipelines,
    });
    const { resolved: resolvedTools } = runAssembly;
    // Only what this loop still reads. `registry` and `catalogView` for the
    // catalog-eligibility block further down, `constraints` for the same
    // decision, and `baseTools` as the starting value of the LIVE `tools` the
    // loop promotes through the run. Kept narrow deliberately: a destructuring
    // that binds names nothing reads is a second, silently-stale account.
    const {
      tools: baseTools,
      registry,
      constraints,
      catalogView,
    } = resolvedTools;
    let tools = baseTools;

    // The catalog snapshot and per-context dispatchers are prepared by
    // _resolveTools; each stream keeps its own immutable request view.

    // Diagnostic: worker uses console.error for stderr (stdout is JSON-RPC).
    // eslint-disable-next-line no-console
    console.error(`[Agent-Process] streamChat tools (${tools.length}): conductorMode=${options?.conductorMode}, agentProfileId=${options?.agentProfileId}, mode=${options?.mode}, hasCanvasCreate=${tools.some(t => t.name === 'canvas_create_element')}`);
    // eslint-disable-next-line no-console
    console.error(`[Agent-Process] canvas tools: ${tools.filter(t => t.name.startsWith('canvas_')).map(t => t.name).join(', ') || '(none)'}`);
    let systemPromptContent = runAssembly.systemPrompt;
    // Plan 522: route the model-switch window check through the same
    // capability → catalog → default resolution as the constructor, so a
    // switch re-bases the compaction budget on the real window instead of
    // the 200K default.
    // Plan 577 Phase 0: the resolution SOURCE is kept alongside the value so
    // the emergency-compaction evidence log can state where the budget came
    // from (future ContextLedger verification baselines read these lines).
    const resolvedCompactionWindow = resolveCompactionContextWindow({
      capabilityContextWindow:
        this.runtimeConfig?.modelCapabilities?.contextWindow,
      modelId: this.runtimeConfig?.model ?? this._model,
    });
    const contextWindow = resolvedCompactionWindow.contextWindow;
    const compactionWindowSource = resolvedCompactionWindow.source;
    // Plan 577 §3: keep the ledger's window/model lineage in step. A model
    // or window change is a BUDGET change, NOT a context-lineage rebuild —
    // noteModelSwitch never rolls the epoch over.
    this.resolvedWindow = {
      contextWindow,
      windowSource: compactionWindowSource,
    };
    this.compactionManager
      .getContextLedger()
      .noteModelSwitch(
        { contextWindow, windowSource: compactionWindowSource },
        this.runtimeConfig?.model ?? this._model,
      );

    // Grok-aligned model-switch trigger (`maybe_compact_on_model_switch`,
    // grok `compaction.rs:1984-2016`). When the model or its context window
    // changes, the prior compaction decision is stale: a larger window
    // may have over-compressed (now we can keep more), a smaller window
    // MUST compact to fit. STICKY suppression is also cleared inside
    // CompactionManager.compact() because a window change is exactly the
    // budget change it was waiting for.
    //
    // First streamChat (`_lastSeenModel` undefined) is treated as the
    // baseline 鈥?no model-switch compaction, just record what we saw so
    // the *next* streamChat can detect drift.
    if (this._lastSeenModel !== undefined) {
      const previousContextWindow = this.compactionManager.getMaxTokens();
      const previousModel = this._lastSeenModel;
      if (
        previousModel !== this._model ||
        previousContextWindow !== contextWindow
      ) {
        // Plan 577 Phase 0: model switch is a BUDGET INVALIDATION, not a
        // compaction command. The old order compacted unconditionally (any
        // context size) and only then raised the window. New order: apply the
        // new budget first (which also clears 'size' suppression — a window
        // change is exactly the budget change it waits for), re-probe the
        // projected context against the NEW trigger line, and compact only
        // when the next request would not fit. A 200K→1M upgrade with a
        // 120K context therefore no longer compacts at all.
        this.compactionManager.updateMaxTokens(contextWindow);
        let probe: CompactionProbe | null = null;
        try {
          probe = this.compactionManager.probeCompaction(
            this.compactionController.projectInputMessages(),
          );
        } catch (probeError) {
          logger.warn(
            `[Agent] Model-switch probe failed, skipping threshold check: ${
              probeError instanceof Error ? probeError.message : String(probeError)
            }`,
            undefined,
            'Agent',
          );
        }
        if (probe && !probe.overTriggerLine) {
          logger.info(
            `[Agent] Model/window switched (${previousModel} → ${this._model}, ` +
              `window ${previousContextWindow} → ${contextWindow}): projected context ` +
              `${probe.tokens} ≤ trigger line ${contextWindow - 16384}, no compaction needed`,
            undefined,
            'Agent',
          );
        } else {
          try {
            await this.compactionController.compactProactive({
              trigger: 'model_switch',
            });
          } catch (modelSwitchError) {
            // model_switch is best-effort: a failed model-switch compact does
            // not block the turn. The error is surfaced via the
            // `compaction_error` event for telemetry.
            logger.warn(
              `[Agent] Model-switch compaction failed: ${
                modelSwitchError instanceof Error ? modelSwitchError.message : String(modelSwitchError)
              }`,
              undefined,
              'Agent',
            );
          }
        }
      }
    }
    this._lastSeenModel = this._model;

    // Handle options.messages fallback (CLI / harness scenarios)
    if (this.messages.length === 0 && options?.messages?.length) {
      this.setMessages([...options.messages]);
    }

    // Plan 315: project the timeline to the model boundary. System content
    // from legacy system messages and compaction reinjected context is
    // extracted into PromptSegments and merged into the system prompt. The
    // resulting messages array contains only user/assistant/tool roles.
    const projected = this._projectModelMessages(systemPromptContent, { injectHookContexts: true });
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
        sessionId: turnContext.sessionId ?? '',
        workingDirectory: turnContext.workingDirectory ?? '',
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

      // applyModes filters the direct tool list. Mirror those decisions in
      // the catalog too, or a deferred target could bypass a mode block via
      // tool_invoke. Router wrappers are infrastructure, so a mode allowlist
      // does not need to name them; explicit mode blocks still apply.
      const modeToolPolicy = this.resolvedModes.tools;
      const modeAllowsTarget = (name: string): boolean =>
        modeToolPolicy.overrideFilter || (
          !modeToolPolicy.blocked.includes(name) &&
          (modeToolPolicy.allowed === null || modeToolPolicy.allowed.includes(name))
        );
      const modeAllowsRouter = (name: string): boolean =>
        modeToolPolicy.overrideFilter || !modeToolPolicy.blocked.includes(name);
      const canCatalog =
        isToolVisible('tool_catalog', 'eager', EMPTY_DISCOVERED, constraints) &&
        modeAllowsRouter('tool_catalog');
      const canInvoke =
        isToolVisible('tool_invoke', 'eager', EMPTY_DISCOVERED, constraints) &&
        modeAllowsRouter('tool_invoke');
      const directNames = new Set(tools.map((tool) => tool.name));
      const eligibleAfterMode = catalogView.snapshot.catalogEntries.filter((entry) => {
        if (!catalogView.eligibleToolIds.has(entry.toolId) || !modeAllowsTarget(entry.definition.name)) return false;
        if (entry.exposure !== 'deferred' || directNames.has(entry.definition.name)) return true;
        return canCatalog && canInvoke;
      });
      catalogView.eligibleToolIds = new Set(eligibleAfterMode.map((entry) => entry.toolId));
      catalogView.directToolIds = new Set(
        eligibleAfterMode
          .filter((entry) => directNames.has(entry.definition.name))
          .map((entry) => entry.toolId),
      );
      if (canCatalog && !directNames.has('tool_catalog')) {
        const definition = catalogView.snapshot.tools.find((tool) => tool.name === 'tool_catalog');
        if (definition) tools.push(definition);
      }
      const hasRoutableDeferred = eligibleAfterMode.some(
        (entry) => entry.exposure === 'deferred' && !directNames.has(entry.definition.name),
      );
      if (canInvoke && hasRoutableDeferred && !directNames.has('tool_invoke')) {
        const definition = catalogView.snapshot.tools.find((tool) => tool.name === 'tool_invoke');
        if (definition) tools.push(definition);
      }

      logger.info(
        `[Agent] streamChat: Applied ${this.resolvedModes.modes.length} mode modifier(s): ${this.resolvedModes.modes.map((m) => m.id).join(', ')}`,
      );
    } else {
      // No active modes 鈥?clear stored state so per-turn refresh is a no-op.
      this.resolvedModes = undefined;
      this.modeCtx = undefined;
      this.baseSystemPromptWithoutModes = undefined;
    }

    let progressToolName = PROGRESS_UPDATE_TOOL_NAME;
    while (tools.some((tool) => tool.name === progressToolName)) {
      progressToolName = `duya_${progressToolName}`;
    }
    tools = [...tools, { ...PROGRESS_UPDATE_TOOL, name: progressToolName }];

    // Plan 413d: build the mode state-machine coordinator only when a
    // session-level mode with a tracker is active. Rebuilt per streamChat
    // call (same lifecycle as modeCtx); the trackers themselves are engine
    // singletons that survive across calls, so state persists between turns.
    // Scope the coordinator to THIS turn's active tracker ids 鈥?otherwise a
    // dormant tracker (e.g. planModeTracker while only goal mode is on)
    // would be auto-activated and injected by the coordinator (plan 411
    // follow-up: goal mode must not wake plan mode).
    //
    // Also include trackers the AGENT activated this session via tool
    // (EnterPlanModeTool 鈫?`activate_from_tool`), not just the frontend's
    // `options.mode` 鈥?otherwise a tool-entered plan mode would be invisible
    // to the coordinator and its write-gate/reminders never fire (grok:
    // tracker state is authoritative; the prompt mode reconciles to it).
    const activeTrackerIds = new Set<string>(
      (this.resolvedModes?.modes ?? [])
        .filter((m) => m.tracker)
        .map((m) => m.tracker!.id),
    );
    for (const tracker of modeTrackerEngine.list()) {
      if (tracker.id === 'plan-task' && planModeTracker.state() === 'active') {
        activeTrackerIds.add(tracker.id);
      }
    }
    // Plan 552: persisted tracker state is authoritative for goal mode —
    // a goal started in a previous run (or before a restart) re-enters the
    // active set from its `mode_state_snapshots` row even when the frontend
    // did not re-select the mode, so continuation reminders, budget
    // cut-off and the auto-resume path all keep working across sessions.
    if (!activeTrackerIds.has('goal') && turnContext.sessionId) {
      try {
        const goalRow = await modeStateDb.get(turnContext.sessionId, 'goal');
        if (goalRow?.snapshotJson) {
          const parsed = JSON.parse(goalRow.snapshotJson) as { status?: string };
          if (parsed?.status && parsed.status !== 'idle') {
            activeTrackerIds.add('goal');
          }
        }
      } catch {
        // DB/IPC hiccup — degrade to mode-selection-only scoping.
      }
    }
    this.modeCoordinator =
      activeTrackerIds.size > 0
        ? new ModeCoordinator(modeTrackerEngine, turnContext.sessionId ?? '', activeTrackerIds)
        : undefined;

    // Plan 413c: restore persisted tracker state for this session before any
    // per-turn reminder injection (crash/restart recovery). Best-effort 鈥?    // restoreTracker swallows DB/IPC failures and leaves the tracker initial.
    if (this.modeCoordinator) {
      await this.modeCoordinator.restore();
    }

    let turnCount = 0;
    // Tool-group state belongs to the whole streamChat run, not one provider
    // request. Private progress calls consume a model turn before real tools
    // run, and tool batches may continue across multiple model turns.
    const toolGroupProgress = new ToolGroupProgressTracker();
    // Per-run agentic-turn cap. Absent 鈫?uncapped (pi-aligned design):
    // the loop runs until the LLM naturally produces a tool-free turn,
    // hits a token/context limit (`stopReason: 'length'`), the caller
    // aborts, or a tool batch returns `terminate: true`. Upper-layer
    // harnesses (CLI, renderer config) can still set a value here as an
    // opt-in safety net 鈥?there is no implicit fallback. Plan 426 keeps
    // engine invariants in the loop (dead-loop guard, mailboxes) but
    // intentionally does not enforce a default turn limit.
    const maxTurns = options?.maxTurns;
    let runtimePromptMessageId: string | null = null;

    // Anti-dead-loop guard (per streamChat call). Tracks consecutive identical
    // tool calls so the loop can steer or stop instead of spinning forever.
    // Progression: soft nudge (deadLoopNudgeAt) 鈫?stronger "change approach"
    // nudge (deadLoopHardNudgeAt) 鈫?hard stop (deadLoopHardStopAt). The
    // counting and the hard stop are engine invariants (plan 426); the
    // soft/hard nudge *texts* live in the builtin dead-loop loop hook.
    // Plan 550 step 2e (TurnPreparer): the streak counter + signature
    // logic moved behind `DeadLoopTracker` so the per-run allocation
    // lives in one place and the inline `let` bindings no longer leak
    // across streamChat's prologue. The four read sites below consult
    // the tracker instead of touching local variables.
    const deadLoopTracker = new DeadLoopTracker(
      resolveDeadLoopConfig(options?.antiDeadLoop),
    );

    // Loop-hook bus (plan 426): per-run event spine carrying the steering
    // policies that used to be inline blocks below (todo gate, premature
    // stop, dead-loop nudges). Engine invariants 鈥?mailbox
    // checkpoints, max-turns stop, dead-loop hard stop 鈥?stay in this loop
    // and are never delegated.
    const loopHooks = new LoopHookBus();
    for (const registration of createBuiltinLoopHooks({
      sessionId: turnContext.sessionId ?? undefined,
      todoGateEnabled: options?.todoGate?.enabled ?? true,
      antiDeadLoop: {
        enabled: deadLoopTracker.config.enabled,
        nudgeAt: deadLoopTracker.config.nudgeAt,
        hardNudgeAt: deadLoopTracker.config.hardNudgeAt,
      },
      // grok SendMessageReminderMiddleware port: only runs whose toolset
      // actually exposes SendMessage (bot sessions) can go "silently"
      // invisible, so only those get the silence / early-result nudges.
      sendMessageReminder: {
        enabled: tools.some((t) => t.name === 'SendMessage'),
      },
      // Plan 496: full delivery enforcement (grok ensureUserReply port) —
      // reply reminder on turn start + turn-end delivery vetoes. Same bot
      // gate; silence-allowed runs (wake / cron / effort:'off' /
      // backgroundTaskResume — the same markers the router treats as
      // non-user turns) keep grok's isSilenceAllowed exemption.
      sendMessageDelivery: {
        enabled: tools.some((t) => t.name === 'SendMessage'),
        silenceAllowed:
          options?.effort === 'off' || options?.backgroundTaskResume === true,
      },
      disabled: options?.disabledLoopHooks,
    })) {
      loopHooks.register(registration);
    }
    // Plan 426 Phase 3: the mode coordinator rides the bus 鈥?per-turn
    // reminders via PreTurn (priority 5), round-end transitions + snapshot
    // persistence via PreFinalize (priority 5, ahead of builtin vetoes).
    // Its dedicated call sites below are gone; the WHEN is now owned here.
    for (const registration of this.modeCoordinator?.createLoopHookRegistrations() ?? []) {
      loopHooks.register(registration);
    }
    // Plan 426 Phase 4: user-configured [hooks] from config.toml (plan 87
    // command/http executor vocabulary) bridged onto the loop events.
    // Config is read fresh per streamChat, so edits hot-reload on the next
    // run. Fail-open: configured hook failures never break the loop.
    for (const registration of createConfiguredLoopHooks()) {
      loopHooks.register(registration);
    }
    // Shared snapshot builder for loop-hook dispatches.
    const buildHookCtx = (): Omit<LoopHookDispatchContext, 'event'> => ({
      sessionId: turnContext.sessionId ?? undefined,
      turnCount,
      seqIndex,
      messages,
      prompt: typeof prompt === 'string' ? prompt : undefined,
    });

    // The LLM's native stop reason for the current turn (end_turn / max_tokens
    // / tool_use / stop_sequence), captured from the stream's done event.
    let turnStopReason: string | undefined = undefined;


    // Generate a unique seq_index for this streamChat call
    // All messages created in this call (including multi-turn) will share this seq_index
    // This allows the UI to group all related messages into a single "round"
    const seqIndex = Date.now();
    // Plan 587 R2.1: the run id is the Control Plane's, not ours. It arrives on
    // `chat:start` and, when present, IS this run's identity — the same string,
    // not an alias. Producers that do not send one (automation, workflow,
    // sub-agent: all registered for H8) fall back to minting, and
    // `resolveTurnRunId` reports that it happened so the fallback can be
    // counted and eventually deleted. See `run-identity.ts`.
    const { runId } = resolveTurnRunId(options?.runId);

    // Deferred tool contexts collected from tool results during this
    // streamChat call. They are injected into the provider payload on the
    // next turn (transient runtime context) but never persisted to the
    // durable history.
    const deferredContexts: Array<{
      toolUseId: string;
      toolName: string;
      promise: Promise<unknown>;
    }> = [];

    // Plan 569: run-level counter for the final mailbox poll inside
    // finalizeSuccess. Each absorb hands the model a fresh turn, and the
    // model may finish again immediately — a notification storm could
    // otherwise extend the run indefinitely. After FINAL_POLL_MAX_ABSORBS
    // absorbs the final poll passes through (returns false) and leftover
    // notifications fall to the renderer resume path (which has the
    // 2026-09-26 no-idle-run guard). 3 is the same conservative magnitude
    // as claimBatch's DEFAULT_LIMIT=10 / DEFAULT_MAX_CLAIM_ATTEMPTS=5.
    const FINAL_POLL_MAX_ABSORBS = 3;
    let finalPollAbsorbs = 0;

    // Track total elapsed time for the entire stream (including all turns and tool execution)
    const streamStartTime = Date.now();

    while (!this.abortController.signal.aborted) {
      // Remove the prior turn's dynamic guide before rebuilding this turn.
      // This prevents duplicate prompt sections when a discovered tool stays
      // active across multiple tool-use turns.

      turnCount++;
      // Grok-aligned 5-state suppression: clear SUPPRESS_TURN at the start
      // of every turn so a transient `other` failure on the previous turn
      // does not bleed into the next one. STICKY/UNTIL_SUCCESS/AUTH are
      // preserved 鈥?their clear triggers are event-based, not turn-based.
      this.compactionManager.onTurnStart();
      const turnStartTime = Date.now();
      // Tool calls the assistant emits this turn; handed to the PostToolUse
      // dispatch so configured hooks can match on tool names (plan 426 Phase 4).
      const turnToolCalls: Array<{ name: string; input: unknown }> = [];
      // tool_use id 鈫?tool name, so a failing tool result can be attributed
      // to its hook matcher (PostToolUseFailure).
      const turnToolCallIds = new Map<string, string>();

      // Runtime fallback: once a mid-stream compaction promoted the
      // discovered set, merge those tools into the request's tools array
      // for the rest of the call, respecting the same deny/allow
      // constraints. Config-driven 'array' delivery was retired — this
      // promotion is the only remaining merge path.

      // Plan 610 A3-2b7 (S1): the per-turn system-prompt refresh and this
      // turn's pipeline now come from ONE call, `assembleTurn`. It used to be
      // the inline mode-prefix block above plus a `buildTurnPipeline` call
      // further down, and the catalog round was assigned a third time between
      // them. Three hand-reached pieces of one turn's assembly is the shape that
      // lets an engine-driven turn get two of the three; the seam is the answer
      // to that, so the loop routes through it rather than beside it.

      // Plan 426 Phase 3: the mid-turn buffered-activation flush and the
      // per-turn mode reminders moved into the mode-coordinator PreTurn hook
      // (dispatched after the mailbox checkpoint below).

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
            id: options?.clientMsgId ?? crypto.randomUUID(),
            role: 'user',
            content: persistedPromptContent,
            displayContent: displayContent !== undefined ? displayContent : undefined,
            timestamp: Date.now(),
            seq_index: seqIndex,
            attachments: (options as ChatOptions & { attachments?: Message['attachments'] })?.attachments,
            // Plan 497: a wake run's prompt is model context, not user chat —
            // persist it source 'system' (bot-direct hidden) so it does not
            // duplicate the agent_dm marker card the dispatcher already wrote.
            ...(options?.wakeRun ? { source: 'system' as const } : {}),
          } as Message;
          // Plan 486 搂2.1/搂2.2: fork/reply creation rule. The target must
          // exist in this session's timeline (checked against entries already
          // committed 鈥?this message is not yet appended). An unknown target
          // is silently stripped so a dangling fork is never persisted.
          const replyMeta = resolveReplyMeta(
            options?.replyToId,
            options?.branched,
            collectMessageIds(this.timeline.snapshot()),
          );
          if (replyMeta) {
            userMessage.metadata = mergeThreadMetadata(userMessage.metadata, replyMeta);
            // Plan 486 搂2.3: a branched fork opens an active fork turn 鈥?every
            // message this turn produces is tagged branched (see _pushDurable).
            // Quote replies (no branched) stay on the main line and leave the
            // marker null.
            if (replyMeta.branched === true && userMessage.id) {
              this.forkTurn = {
                replyToId: replyMeta.replyToId ?? userMessage.id,
                userId: userMessage.id,
              };
            }
          }
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

      // Plan 610 A3-2b8 (S2): ONE call assembles this turn, through the
      // run handle -- the mode-prefix prompt refresh, the catalog round, and a
      // FRESH pipeline.
      //
      // `tools` is passed per turn because promotion moves it during a run, and
      // `systemPromptContent` because compaction replaces it. Neither belongs on
      // the handle, which is why this call carries them rather than reading them.
      const assembly = runAssembly.assemble({
        turn: turnCount,
        systemPrompt: systemPromptContent,
        messages,
        tools,
      });
      // The refreshed prompt REPLACES the run's current one for the rest of the
      // turn, exactly as the inline block it replaces did. Compaction reassigns
      // `systemPromptContent` later in the turn and the next assembly reads that
      // value back in, so a compaction's replacement is not undone.
      systemPromptContent = assembly.systemPrompt;
      const executor = assembly.pipeline;

      // Per-turn state
      const assistantContent: MessageContent[] = [];
      const privateProgressCalls: Array<{ id: string; title?: string }> = [];
      const pendingProgressAtRequestStart = toolGroupProgress.pendingSnapshot();
      let needsFollowUp = false;
      let thinkingContent = '';  // Accumulate thinking content for this turn
      let hasThinkingContent = false;  // Track if we have any thinking content
      let thinkingSignature: string | undefined = undefined;  // Anthropic extended-thinking signature for this turn
      // Anthropic redacted_thinking: the encrypted payload arrives on a
      // signature-only SSE thinking event. It must reach the pushed message
      // verbatim or the next request's assistant turn loses its thinking
      // prefix and thinking-mode continuations 400.
      let redactedEncrypted: string | undefined = undefined;
      // Guard against providers that emit more than one `done` event per
      // stream (a protocol-layer bug duplicated every assistant message).
      // One LLM stream produces exactly one assistant message push.
      let doneEventHandled = false;
      // Per-call usage from this round's `result` event (always yielded
      // immediately before `done`). Attached to the pushed assistant message
      // (pi parity) so context estimation can anchor on real API numbers 鈥?      // see computeContextEstimate in @duya/ai.
      // NOTE: keep the LARGEST-prompt result of the turn, not the latest.
      // Some gateways (GLM-style cache reporting) report a near-fresh prefix
      // (input_tokens=0, tiny cache hit) on individual rounds, which made the
      // context ring collapse to ~1% for an instant between tool rounds.
      // Conversation context only grows within a turn, so max is always the
      // truthful anchor; compaction resets via compactedPending separately.
      // Plan 577 §2: split the prompt-volume normalizer from the volume that
      // folds output in. `normalizedPromptVolume` is the Observation-layer
      // input (the prompt the provider actually saw); `resultPromptVolume`
      // keeps the historical prompt+output semantics for round-max tracing.
      const normalizedPromptVolume = (
        u?: { input_tokens?: number; output_tokens?: number; cache_hit_tokens?: number; cache_creation_tokens?: number },
      ): number => {
        if (!u) return 0;
        const input = u.input_tokens ?? 0;
        const hit = u.cache_hit_tokens ?? 0;
        const write = u.cache_creation_tokens ?? 0;
        return hit > input || write > input ? input + hit + write : input;
      };
      const resultPromptVolume = (
        u?: { input_tokens?: number; output_tokens?: number; cache_hit_tokens?: number; cache_creation_tokens?: number },
      ): number => normalizedPromptVolume(u) + (u?.output_tokens ?? 0);
      let roundResultUsage:
        | { input_tokens?: number; output_tokens?: number; total_tokens?: number; cache_hit_tokens?: number; cache_creation_tokens?: number }
        | undefined = undefined;
      // Plan 224 follow-up: track mode-switch tool_use ids so we can emit
      // a `mode_changed` SSE event right after their tool_result lands.
      // Keyed by tool_use_id, value is the tool name.
      const modeSwitchToolIds = new Map<string, string>();

      yield { type: 'turn_start', data: { turnCount } };

      // Lightweight tool result cleanup before each turn

      // Proactive context compaction before each LLM call. Plan 550 step 2c:
      // delegate to the per-session CompactionCoordinator (it owns the
      // prefire kick, cooldown gate, event buffer, and post-compact re-projection).
      //
      // Real-time pump: `runPreTurn` used to buffer compact:start/steps/done
      // and return them only AFTER compaction finished, so the renderer saw
      // nothing during the (~minutes) summarizer call and then every row at
      // once. An async generator cannot yield while awaiting a sub-promise,
      // so the coordinator pushes events into a queue via `onEvent` and this
      // loop drains it on a short tick until the run settles. When no
      // compaction fires the promise resolves immediately — the loop exits
      // without waiting a tick.
      const compactionQueue: SSEEvent[] = [];
      let compactionRun: CompactionRunResult | null = null;
      let compactionFailure: unknown = null;
      const compactionPromise = this.compactionCoordinator
        .runPreTurn({
          turnCount,
          systemPromptContent,
          messages,
          onEvent: (event) => compactionQueue.push(event),
        })
        .then(
          (result) => {
            compactionRun = result;
          },
          (err) => {
            compactionFailure = err;
          },
        );
      while (compactionRun === null && compactionFailure === null) {
        if (compactionQueue.length > 0) {
          yield* compactionQueue.splice(0, compactionQueue.length);
          continue;
        }
        await Promise.race([
          compactionPromise,
          new Promise<void>((resolve) => setTimeout(resolve, 50)),
        ]);
      }
      yield* compactionQueue.splice(0, compactionQueue.length);
      if (compactionFailure !== null) throw compactionFailure;
      // The while loop can only be exited with the run settled, but TS
      // cannot see through the closure assignment above — re-check via a
      // widened local so the narrowing below is sound.
      const settledRun = compactionRun as CompactionRunResult | null;
      if (!settledRun) {
        throw compactionFailure ?? new Error('Compaction run did not settle');
      }
      if (settledRun.didCompact) this.invalidateTurnCatalogSchemaReads(resolvedTools);
      for (const ev of settledRun.events) yield ev;
      systemPromptContent = settledRun.systemPromptContent;
      messages = settledRun.messages;
      const mailboxDecision = await this._sweepInterTurn(
        runId,
        messages,
        seqIndex,
        'before_model_turn',
        options,
      );
      // A `backgroundTaskResume` run has no user prompt (the turn-1 push is
      // skipped above). If its FIRST checkpoint claim comes back empty, the
      // notification it was woken for was already absorbed by the run that
      // was active when it arrived — proceeding would make a bare LLM call
      // with no new input, wasting a turn and producing a reply with nothing
      // to reply to (2026-09-26 investigation: empty idle-resume runs).
      if (
        options?.backgroundTaskResume === true &&
        turnCount === 1 &&
        mailboxDecision.action === 'continue' &&
        !mailboxDecision.absorbed
      ) {
        logger.info('[AgentMailbox] backgroundTaskResume run has no claimable rows — terminating without an LLM call');
        yield { type: 'done', reason: 'completed' };
        return;
      }
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

      // Plan 426 Phase 3: PreTurn dispatch, deliberately located AFTER the
      // mailbox checkpoint so mode turn reminders (mode-coordinator hook,
      // priority 5) stay more recent than mailbox guidance 鈥?the same
      // ordering the pre-bus inline calls produced. The hook flushes
      // buffered mid-turn activations first, then injects per-turn mode
      // reminders; other PreTurn consumers see the same position.
      for (const effect of await loopHooks.dispatch('PreTurn', buildHookCtx())) {
        applyLoopHookEffect(messages, effect, seqIndex);
      }

      // Optional per-request wall-clock timeout (curator + callers that opt
      // in via llmRequestTimeoutMs). Aborts a single LLM call that overruns
      // even while the stream is still producing data (e.g. a MiniMax
      // thinking stream that never converges), so a hung turn fails fast
      // instead of consuming the whole run budget. Cleaned up on both the
      // normal-completion and error paths.
      let requestController: (AbortController & { dispose?: () => void }) | null = null;
      let requestTimer: ReturnType<typeof setTimeout> | undefined;
      let requestSignal: AbortSignal = this.abortController.signal;
      if (options?.llmRequestTimeoutMs && options.llmRequestTimeoutMs > 0) {
        requestController = createChildAbortController(this.abortController);
        requestSignal = requestController.signal;
        requestTimer = setTimeout(() => {
          requestController?.abort(new Error(`LLM request timed out after ${options.llmRequestTimeoutMs}ms`));
        }, options.llmRequestTimeoutMs);
      }
      const disposeRequestController = () => {
        if (requestTimer !== undefined) clearTimeout(requestTimer);
        requestController?.dispose?.();
        requestController = null;
      };

      try {
        // Stream from LLM with FULL message history
        logger.info(`[Agent] Turn ${turnCount}: Starting LLM stream, messages=${messages.length}, provider=${this.provider}`);
        let llmEventCount = 0;
        logger.info(`[Agent] Turn ${turnCount}: Calling llmClient.streamChat...`);
        // Plan 577 §2: prune detection — compressProjectedToolMessages is
        // pure and returns the SAME reference when no transform changed
        // anything, so a reference change is the projection-shrink signal.
        const prePruneMessages = runtimePromptMessageId
          ? messages.map((msg) => (
                msg.id === runtimePromptMessageId
                  ? {
                      ...msg,
                      content: prompt as string | MessageContent[],
                    }
                  : msg
              ))
            : messages;
        const llmMessages = compressProjectedToolMessages(prePruneMessages);
        if (llmMessages !== prePruneMessages) {
          // Projection shrank (tool-result prune / offload / reformat): arm
          // the next observation to replace the accounting `latest` even
          // when smaller, and let the ring correct its anchor downward.
          this.compactionManager.noteProjectionShrink();
          logger.tokenTrace('projectionShrink', {
            sessionId: turnContext.sessionId ?? undefined,
            msgsBefore: prePruneMessages.length,
            msgsAfter: llmMessages.length,
          });
        }

        // Plan 486 搂2.3: render the reply/fork quote context and keep the
        // provider payload clean. This runs at the per-request boundary where
        // the current turn's user message is present: historical messages
        // arrive already stripped by projectModelMessages, so only messages
        // carrying a live replyToId (this turn's quote reply or fork) get the
        // `[In reply to <id>: "<quote>"]` prefix. Thread metadata is then
        // removed from every message so it never leaks into the request body.
        this._applyProviderThreadBoundary(llmMessages);

        // AGENTS.md is now carried in the system prompt (Plan 408 Phase 5),
        // not injected as a first-turn user message.

        // Inject transient runtime context (attachment text + deferred tool
        // contexts) into the provider payload. These are never persisted to
        // the durable history.
        await this._injectRuntimeContext(llmMessages, options, deferredContexts);

        // Plan 453 Task C: append OSContext as a contextual user fragment on
        // every turn. The bridge is the integration seam 鈥?tests can swap
        // it via __setBridgeForTest. The fragment is ephemeral (lives only
        // on `llmMessages`; never lands in the durable timeline).
        injectOSContextFragment(llmMessages, runtimePromptMessageId);

        // Persistent turn-context injection (C′): every human-turn user
        // message — historical ones included — gets its `Message sent at`
        // reminder re-rendered deterministically from the persisted
        // `message.timestamp` on every request. Bytes never change across
        // replays, so the provider cache prefix stays intact; the durable
        // timeline keeps the clean canonical content (shallow-copy swap on
        // `llmMessages` only). Replaces the old `Current date and time:`
        // line in the environment system-prompt section.
        injectTurnTimestampReminders(llmMessages);

        // Cache the system-prompt + tool-surface estimate for the live
        // context ring's no-usage fallback. Only the provider contract is
        // counted (name/description/input_schema), mirroring what is
        // serialized into the request body. Plan 577 §4: the two halves
        // are kept separate for the composition diagnostics.
        const systemAndTools = this._estimateSystemAndToolsTokens(systemPromptContent, tools);
        this.lastSystemTokensEstimate = systemAndTools.system;
        this.lastToolsTokensEstimate = systemAndTools.tools;
        this.lastSystemContextTokensEstimate = systemAndTools.total;
        // Plan 577 §2: feed the schema baseline so the compaction manager
        // can price tool/schema growth BETWEEN provider observations
        // (schemaDelta) — an MCP/skill load is felt by the next request
        // without waiting for the provider to report it.
        this.compactionManager.setSchemaEstimateTokens(this.lastSystemContextTokensEstimate);
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

        // Plan 439: wrap the raw LLM stream with turn-level replay. A
        // transport death (undici `terminated`, OpenRouter upstream drop,
        // idle timeout) BEFORE the stream's `done` event leaves no durable
        // state 鈥?deltas live only in the local accumulators below 鈥?so the
        // partial attempt is discarded and retried from scratch instead of
        // failing the whole turn. The retryable-error classification and
        // attempt budget live in ./stream-retry.ts. Post-`done` failures
        // propagate unchanged via the turnCommitted guard.
        // Refresh the declared-tools snapshot before every provider request.
        // The visibility guard reads it during execution.
        // Plan 577 §3: capture the epoch for this built prompt. A replay uses
        // the same prompt bytes, so it must retain this generation and be
        // dropped if compaction/clear changed the timeline while it was in flight.
        const requestEpoch = this.compactionManager.getContextEpoch();
        // Plan 610 A3-2b7 (S1): `catalogView.currentRound` is assigned by
        // `assembleTurn` at the top of this turn, not here. The value a reader
        // sees is unchanged -- nothing between the two points dispatches a tool,
        // and the drain that reads it (:3444) is downstream of both -- but the
        // round is now something the ENGINE can set rather than something only
        // this loop can advance.
        // Plan 600 S2, model-leg slice: named so this turn's deps can be
        // PUBLISHED rather than buried in the call below. One object, two
        // readers -- the legacy loop and the engine's model leg -- so the leg
        // cannot drift from the stream the turn is actually running.
        const turnStreamDeps: TurnStreamRunnerDeps = {
          llmClient: this.llmClient,
          llmMessages,
          systemPromptContent,
          tools,
          maxTokens: options?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          temperature: options?.temperature ?? 1,
          effort: options?.effort,
          maxOutputTokens: this.runtimeConfig?.modelCapabilities?.maxOutputTokens,
          signal: requestSignal,
          turnCount,
          turnCommitted: doneEventHandled,
          refreshDeclaredTools: () => {
            // Plan 610 A3-2b8 (S2): the snapshot is re-taken from the handle,
            // which holds the guard. Reading a local here would mean the loop
            // and the guard could disagree about which tools are declared.
            return runAssembly.refreshDeclaredTools();
          },
          onRetryReset: () => {
            // Plan 550 step 2e (TurnLoop first slice): the retry envelope lives in
            // runTurnStream; the per-attempt state reset (executor discard +
            // deadLoopTracker reset + accumulator clears) is delegated back to the
            // caller because it touches closure state in streamChat.
            executor.discard();
            assistantContent.length = 0;
            privateProgressCalls.length = 0;
            // A retry replays this provider request. Keep prior turn state,
            // but discard progress announced only by the failed attempt.
            toolGroupProgress.restorePending(pendingProgressAtRequestStart);
            thinkingContent = '';
            hasThinkingContent = false;
            thinkingSignature = undefined;
            needsFollowUp = false;
            turnToolCalls.length = 0;
            turnToolCallIds.clear();
            modeSwitchToolIds.clear();
            deadLoopTracker.reset();
          },
        };

        // Plan 600 S2: hand this turn's MODEL leg to the run engine.
        //
        // Published HERE, after `llmMessages` is bound, because that is the
        // only step of the chain above that can REBIND the array:
        // `compressProjectedToolMessages` returns a fresh array when it changes
        // anything and the SAME reference when it does not (the reference change
        // is the projection-shrink signal read a few lines above). The four
        // transforms after it cannot rebind -- they receive the reference and
        // mutate entries in place (`injectTurnTimestampReminders` replaces
        // `messages[i]`, `_injectRuntimeContext` and `injectOSContextFragment`
        // push or rewrite `content`) -- so publishing the same reference earlier
        // would still observe their output at request time. Publishing
        // `prePruneMessages` instead would not.
        //
        // `get messages()` is NOT a substitute at any point: it recomputes the
        // durable projection from the timeline, so it carries none of the four.
        // `model-leg.test.ts` pins that by reading the same turn three ways.
        //
        // Absent publisher means no engine is bound to this run, which is the
        // pre-plan case (the CLI, the sub-agent tool) and is not an error.
        //
        // The abort controller handed over is the one that OWNS
        // `requestSignal`, which is the signal `runTurnStream` passes to the
        // client: the per-request child when a request timeout is configured,
        // otherwise the run's own controller. Captured here, at publish time,
        // because `disposeRequestController()` nulls the child on the way out
        // and a later read would hand the leg a controller that no longer
        // governs anything.
        const turnAbortController = requestController ?? this.abortController;
        options?.modelLegs?.publish(
          buildTurnModelLeg({
            turn: turnCount,
            deps: turnStreamDeps,
            abortController: turnAbortController,
          }),
        );

        const streamGenerator = runTurnStream(turnStreamDeps);
        
        logger.info(`[Agent] Turn ${turnCount}: Stream generator created, starting iteration...`);
        for await (const event of streamGenerator) {
          llmEventCount++;
          if (event.type === 'text' || event.type === 'thinking') {
            logger.debug(`[Agent] LLM event ${llmEventCount}: type=${event.type}, data_length=${String(event.data).length}`);
          } else {
            logger.debug(`[Agent] LLM event ${llmEventCount}: type=${event.type}`);
          }

          if (event.type === 'tool_use_started') {
            if (event.data.name === progressToolName) continue;
            const group = toolGroupProgress.assign(event.data.id);
            if (group.progressEvent) {
              yield { type: 'tool_group_progress', data: group.progressEvent };
            }
            yield {
              ...event,
              data: {
                ...event.data,
                groupId: group.groupId,
                ...(group.progressTitle ? { progressTitle: group.progressTitle } : {}),
                progressSource: group.progressSource,
              },
            };

          } else if (event.type === 'tool_use_delta') {
            if (event.data.name === progressToolName) continue;
            // Plan 461: incremental tool-call argument fragment. Purely
            // cosmetic on this side (the authoritative input arrives with
            // `tool_use`), so forward it untouched 鈥?the renderer uses it
            // to render file edits while the model is still writing them.
            yield event;

          } else if (event.type === 'tool_group_progress') {
            toolGroupProgress.queue(event.data.title, event.data.source);

          } else if (event.type === 'tool_use') {
            const progressUpdate = readProgressUpdateCall(
              event.data.name,
              progressToolName,
              event.data.input,
            );
            if (progressUpdate) {
              const title = progressUpdate.title;
              privateProgressCalls.push({ id: event.data.id, title });
              if (title) toolGroupProgress.queue(title, 'model_progress_tool');
              needsFollowUp = true;
              continue;
            }

            const group = toolGroupProgress.assign(event.data.id);
            const { groupId, progressTitle } = group;
            if (group.progressEvent) {
              yield { type: 'tool_group_progress', data: group.progressEvent };
            }

            // Plan 426 follow-up: PreToolUse 鈥?notification before the tool
            // is dispatched to its executor. Runs to completion (blocking),
            // fail-open; matchers filter on the tool name.
            const preCtx = yield* dispatchHooks(
              'PreToolUse',
              {
                session_id: turnContext.sessionId ?? '',
                cwd: turnContext.workingDirectory ?? '',
                hook_event_name: 'PreToolUse',
                tool_name: event.data.name,
                tool_input: event.data.input ?? {},
                tool_use_id: event.data.id,
              },
              { toolName: event.data.name },
            );
            if (preCtx && preCtx.contexts.length > 0) {
              logger.debug(
                `[Hooks] PreToolUse ${event.data.name} produced ${preCtx.contexts.length} context line(s)`,
              );
              // Context-injection hardening: PreToolUse is advisory, not a
              // decision point 鈥?its contexts are injected as an enveloped
              // reminder keyed per tool so repeated firings replace the
              // previous block instead of stacking. Fail-open by contract.
              const advisory = preCtx.contexts
                .map((c, i) => renderHookContextEnvelope(
                  { event: 'PreToolUse', hookName: 'pre-tool-use', toolName: event.data.name, toolUseId: event.data.id, seq: i },
                  c,
                ))
                .join('\n\n');
              applyHookInjection(
                messages as unknown as InjectableMessage[],
                `PreToolUse:${event.data.name}`,
                renderSystemReminder(advisory, 'pre_tool_use_advisory'),
                'custom',
                { id: crypto.randomUUID(), now: Date.now() },
              );
            }

            // Add tool to executor for background execution
            const groupedToolUse = {
              ...event.data,
              groupId,
              ...(progressTitle ? { progressTitle } : {}),
              progressSource: group.progressSource,
            };
            executor.addTool(groupedToolUse);
            needsFollowUp = true;

            // Anti-dead-loop: track consecutive identical tool calls (name +
            // serialized input). Streak counting is an engine invariant;
            // nudge decisions consume it via PostToolUse. Plan 550 step 2e
            // (TurnPreparer): encapsulated in DeadLoopTracker.
            deadLoopTracker.record(event.data.name, event.data.input ?? {});
            turnToolCalls.push({ name: event.data.name, input: event.data.input });
            turnToolCallIds.set(event.data.id, event.data.name);

            // Build assistant content with tool_use block
            assistantContent.push({
              type: 'tool_use',
              id: event.data.id,
              name: event.data.name,
              input: event.data.input,
              groupId,
              ...(progressTitle ? { progressTitle } : {}),
              progressSource: group.progressSource,
              // Gemini thought signatures must be replayed with the
              // function call they were issued for.
              ...(event.data.signature ? { thoughtSignature: event.data.signature } : {}),
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

            // Yield the tool_use event to caller with its stable group identity.
            yield { ...event, data: groupedToolUse };

          } else if (event.type === 'text') {
            toolGroupProgress.closeActiveGroup();
            // Accumulate text content - merge consecutive text blocks
            // to prevent markdown fragmentation when stored in DB
            const lastBlock = assistantContent[assistantContent.length - 1];
            if (lastBlock && lastBlock.type === 'text') {
              lastBlock.text += event.data;
            } else {
              // When the previous block was a tool_use / thinking, the new
              // text block needs a leading newline so block-level markdown
              // (### heading, - list, 1. numbered, etc.) is not swallowed
              // into the previous paragraph. Without this, LLM outputs
              // like `...text\n### heading` that span a tool boundary get
              // concatenated into a single inline paragraph.
              const prefix = assistantContent.length > 0 ? '\n' : '';
              assistantContent.push({
                type: 'text',
                text: prefix + event.data,
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
            // Plan 418 L2: capture the model's native stop reason (end_turn /
            // max_tokens / tool_use / stop_sequence) for turn-termination
            // decisions below (intent-consistency nudge, length guard).
            turnStopReason = (event as { reason?: string }).reason;
            // LLM stream is done for this turn
            // IMPORTANT: Add assistant message BEFORE tool results for OpenAI API compatibility
            // OpenAI requires: assistant (tool_calls) -> tool (result) message order

            // Build final assistant content including thinking block if present
            const finalAssistantContent: MessageContent[] = [];

            // Redacted reasoning goes first: the encrypted payload must lead
            // the assistant turn for Anthropic thinking-mode validation.
            if (redactedEncrypted) {
              finalAssistantContent.push({
                type: 'thinking',
                thinking: '',
                redacted: true,
                encrypted: redactedEncrypted,
              });
            }

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

            if (
              finalAssistantContent.length > 0 ||
              (needsFollowUp && privateProgressCalls.length === 0)
            ) {
              // Per-message model attribution: lets transformMessages
              // recognize this message as same-model on the next round's
              // request and replay its thinking block natively (with the
              // signature captured above) instead of downgrading to text.
              const pushed: Message = { id: crypto.randomUUID(), role: 'assistant', content: finalAssistantContent.length > 0 ? finalAssistantContent : assistantContent, timestamp: Date.now(), duration_ms: Date.now() - streamStartTime, seq_index: seqIndex, ...this.modelAttribution };
              // Plan 445: prefer the turn-cumulative tokenUsage (with
              // `last_call` sub-block) supplied by the caller via
              // `cumulativeTokenUsageRef`. Falls back to the single-call
              // `usageBlock` derived from `roundResultUsage` so callers that
              // never set the ref (CLI / tests / direct streamChat) still
              // get a working ring — they just lose `last_call` and the
              // turn sum, matching pre-plan-445 behavior.
              const cumulative = options?.cumulativeTokenUsageRef?.current ?? null;
              if (cumulative) {
                // Plan 546: `pushed.usage` is the in-memory anchor consumed
                // by computeContextEstimate (pi style). It MUST stay the
                // single-call snapshot (largest-prompt call of the turn),
                // not the turn-cumulative block — otherwise every consumer
                // that reads `usage` (seed loop, anchor scans, anchor
                // correction) inherits a per-turn sum that overlaps with
                // the per-call ledger the `result` handler also walks.
                // `pushed.tokenUsage` remains the turn-cumulative block
                // (with `last_call` + `calls` ledger) for the DB column;
                // the renderer's persisted scan prefers `last_call`, so the
                // anchor still recovers correctly on reload.
                const singleCall = deriveSingleCallUsage(cumulative);
                (pushed as AssistantMessage).usage = singleCall as AssistantMessage['usage'];
                // Persisted shape — turn-cumulative + last_call + calls
                (pushed as Message & { tokenUsage?: unknown }).tokenUsage = cumulative;
              } else if (roundResultUsage && ((roundResultUsage.input_tokens ?? 0) + (roundResultUsage.output_tokens ?? 0)) > 0) {
                // Legacy fallback (CLI / unit tests): single-call block.
                // Attach BOTH field names: `usage` is the pi-style in-memory
                // convention read by computeContextEstimate's anchor scan,
                // `tokenUsage` is the duya projection field listed in
                // LEGACY_KNOWN_KEYS 鈥?without it ingestMessage strips the
                // block from the timeline and the context ring shows "?"
                // forever (plan 443 regression, fixed in plan 444).
                const usageBlock = {
                  input_tokens: roundResultUsage.input_tokens ?? 0,
                  output_tokens: roundResultUsage.output_tokens ?? 0,
                  ...(roundResultUsage.total_tokens !== undefined ? { total_tokens: roundResultUsage.total_tokens } : {}),
                  ...(roundResultUsage.cache_hit_tokens !== undefined ? { cache_hit_tokens: roundResultUsage.cache_hit_tokens } : {}),
                  ...(roundResultUsage.cache_creation_tokens !== undefined ? { cache_creation_tokens: roundResultUsage.cache_creation_tokens } : {}),
                };
                (pushed as AssistantMessage).usage = usageBlock;
                (pushed as Message & { tokenUsage?: unknown }).tokenUsage = usageBlock;
              }
              this._pushDurable(messages, pushed);
            }

            if (!needsFollowUp) {
              // No subsequent tool call consumed this update. Treat it as an
              // orphan rather than carrying it into a later agent run.
              toolGroupProgress.restorePending(undefined);
              toolGroupProgress.closeActiveGroup();
            }

            // Plan 418 L2 (pi parity): a max_tokens/length stop means every
            // tool call in this turn may carry truncated arguments. Fail them
            // all instead of executing potentially borked calls (pi
            // `failToolCallsFromTruncatedMessage`). The model retries next
            // turn with complete arguments.
            if (
              turnStopReason === 'max_tokens' &&
              assistantContent.some((b) => b.type === 'tool_use')
            ) {
              const truncatedUses = assistantContent.filter(
                (b): b is ToolUseContent => b.type === 'tool_use',
              );
              logger.warn(
                `[Agent] Turn ${turnCount}: LLM stopped at max_tokens with ${truncatedUses.length} tool call(s); failing them to avoid truncated arguments`,
              );
              executor.discard();
              for (const use of truncatedUses) {
                messages.push({
                  id: crypto.randomUUID(),
                  role: 'tool',
                  tool_call_id: use.id,
                  content:
                    '<tool_error>output truncated (max_tokens); tool call arguments may be incomplete. Retry the call with complete arguments.</tool_error>',
                  timestamp: Date.now(),
                  seq_index: seqIndex,
                });
              }
              needsFollowUp = true;
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
                  // Plan 610 A3-2b7 (S1): the `role === 'tool'` test moved
                  // INTO the seam method, because "is this row a tool result"
                  // is part of the protocol's answer rather than a precondition
                  // a caller has to remember.
                  this.recordTurnCatalogSchemaRead(resolvedTools, result.message);
                  this._pushDurable(messages, result.message);

                  // Yield tool result event. The frame is built by the SAME
                  // helper `recordTurnToolResult` publishes through, so the
                  // engine's port and this yield cannot drift into two
                  // renderings of one event (plan 610 A3-2b2).
                  const toolResultOutcome = this._readToolResultOutcome(result.message);
                  const toolResultId = toolResultOutcome.id;
                  const toolResultContent = toolResultOutcome.content;
                  const toolResultError = toolResultOutcome.isError;

                  yield this._buildToolResultFrame(result.message, toolResultOutcome);

                  // Plan 426 follow-up: PostToolUseFailure 鈥?fired when a
                  // tool result is an error (fail-open; matchers filter on
                  // the failed tool's name).
                  if (toolResultError) {
                    const failedToolName = turnToolCallIds.get(toolResultId) ?? '';
                    yield* dispatchHooks(
                      'PostToolUseFailure',
                      {
                        session_id: turnContext.sessionId ?? '',
                        cwd: turnContext.workingDirectory ?? '',
                        hook_event_name: 'PostToolUseFailure',
                        tool_name: failedToolName,
                        tool_input: {},
                        tool_use_id: toolResultId,
                        error: toolResultContent.slice(0, 2048),
                      },
                      { toolName: failedToolName || undefined },
                    );
                  }

                  // Plan 224 follow-up: if this tool_result belongs to a
                  // mode-switch tool (EnterPlanMode / ExitPlanMode /
                  // SwitchMode), parse the new runtime mode out of the
                  // JSON result and emit a `mode_changed` SSE event so
                  // the renderer can sync the input-box chip + glow.
                  // Skip on error 鈥?failed switches leave the mode unchanged.
                  //
                  // The map holds the tool NAME, which is the whole of what the
                  // mode switch is derived from (`modeSwitchToolIds` is filtered
                  // on the three mode tools at `:2620-2626`), so
                  // `_buildModeChangedFrame` takes the name and is callable from
                  // outside the generator as well.
                  const modeSwitchToolName = modeSwitchToolIds.get(toolResultId);
                  if (modeSwitchToolName && !toolResultError) {
                    const modeChanged = this._buildModeChangedFrame(
                      modeSwitchToolName,
                      toolResultOutcome,
                    );
                    if (modeChanged !== null) yield modeChanged;
                    modeSwitchToolIds.delete(toolResultId);
                  }
                }
              }
            }
            logger.debug(
              `[Agent] Turn ${turnCount}: getRemainingResults completed, toolResultMessageCount=${toolResultMessageCount}`
            );

            // Private progress calls are replayed to the model through the
            // working message array only. They never enter the durable
            // timeline, tool executor, permission flow, or renderer rows.
            for (const call of privateProgressCalls.splice(0)) {
              messages.push({
                role: 'assistant',
                content: [{
                  type: 'tool_use',
                  id: call.id,
                  name: progressToolName,
                  input: { title: call.title ?? '' },
                }],
                timestamp: Date.now(),
              });
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: call.title
                  ? 'Progress title accepted.'
                  : 'No valid progress title was accepted.',
                timestamp: Date.now(),
              });
            }

            // Post-tool hooks and file-context collection run after results
            // have been committed to the message history.
            //
            if (toolResultMessageCount > 0) {
              // Plan 426: PostToolUse dispatch, fired now that the turn's
              // tool results are committed so hook injections read as
              // feedback on those results (grok "results committed after"
              // semantics). Carries the identical-call streak for the
              // dead-loop nudge hook. Plan 550 step 2e (TurnPreparer):
              // the streak snapshot is now sourced from DeadLoopTracker.
              const streak = deadLoopTracker.stats();
              for (const effect of await loopHooks.dispatch('PostToolUse', {
                ...buildHookCtx(),
                consecutiveIdenticalToolCalls: streak,
              })) {
                applyLoopHookEffect(messages, effect, seqIndex);
              }

              // Plan 408b: nested AGENTS.md on-demand loading. Tools that
              // touched files under the project root pull in subtree
              // AGENTS.md / conditional rules as a one-shot user-role
              // reminder (cc-haha nested_memory parity). Per-file dedup is
              // handled by the manager's session-level loaded set.
              if (
                this.omitAgentsMd !== true &&
                isNestedAgentsMdEnabled() &&
                turnToolCalls.length > 0
              ) {
                try {
                  const triggerPaths = extractTriggerPaths(
                    turnToolCalls,
                    turnContext.workingDirectory ?? process.cwd(),
                  );
                  if (triggerPaths.length > 0) {
                    const nestedFiles = await getAgentsMdManager().collectNestedMemory(triggerPaths);
                    if (nestedFiles.length > 0) {
                      // Plan 567 §B: renderNestedMemoryBlock returns the inner
                      // <project_instructions_spec> body only — the outer
                      // <system-reminder> envelope is applied exactly once here.
                      const block = getAgentsMdManager().renderNestedMemoryBlock(nestedFiles);
                      if (block) {
                        const action = applyHookInjection(
                          messages as unknown as InjectableMessage[],
                          undefined,
                          renderSystemReminder(block, 'nested_agents_md'),
                          'nested-agents-md',
                          { id: crypto.randomUUID(), now: Date.now() },
                        );
                        logger.info(
                          `Nested AGENTS.md injected (${action})`,
                          { count: nestedFiles.length },
                          'AgentsMd',
                        );
                      }
                    }
                  }
                } catch (err) {
                  // Nested memory is advisory 鈥?never fail the turn on it.
                  logger.warn(
                    `Nested AGENTS.md collection failed: ${err instanceof Error ? err.message : String(err)}`,
                    undefined,
                    'AgentsMd',
                  );
                }
              }
            }

            // widgetStyleHistory and canvasFreshness are stable references
            // injected into toolUseContext; canvas tools mutate them in
            // place, so nothing to copy back here. The next turn reads the
            // same references via this.widgetStyleHistory / this.canvasFreshness.

            // Grok-aligned preflight overflow check
            // (`check_preflight_overflow`, grok `turn.rs:2711`). After tool
            // results are committed, see whether the projected context has
            // *exceeded* the window 鈥?a single tool call can blow past the
            // 78% threshold by itself, and waiting for the next turn's
            // `shouldCompact()` check risks a `context_length_exceeded`
            // round-trip. Compacting here is cheaper than retrying the
            // whole turn.
            if (toolResultMessageCount > 0) {
              // Plan 610 A3-2b6: the gate and the compaction moved onto the
              // coordinator (`CompactionCoordinator.decidePreflightOverflow` /
              // `.executeRecovery`) so a `CompactionPort` host can reach them.
              // The probe, the `overHardLimit` comparison, the image arm's
              // `force` and the re-projection are all still the legacy's
              // statements -- they are now the coordinator's, and this site
              // asks the same two methods the port does rather than keeping a
              // second copy of the decision.
              const overflowVerdict =
                this.compactionCoordinator.decidePreflightOverflow({ turnCount });
              if (overflowVerdict.fire) {
                try {
                  const overflowRun = await this.compactionCoordinator.executeRecovery({
                    turnCount,
                    systemPromptContent,
                    messages,
                    trigger: 'preflight_overflow',
                    force: overflowVerdict.imageTriggered,
                  });
                  const compactEntry = overflowRun.entry;
                  if (compactEntry) {
                    this.invalidateTurnCatalogSchemaReads(resolvedTools);
                    logger.info(
                      `[Agent] Turn ${turnCount}: Preflight overflow compaction fired, retained=${compactEntry.tokensAfter ?? 0} tokens`,
                      undefined,
                      'Agent',
                    );
                    // Re-project model messages from the updated timeline
                    // so the next iteration (if any) and the next turn
                    // see the compacted projection.
                    systemPromptContent = overflowRun.systemPromptContent;
                    messages = overflowRun.messages;
                  }
                } catch (overflowError) {
                  // Best-effort: a failed preflight overflow does not
                  // block the turn. Fall through to the next iteration.
                  logger.warn(
                    `[Agent] Turn ${turnCount}: Preflight overflow compaction failed: ${
                      overflowError instanceof Error
                        ? overflowError.message
                        : String(overflowError)
                    }`,
                    undefined,
                    'Agent',
                  );
                }
              }
            }

            // Do NOT yield the LLM's 'done' event to the SSE client here.
            // In multi-turn conversations, the LLM client yields a 'done' event
            // at the end of each turn. Forwarding it would cause the client to
            // prematurely think the stream is complete. Only the final 'done'
            // event (yielded after the while-loop) should reach the client.

          } else if (event.type === 'system') {
            // Plan 439: forward retry/diagnostic notices. Transport-layer
            // retries (withRetry) and turn-level stream replays both emit
            // `{ type:'system', metadata:{ retryAttempt, ... } }`; the worker
            // boundary converts those into chat:retry chips. Previously this
            // event type was silently dropped here.
            yield event;

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
            // across turns 鈥?without it the next request 400s with
            // "The content[].thinking in the thinking mode must be passed back to the API."
            if (event.signature) {
              thinkingSignature = event.signature;
            }
            // Redacted reasoning: no content follows — record the encrypted
            // payload for the push site below.
            if (event.redacted && typeof event.encrypted === 'string') {
              redactedEncrypted = event.encrypted;
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
            // Also feed usage into the goal tracker's token budget so an
            // over-budget goal transitions to `budget_limited` (plan 411
            // Phase 2) instead of silently burning tokens.
            const usage = event.data as
              | {
                  input_tokens?: number
                  output_tokens?: number
                  total_tokens?: number
                  cache_hit_tokens?: number
                  cache_creation_tokens?: number
                }
              | undefined;
            const used = usage?.total_tokens ?? usage?.input_tokens ?? 0;
            if (used > 0 && this.modeCoordinator) {
              void this.modeCoordinator.reportGoalTokenUsage(used);
            }
            roundResultUsage =
              resultPromptVolume(usage) >= resultPromptVolume(roundResultUsage) ? usage : roundResultUsage;
            // Anchor compaction decisions on real provider usage. Keeps the
            // largest-prompt result of the turn (see resultPromptVolume note
            // above) so GLM-style per-round cache reporting cannot collapse
            // the anchor mid-turn.
            const observedPrompt = resultPromptVolume(roundResultUsage);
            // Token-trace: log the per-call delta + the chosen round-max so
            // a dropped/duplicated cache_read or input_tokens is visible in
            // the log diff (the previous value is reported alongside the new
            // candidate so an off-by-one is easy to spot).
            const candidateVolume = resultPromptVolume(usage);
            const prevVolume = roundResultUsage ? candidateVolume : 0;
            // Plan 577 §2: Observation-layer feed — input and output travel
            // separately; the manager owns the round-max defense on the
            // input slot and output never inflates the anchor.
            const observedInput = normalizedPromptVolume(usage);
            const observedOutput = usage?.output_tokens ?? 0;
            logger.tokenTrace('observedPromptTokens', {
              sessionId: turnContext.sessionId ?? undefined,
              turnEvent: 'result',
              observed: observedPrompt,
              candidate: candidateVolume,
              prev: prevVolume,
              keptNew: resultPromptVolume(usage) >= resultPromptVolume(roundResultUsage),
              input: observedInput,
              output: observedOutput,
              latestInput: this.compactionManager.getLatestInputTokens() ?? null,
              peakInput: this.compactionManager.getPeakInputTokens() ?? null,
              usage: usage
                ? {
                    input: usage.input_tokens,
                    output: usage.output_tokens,
                    cacheRead: usage.cache_hit_tokens,
                    cacheWrite: usage.cache_creation_tokens,
                    total: usage.total_tokens,
                  }
                : null,
            });
            if (observedInput > 0) {
              this.compactionManager.setObservedUsageForEpoch(
                observedInput,
                observedOutput,
                requestEpoch,
              );
            }
            yield event;
          }
        }

        logger.debug(`[Agent] Turn ${turnCount}: LLM stream ended, total events=${llmEventCount}`);

        // Per-run turn cap (only fires when the caller passed an explicit
        // `maxTurns`). `maxTurns === undefined` means uncapped 鈥?matches
        // pi's design where `shouldStopAfterTurn` is the only stop hook and
        // defaults to undefined. We mirror that: no `?? N` fallback here.
        // A natural completion falls through to the `!needsFollowUp` branch.
        if (maxTurns !== undefined && turnCount >= maxTurns && needsFollowUp) {
          // No wrap-up nudge 鈥?the caller opted into a hard ceiling, so we
          // honour it. Refresh sessionInfo counters BEFORE yielding.
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
          const finalMailboxDecision = await this._sweepInterTurn(
            runId,
            messages,
            seqIndex,
            'before_final_answer',
            options,
          );
          if (finalMailboxDecision.action === 'hard_replace') {
            // Replacement runtime_context was already pushed by
            // _claimMailboxAtCheckpoint; loop to give the model a fresh turn.
            continue;
          }
          if (finalMailboxDecision.action === 'continue' && finalMailboxDecision.absorbed) {
            continue;
          }

          // Plan 426 Phase 3: round-end mode transitions + snapshot
          // persistence (plan deferred exit, goal worker rounds, research
          // auto-converge) now run inside the mode-coordinator PreFinalize
          // hook (priority 5) 鈥?dispatched ahead of the builtin vetoes
          // below, and re-fired on every natural stop exactly like the
          // pre-bus inline call did.

          // Plan 426: PreFinalize dispatch 鈥?the veto-capable steering point.
          // The model ended its turn naturally; the bus consults the builtin
          // policies (goal premature-stop 鈫?todo gate, in that
          // fixed priority order) before the run is allowed to finalize. A
          // block_finalize veto injects a transient <system-reminder>
          // directive and continues the loop. Hook failures already degraded
          // to "allow" inside the bus (fail-open).
          // Plan 550 step 2e (StreamFinalizer): the entire success-path
          // finalization is delegated to SessionFinalizer so the
          // "PreFinalize veto short-circuits the natural exit and
          // continues the loop" contract is unit-testable in
          // isolation rather than embedded in streamChat. The
          // dispatchHooks / host casts are the contractually-typed
          // escape hatches for the agent's narrowed `event` type
          // (HookEvent union) and the private `_commitMessages`
          // access — see SessionFinalizer doc comments.
          const finalizer = new SessionFinalizer({
            messages,
            turnCount,
            seqIndex,
            turnContext,
            deadLoopTracker,
            loopHooks,
            dispatchHooks: dispatchHooks as unknown as import('./SessionFinalizer.js').HookDispatcher,
            buildHookCtx,
            resolvedModes: this.resolvedModes,
            modeCtx: this.modeCtx,
            host: this as unknown as import('./SessionFinalizer.js').FinalizerHost,
            stopReason: turnStopReason,
            // Plan 569: one last mailbox claim at the finalize boundary.
            // Absorbing here keeps notifications that landed in the
            // finalize window inside this run (same path as a PreFinalize
            // veto → continue → next turn's before_model_turn claim is
            // empty → the LLM sees the notification) instead of leaking
            // to the renderer's pendingBackgroundResumes resume path.
            // soft_stop / hard_replace decisions are folded away — a run
            // about to end neither replays a soft stop nor accepts a
            // replacement context. `_claimMailboxAtCheckpoint` never
            // throws (claim failures degrade to continue/absorbed=false).
            pollFinalMailbox: async () => {
              if (finalPollAbsorbs >= FINAL_POLL_MAX_ABSORBS) return false;
              const decision = await this._sweepInterTurn(
                runId,
                messages,
                seqIndex,
                'before_final_answer',
                options,
              );
              const absorbed = decision.action === 'continue' && decision.absorbed;
              if (absorbed) {
                finalPollAbsorbs++;
                logger.info(
                  `[AgentMailbox] final poll absorbed #${finalPollAbsorbs}/${FINAL_POLL_MAX_ABSORBS} at finalizeSuccess`,
                );
              }
              return absorbed;
            },
          });
          const finalized = yield* finalizer.finalizeSuccess();
          if (finalized) return;
          // PreFinalize vetoed — the effect has been applied to the
          // messages array, continue the loop.
          continue;

          // (PostTurn dispatch + mode-exit hooks + SessionEnd +
          // done event are now driven by SessionFinalizer.finalizeSuccess
          // above. The block below is unreachable dead code kept out of
          // the diff to keep this commit reviewable.)
        }

        // Anti-dead-loop hard stop: only when the model requested more tool
        // rounds. The assistant message and tool results are already persisted
        // above, so terminating here is safe. Plan 550 step 2e (TurnPreparer):
        // threshold check moved into DeadLoopTracker.shouldHardStop().
        if (deadLoopTracker.shouldHardStop()) {
          this._commitMessages();
          yield { type: 'done', reason: 'repeated_tool_calls' };
          return;
        }

        // Loop continues - next LLM call will include tool results
        // Note: assistant message and tool results were already added in 'done' event handler

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`[Agent] Turn ${turnCount}: Error in LLM stream`, error instanceof Error ? error : new Error(errorMessage));

        // Check for context length exceeded errors and attempt compaction.
        // Plan 577 Phase 0: dual-evidence gate. The old raw
        // `errorMessage.includes('exceeds limit')` match fired a
        // threshold-free emergency compaction for ANY error carrying that
        // phrase (output/payload/quota wording included). Now:
        //   explicit provider claim → compaction on its own (the local budget
        //     may be misresolved, so a probe is NOT more authoritative here);
        //   weak wording            → only with local corroboration
        //     (projected context already over the trigger line); probe
        //     failure = no evidence = no compaction (fail-closed).
        //
        // Plan 610 A3-2b6: the gate moved onto the coordinator
        // (`decideEmergency`) so a `CompactionPort` host can reach the recovery
        // path at all, and the compaction itself onto `executeRecovery`. The
        // structured log below still reads the classification and the measured
        // context off the SAME verdict that decided -- plan 577 review round 2
        // made these lines the historical baseline the ContextLedger is
        // verified against, so they are preserved rather than re-derived by a
        // second probe next to the gate.
        const emergencyVerdict = this.compactionCoordinator.decideEmergency({
          turnCount,
          providerError: errorMessage,
        });
        const evidenceProbe: CompactionProbe | null = emergencyVerdict.probe ?? null;

        if (emergencyVerdict.fire) {
          const evidence =
            emergencyVerdict.classification === 'explicit' ? 'explicit' : 'weak+probe';
          logger.warn(
            `[Agent] Turn ${turnCount}: Context length exceeded (evidence=${evidence}), attempting compaction`,
            {
              classification: emergencyVerdict.classification,
              estimatedTokens: evidenceProbe?.tokens ?? null,
              peakInputTokens: evidenceProbe?.peakInputTokens ?? null,
              triggerLine: this.compactionManager.getTriggerLine(),
              hardLimit: this.compactionManager.getHardLimit(),
              contextWindow: this.compactionManager.getMaxTokens(),
              modelId: this._model,
              windowSource: compactionWindowSource,
            },
          );
          try {
            const emergencyRun = await this.compactionCoordinator.executeRecovery({
              turnCount,
              systemPromptContent,
              messages,
              trigger: 'emergency',
              force: false,
            });
            const compactEntry = emergencyRun.entry;
            if (compactEntry) {
              this.invalidateTurnCatalogSchemaReads(resolvedTools);
              logger.info(`[Agent] Turn ${turnCount}: Compaction succeeded, strategy=${compactEntry.strategy}, retained=${compactEntry.tokensAfter ?? 0} tokens`);
              systemPromptContent = emergencyRun.systemPromptContent;
              messages = emergencyRun.messages;
              // Retry this turn with compacted messages
              executor.discard();
              turnCount--; // Decrement so the next iteration uses the same turn number
              continue;
            }
          } catch (compactError) {
            const compactErrorMsg = compactError instanceof Error ? compactError.message : String(compactError);
            logger.error(`[Agent] Turn ${turnCount}: Compaction failed: ${compactErrorMsg}`);
          }
        }

        // Plan 550 step 2e (StreamFinalizer): the cleanup +
        // AbortError synthetic tool_result injection + Plan 462
        // error-code mapping is delegated to the finalizer so the
        // catch block stays focused on the retry orchestration.
        const errorFinalizer = new SessionFinalizer({
          messages,
          turnCount,
          seqIndex,
          turnContext,
          deadLoopTracker,
          loopHooks,
          dispatchHooks: dispatchHooks as unknown as import('./SessionFinalizer.js').HookDispatcher,
          buildHookCtx,
          resolvedModes: this.resolvedModes,
          modeCtx: this.modeCtx,
          host: this as unknown as import('./SessionFinalizer.js').FinalizerHost,
          executor,
        });
        yield* errorFinalizer.finalizeStreamError(error);
        return;
      } finally {
        // Always release the per-request timeout controller (clear the
        // timer and drop the parent-signal abort listener) so a long
        // multi-turn run does not accumulate listeners/timers.
        disposeRequestController();
      }
    }

    // User interrupted - executor already created in current turn.
    // Plan 550 step 2e (StreamFinalizer): Stop + SessionEnd +
    // done(aborted) is delegated to SessionFinalizer.finalizeAbort.
    const finalizer = new SessionFinalizer({
      messages,
      turnCount,
      seqIndex,
      turnContext,
      deadLoopTracker,
      loopHooks,
      dispatchHooks: dispatchHooks as unknown as import('./SessionFinalizer.js').HookDispatcher,
      buildHookCtx,
      resolvedModes: this.resolvedModes,
      modeCtx: this.modeCtx,
      host: this as unknown as import('./SessionFinalizer.js').FinalizerHost,
    });
    yield* finalizer.finalizeAbort();
  }

  /**
   * Plan 437: drain hook-event messages accumulated during this
   * `streamChat` call. The agent process entry calls this at the turn-end
   * boundary and forwards the messages to `appendMessages` so they
   * persist as `msg_type: 'hook_invocation'` rows. Returns a fresh array
   * (the internal buffer is reset) so subsequent dispatches within the
   * same round don't double-count.
   *
   * Marked public so the agent process entry can call it across the
   * module boundary.
   */
  drainPendingHookMessages(): Message[] {
    return this.pendingHookMessages.drain();
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
   * timeline-derived getter, so no array assignment happens here 鈥?the
   * timeline is the single source of truth for the durable projection.
   */
  private _commitMessages(): void {
    this.sessionInfo.messageCount = this.messages.length;
    this.sessionInfo.updatedAt = Date.now();
  }

  /**
   * Append a message to the timeline if not already present. O(1) via
   * syncedMessageIds set. Called at every durable message creation site
   * so the timeline is always current 鈥?no batch reverse sync needed.
   */
  private _appendMessageToTimeline(message: Message): void {
    if (!message.id || this.syncedMessageIds.has(message.id)) return;
    // Tool-result messages are built without a timestamp (see
    // StreamingToolExecutor). Backfill with the current time so persisted
    // history (the timeline-derived `messages` projection) never carries a
    // 0 epoch timestamp that breaks time ordering / display.
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
      // RuntimeContextMessage discriminates on `role` (message-framework.ts).
      // Keep `kind` as a legacy fallback for envelope-shaped entries.
      if (msg.role !== 'runtime_context' && msg.kind !== 'runtime_context') continue;
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
   * Plan 441: per-event persistence journal. Wired up by the caller
   * (agent-process-entry) after construction so the agent loop can
   * `journal.*` every completed timeline boundary without holding a
   * construction-time dependency on the persistence module.
   *
   * If unset, `_pushDurable` silently skips journal emits 鈥?the in-memory
   * timeline still updates, so unit tests that don't exercise persistence
   * stay green.
   */
  journal?: import('../journal/Journal.js').Journal;
  /**
   * Plan 441: turn id for the in-progress streamChat. Set at the top of
   * every streamChat call from `ChatOptions.turnId`. Read by `_pushDurable`
   * to thread the id into journal emits.
   */
  private currentTurnId: string | null = null;

  /**
   * Plan 486: active fork (thread) turn. Set when the current streamChat turn
   * is a branched fork submission (`replyToId` + `branched`). Every non-user
   * durable message produced during this turn is tagged branched against the
   * fork's user message, so the whole exchange belongs to the branched layer:
   * it never appears in the main transcript or any later main projection.
   * Quote replies (replyToId without branched) leave this null 鈥?they stay on
   * the main line. Reset at the top of every streamChat call.
   */
  private forkTurn: { replyToId: string; userId: string } | null = null;

  /**
   * Push a durable message to both the working array and the timeline.
   * Transient messages (mailbox, background notifications) should use
   * `messages.push()` directly 鈥?they are filtered out by persistableMessages
   * and never reach the timeline.
   *
   * Plan 441: when a `journal` is wired, also fire the appropriate event
   * boundary so the message is durable at the moment it enters the
   * timeline (not at turn end). User messages, assistant messages, and tool
   * results each get their own deterministic id via `Journal`.
   */
  private _pushDurable(messages: Message[], message: Message): void {
    messages.push(message);
    this._commitDurable(message);
  }

  /**
   * Read one drained tool result's id / content / error-ness.
   *
   * ## Why this is a method and not inline code at the two call sites
   *
   * Plan 610 A3-2b2. Both the legacy's `yield` and `recordTurnToolResult` need
   * this reading, and the two message shapes it bridges (the `role: 'tool'` row
   * and the older `tool_result` content block) are exactly the kind of
   * "both sides are `Record<string, unknown>`" mismatch that typechecks either
   * way. One reader, two callers, is the only way the two can be guaranteed to
   * agree -- and an error-ness read that disagreed would show the renderer a
   * success frame for a failed tool.
   */
  private _readToolResultOutcome(message: Message): ToolResultOutcome {
    const content = message.content;
    if (message.role === 'tool') {
      // New format: role: 'tool' with string content
      const text = typeof content === 'string' ? content : JSON.stringify(content);
      return {
        id: message.tool_call_id || '',
        content: text,
        // Check if content indicates an error
        isError: text.includes('<tool_error>'),
      };
    }
    // Old format: content array with tool_result block
    const contentBlock = (content as MessageContent[])[0] as ToolResultContent;
    return {
      id: contentBlock.tool_use_id,
      content: typeof contentBlock.content === 'string'
        ? contentBlock.content
        : JSON.stringify(contentBlock.content),
      isError: contentBlock.is_error ?? false,
    };
  }

  /**
   * The `tool_result` SSE frame for one drained result.
   *
   * Built here rather than at either call site so the legacy's `yield` and the
   * turn-output sink publish the SAME object shape. `name: ''` is the legacy's
   * own value, kept: the renderer's `ToolResultInfo` resolves the name from the
   * preceding `tool_use`, and filling it from the record would be a second
   * answer to a question the stream already answered.
   */
  private _buildToolResultFrame(message: Message, outcome: ToolResultOutcome): SSEEvent {
    return {
      type: 'tool_result',
      data: {
        id: outcome.id,
        name: '',
        result: outcome.content,
        error: outcome.isError,
        duration_ms: message.duration_ms,
        // Forward tool-result metadata so renderer ToolResultInfo
        // can surface previews (browser screenshot / vision_analyze).
        metadata: message.metadata,
      },
    } as SSEEvent;
  }

  /**
   * The `mode_changed` frame for a mode-switch tool's result, or `null`.
   *
   * ## Why the tool NAME is enough
   *
   * Because `modeSwitchToolIds` carries nothing else: the legacy fills it only
   * for `EnterPlanMode` / `ExitPlanMode` / `SwitchMode` and stores the name
   * (`:2620-2626`). So the switch is a pure function of (name, result JSON), and
   * a caller outside the generator can compute the same frame rather than
   * re-deriving the rule.
   *
   * `null` covers all three ways there is nothing to say: not a mode-switch
   * tool, malformed JSON (fail-open, exactly as the legacy's `catch`), and a
   * result that names no mode.
   */
  private _buildModeChangedFrame(toolName: string, outcome: ToolResultOutcome): SSEEvent | null {
    // Skip on error 鈥?failed switches leave the mode unchanged.
    if (outcome.isError) return null;
    if (
      toolName !== 'SwitchMode' &&
      toolName !== 'EnterPlanMode' &&
      toolName !== 'ExitPlanMode'
    ) {
      return null;
    }
    let nextMode: AgentRuntimeMode | undefined;
    let reason: string | undefined;
    try {
      const parsed = JSON.parse(outcome.content) as Record<string, unknown>;
      if (toolName === 'SwitchMode') {
        nextMode = parsed.currentMode as AgentRuntimeMode | undefined;
        reason = parsed.reason as string | undefined;
      } else {
        const planMode = parsed.planMode;
        nextMode = planMode ? 'plan' : 'general';
      }
    } catch {
      // Malformed JSON result 鈥?leave nextMode undefined.
      return null;
    }
    if (!nextMode) return null;
    return {
      type: 'mode_changed',
      data: { mode: nextMode, source: 'agent', reason },
    } as SSEEvent;
  }

  /**
   * The DURABLE half of `_pushDurable`: fork tagging, timeline, journal.
   *
   * ## Why this is a separate method rather than inlined above
   *
   * Plan 610 A3-2b2. `_pushDurable` does two things that have different owners:
   * it pushes into the LEGACY's working `messages` array (the generator builds
   * the next request from that array, and it is the generator's alone), and it
   * makes the row durable. Only the second half is something a host binding
   * `RunEnginePorts.turnOutput` needs, because the engine seeds its own next
   * request from `assembled.messages` (`run-engine.ts:900`) and does not read
   * the legacy's.
   *
   * Splitting it means the legacy's array push and the durable write are ONE
   * implementation with two callers -- the `claimInterTurn` / `_sweepInterTurn`
   * shape -- instead of a seam that re-implements the journal emits and can drift
   * from them.
   *
   * ## Why the fork tag moved below the array push
   *
   * Because the array holds the SAME object, and nothing reads `messages` between
   * the push and the tag: the tag is applied in place and is visible to every
   * reader of the array afterwards, exactly as it was when the tag ran first.
   * Keeping the tagging in both places would have been the alternative, and a
   * guard-guarded second copy of a merge is a second copy that can drift.
   */
  private _commitDurable(message: Message): void {
    // Plan 486: during an active fork turn every assistant/tool message that
    // closes a boundary is tagged branched against the fork's user message, so
    // the whole exchange stays on the thread layer (never in the main
    // transcript or later main projections). The fork's own user message is
    // tagged at construction; anything already branched is left untouched.
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
        // 'system' messages (hook invocations, runtime context) are
        // emitted separately via Journal.hookInvoked so the wire format
        // stays a typed event rather than a free-form 'system' row.
      }
    }
  }

  /**
   * One inter-turn sweep, in the port's shape, against the live transcript.
   *
   * ## Why the three call sites go through here
   *
   * This is the SEAM, not a wrapper for tidiness. `_claimMailboxAtCheckpoint`
   * has exactly one implementation and it is private, so the only way for the
   * engine to reach the same claim is through something the host can bind as
   * `RunEnginePorts.interTurn` -- and the three in-loop call sites are what
   * makes that binding the SAME capability rather than a parallel one. Two
   * code paths claiming the same rows is the failure this method exists to make
   * impossible: the claim token decides which run owns a row, so a second
   * claim path is a second authority for that.
   *
   * ## Why the signature keeps `messages` rather than a capture array
   *
   * Because the legacy OWNS its transcript and can push into it directly, which
   * is what the claim has always done (`:3709`, `:3720`). The engine cannot:
   * `assembled.messages` is a `readonly` value the engine did not build
   * (`run-engine.ts:497`), so `buildInterTurnPort` hands the claim a CAPTURE
   * array and reports back what landed in it. Two callers, one claim, two
   * vocabularies -- stated here because the asymmetry looks like an oversight
   * otherwise, and it is a consequence of who owns the array.
   *
   * The injected rows are NOT returned here. They are already in `messages`,
   * which is the array every later turn is built from, and returning them as
   * well would push each row twice.
   */
  /**
   * Run one inter-turn sweep against a capture array, for a host binding
   * `RunEnginePorts.interTurn`.
   *
   * PUBLIC, and it is the whole reason `_sweepInterTurn` exists. The claim is
   * private, so without this the engine could not reach the same rows the legacy
   * claims -- and two claim paths over one store is a second authority for which
   * run owns a row (`DuyaAgent.ts:3635`, the claim token).
   *
   * ## Why the signature takes a CAPTURE array, while `_sweepInterTurn` does not
   *
   * Two callers, two different owners of the transcript, one claim:
   *
   *  - the legacy OWNS its `messages` array and can push into it directly, which
   *    is what the claim has always done (`:3709`, `:3720`). That is
   *    `_sweepInterTurn`.
   *  - the engine does NOT: `assembled.messages` is a `readonly` value the engine
   *    did not build (`run-engine.ts:497`). So it hands over a fresh array and
   *    reads back what landed in it. The asymmetry is a consequence of who owns
   *    the array, and it is stated here because it otherwise reads as an
   *    oversight.
   *
   * ## Why this returns the TRANSCRIPT decision
   *
   * Because `RuntimeMailboxDecision` is already this file's vocabulary and is
   * already imported. Returning it keeps the module graph unchanged: naming the
   * runtime's `InterTurnSweepResult` here would need a new import statement from
   * this file, and `architecture-policy.yaml` pins the permitted-edge count, so a
   * port whose only cost was a new edge in a 5295-line file is a bad trade. The
   * translation to the runtime's shapes happens in `process/run-engine-ports.ts`,
   * beside the other adapters, and it is the only place that knows both
   * vocabularies.
   *
   * ## Why `seqIndex` is a parameter and not a field
   *
   * It is `Date.now()` taken once per `streamChat` call (`:1792`) and threaded
   * into every durable row the loop writes, so it is per-run state the LEGACY
   * owns. Mirroring it onto a field would mean inventing state to hold a value
   * that already exists as a local, and defaulting it would stamp every injected
   * row with a constant index that silently mis-orders it against real
   * transcript rows. Whoever binds the port for a run supplies the same value
   * that run's loop used -- which is why it is required rather than optional.
   */
  async claimInterTurn(input: {
    readonly runId: string;
    readonly checkpoint: 'before_model_turn' | 'before_final_answer';
    /** Stand-in for the run's transcript. The claim only ever appends to it. */
    readonly messages: Message[];
    readonly seqIndex: number;
    readonly wakeRun: boolean;
    readonly imageInputSupported?: boolean;
  }): Promise<RuntimeMailboxDecision> {
    return this._claimMailboxAtCheckpoint(
      input.runId,
      input.messages,
      input.seqIndex,
      input.checkpoint,
      input.wakeRun,
      input.imageInputSupported,
    );
  }

  private async _sweepInterTurn(
    runId: string,
    messages: Message[],
    seqIndex: number,
    checkpoint: 'before_model_turn' | 'before_final_answer',
    options?: ChatOptions,
  ): Promise<RuntimeMailboxDecision> {
    return this._claimMailboxAtCheckpoint(
      runId,
      messages,
      seqIndex,
      checkpoint,
      options?.wakeRun === true,
      options?.imageInputSupported,
    );
  }

  /**
   * The engine's `CompactionSources`, bound to THIS agent's compaction.
   *
   * PUBLIC, and the fourth instance of the same seam the module already
   * documents: `readModelClient` (`:295`), `claimInterTurn` (`:4226`) and the
   * turn-output sink (`:589`) each lift one thing out of `streamChat`'s closure
   * so a run composition can bind the port that needs it. Compaction is the
   * fourth because `compactionCoordinator` is private and the loop's
   * `systemPromptContent` / `messages` live in the generator's own frame --
   * neither is reachable from outside without this.
   *
   * ## What the two accessors are, and why they are accessors
   *
   * They are the legacy loop's per-turn values, and `streamChat` hands the
   * coordinator exactly these two (`DuyaAgent.ts:2597-2598`). They are read at
   * CALL TIME because a compaction re-projects them mid-run
   * (`DuyaAgent.ts:2630-2631`): a snapshot taken when the run's ports were
   * built would hand turn two turn one's transcript.
   *
   * ## Why this is a SOURCE and not the PORT
   *
   * `buildCompactionPort` is the adapter, and `process/run-engine-compaction.ts`
   * is what knows how the legacy's compaction fits `CompactionPort`'s decide /
   * run split. What only this class can supply is the coordinator and the
   * usage-ledger call -- both private, both already owned here.
   */
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
      // The provider's real usage, epoch-tagged exactly as the loop files it
      // (`:3565`). WITHOUT this the port would carry no `noteUsage` at all and
      // the engine could not tell an anchored trigger from an estimated one
      // (`run-engine-ports.ts:518-526`), so it is bound rather than optional.
      noteUsage: (anchor) => {
        this.compactionManager.setObservedUsageForEpoch(
          anchor.inputTokens,
          anchor.outputTokens,
          anchor.epoch,
        );
      },
    });
  }

  private async _claimMailboxAtCheckpoint(
    runId: string,
    messages: Message[],
    seqIndex: number,
    checkpoint: 'before_model_turn' | 'before_final_answer',
    wakeRun = false,
    imageInputSupported = isModelLikelyMultimodal(this.model),
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

    const usableRows = claim.rows.filter((row) => row.content.trim().length > 0 || parseMailboxAttachments(row.attachments_json).length > 0);
    if (!usableRows.length) {
      return { action: 'continue', absorbed: false };
    }

    for (const row of usableRows) {
      await applyRow(row, claim.rows.indexOf(row), 'absorbed as runtime instruction before model turn');
    }

    // Plan 497: on a wake run the DM body is already in the wake prompt —
    // re-injecting an `agent_dm` row would make the model read the same text
    // twice. In practice `agent_dm` rows are never claimable at any
    // checkpoint (see claimableKinds in mailbox.ts), so this filter is
    // belt-and-braces; mid-user-turn delivery still injects other row kinds
    // via the guidance block below.
    const injectableRows = wakeRun
      ? usableRows.filter((row) => row.kind !== 'agent_dm')
      : usableRows;

    const backgroundNotificationRows = injectableRows.filter((row) => row.kind === 'background_notification');
    // Plan 570: since claimableKinds narrowed `before_final_answer` to
    // background_notification only, `guidanceRows` is always empty at that
    // checkpoint — the `<runtime-user-guidance>` fold below now only fires at
    // `before_model_turn` (followup steering). User messages surviving the
    // exit boundary are promoted to a real user turn by the renderer.
    const guidanceRows = injectableRows.filter((row) => row.kind !== 'background_notification');

    for (const row of backgroundNotificationRows) {
      const ctx = adaptBackgroundNotification(row, { seqIndex });
      // Frame the raw `<task-notification>` XML in a `<system-reminder>`
      // envelope (plan 408/567 convention) so the model treats it as system
      // context rather than user speech. Injecting it as a bare user turn
      // made the model adopt the notification as its own conversational
      // voice and degraded reply quality (2026-09-26 investigation).
      const wrappedContent = typeof ctx.content === 'string'
        ? renderSystemReminder(
          [
            'Automated background-task notification — system context, not a user message.',
            'Do not greet the user or announce this notification; silently fold it into the ongoing work where relevant.',
            ctx.content,
          ].join('\n'),
          'background_notification',
        )
        : ctx.content;
      const projected = projectRuntimeContextToProviderMessage({ ...ctx, content: wrappedContent });
      if (projected) messages.push(projected);
    }

    if (guidanceRows.length > 0) {
      // Align claim tokens with the guidance (non-empty) rows.
      const guidanceTokens = guidanceRows.map((row) => claim.claimTokens[claim.rows.indexOf(row)]);
      const adapted = await prepareMailboxGuidance(guidanceRows, guidanceTokens, {
        seqIndex, imageInputSupported, analyzeImage: this.visualAnalysis.analyzeImage.bind(this.visualAnalysis),
      });
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
   * resolved here 鈥?callers handle profile -> mode mapping.
   */
  private async _resolveAgentProfile(options?: ChatOptions): Promise<AgentProfile | undefined> {
    if (!options?.agentProfileId) {
      return undefined;
    }
    const profileService = getAgentProfileService();
    const preset = profileService.get(options.agentProfileId);
    if (preset) {
      logger.info(
        `[Agent] Applying agent profile: ${preset.name} (${preset.id}), promptSystem=${preset.promptSystem || 'general'}`
      );
      return preset;
    }
    // Config-driven custom agents (Plan 424): read [agents.<id>] from config.toml.
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
    } catch (err) {
      logger.warn(`[Agent] Failed to resolve config agent profile ${options.agentProfileId}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /**
   * Build the tool list for this turn.
   *
   * Three layers of filtering are applied in order:
   *   0. `options.allowedTools` 鈥?caller-supplied hard allowlist (most restrictive)
   *   1. `options.disabledTools` 鈥?caller-supplied hard denylist
   *   2. `appliedProfile.allowedTools/disallowedTools` 鈥?agent profile policy
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
  ): Promise<ResolvedTurnTools> {
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
    // Connector tools are deferred by default. An @-mention promotes that
    // provider's tools to direct calls for this turn.
    const selectedProviders = options?.mentionedProviders?.filter((p) => typeof p === 'string' && p) ?? [];
    const preExposedConnectorTools = new Set<string>(
      selectedProviders.length
        ? getCachedAppConnectionDescriptors()
            .filter((d) => selectedProviders.includes(d.provider))
            .map((d) => d.name)
        : [],
    );
    // Apply current profile, caller, and provider-mention constraints. The
    // catalog keeps a separate eligible set for deferred dispatch.
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
    logger.debug(
      `[Agent] Tool snapshot: ${allTools.length} total (${mcpToolCount} MCP, ${allTools.length - mcpToolCount} non-MCP)`,
    );
    const discoveredSeed =
      preExposedConnectorTools.size > 0
        ? new Set([...EMPTY_DISCOVERED, ...preExposedConnectorTools])
        : EMPTY_DISCOVERED;
    const directToolIds = new Set(
      snapshot.catalogEntries
        .filter((entry) => isToolVisible(entry.definition.name, entry.exposure, discoveredSeed, constraints))
        .map((entry) => entry.toolId),
    );
    const catalogAllowed = isToolVisible('tool_catalog', 'eager', EMPTY_DISCOVERED, constraints);
    const invokeAllowed = isToolVisible('tool_invoke', 'eager', EMPTY_DISCOVERED, constraints);
    const eligibleToolIds = new Set(
      snapshot.catalogEntries
        .filter((entry) =>
          isToolVisible(entry.definition.name, 'eager', discoveredSeed, constraints) &&
          (entry.exposure !== 'deferred' || directToolIds.has(entry.toolId) || (catalogAllowed && invokeAllowed))
        )
        .map((entry) => entry.toolId),
    );
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
      if (!isToolVisible(t.name, exposure, discoveredSeed, constraints)) continue;
      // Plan 580 D4: last-mile provider projection. The registry holds
      // canonical schemas untouched; only what leaves to the model is
      // wrapped (combinator roots) or 8KB-budget-trimmed here. Identity
      // results push the original object so byte-stable turns don't copy.
      const projection = projectForProvider(t.input_schema);
      tools.push(projection.downgraded ? { ...t, input_schema: projection.schema } : t);
    }
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
    // returned to the LLM 鈥?they live behind the tool's own validation.
    logger.info(`[Agent] streamChat: Loading agent definitions...`);
    // Dynamic import breaks the load-time cycle through
    // `tool/SubagentTool/runAgent.ts:15` (`import { duyaAgent }`). See Plan 211
    // Phase D for the full explanation.
    const { getAgentDefinitions } = await import('../tool/SubagentTool/index.js');
    const agentDefinitions = getAgentDefinitions();
    logger.info(`[Agent] streamChat: Loaded ${agentDefinitions.length} agent definitions`);

    return { tools, registry, agentDefinitions, constraints, catalogTool, catalogView, toolInvokeExecutor };
  }

  /**
   * Build the final system prompt string for this turn.
   *
   * The composition order is:
   *   1. Profile-driven identity block (highest precedence 鈥?must lead)
   *   2. Caller-supplied `systemPromptPrefix`
   *   3. Resolved prompt system (general/research), honoring:
   *      - `disableSystemPrompt` (empty)
   *      - `systemPrompt` (raw override)
   *      - prompt system rendering (default)
   *   4. Output style injection (handled inside the prompt system context)
   *
   * Note: conversation-derived system messages (compaction summaries, etc.)
   * are merged in *after* this helper returns 鈥?see the inline block in
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
        // Plan 525 / 408 follow-up: feed the project-entity home into
        // the agentsmd loader via `preBuildHook` so the project's seeded
        // home AGENTS.md joins the cwd ancestor walk in the first-turn
        // system prompt. Undefined when the session is not bound to a
        // registered duya project.
        projectHome: this.projectHome,
      });
      const systemPromptResult = await promptSystem.buildSystemPrompt(context);
      systemPromptContent = [...systemPromptResult].join('\n\n');
    }

    // Four-tier exposure: under `exposure = "search"` MCP tools are absent
    // from the tools array and unknown to the model — keep a bounded
    // capability directory in the system prompt so a broad request such as
    // "what MCP tools do I have?" does not depend on search-result
    // ordering. Under `full`/`hint` every MCP tool is declared on the
    // request already; the directory would be redundant.
    //
    // Plan 580 Phase 3 (Awareness 常驻): the connector "Apps" section is
    // gated on `disableSystemPrompt` only, NOT on the exposure config — the
    // model needs the mention syntax and the `tool_catalog list` pointer in
    // every exposure mode, because deferred/connector tools are still
    // reachable through `tool_catalog` even when the directory above is
    // redundant. Rendered deterministically: null (omitted) when nothing is
    // connected, byte-stable for a stable connection set.
    if (!options?.disableSystemPrompt) {
      if (readToolExposureConfig().exposure === 'search') {
        const mcpCatalog = buildMCPCapabilityCatalog(
          this.activeMCPRegistry.getAllTools().filter(
            (tool) => this.activeMCPRegistry.getOwner(tool.name) === 'mcp',
          ),
          { entryPoint: 'tool_catalog' },
        );
        if (mcpCatalog) {
          systemPromptContent = systemPromptContent
            ? `${systemPromptContent}\n\n${mcpCatalog}`
            : mcpCatalog;
        }
      }

      // Plan 450 Phase G: persistent "Apps (Connectors)" section 鈥?codex's
      // developer-role apps_instructions parity. Rendered whenever any app
      // connection has tool descriptors, so the model knows the mention
      // syntax and can trigger apps implicitly, not only on turns where the
      // user @-mentioned one. Null (omitted) when nothing is connected.
      const appsSection = buildAppsSystemSection(getCachedAppConnectionDescriptors());
      if (appsSection) {
        systemPromptContent = systemPromptContent
          ? `${systemPromptContent}\n\n${appsSection}`
          : appsSection;
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
    // prompt only 鈥?no mode-specific overlays.

    // Plan 408 Phase 5: AGENTS.md lives in the system field so it sits on
    // the system-prefix cache breakpoint (Phase 4). Read-only sub-agents
    // whose definition sets omitClaudeMd: true skip it (Phase 2).
    if (!this.omitAgentsMd && !options?.disableSystemPrompt) {
      const agentsMdSection = getAgentsMdManager().buildAgentsMdSection();
      if (agentsMdSection) {
        systemPromptContent = systemPromptContent
          ? `${systemPromptContent}\n\n${agentsMdSection}`
          : agentsMdSection;
      }
    }

    // Plan 474 搂7: append bot prompt-layer sections (identity / roster / 鈥?
    // when the applied profile is a config-driven bot ([agents.<id>], Plan
    // 424). Only the registered *sections* are appended 鈥?the stable base
    // already came from the PromptSystem above, so appending the full bot
    // basic prompt would duplicate platform guidance. Rendered sections
    // return null when their context fields are absent, keeping this a
    // no-op for non-bot sessions and for bots with no data yet.
    if (!options?.disableSystemPrompt && isBotAgentProfile(appliedProfile) && appliedProfile) {
      try {
        const botContext = await loadBotPromptContext(appliedProfile.id);
        // Plan 474 搂2.3/P1.2: dual-key frozen snapshot 鈥?a content hash over
        // the bot context (profile/roster/reserved slots) plus the compaction
        // epoch (compaction-entry count). Same keys reuse the cached
        // per-section render verbatim; either key changing re-renders.
        const summaryEpoch = countTimelineCompactions(this.timeline.snapshot());
        const botSections = await this.getBotAssembly().renderSections(botContext, {
          snapshot: {
            botId: appliedProfile.id,
            contentHash: computeBotContentHash(botContext),
            summaryEpoch,
          },
        });
        // Plan 474 搂2.2/P3.1: identity change announcement + compaction
        // folding. (1) When the current identity differs from what the
        // model was last told, append a hidden profile-update envelope.
        // (2) When a compaction persisted since the last turn, fold the
        // announced baseline: the identity section now renders the merged
        // view (profile.json is re-read every turn), so the history
        // envelope no longer needs to survive compaction.
        this._syncBotProfileBaseline(appliedProfile.id, botContext, summaryEpoch);
        if (botSections) {
          systemPromptContent = systemPromptContent
            ? `${systemPromptContent}\n\n${botSections}`
            : botSections;
        }
      } catch (err) {
        // A bot-section failure must never break the chat system prompt.
        logger.warn(
          `[Agent] bot prompt sections skipped: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Deferred tools must be discovered and have their full schema loaded in
    // a separate provider round before tool_invoke is eligible. ToolInvoke
    // enforces this at runtime; this system-level sequence prevents avoidable
    // failed calls when a connector tool is unfamiliar to the model.
    if (
      !options?.disableSystemPrompt &&
      tools.some((tool) => tool.name === 'tool_catalog') &&
      tools.some((tool) => tool.name === 'tool_invoke')
    ) {
      const deferredToolProtocol = [
        '## Deferred tool schema protocol',
        '- Search for a needed tool with `tool_catalog({ query })`. If there are no matches, retry with a shorter, broader query or a suggested namespace.',
        '- When a search result says `invocation` uses `tool_invoke`, call `tool_catalog({ tool_id })` for that exact stable ID and wait for its complete schema result.',
        '- Do not call `tool_invoke` in the same assistant response or parallel batch as the schema lookup. Invoke it only in a later provider round, using arguments that match the returned `input_schema`.',
        '- Never guess a deferred tool\'s arguments from its name, description, or search summary. If the schema is missing or stale, read it again before invoking.',
        '- A catalog or invocation configuration error describes current-session tool availability; it does not prove that the user\'s connector is unauthorized.',
      ].join('\n');
      systemPromptContent = systemPromptContent
        ? `${systemPromptContent}\n\n${deferredToolProtocol}`
        : deferredToolProtocol;
    }

    return systemPromptContent;
  }

  /**
   * Bot profile baseline (Plan 474 搂2.2/P3.1): the identity the model has
   * last been told about, per bot id. Seeded lazily from the first context
   * load so an already-running session does not announce a "change" from a
   * cold undefined baseline.
   */
  private botProfileBaselines = new Map<
    string,
    { baseline: ProfileBaseline; summaryEpoch: number }
  >();

  private _syncBotProfileBaseline(
    botId: string,
    ctx: { botName?: string; botDescription?: string },
    summaryEpoch: number,
  ): void {
    try {
      const state = this.botProfileBaselines.get(botId);
      if (!state) {
        // First sight this session: adopt the current identity silently.
        this.botProfileBaselines.set(botId, {
          baseline: { name: ctx.botName, description: ctx.botDescription },
          summaryEpoch,
        });
        return;
      }

      // Compaction folding (搂2.2): summaryEpoch advanced 鈫?the newest
      // announced update is folded into the baseline; no re-announcement 鈥?      // the identity section re-rendered this turn already carries the
      // merged view (profile.json is re-read every turn).
      const baseline =
        summaryEpoch > state.summaryEpoch
          ? { ...state.baseline, foldedUntil: undefined }
          : state.baseline;

      const update = detectProfileUpdate(
        baseline,
        { name: ctx.botName, description: ctx.botDescription },
      );
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
        const appended = this._appendRuntimeContextToTimeline(
          message as unknown as RuntimeContextAgentMessage,
        );
        if (appended) {
          logger.info(
            `[Agent] bot profile update announced (id=${botId}, changedAt=${update.changedAt})`,
          );
        }
      }

      this.botProfileBaselines.set(botId, {
        baseline: mergeProfileUpdate(baseline, update),
        summaryEpoch,
      });
    } catch (err) {
      // Envelope bookkeeping must never break the system prompt build.
      logger.warn(
        `[Agent] bot profile baseline sync skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Plan 474: lazily-instantiated bot prompt assembly (stable catalog).
   */
  private getBotAssembly(): BotPromptAssembly {
    if (!this.botAssembly) {
      this.botAssembly = createBotPromptAssembly();
    }
    return this.botAssembly;
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
        // `_appendRuntimeContextToTimeline` returns false when the same attachment IDs
        // are already present, so we must also skip the llmMessages push to avoid
        // duplicating the projected context across turns.
        const appended = this._appendRuntimeContextToTimeline(ctx);
        if (appended) {
          const projected = projectRuntimeContextToProviderMessage(ctx);
          if (projected) llmMessages.push(projected);
        }
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
   * building their own LLM calls, tool execution, and persistence 鈥?   * they do NOT run through the agent tool loop.
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

    // Plan 224 Phase 3: if a modifier mode (conductor) is active alongside
    // this orchestrator mode (research), inject the modifier's tools into
    // the orchestrator's registry so the orchestrator can call them. The
    // orchestrator manages its own prompt/loop, so we only apply the tool
    // injection 鈥?not prompt prefixes or hooks.
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

    const catalogExecutor = toolRegistry.getExecutor('tool_catalog');
    if (catalogExecutor instanceof ToolCatalogTool) {
      const snapshot = toolRegistry.snapshot(this.providerNameToInternalKey);
      const constraints: ToolVisibilityConstraints = {
        disabledTools: options?.disabledTools,
        allowedTools: options?.allowedTools,
      };
      const eligibleToolIds = new Set(
        snapshot.catalogEntries
          .filter((entry) => isToolVisible(entry.definition.name, entry.exposure === 'hidden' ? 'hidden' : 'eager', EMPTY_DISCOVERED, constraints))
          .map((entry) => entry.toolId),
      );
      const directToolIds = new Set(
        snapshot.catalogEntries
          .filter((entry) => isToolVisible(entry.definition.name, entry.exposure, EMPTY_DISCOVERED, constraints))
          .map((entry) => entry.toolId),
      );
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
      // Defensive 鈥?caller already checked mod.orchestrator before invoking
      // _dispatchOrchestratorMode, but TypeScript can't narrow across the
      // method boundary.
      yield {
        type: 'error',
        data: `Mode "${mod.id}" has no orchestrator`,
      } as unknown as SSEEvent;
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
      } as unknown as SSEEvent;
    }
  }

  // === end streamChat helpers ===========================================

  /**
   * 涓柇褰撳墠瀵硅瘽
   */
  interrupt(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * 鑾峰彇娑堟伅鍘嗗彶 (legacy interface)
   * Returns the durable, persistence-ready legacy Message[] shape that the
   * desktop renderer expects. Hidden runtime context is excluded.
   */
  getMessages(): readonly Message[] {
    return this.messages;
  }

  /**
   * Ask a side question without interrupting the running agent (grok-style
   * `/btw`). Snapshot the current conversation, append a no-tool one-shot
   * question, and return the final text answer.
   *
   * This deliberately bypasses the main turn loop: it does NOT mutate the
   * timeline / `this.messages`, does NOT register or expose tools, and does
   * NOT enter the prompt queue. It runs one independent one-shot generation
   * over the projected history (`OneShotTextPort`, see
   * `run-engine-model.ts:createOneShotTextPort`), so it can complete while the
   * primary agent turn is still streaming.
   */
  async sideQuestion(question: string): Promise<string> {
    const trimmed = question.trim();
    if (!trimmed) {
      throw new Error('Side question cannot be empty');
    }

    // Build a system prompt with no tools 鈥?side questions never call tools.
    const profile = await this._resolveAgentProfile({});
    const systemPromptBase = await this._buildSystemPrompt([], {}, profile);

    // Project the current timeline to the model boundary (user/assistant/tool
    // roles only) and merge projected system context.
    const { systemPromptContent, messages } = this._projectModelMessages(systemPromptBase);

    // Trim any trailing tool_use that has no matching tool_result so the
    // provider message list ends cleanly for a tool-less one-shot call.
    let llmMessages = messages;
    while (
      llmMessages.length > 0 &&
      llmMessages[llmMessages.length - 1].role === 'assistant' &&
      Array.isArray(llmMessages[llmMessages.length - 1].content) &&
      (llmMessages[llmMessages.length - 1].content as MessageContent[]).some(
        (block) => block.type === 'tool_use',
      )
    ) {
      llmMessages = llmMessages.slice(0, -1);
    }

    // Append the side question as a fresh user message with a strict
    // single-turn, no-tool instruction (mirrors grok's side-question prompt).
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
      const result = await createOneShotTextPort(this.llmClient).complete(
        {
          systemPrompt: systemPromptContent,
          messages: fromProviderMessages(llmMessagesWithQuestion),
          maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          temperature: 0.7,
        },
        abortController.signal,
      );

      if (result.kind === 'completed') {
        // The trim is the caller's, as it was: this value is returned to the
        // renderer, not stored.
        return result.text.trim();
      }
      if (result.kind === 'failed') {
        // Preserved: the legacy loop threw `new Error(event.data)` on an error
        // frame (`:4493-4494`), and `failed.error.message` IS that `data`
        // (`ports.ts:1749-1753`).
        throw new Error(result.error.message);
      }
      // `cancelled`. The old `finally` aborted only AFTER the loop settled, so
      // nothing cancelled this call in flight and an abort could not surface
      // here; the arm is reachable now solely because the port reports it.
      throw abortController.signal.reason instanceof Error
        ? abortController.signal.reason
        : new Error('Side question was cancelled');
    } finally {
      abortController.abort();
    }
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
    // Plan 422 follow-up: `this.timeline = new MessageTimeline()` above
    // replaces the timeline reference. The compaction controller captured the
    // *original* reference at construction, so without this re-pointing it
    // would keep reading from the empty pre-rebuild instance. `compactProactive`
    // would then call `CompactionManager.compact([])` and trip the
    // `conversation is empty` preflight on every load-from-DB path.
    this.compactionController.setTimeline(this.timeline);
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
    // Keep the compaction controller's timeline reference in sync with the
    // new (empty) instance 鈥?see `setMessages` for the rationale.
    this.compactionController.setTimeline(this.timeline);
    this.sessionInfo.updatedAt = Date.now();
  }

  // ==========================================================================
  // Plan 314: long-lived ToolCatalog + per-turn snapshot
  // ==========================================================================

  /**
   * Plan 314: Block first chat:start until MCP tools are registered
   * into the catalog, or until `timeoutMs` elapses (whichever is
   * first). On timeout the chat proceeds without MCP tools 鈥?better
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
   * `applyMCPConfiguration` completes 鈥?success OR failure. Failure
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
   * Profile applied by the most recent `streamChat` call. Set right after
   * `_resolveAgentProfile` resolves (before mode dispatch), so turn-end
   * logic in the process entry can inspect it (e.g. skip title generation
   * for bot-pipeline sessions).
   */
  getLastAppliedAgentProfile(): AgentProfile | undefined {
    return this.lastAppliedAgentProfile;
  }

  /**
   * Plan 314: Initialize the long-lived ToolCatalog by registering
   * all builtin tools once at agent init, before the first
   * `streamChat`. MCP tools are added later via
   * `applyMCPConfiguration` 鈫?`setActiveMCPRuntime` 鈫?   * `replaceByOwner('mcp', ...)`.
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
   * does NOT include currently active MCP provider names 鈥?   * full-replace removes them before computing the next state, and
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
   * Current permission mode (default / auto / plan / bypassPermissions /
   * dontAsk / ...). The MCP runtime gate consults this so sessions that
   * opted into bypass modes are not blocked by the third-party tool gate.
   */
  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  /**
   * The currently active MCPManager, or `null` when no MCP runtime
   * has been installed yet. Consumed by `applyMCPConfiguration` to
   * reuse still-valid clients across incremental reloads.
   */
  getActiveMCPManager(): MCPManager | null {
    return this.mcpManager;
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
      // atomic 鈥?it never leaves the registry in a partial
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
   * Build a name 鈫?executor map for the current MCP tools, so sub-agents that
   * opt in via `mcpTools` can reuse this agent's live MCP runtime (the client
   * is captured in the executor closure) instead of reconnecting the servers.
   * Only tools carrying `mcpInfo` are included; builtin tools are excluded.
   */
  private buildMCPToolExecutors(tools: Tool[]): Map<string, ToolExecutor> {
    const map = new Map<string, ToolExecutor>();
    for (const tool of tools) {
      if (!tool.mcpInfo) continue;
      const executor = this.activeMCPRegistry.getExecutor(tool.name);
      if (executor) map.set(tool.name, executor);
    }
    return map;
  }

  /**
   * 鑾峰彇褰撳墠宸ヤ綔鐩綍
   */
  getWorkingDirectory(): string | undefined {
    return this.workingDirectory;
  }

  /**
   * 璁剧疆宸ヤ綔鐩綍
   */
  setWorkingDirectory(directory: string): void {
    this.workingDirectory = directory;
    // PromptSystem reads workingDirectory fresh on every streamChat via
    // _buildSystemPrompt 鈫?buildContext, so no separate sync needed.
  }

  /**
   * Plan 536 L1: update the session's resolved project ID at runtime
   * (e.g. when the renderer reloads the project list after a switch).
   * Future ctx.options built from this point on will pick up the new
   * value via `this.currentProjectId`; in-flight tool calls keep the
   * value they captured when they were dispatched.
   */
  setCurrentProjectId(projectId: string | null | undefined): void {
    this.currentProjectId = projectId ?? null;
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
   * Plan 487: set the host-level standing permission switch. Called by
   * the IPC `agent:reinit-provider` handler in phase 2 whenever the user
   * persists a new value via Settings. Throws on invalid input 鈥?callers
   * must validate against `LOCAL_TOOL_PERMISSIONS` from `@duya/agent`.
   */
  setHostToolPermission(value: LocalToolPermission): void {
    this.hostToolPermission = value;
    logger.info(`[Agent] Host tool permission set to: ${value}`);
  }

  /**
   * 鑾峰彇浼氳瘽淇℃伅
   */
  getSessionInfo(): SessionInfo {
    return { ...this.sessionInfo };
  }

  /**
   * 娣诲姞鐢ㄦ埛娑堟伅
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
   * 妫€鏌ユ槸鍚﹀簲璇ヨ繘琛屽帇缂?   */
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
   * only user/assistant/tool roles 鈥?no system messages.
   *
   * Returns the projected model messages; it does not mutate `this.messages`,
   * which remains the durable persistence projection derived from the
   * timeline.
   */
  private _projectModelMessages(
    systemPromptContent: string,
    opts: { injectHookContexts?: boolean } = {},
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
    const messages: Message[] = [...projection.messages];

    // Plan 486: reply quote injection happens at the per-request provider
    // boundary (see `_renderReplyQuoteForProviderRequest` next to the LLM
    // call), where the current turn's user message is already on the array.
    // projectModelMessages above already filtered branched messages and
    // stripped thread metadata, so historical reply markers never leak.

    // Context-injection hardening (UserPromptSubmit / SessionStart hook
    // additionalContext): each block is wrapped in `<system-reminder>` and
    // tagged source='custom', exactly matching the loop-hook injection
    // shape so the model sees one uniform "steering message" rail.
    //
    // Ensure-present semantics: pending blocks move into
    // `promptContextBlocks` on first injection; every streaming projection
    // afterwards re-injects any block the working array lost 鈥?which is
    // exactly what a mid-run compaction re-projection does to transient
    // runtime context. Dedup by content hash makes this idempotent.
    // Non-streaming callers (side questions) pass no flag and skip this.
    if (opts.injectHookContexts === true) {
      // Move pending blocks into the delivered set; indices >= freshFrom
      // belong to THIS call's drain (initial injection, not restoration).
      const freshFrom = this.promptContextBlocks.length;
      if (this.promptContexts.length > 0) {
        logger.info(
          `[Agent] injecting ${this.promptContexts.length} hook context block(s) into first turn (source='custom')`,
        );
        this.promptContextBlocks.push(...this.promptContexts);
        this.promptContexts = [];
      }
      let restored = 0;
      for (let i = 0; i < this.promptContextBlocks.length; i += 1) {
        const action = applyHookInjection(
          messages as unknown as InjectableMessage[],
          undefined,
          renderSystemReminder(this.promptContextBlocks[i], 'hook_context_rail'),
          'custom',
          { now: Date.now() },
        );
        if (action === 'injected' && i < freshFrom) {
          restored += 1;
        }
      }
      if (restored > 0) {
        logger.info(`[Agent] restored ${restored} hook context block(s) after re-projection`);
      }
    }

    // Merge projected system with existing system prompt
    const systemFromProjection = typeof projection.system === 'string'
      ? projection.system
      : '';
    const merged = systemPromptContent && systemFromProjection
      ? `${systemPromptContent}\n\n---\n\n## Conversation Context\n\n${systemFromProjection}`
      : (systemPromptContent || systemFromProjection);

    logger.info(
      `[Agent] projectModelMessages: ${context.messages.length} agent messages 鈫?${messages.length} model messages, ${systemSegments.length} system segments`,
    );

    return { systemPromptContent: merged, messages };
  }

  /**
   * Plan 486 搂2.3: apply the provider thread boundary to a request message
   * array in place, at the per-request LLM call site:
   *  1. Prefix user messages that carry a live `replyToId` (this turn's quote
   *     reply or fork) with `[In reply to <id>: "<quote>"]`, rendered from the
   *     referenced timeline message (grok system-prompt.ts:48 parity).
   *     Historical messages arrive here already stripped by projectModelMessages,
   *     so only the current turn's message can match; the prefix render is
   *     idempotent per target so re-projections never double-inject.
   *  2. Strip thread metadata from every message so `replyToId` / `branched`
   *     never leak into the provider request body.
   */
  private _applyProviderThreadBoundary(messages: Message[]): void {
    if (messages.length === 0) return;
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
      if (!source || typeof source !== 'object') continue;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { threadMeta: _, ...cleaned } = source as unknown as Record<string, unknown>;
      const cleanedMsg = cleaned as unknown as Message;
      if (cleanedMsg !== messages[i]) {
        messages[i] = cleanedMsg;
      }
    }
  }

  /**
   * 鑾峰彇褰撳墠涓婁笅鏂囩粺璁′俊鎭?   */
  getContextStats() {
    return this.compactionManager.getStats(this.messages);
  }

  /**
   * Estimated tokens of the system prompt + tool definitions of the last
   * LLM request (excluding message history). 0 until the first streamChat
   * call builds a prompt 鈥?callers should fall back to their own system
   * prompt estimate when 0.
   */
  getSystemContextTokensEstimate(): number {
    return this.lastSystemContextTokensEstimate;
  }

  /**
   * Plan 577 §3: true when the latest provider observation is the FIRST one
   * after a projection shrink (prune / offload). The worker process reads
   * this in emitLiveUsage to allow the ring's anchor correction to replace
   * the timeline anchor downward — otherwise gateway under-reports would
   * collapse it. Non-consuming; provenance lives in the ContextLedger.
   */
  isLastContextObservationPostShrink(): boolean {
    return this.compactionManager.wasLastObservationPostShrink();
  }

  /**
   * Plan 577 §3: raw ledger facts and lineage. The worker's usage path uses
   * getContextSnapshot() below to add the shared timeline projection.
   */
  getContextLedgerSnapshot(): ReturnType<import('../context/ContextLedger.js').ContextLedger['getSnapshot']> {
    return this.compactionManager.getContextLedger().getSnapshot();
  }

  /**
   * Plan 577 §3: return the enriched projection snapshot used by both
   * compaction decisions and the worker's live usage frame.
   */
  getContextSnapshot(messages: readonly Message[] = this.messages) {
    return this.compactionManager.getContextSnapshot(messages);
  }

  /**
   * Plan 577 §3/§4: the resolved compaction window + its source
   * (capability → catalog → 200K default). The ring surfaces the source so
   * a silent 200K fallback becomes visible in the UI.
   */
  getContextWindowResolved(): { contextWindow: number; windowSource: 'capability' | 'catalog' | 'default' } {
    return { ...this.resolvedWindow };
  }

  /**
   * Plan 577 §4: the system-prompt half of the last request's fixed
   * surface (excluding tool definitions). 0 until the first streamChat.
   */
  getSystemTokensEstimate(): number {
    return this.lastSystemTokensEstimate;
  }

  /**
   * Plan 577 §4: the tool-definition half (name/description/input_schema
   * JSON of the full tool list). 0 until the first streamChat.
   */
  getToolsTokensEstimate(): number {
    return this.lastToolsTokensEstimate;
  }

  /**
   * Character→token estimates for the system prompt and the tool-definition
   * surface separately (plan 552 delegation + plan 577 §4 split). Only the
   * provider contract fields (name/description/input_schema) are counted.
   */
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

  /**
   * 浣跨敤鏂扮殑 CompactionManager 鍘嬬缉娑堟伅鍘嗗彶
   * 鍗曚竴 grok 寮忕瓥鐣? session_memory
   */
  async compact(options?: CompactOptions): Promise<{
    strategy: string;
    tokensRemoved: number;
    tokensRetained: number;
    removedCount: number;
  }> {
    if (this.messages.length === 0) {
      // Plan 422: align with grok-build 鈥?an empty timeline is a hard error,
      // not a silent no-op. The pre-flight check inside CompactionManager.compact
      // enforces the same invariant; we let it throw here so the worker emits a
      // `compact:error` SSE event instead of `compact:done { strategy: 'none' }`,
      // which the UI previously misreported as "0 messages compacted".
      throw new Error('Compaction failed: conversation is empty (timeline not hydrated?)')
    }

    const compactEntry = await this.compactionController.compactProactive({
      ...(options ?? {}),
      // Public entry point serves /compact and worker commands 鈥?always manual
      // unless the caller says otherwise, so loop guards never block a user.
      trigger: options?.trigger ?? 'manual',
    });
    if (!compactEntry) {
      return { strategy: 'none', tokensRemoved: 0, tokensRetained: 0, removedCount: 0 };
    }

    // `this.messages` is a timeline-derived getter; the checkpoint entry
    // appended by the controller is reflected automatically.
    this.sessionInfo.messageCount = this.messages.length;
    this.sessionInfo.updatedAt = Date.now();

    // Plan 475 P4.6 follow-up: emit the same compaction notification the
    // proactive path uses (streamChat) so the worker's `onMessagesCompacted`
    // wiring appends a `rebase` journal event for manual /compact too.
    // Without this, compacted-away messages were never superseded in the
    // rollout and a reload resurrected the full pre-compaction history
    // alongside the summary (ghost history).
    this.onMessagesCompacted?.(this.messages.length);

    return {
      strategy: compactEntry.strategy,
      tokensRemoved: compactEntry.tokensBefore - (compactEntry.tokensAfter ?? 0),
      tokensRetained: compactEntry.tokensAfter ?? 0,
      removedCount: compactEntry.compactedMessageIds.length,
    };
  }
}

/**
 * Plan 437: build a legacy `Message` row for a single hook invocation.
 * Persisted at the turn-end boundary so reload / cross-device sync keep
 * the hook history visible alongside tool_use / tool_result.
 *
 * Shape mirrors the other Message rows the renderer knows how to read
 * back (`MessageItem.messageToActionItems`):
 *   - `role: 'system'` 鈥?hooks aren't user/assistant/tool; `system` is
 *     the closest neutral slot that already renders.
 *   - `msg_type: 'hook_invocation'` 鈥?discriminator the renderer uses.
 *   - `tool_name` carries the hook event name (PreToolUse, PostToolUse,
 *     UserPromptSubmit, ...) so existing tool-name consumers stay
 *     unaware and the hook-specific fields live in `tool_input`.
 *   - `tool_input` is a JSON blob of the structured HookInvokedEvent.
 *   - `content` carries `additionalContext` (or empty for verifier-only).
 *   - `status: 'failed'` on non-ok status so the row is greppable.
 */
function buildHookMessage(
  event: import('../hooks/types.js').HookInvokedEvent,
  sessionId: string,
): Message {
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
    seq_index: undefined,
    parent_tool_call_id: event.toolUseId,
    metadata: {
      sessionId,
      hookEventName: event.hookEventName,
    },
  };
}

/**
 * Build a dedicated compaction client from `compact_model` config. Returns
 * undefined when disabled or unconfigured so callers fall back to the main
 * client. Failures degrade to undefined (best-effort).
 */
function buildCompactClient(
  config: import('../types.js').CompactModelConfig | undefined,
): AIClient | undefined {
  if (!config?.enabled) return undefined;
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
      modelCapabilities,
    });
  } catch {
    return undefined;
  }
}
