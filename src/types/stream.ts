// stream.ts - Stream event types

import type { ToolUseInfo, ToolResultInfo, TokenUsage } from './message';

export type StreamEventType =
  | 'snapshot-updated'
  | 'phase-changed'
  | 'error'
  | 'done';

export interface StreamEvent {
  type: StreamEventType;
  sessionId: string;
  snapshot: import('./message.js').SessionStreamSnapshot;
}

export type SSEEventType =
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'tool_output'
  | 'tool_progress'
  | 'status'
  | 'result'
  | 'permission_request'
  | 'permission_requested'
  | 'permission_resolved'
  | 'permission_timed_out'
  | 'tool_timeout'
  | 'mode_changed'
  | 'rewind_point'
  | 'error'
  | 'initMeta'
  | 'keep_alive'
  | 'terminal'
  | 'done'
  | 'db_persisted';

export interface SSEEvent {
  type: SSEEventType;
  data?: string;
}

/**
 * Plan 224 follow-up: emitted by the agent after a mode-switch tool call
 * (EnterPlanMode / ExitPlanMode / SwitchMode) completes. The renderer
 * listens for this via `subscribeToModeChanged` and syncs the input-box
 * chip + glow accordingly. `mode` mirrors `AgentRuntimeMode` from the
 * agent package; `source` distinguishes agent-initiated switches from
 * user-driven ones (forward-compat — currently always 'agent').
 */
export interface ModeChangedEvent {
  mode: 'general' | 'plan' | 'explore' | 'verify' | 'code-review';
  source: 'agent' | 'user';
  reason?: string;
}

/**
 * Goal tracker state broadcast (plan 411 Phase 3). Emitted by the agent
 * worker after goal transitions / verification rounds; the frontend renders
 * a goal status card from it.
 */
export interface GoalUpdatedEvent {
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

/**
 * Research tracker state broadcast (plan 423 Phase 3), delivered via SSE
 * as `research_updated`. Surfaces query / state / sub-questions / sources /
 * gaps so the UI can render a research status card.
 */
export interface ResearchUpdatedEvent {
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

/** Lifecycle kind of a workflow-run SSE frame (plan 552 ZCode parity). */
export type WorkflowRunEventKind = 'start' | 'progress' | 'done' | 'error';

/**
 * Renderer-facing snapshot of a workflow run. Deliberately shallow and
 * honest-to-source: every numeric field is only present when the runner has a
 * real value (see "数字诚实" — renderers draw "—" for absent numbers, never a
 * fabricated 0).
 */
/** Per-step status in a workflow run (plan 552 step progression). */
export type RunStepStatus = 'running' | 'success' | 'failed';

/**
 * One executed step of a workflow run. Carried (accumulated) on progress/done/
 * error frames so the renderer can draw a growing vertical timeline.
 *
 * `nodeKind` mirrors the journal annotation (worker-protocol's
 * `RunStepNodeKind`). A step with nodeKind `'phase'` is a stage divider
 * (`wf.phase(name)`), not work — the run card cuts stage columns at these
 * markers and never renders them as a row of their own.
 */
export type RunStepNodeKind = 'tool' | 'agent' | 'gui' | 'browser' | 'decision' | 'human' | 'noop' | 'phase';

export interface RunStepView {
  /** Node id (matches journal.nodeId). */
  id: string;
  /** Display label (phase / action name). */
  label?: string;
  status: RunStepStatus;
  /** Journal node-kind annotation (display only — drives icons + stage cuts). */
  nodeKind?: RunStepNodeKind;
  startedAt?: number;
  finishedAt?: number;
}

/** Name-only artifact reference carried on digest frames (display only). */
export interface RunArtifactNameView {
  name: string;
}

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
  /** Accumulated per-step view, growing as the run executes. */
  steps?: RunStepView[];
  /** Published artifacts (name only), accumulated as `wf.publish` lands. */
  artifacts?: RunArtifactNameView[];
  /** Declared total steps, when the runner knows it; unknown → renderer draws "—". */
  total?: number;
  /** Present on a terminal non-success status. */
  stoppedReason?: string;
  /** True when the run can be resumed (waiting/paused). */
  resumable?: boolean;
  error?: string;
}

/**
 * Payload delivered to the renderer's `workflow_run` SSE dispatch (router.ts
 * strips the worker `chat:workflow_run` transport type and forwards the flat
 * `{ event, run }` snapshot as `{ type:'workflow_run', data: { event, run } }`).
 */
export interface WorkflowRunSseEvent {
  event: WorkflowRunEventKind;
  run: WorkflowRunSse;
}

/**
 * Permission request event sent via SSE
 */
export interface PermissionRequestEvent {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  mode: 'generic' | 'ask_user_question' | 'exit_plan_mode';
  expiresAt: number;
  decisionReason?: string;
  /** Present only for app-connection tools (Plan 449): enables "Always allow". */
  connector?: { provider: string; riskTier: string; preApproved: boolean };
  /** Plan 450 Phase D: structured parameter display for the approval card. */
  metadata?: { toolParamsDisplay?: Array<{ name: string; label: string; value: string }> };
  suggestions?: Array<{
    type: string;
    destination: string;
    rules?: Array<{ toolName: string; ruleContent?: string }>;
    mode?: string;
  }>;
}

/**
 * Pending permission state tracked in the frontend
 */
export interface PendingPermissionState {
  request: PermissionRequestEvent;
  resolved: 'allow' | 'deny' | null;
}
