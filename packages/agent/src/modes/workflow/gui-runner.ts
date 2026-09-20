/**
 * gui-runner.ts — the gui node: computer-use deterministic steps first,
 * decide-channel agent fallback, human gate for irreversible actions
 * (plan 552 §4.3 — RPA core consuming 551 Phase 3 semantics).
 *
 * Execution semantics, in order:
 *   1. The STEP LOOP lives in code — declared steps drive the backend
 *      directly (zero LLM); `verify: true` runs the 454 verdict ladder
 *      (confirmed / unverifiable / suspected_noop).
 *   2. `suspected_noop` twice in a row (no on-screen change) trips the
 *      escalation ladder — grok ruling 1: the engine NEVER hot-replans;
 *      the ladder is the pre-declared branch.
 *   3. `on_stuck: agent` hands the sub-goal to the 551 decide loop
 *      (LLM plans, Jev decides) whose EIGHT-STATE honest status contract
 *      maps onto node outcomes; `fail` / `skip` end the node locally.
 *   4. `needs_confirmation` / irreversible noul → the 498 approval gate
 *      (await or suspend per run mode) — the ONLY risky-action channel.
 *   5. Every step's capture and result lands a journal record; screenshot
 *      bytes are externalized to the ArtifactStore (ref in the journal).
 *
 * The backend and decide loop are PORTS — production wires the Electron
 * `computer-use` pipeline (Phase 4); fixtures cover the eight statuses.
 */

import type { GuiNodeSpec, GuiStep } from './schema.js';
import type { WorkflowHost, HostCallContext } from './host.js';
import type { Journal } from './journal.js';
import { computeReqHash } from './journal.js';
import type { BudgetLedger } from './host.js';
import { SuspensionSignal, classifyError, type WorkflowErrorClass } from './error-class.js';
import { interpolateString, interpolateDeep, type ExprScope } from './expr.js';

/** One deterministic step's backend result. */
export interface GuiStepResult {
  ok: boolean;
  /** Verdict effect from the backend (454 ladder) when surfaced. */
  effect?: 'confirmed' | 'unverifiable' | 'suspected_noop';
  error?: string;
}

/** Port onto the DesktopBackend (production: Electron computer-use IPC). */
export interface GuiBackendPort {
  step(step: GuiStep, ctx: HostCallContext): Promise<GuiStepResult>;
  /** Capture the screen; bytes go to the store, the ref to the journal. */
  capture(ctx: HostCallContext): Promise<{ base64: string | null }>;
}

/** The 551 decide loop's honest status contract (controller.ts). */
export type GuiDecideStatus =
  | 'done'
  | 'likely_done'
  | 'needs_confirmation'
  | 'error'
  | 'stuck'
  | 'ambiguous'
  | 'blocked'
  | 'max_actions';

export interface GuiDecidePort {
  run(task: string, options: { values?: string[]; maxActions?: number }): Promise<{
    status: GuiDecideStatus;
    reason?: string;
    candidates?: Array<{ option: string; p: number }>;
  }>;
}

export interface GuiRunPorts {
  backend: GuiBackendPort;
  artifacts: import('./gui-artifacts.js').ArtifactStore;
  decide?: GuiDecidePort;
}

export interface GuiNodeOutcome {
  status: 'succeeded' | 'skipped' | 'failed';
  output?: unknown;
  errorClass?: WorkflowErrorClass;
  error?: string;
  verification?: 'verified' | 'unconfirmed';
}

export interface GuiRunOptions {
  nodeId: string;
  gui: GuiNodeSpec;
  scope: ExprScope;
  host: WorkflowHost;
  journal: Journal;
  budget: BudgetLedger;
  ports: GuiRunPorts;
  approvalMode: 'await' | 'suspend';
  /** Values the run provides — the decide channel never invents text. */
  values?: string[];
  runId: string;
  dryRun?: boolean;
}

const SUSPECTED_NOOP_LIMIT = 2;

function stepReqHash(nodeId: string, index: number, step: GuiStep, text?: string): string {
  return computeReqHash('node_result', { nodeId, step: index, do: step.do, ...(text !== undefined ? { text } : {}) });
}

/**
 * Execute one gui node. Never throws except SuspensionSignal — failures
 * surface through the outcome (fixture-testable, host-free).
 */
