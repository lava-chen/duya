import * as readline from 'readline';

export interface InitCommand {
  type: 'init';
  sessionId: string;
  providerConfig: {
    apiKey: string;
    baseURL?: string;
    model: string;
    provider: 'anthropic' | 'openai' | 'ollama';
    authStyle?: 'api_key' | 'auth_token';
    visionConfig?: {
      provider: string;
      model: string;
      baseURL: string;
      apiKey: string;
      enabled: boolean;
    };
    compactModelConfig?: {
      provider: string;
      model: string;
      baseURL: string;
      apiKey: string;
      enabled: boolean;
    };
  };
  workingDirectory?: string;
  systemPrompt?: string;
  skillPaths?: string[];
  communicationPlatform?: string;
  blockedDomains?: string[];
  browserBackendMode?: 'auto' | 'extension' | 'built-in' | 'human-like';
  language?: string;
  sandboxEnabled?: boolean;
}

export interface ChatStartCommand {
  type: 'chat:start';
  sessionId: string;
  id: string;
  prompt: string;
  options?: {
    messages?: Array<{ role: string; content: string }>;
    systemPrompt?: string;
    language?: string;
    /**
     * @deprecated 由 session row.permission_profile 派生. worker 严格忽略此字段, 防止残留发送路径覆盖 DB 决定.
     */
    permissionMode?: string;
    /**
     * 显式单次 override (trusted caller only). 类型: agent internal mode, 不是 DB profile.
     */
    permissionModeOverride?: 'default' | 'auto' | 'bypassPermissions';
    files?: Array<{
      id: string;
      name: string;
      type: string;
      url: string;
      size: number;
      cacheKey?: string;
      base64?: string;
      images?: string[];
      parsedText?: string;
      storedPath?: string;
    }>;
    agentProfileId?: string | null;
    outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean };
    displayContent?: string;
    /** Plan 450 Phase H: `/skill-name` mentioned this run (see ChatOptions). */
    mentionedSkills?: string[];
    /** Plugins @-mentioned this run — structured capability summaries (see ChatOptions). */
    mentionedPlugins?: Array<{
      pluginId: string;
      name: string;
      description?: string;
      appConnections: string[];
      mcpServers: string[];
      skillNames: string[];
    }>;
    parsedDocs?: Array<{
      filename: string;
      charCount: number;
      text: string;
      extractMethod?: string;
      imageChunks?: Array<{ base64: string; mediaType: string }>;
      cacheKey?: string;
    }>;
    /**
     * Anthropic thinking effort level. Mapped to
     * `thinking.budget_tokens` by the LLM client.
     */
    effort?: string;
    /**
     * Maximum agentic turns for this run. Absent → worker falls back to the
     * configured `agent.max_turns`, then its built-in default (100).
     */
    maxTurns?: number;
    /**
     * Allowlist of tool names permitted for this chat turn. When set, only
     * tools whose name is in this list are exposed to the LLM. Used by
     * interagent `minimal` mode to restrict the target agent to Read/Grep/Glob.
     */
    allowedTools?: string[];
    /**
     * Plan 498: permission ask surface for this session. 'bot' (bot/wake
     * sessions) pauses the turn on ask — the request is persisted as a
     * durable approval card and the turn ends with a neutral tool result.
     * 'default' keeps the in-worker interactive wait (5-minute timeout).
     * Derived by the agent server from the session row; absent → 'default'.
     */
    permissionSurface?: 'bot' | 'default';
    /**
     * Mark this session transcript as excluded from Stage 1 memory
     * extraction (design §7.4). Used by the curator agent runner so
     * curator reasoning is not fed back into Stage 1.
     */
    excludeFromStage1?: boolean;
    /**
     * Internal agent mode for this chat turn (e.g. 'automation' for the
     * headless curator). Mirrors ChatOptions.mode.
     */
    mode?: string;
    /**
     * Plan 453 Task G: wakeless chat path. When true:
     *   - the sessionId must start with `wakeless-` (callers generate
     *     a fresh UUID per wake);
     *   - no durable journal entry is created (messages live only in
     *     the in-memory thread);
     *   - the agent output stream is forwarded to the orb IPC sink
     *     (`automation:orb:*`) instead of the main renderer;
     *   - the session is auto-ended when the orb is collapsed.
     *
     * Used by Wake Agent so a "ask from anywhere" session never pollutes
     * the persistent chat history.
     */
    wakeless?: boolean;
  };
}

