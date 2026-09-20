/**
 * run-lifecycle-tracker.ts — small shared kernel for "session-level
 * autonomous run" lifecycles (plan 552 ruling #4, amending 415 §6.2).
 *
 * grok-build 源码裁决:goal_tracker 与 workflow_tracker 是复制式平行实现 —
 * 无共享 trait/基类,仅共享 `PauseKind` 词汇枚举(xai-workflow/lib.rs:43),
 * 状态结构体互不引用。因此 duya 抽的是**小内核**(词汇 + 纯函数),不是
 * 强类型抽象基类:状态枚举 + paused 族判定 + revision + history cap(64)
 * + elapsed 折叠 + 快照消毒 + 纯函数转移矩阵。goal(plan 411 GoalTracker)
 * 与 workflow(WorkflowRunTracker)各自持有专属字段、各自实现 ModeTracker。
 *
 * States / events follow 415 §6.2.1-6.2.5 (which itself follows grok's
 * from_snapshot fold semantics):
 *
 *   inactive → planning → [high_risk] awaiting_confirm → active ⇄ verifying
 *     → complete | budget_limited | cancelled | interrupted | failed
 *     → user/backoff/no_progress/infra paused | blocked
 *
 * The kernel is pure: no I/O, no clocks beyond what callers pass in.
 */

// ─── states ───

export type RunLifecycleState =
  | 'inactive'
  | 'planning'
  | 'awaiting_confirm'
  | 'active'
  | 'verifying'
  | 'user_paused'
  | 'backoff_paused'
  | 'no_progress_paused'
  | 'infra_paused'
  | 'blocked'
  | 'budget_limited'
  | 'complete'
  | 'interrupted'
  | 'cancelled'
  | 'failed';

export const RUN_LIFECYCLE_STATES: readonly RunLifecycleState[] = [
  'inactive',
  'planning',
  'awaiting_confirm',
  'active',
  'verifying',
  'user_paused',
  'backoff_paused',
  'no_progress_paused',
  'infra_paused',
  'blocked',
  'budget_limited',
  'complete',
  'interrupted',
  'cancelled',
  'failed',
];

/** Pause subtypes (grok `PauseKind`). `'verification'` lands on `blocked`. */
export type PauseKind = 'user' | 'back_off' | 'no_progress' | 'infra' | 'verification';

export const RUN_PAUSED_STATES: ReadonlySet<RunLifecycleState> = new Set([
  'user_paused',
  'backoff_paused',
  'no_progress_paused',
  'infra_paused',
  'blocked',
]);

export const RUN_TERMINAL_STATES: ReadonlySet<RunLifecycleState> = new Set([
  'budget_limited',
  'complete',
  'cancelled',
  'interrupted',
  'failed',
]);

export function isPausedRunState(s: RunLifecycleState): boolean {
  return RUN_PAUSED_STATES.has(s);
}

export function isTerminalRunState(s: RunLifecycleState): boolean {
  return RUN_TERMINAL_STATES.has(s);
}

/** Free resume (no budget top-up needed): paused family, failed, interrupted. */
export function isResumableRunState(s: RunLifecycleState): boolean {
  return RUN_PAUSED_STATES.has(s) || s === 'failed' || s === 'interrupted';
}

/** budget_limited must be resumed with a new budget (resume{budget}). */
export function runNeedsTopUp(s: RunLifecycleState): boolean {
  return s === 'budget_limited';
}

/** Runtime tool gating is live while the run executes. */
export function runStateCanGateTools(s: RunLifecycleState): boolean {
  return s === 'active' || s === 'verifying';
}

export function runStateShouldInjectReminder(s: RunLifecycleState): boolean {
  return s === 'active' || s === 'verifying';
}

/** Map a PauseKind to the state it lands on ('verification' → blocked). */
export function pauseKindToState(kind: PauseKind): RunLifecycleState {
  switch (kind) {
    case 'user': return 'user_paused';
    case 'back_off': return 'backoff_paused';
    case 'no_progress': return 'no_progress_paused';
    case 'infra': return 'infra_paused';
    case 'verification': return 'blocked';
  }
}

// ─── events ───