export async function runGuiNode(options: GuiRunOptions): Promise<GuiNodeOutcome> {
  const { nodeId, gui, journal, ports, host, budget } = options;

  if (options.dryRun) {
    return {
      status: 'succeeded',
      output: { dryRun: true, targetApp: gui.target_app, steps: gui.steps.length },
    };
  }

  const ctx: HostCallContext = { runId: options.runId, nodeId };
  let suspectedNoopStreak = 0;

  // ── Phase A: deterministic declared steps (code owns the loop) ──
  for (let i = 0; i < gui.steps.length; i++) {
    const rawStep = gui.steps[i];
    const stepId = `${nodeId}#step${i}`;

    // Capture + externalize BEFORE each state-changing step (§4.3 point 5).
    budget.countHostCall();
    try {
      const shot = await ports.backend.capture(ctx);
      if (shot.base64) {
        const ref = await ports.artifacts.put(options.runId, `capture-${i}`, shot.base64, '.png');
        journal.append({
          kind: 'artifact',
          nodeId: stepId,
          attempt: 1,
          status: 'succeeded',
          result: { kind: 'screenshot', step: i, ref },
          nodeKind: 'gui',
          action: 'capture',
          outputSize: shot.base64.length,
        });
      }
    } catch {
      // Capture failure must not abort a declared step sequence.
    }

    // Interpolate caller-provided text (rule #1: the channel never invents).
    const step = interpolateDeep(rawStep, options.scope) as GuiStep;
    const text = 'text' in step && typeof step.text === 'string' ? interpolateString(step.text, options.scope) : undefined;
    const reqHash = stepReqHash(nodeId, i, rawStep, text);

    // Cache: identical declared step + text in THIS run replays.
    const hit = journal.hit(stepId, reqHash);
    if (hit) continue;

    budget.countHostCall();
    const stepStartedAt = Date.now();
    const result = await ports.backend.step(
      { ...step, ...(text !== undefined ? { text } : {}) } as GuiStep,
      ctx,
    );
    const stepStatus = result.ok ? 'succeeded' : 'failed';
    journal.append({
      kind: 'node_result',
      nodeId: stepId,
      attempt: 1,
      reqHash,
      status: stepStatus,
      result: { do: step.do, effect: result.effect ?? null, error: result.error ?? null },
      errorClass: result.ok ? undefined : classifyError(result.error),
      nodeKind: 'gui',
      action: step.do,
      durationMs: Date.now() - stepStartedAt,
      outputSize: result.effect ? result.effect.length : 0,
    });

    if (!result.ok) {
      return mapStepFailure(nodeId, result.error);
    }
    if ('verify' in step && step.verify) {
      if (result.effect === 'confirmed') {
        suspectedNoopStreak = 0;
      } else if (result.effect === 'suspected_noop') {
        suspectedNoopStreak++;
        if (suspectedNoopStreak >= SUSPECTED_NOOP_LIMIT) {
          journal.append({
            kind: 'node_result',
            nodeId,
            attempt: 1,
            status: 'failed',
            result: { reason: 'suspected_noop ladder reached' },
            errorClass: 'tool_error',
            nodeKind: 'gui',
            action: 'escalate',
          });
          return enterLadder(options, 'stuck', `no on-screen change after ${suspectedNoopStreak} verified steps`);
        }
      }
      // 'unverifiable' → keep going; the next capture sees the truth.
    }
  }

  return { status: 'succeeded', output: { steps: gui.steps.length }, verification: 'verified' };
}

function mapStepFailure(nodeId: string, error?: string): GuiNodeOutcome {
  const cls = classifyError(error);
  return {
    status: 'failed',
    errorClass: cls === 'unknown' ? 'tool_error' : cls,
    error: error ?? 'gui step failed',
  };
}

/**
 * Phase B: the escalation ladder / decide-channel hand-off. `entry`
 * records why we got here (stuck | ambiguous | needs_confirmation |
 * blocked | max_actions | error).
 */
async function enterLadder(
  options: GuiRunOptions,
  entry: GuiDecideStatus,
  reason: string,
): Promise<GuiNodeOutcome> {
  const { nodeId, gui, journal } = options;

  // Deterministic dispositions first (no LLM involvement).
  if (entry === 'blocked' || entry === 'error' || entry === 'max_actions') {
    if (entry === 'max_actions' && gui.on_stuck === 'agent' && options.ports.decide) {
      return decideHandoff(options, entry, reason);
    }
    return {
      status: 'failed',
      errorClass: entry === 'blocked' ? 'approval_denied' : 'tool_error',
      error: `gui ${entry}: ${reason}`,
    };
  }
  if (entry === 'stuck' || entry === 'ambiguous') {
    if (gui.on_stuck === 'fail') {
      return { status: 'failed', errorClass: 'tool_error', error: `gui ${entry}: ${reason}` };
    }
    if (gui.on_stuck === 'skip') {
      return { status: 'skipped', error: `gui ${entry}: ${reason}` };
    }
    // on_stuck: agent (default) — needs the decide port.
    if (!options.ports.decide) {
      return { status: 'failed', errorClass: 'tool_error', error: `gui ${entry} without a decide channel: ${reason}` };
    }
    return decideHandoff(options, entry, reason);
  }
  return { status: 'failed', errorClass: 'tool_error', error: reason };
}