export interface ChatInterruptCommand {
  type: 'chat:interrupt';
}

export interface CompactCommand {
  type: 'compact';
  sessionId: string;
}

export interface SideQuestionCommand {
  type: 'side:question';
  sessionId: string;
  id: string;
  question: string;
}

/** Response sent by the worker after a `side:question` one-shot completes. */
export interface SideQuestionResponse {
  type: 'side:answer';
  sessionId: string;
  id: string;
  answer: string;
  error?: string;
}

export interface ConfigUpdateCommand {
  type: 'config:update';
  sessionId: string;
  browserBackendMode?: 'auto' | 'extension' | 'built-in' | 'human-like';
  blockedDomains?: string[];
}

export interface PermissionResolveCommand {
  type: 'permission:resolve';
  id: string;
  decision: string;
  updatedInput?: Record<string, unknown>;
}

/** Live mid-run permission-mode switch (Ask/Auto/Bypass → agent mode). */
export interface PermissionSetCommand {
  type: 'permission:set';
  mode: string;
}

export interface DbResponseCommand {
  type: 'db:response';
  requestId: string;
  response: unknown;
  error?: string;
}

export interface InteragentInvokeCommand {
  type: 'interagent:invoke';
  id: string;              // UUID, correlates invoke → events
  callerSessionId: string;
  callerAgentName: string; // for metadata stamping on target's messages
  targetSessionId: string;
  message: string;
  mode: 'minimal' | 'full';
  timeout: number;         // seconds
}

export interface InteragentEventMessage {
  type: 'interagent:event';
  id: string;              // correlates to invoke id
  event: WorkerEvent;      // target worker's stdout event (chat:text, chat:tool_use, chat:done, chat:error, ...)
}

export type WorkerCommand =
  | InitCommand
  | ChatStartCommand
  | ChatInterruptCommand
  | CompactCommand
  | SideQuestionCommand
  | ConfigUpdateCommand
  | PermissionResolveCommand
  | PermissionSetCommand
  | DbResponseCommand
  | InteragentInvokeCommand
  | InteragentEventMessage
  | { type: string; [key: string]: unknown };

export interface CheckpointEvent {
  type: 'checkpoint';
  sessionId: string;
  data: {
    messages: Array<Record<string, unknown>>;
    generation: number;
  };
}

export interface AgentTextEvent {
  type: 'chat:text';
  sessionId: string;
  content: string;
}

export interface AgentThinkingEvent {
  type: 'chat:thinking';
  sessionId: string;
  content: string;
}

export interface SubagentToolUseEvent {
  type: 'chat:tool_use';
  sessionId: string;
  id: string;
  name: string;
  input: unknown;
}

export interface SubagentToolUseStartedEvent {
  type: 'chat:tool_use_started';
  sessionId: string;
  id: string;
  name: string;
  input: unknown;
}

/**
 * Plan 461: incremental tool-call argument fragment. `delta` is a raw JSON
 * slice of the tool's argument object — not a complete document. Consumers
 * accumulate per `id` and parse leniently to render partial arguments while
 * the model is still producing them.
 */
export interface SubagentToolUseDeltaEvent {
  type: 'chat:tool_use_delta';
  sessionId: string;
  id: string;
  name: string;
  delta: string;
}

export interface SubagentToolResultEvent {
  type: 'chat:tool_result';
  sessionId: string;
  id: string;
  result: string;
  error?: boolean;
  duration_ms?: number;
  /** Structured tool-result metadata (e.g. browserResults for browser
   *  search / parallel_fetch) forwarded for rich renderer tool rows. */
  metadata?: Record<string, unknown>;
}

export interface SubagentToolProgressEvent {
  type: 'chat:tool_progress';
  sessionId: string;
  toolUseId: string;
  percent: number;
  stage: string;
}

export interface AgentPermissionEvent {
  type: 'chat:permission';
  sessionId: string;
  request: {
    id: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  };
}

export interface AgentDoneEvent {
  type: 'chat:done';
  sessionId: string;
}

export interface AgentErrorEvent {
  type: 'chat:error';
  sessionId: string;
  message: string;
  code?: string;
}

export interface AgentStatusEvent {
  type: 'chat:status';
  sessionId: string;
  message: string;
}

/**
 * Plan 224 follow-up: emitted by DuyaAgent.streamChat right after a
 * mode-switch tool (EnterPlanMode / ExitPlanMode / SwitchMode) result
 * lands. Carries the new runtime mode + source so the renderer can
 * sync the input-box chip/glow. Forwarded by router.ts as the SSE
 * `mode_changed` event.
 */