export type RunLifecycleEvent =
  | { type: 'start'; objective?: string; budget?: number }
  | { type: 'plan_ready'; highRisk?: boolean }
  | { type: 'confirm' }
  | { type: 'report_verifiable' }
  | { type: 'verdict'; verdict: 'achieved' | 'not_achieved' | 'blocked' }
  | { type: 'budget_limit' }
  | { type: 'stall' }
  | { type: 'infra_error' }
  | { type: 'pause'; kind: PauseKind; message?: string }
  | { type: 'resume'; budget?: number }
  | { type: 'interrupt' }
  | { type: 'complete' }
  | { type: 'cancel' }
  | { type: 'fail'; message?: string }
  | { type: 'clear' };

// ─── history ───

export interface RunLifecycleHistoryEntry {
  at: number;
  event: string;
  detail?: string;
}

/** grok `MAX_HISTORY_ENTRIES` — both trackers cap their history at 64. */
export const RUN_HISTORY_CAP = 64;

/** Append + cap (mutates the passed array; callers own their log). */
export function pushRunHistory(
  log: RunLifecycleHistoryEntry[],
  event: string,
  detail?: string,
  at = Date.now(),
): void {
  log.push(detail === undefined ? { at, event } : { at, event, detail });
  if (log.length > RUN_HISTORY_CAP) {
    log.splice(0, log.length - RUN_HISTORY_CAP);
  }
}

// ─── snapshot folding / sanitization (grok from_snapshot semantics) ───

/**
 * Fold half-open / half-way states on restore (415 §6.2.5):
 *   verifying → active       (a restart cannot resurrect a half-open verify)
 *   planning → inactive      (half-way planning is not preserved)
 *   awaiting_confirm → inactive
 * Everything else restores verbatim (durable user/terminal decisions).
 */
export function foldRestoredRunState(state: RunLifecycleState): RunLifecycleState {
  if (state === 'verifying') return 'active';
  if (state === 'planning' || state === 'awaiting_confirm') return 'inactive';
  return state;
}

/**
 * Validate a raw snapshot `state` field. Throws on anything that is not a
 * known state — persistence layers surface the error rather than leaving
 * a tracker inconsistent.
 */
export function parseRunLifecycleState(raw: unknown): RunLifecycleState {
  if (typeof raw !== 'string' || !RUN_LIFECYCLE_STATES.includes(raw as RunLifecycleState)) {
    throw new Error(`invalid RunLifecycleState: ${JSON.stringify(raw)}`);
  }
  return raw as RunLifecycleState;
}

/** Validate + cap a raw history array. Throws on malformed entries. */
export function parseRunHistory(raw: unknown): RunLifecycleHistoryEntry[] {
  if (!Array.isArray(raw)) throw new Error(`invalid run history: ${JSON.stringify(raw)}`);
  const out: RunLifecycleHistoryEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || typeof (entry as { event?: unknown }).event !== 'string') {
      throw new Error(`invalid run history entry: ${JSON.stringify(entry)}`);
    }
    const e = entry as RunLifecycleHistoryEntry;
    out.push({
      at: typeof e.at === 'number' ? e.at : 0,
      event: e.event,
      ...(e.detail !== undefined ? { detail: e.detail } : {}),
    });
  }
  return out.slice(-RUN_HISTORY_CAP);
}

// ─── transition matrix (pure, 415 §6.2.3) ───

export interface RunTransitionResult {
  /** Next state when the transition is legal; absent → not handled. */
  next?: RunLifecycleState;
  /** History label for the transition (set when handled). */
  label?: string;
  /** True when the event was consumed. Illegal / no-op events → false. */
  handled: boolean;
}

const HANDLED = (next: RunLifecycleState, label: string): RunTransitionResult => ({ next, label, handled: true });
const NOT_HANDLED: RunTransitionResult = { handled: false };

function pauseTransition(kind: PauseKind): RunTransitionResult {
  return HANDLED(pauseKindToState(kind), 'pause');
}

/**
 * Pure transition matrix. The caller (tracker) applies side effects —
 * history, budget updates, pause messages, hooks — only when
 * `handled` is true. Idempotent: illegal / no-op events return
 * `handled: false` and never throw.
 */