/** Hand the sub-goal to the 551 decide loop and map its status contract. */
async function decideHandoff(
  options: GuiRunOptions,
  entry: GuiDecideStatus,
  entryReason: string,
): Promise<GuiNodeOutcome> {
  const { nodeId, gui, journal, host } = options;
  const decide = options.ports.decide!;
  const task = interpolateString(`${gui.target_app}: ${nodeId}`, options.scope);
  const reqHash = computeReqHash('decision', { nodeId, entry, entryReason, task });

  // 铁律: decide results are journaled with reqHash — resume replays,
  // never re-asks (the loop is seeded with candidate values, rule #1).
  const hit = journal.hit(nodeId, reqHash);
  let result: Awaited<ReturnType<GuiDecidePort['run']>>;
  if (hit) {
    result = hit.result as typeof result;
  } else {
    journal.append({
      kind: 'node_result',
      nodeId,
      attempt: 1,
      status: 'running',
      result: { decide: entry, reason: entryReason },
    });
    result = await decide.run(task, { values: options.values, maxActions: gui.max_actions });
    journal.append({
      kind: 'decision',
      nodeId,
      attempt: 1,
      reqHash,
      status: 'succeeded',
      result: { status: result.status, reason: result.reason ?? null, candidates: result.candidates ?? null },
      nodeKind: 'decision',
      action: 'decide',
    });
  }

  switch (result.status) {
    case 'done':
      return { status: 'succeeded', output: { decided: 'done', reason: result.reason }, verification: 'verified' };
    case 'likely_done':
      return { status: 'succeeded', output: { decided: 'likely_done', reason: result.reason }, verification: 'unconfirmed' };
    case 'needs_confirmation':
      return gateConfirmation(options, result.reason ?? 'irreversible action pending');
    case 'ambiguous':
      return {
        status: 'failed',
        errorClass: 'tool_error',
        error: `gui ambiguous: ${result.reason ?? 'no confident target'} (candidates: ${(result.candidates ?? [])
          .map((c) => `${c.option}@${c.p.toFixed(2)}`)
          .join(', ')})`,
      };
    case 'error':
      return { status: 'failed', errorClass: 'tool_error', error: `gui decide error: ${result.reason}` };
    case 'stuck':
    case 'blocked':
      return {
        status: 'failed',
        errorClass: result.status === 'blocked' ? 'approval_denied' : 'tool_error',
        error: `gui ${result.status}: ${result.reason}`,
      };
    case 'max_actions':
      return { status: 'failed', errorClass: 'tool_error', error: `gui action cap reached: ${result.reason}` };
    default:
      return { status: 'failed', errorClass: 'tool_error', error: 'gui decide returned an unknown status' };
  }
}

/** The 498 gate for needs_confirmation — await or suspend (§6.3). */
async function gateConfirmation(options: GuiRunOptions, reason: string): Promise<GuiNodeOutcome> {
  const { nodeId, journal, host } = options;
  const markerHash = computeReqHash('approval', { nodeId, prompt: reason });

  const recorded = journal
    .all()
    .filter((r) => r.kind === 'approval' && r.nodeId === nodeId)
    .pop();
  if (recorded && recorded.status === 'succeeded') {
    const decision = (recorded.result as { decision?: string } | undefined)?.decision;
    if (decision === 'approve' || decision === 'deny') {
      return {
        status: decision === 'approve' ? 'succeeded' : 'skipped',
        output: { approved: decision === 'approve', gated: true },
        verification: decision === 'approve' ? 'verified' : undefined,
      };
    }
  }

  journal.append({
    kind: 'approval',
    nodeId,
    attempt: 1,
    reqHash: markerHash,
    status: 'waiting',
    result: null,
    nodeKind: 'gui',
    action: 'confirm-gate',
  });

  if (options.approvalMode === 'suspend') {
    throw new SuspensionSignal(nodeId, Date.now() + 24 * 3_600_000, `gui needs confirmation: ${reason}`);
  }

  const res = await host.requestApproval(
    { nodeId, prompt: `GUI action needs confirmation: ${reason}`, timeoutMs: 30 * 60_000 },
    { runId: options.runId, nodeId },
  );
  journal.append({
    kind: 'approval',
    nodeId,
    attempt: 1,
    reqHash: markerHash,
    status: 'succeeded',
    result: { decision: res.decision },
    nodeKind: 'gui',
    action: 'confirm-gate',
  });
  return {
    status: res.decision === 'approve' ? 'succeeded' : 'skipped',
    output: { approved: res.decision === 'approve', gated: true, timedOut: res.decision === 'timeout' },
  };
}