export interface AgentModeChangedEvent {
  type: 'chat:mode_changed';
  sessionId: string;
  mode: 'general' | 'plan' | 'explore' | 'verify' | 'code-review';
  source: 'agent' | 'user';
  reason?: string;
}

/**
 * Plan 411: emitted by goal tooling after a goal state transition or
 * verification round. Carries the tracker's public state so the renderer
 * can surface a goal status card (objective / status / tokens).
 * Forwarded by router.ts as the SSE `goal_updated` event.
 */
export interface GoalUpdatedEvent {
  type: 'chat:goal_updated';
  sessionId: string;
  state: string;
  phase: string;
  objective: string;
  tokensUsed: number;
  tokenBudget: number;
  consecutiveNotAchieved: number;
  gapsSummary?: string;
  strategyProposal?: string;
  pauseMessage?: string;
  /** Closed-catalog pause reason (plan 552) — why the goal is not running. */
  pauseReason?: string;
  /** Worker rounds completed toward the objective (the UI "Turn N"). */
  totalWorkerRounds?: number;
  /** Independent verification rounds run so far. */
  totalVerifyRounds?: number;
  /** Wall-clock ms since the goal started. */
  elapsedMs?: number;
  /** Epoch ms the goal was started. */
  createdAt?: number;
  /** Set while the goal is active but parked on a known wait (plan 552). */
  executionWait?: 'verification';
  planFile?: string;
  history?: ReadonlyArray<{ at: number; event: string; detail?: string; reason?: string }>;
}

/** Build the worker goal_updated payload from explicit tracker state. */
export function buildGoalUpdatedEvent(
  sessionId: string,
  state: {
    state: string;
    phase: string;
    objective: string;
    tokensUsed: number;
    tokenBudget: number;
    consecutiveNotAchieved: number;
    gapsSummary?: string;
    pauseMessage?: string;
    pauseReason?: string;
    totalWorkerRounds?: number;
    totalVerifyRounds?: number;
    elapsedMs?: number;
    createdAt?: number;
    planFile?: string;
    history?: ReadonlyArray<{ at: number; event: string; detail?: string; reason?: string }>;
  },
  extra?: { gapsSummary?: string; strategyProposal?: string; executionWait?: 'verification' },
): GoalUpdatedEvent {
  return {
    type: 'chat:goal_updated',
    sessionId,
    state: state.state,
    phase: state.phase,
    objective: state.objective,
    tokensUsed: state.tokensUsed,
    tokenBudget: state.tokenBudget,
    consecutiveNotAchieved: state.consecutiveNotAchieved,
    gapsSummary: state.gapsSummary ?? extra?.gapsSummary,
    strategyProposal: extra?.strategyProposal,
    pauseMessage: state.pauseMessage,
    pauseReason: state.pauseReason,
    totalWorkerRounds: state.totalWorkerRounds,
    totalVerifyRounds: state.totalVerifyRounds,
    elapsedMs: state.elapsedMs,
    createdAt: state.createdAt,
    executionWait: extra?.executionWait,
    planFile: state.planFile,
    history: state.history,
  };
}

/**
 * Plan 554: ask the renderer to write text to the clipboard. Emitted by the
 * deterministic `/copy` intercept — the worker process has no clipboard, so
 * the write happens renderer-side (navigator.clipboard). Forwarded by
 * router.ts as the SSE `clipboard_write` event.
 */
export interface ClipboardWriteEvent {
  type: 'chat:clipboard_write';
  sessionId: string;
  text: string;
}

/** Lifecycle kind of a workflow-run SSE frame (plan 552 ZCode parity). */
export type WorkflowRunEventKind = 'start' | 'progress' | 'done' | 'error';

/**
 * Renderer-facing snapshot of a workflow run. Deliberately shallow and
 * honest-to-source: every numeric field is only present when the runner has
 * a real value (see "数字诚实" — renderers draw "—" for absent numbers, never
 * a fabricated 0).
 */
export interface WorkflowRunSse {
  runId: string;
  workflowName: string;
  /** ManagedRun status: active | complete | failed | cancelled | interrupted. */
  status: string;
  /** Current stage label (e.g. "planning", "executing <node>"). */
  phase?: string;
  startedAt: number;
  finishedAt?: number;
  /** Running token total, if the runner tracks usage. */
  tokens?: number;
  subagents?: number;
  /** Number of phases the definition declared / executed. */
  phases?: number;
  /** Present on a terminal non-success status. */
  stoppedReason?: string;
  /** True when the run can be resumed (waiting/paused). */
  resumable?: boolean;
  error?: string;
}