export function transitionRunLifecycle(
  state: RunLifecycleState,
  event: RunLifecycleEvent,
): RunTransitionResult {
  switch (state) {
    case 'inactive':
      if (event.type === 'start') return HANDLED('planning', 'start');
      return NOT_HANDLED;

    case 'planning':
      switch (event.type) {
        case 'plan_ready':
          return event.highRisk
            ? HANDLED('awaiting_confirm', 'plan_ready:high_risk')
            : HANDLED('active', 'plan_ready');
        case 'cancel':
          return HANDLED('cancelled', 'cancel');
        case 'fail':
          return HANDLED('failed', 'fail');
        case 'clear':
          return HANDLED('inactive', 'clear');
        default:
          return NOT_HANDLED;
      }

    case 'awaiting_confirm':
      switch (event.type) {
        case 'confirm':
          return HANDLED('active', 'confirm');
        case 'cancel':
          return HANDLED('cancelled', 'cancel');
        case 'fail':
          return HANDLED('failed', 'fail');
        case 'clear':
          return HANDLED('inactive', 'clear');
        default:
          return NOT_HANDLED;
      }

    case 'active':
      switch (event.type) {
        case 'report_verifiable':
          return HANDLED('verifying', 'report_verifiable');
        case 'budget_limit':
          return HANDLED('budget_limited', 'budget_limit');
        case 'stall':
          return HANDLED('no_progress_paused', 'stall');
        case 'infra_error':
          return HANDLED('infra_paused', 'infra_error');
        case 'pause':
          return pauseTransition(event.kind);
        case 'interrupt':
          return HANDLED('interrupted', 'interrupt');
        case 'complete':
          return HANDLED('complete', 'complete');
        case 'cancel':
          return HANDLED('cancelled', 'cancel');
        case 'fail':
          return HANDLED('failed', 'fail');
        case 'clear':
          return HANDLED('inactive', 'clear');
        default:
          return NOT_HANDLED;
      }

    case 'verifying':
      switch (event.type) {
        case 'verdict':
          if (event.verdict === 'achieved') return HANDLED('complete', 'verdict:achieved');
          if (event.verdict === 'not_achieved') return HANDLED('active', 'verdict:not_achieved');
          return HANDLED('blocked', 'verdict:blocked');
        case 'pause':
          return pauseTransition(event.kind);
        case 'complete':
          return HANDLED('complete', 'complete');
        case 'cancel':
          return HANDLED('cancelled', 'cancel');
        case 'fail':
          return HANDLED('failed', 'fail');
        case 'clear':
          return HANDLED('inactive', 'clear');
        default:
          return NOT_HANDLED;
      }

    default:
      // Paused family + terminal family.
      break;
  }

  if (RUN_PAUSED_STATES.has(state)) {
    switch (event.type) {
      case 'resume':
        return HANDLED('active', 'resume');
      case 'pause':
        // Same-kind pause is an idempotent no-op (message refresh is the
        // caller's concern); a different kind switches.
        return pauseKindToState(event.kind) === state ? NOT_HANDLED : pauseTransition(event.kind);
      case 'complete':
        return HANDLED('complete', 'complete');
      case 'cancel':
        return HANDLED('cancelled', 'cancel');
      case 'fail':
        return HANDLED('failed', 'fail');
      case 'clear':
        return HANDLED('inactive', 'clear');
      default:
        return NOT_HANDLED;
    }
  }

  switch (state) {
    case 'budget_limited':
      // Free resume is refused — the caller MUST supply resume{budget}.
      if (event.type === 'resume') {
        return typeof event.budget === 'number' && event.budget > 0
          ? HANDLED('active', 'resume')
          : NOT_HANDLED;
      }
      if (event.type === 'clear') return HANDLED('inactive', 'clear');
      if (event.type === 'start') return HANDLED('planning', 'start');
      return NOT_HANDLED;

    case 'complete':
      if (event.type === 'clear') return HANDLED('inactive', 'clear');
      if (event.type === 'start') return HANDLED('planning', 'start');
      return NOT_HANDLED;

    case 'interrupted':
      if (event.type === 'resume') return HANDLED('active', 'resume');
      if (event.type === 'cancel') return HANDLED('cancelled', 'cancel');
      if (event.type === 'fail') return HANDLED('failed', 'fail');
      if (event.type === 'clear') return HANDLED('inactive', 'clear');
      return NOT_HANDLED;

    case 'cancelled':
      if (event.type === 'clear') return HANDLED('inactive', 'clear');
      if (event.type === 'start') return HANDLED('planning', 'start');
      return NOT_HANDLED;

    case 'failed':
      if (event.type === 'resume') return HANDLED('active', 'resume');
      if (event.type === 'cancel') return HANDLED('cancelled', 'cancel');
      if (event.type === 'clear') return HANDLED('inactive', 'clear');
      return NOT_HANDLED;

    default:
      return NOT_HANDLED;
  }
}