/**
 * Plan 552 §14: emitted by the worker's workflow runner (SSE bridge) on a
 * run's start / progress / done / error. Carrying the run snapshot + slot
 * on the launching session anchors the ZCode-style card in that session's
 * assistant stream. Forwarded by router.ts as the SSE `workflow_run` event
 * (via the `chat:workflow_run` branch).
 */
export interface WorkflowRunEvent {
  type: 'chat:workflow_run';
  sessionId: string;
  event: WorkflowRunEventKind;
  run: WorkflowRunSse;
}

/** Build the worker `chat:workflow_run` payload. */
export function buildWorkflowRunEvent(
  sessionId: string,
  event: WorkflowRunEventKind,
  run: WorkflowRunSse,
): WorkflowRunEvent {
  return { type: 'chat:workflow_run', sessionId, event, run };
}

export function buildClipboardWriteEvent(sessionId: string, text: string): ClipboardWriteEvent {
  return { type: 'chat:clipboard_write', sessionId, text };
}

export interface AgentRetryEvent {
  type: 'chat:retry';
  sessionId: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  message: string;
}

/**
 * Plan 423 Phase 3: emitted by research tooling after a research state
 * transition or fan-out. Carries the tracker's public state so the renderer
 * can surface a research status card (query / state / sub-questions /
 * sources / gaps). Forwarded by router.ts as the SSE `research_updated`
 * event (via the `chat:research_*` branch).
 */
export interface ResearchUpdatedEvent {
  type: 'chat:research_updated';
  sessionId: string;
  state: string;
  phase: string;
  query: string;
  subQuestions: string[];
  sourcesGathered: string[];
  coverageGaps: string[];
  rounds: number;
  stallRounds: number;
  history?: ReadonlyArray<{ at: number; event: string; detail?: string }>;
}

/** Build the worker research_updated payload from explicit tracker state. */
export function buildResearchUpdatedEvent(
  sessionId: string,
  state: {
    state: string;
    phase: string;
    query: string;
    subQuestions: string[];
    sourcesGathered: string[];
    coverageGaps: string[];
    rounds: number;
    stallRounds: number;
    history?: ReadonlyArray<{ at: number; event: string; detail?: string }>;
  },
): ResearchUpdatedEvent {
  return {
    type: 'chat:research_updated',
    sessionId,
    state: state.state,
    phase: state.phase,
    query: state.query,
    subQuestions: state.subQuestions,
    sourcesGathered: state.sourcesGathered,
    coverageGaps: state.coverageGaps,
    rounds: state.rounds,
    stallRounds: state.stallRounds,
    history: state.history,
  };
}

export interface AgentDbPersistedEvent {
  type: 'chat:db_persisted';
  sessionId: string;
  success: boolean;
  messageCount?: number;
  reason?: string;
}

export interface AgentTitleGeneratedEvent {
  type: 'chat:title_generated';
  sessionId: string;
  title: string;
}

export interface AgentDebugEvent {
  type: 'chat:debug';
  sessionId: string;
  message: string;
}

export interface AgentAgentProgressEvent {
  type: 'chat:agent_progress';
  sessionId: string;
  agentEventType?: string;
  data?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  duration?: number;
  agentId?: string;
  agentType?: string;
  agentName?: string;
  agentDescription?: string;
  agentSessionId?: string;
}

export interface DbRequestEvent {
  type: 'db:request';
  requestId: string;
  action: string;
  params: unknown;
}

export interface MemoryWarningEvent {
  type: 'memory_warning';
  sessionId: string;
  data: {
    heapUsed: number;
    heapTotal: number;
    heapLimit: number;
  };
}

export interface ReadyEvent {
  type: 'ready';
  sessionId: string;
}

export interface PongEvent {
  type: 'pong';
  timestamp: number;
}

export interface SkillsStatusEvent {
  type: 'skills:status';
  synced: boolean;
  added: unknown[];
  updated: unknown[];
  skipped: unknown[];
  removed: unknown[];
  error?: string;
}

export interface CompactDoneEvent {
  type: 'compact:done';
  sessionId: string;
  result: unknown;
}

export interface CompactErrorEvent {
  type: 'compact:error';
  sessionId: string;
  message: string;
}

/**
 * Plan 517 P2.2: surfaced when a successful compaction could not
 * shrink the context below the budget (system prompt + reinject
 * overshoot). The agent has already applied `suppress('size')` so
 * future shouldCompact() calls return false until context drops.
 * The renderer may surface a "auto-compaction paused" hint here.
 */
export interface CompactOverThresholdEvent {
  type: 'compact:over_threshold';
  sessionId: string;
  tokensRetained: number;
  available: number;
}

/**
 * Plan 517 P3: lifecycle step boundary emitted by CompactionManager during
 * compact(). The renderer mirrors these into a per-phase verb + count
 * (e.g. "summarizing 32 messages"). Step + phase together fully describe
 * where in the pipeline the worker currently is; the legacy 'compact:start'
 * / 'compact:done' events still anchor the overall lifecycle.
 */
export interface CompactStepEvent {
  type: 'compact:step';
  sessionId: string;
  step: 'projecting' | 'cutting' | 'summarizing' | 'rebuilding' | 'reinjecting' | 'trimming';
  phase: 'started' | 'finished';
  messageCount?: number;
  tokensBefore?: number;
  tokensEstimated?: number;
  filesCached?: number;
}

/**
 * Plan 523 P6: one event per summarization attempt inside the retry ladder,
 * so the renderer can explain *why* a compaction retried or failed (degenerate
 * output, empty response, output-length error, …) rather than only seeing the
 * coarse 'summarizing' step boundary.
 */
export interface CompactSummaryOutcomeEvent {
  type: 'compact:summary_outcome';
  sessionId: string;
  attempt: number;
  outcome: 'success' | 'degenerate' | 'empty' | 'error';
  errorKind?: string;
  chars: number;
}

/**
 * Memory wakeup (Plan 305 Phase B). Sent by the agent subprocess
 * fire-and-forget after `ready` to nudge the memory worker into an
 * immediate sweep. Gated by `DUYA_MEMORY_ENABLED` on the agent side.
 *
 * The Electron main-process router intercepts this event (it is NOT
 * forwarded to the renderer as SSE) and calls
 * `getMemoryWorkerHandle()?.forceSweep()`.
 */
export interface MemoryWakeupEvent {
  type: 'memory:wakeup';
  sessionId?: string;
}

export type WorkerEvent =
  | CheckpointEvent
  | AgentTextEvent
  | AgentThinkingEvent
  | SubagentToolUseStartedEvent
  | SubagentToolUseDeltaEvent
  | SubagentToolUseEvent
  | SubagentToolResultEvent
  | SubagentToolProgressEvent
  | AgentPermissionEvent
  | AgentDoneEvent
  | AgentErrorEvent
  | AgentStatusEvent
  | AgentModeChangedEvent
  | GoalUpdatedEvent
  | AgentRetryEvent
  | AgentDbPersistedEvent
  | AgentTitleGeneratedEvent
  | AgentDebugEvent
  | AgentAgentProgressEvent
  | DbRequestEvent
  | MemoryWarningEvent
  | ReadyEvent
  | PongEvent
  | SkillsStatusEvent
  | CompactDoneEvent
  | CompactErrorEvent
  | MemoryWakeupEvent;

// Bounded write queue for backpressure handling (M10)
const writeQueue: string[] = [];
let isDraining = false;

function processWriteQueue(): void {
  isDraining = true;
  while (writeQueue.length > 0) {
    const frame = writeQueue[0];
    let canContinue = false;
    try {
      canContinue = process.stdout.write(frame);
    } catch {
      // C3: Silently ignore — worker may be exiting. Drop this frame.
      writeQueue.shift();
      continue;
    }
    writeQueue.shift();
    if (!canContinue && writeQueue.length > 0) {
      // M10: Wait for drain event before writing more frames
      process.stdout.once('drain', processWriteQueue);
      return;
    }
  }
  isDraining = false;
}

export function sendEvent(event: Record<string, unknown>): void {
  let payload = JSON.stringify({ ...event, _logger: 'worker' });
  // M9: Escape embedded newlines to prevent event boundary corruption
  if (payload.includes('\n')) {
    payload = payload.replace(/\n/g, '\\n');
  }
  writeQueue.push(payload + '\n');
  if (!isDraining) {
    processWriteQueue();
  }
}

export async function* parseStdin(): AsyncGenerator<WorkerCommand> {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const cmd = JSON.parse(line) as WorkerCommand;
      yield cmd;
    } catch {
      console.error('[Worker-Protocol] Failed to parse stdin line:', line.substring(0, 200));
    }
  }
}
