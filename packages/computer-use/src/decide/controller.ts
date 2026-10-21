/**
 * decide/controller.ts — the "LLM plans, Jev decides" inner loop
 * (plan 551 Phase 3).
 *
 * Structure (jev-browser architecture, one round = one request):
 *
 *   settle (code owns timing) → capture → describe (code-computed state)
 *   → ask (fixed fan-out, ONE request) → gate in code → act (via backend)
 *
 * Code owns everything the model must not: settle timing, (target,
 * action) ring detection, the action cap, threshold policy, and the
 * irreversible gate. The model returns distributions; the controller
 * turns them into exactly one of the honest status contract values —
 * `stuck` / `error` / `ambiguous` are entries for the planner to take
 * over, never crashes and never silent guesses (rule #10).
 *
 * Pure orchestration: capture / act / ask / confirm are ports, so the
 * loop is fixture-testable with no backend and no network.
 */

import type { DecisionResponse, Question } from '@duya/ai';
import type { CaptureResult } from '../backend/types.js';
import { describePage, pageStateToDecisionState, type PageState } from './describe.js';
import {
  buildRoundQuestions,
  buildStrictConfirmationQuestion,
} from './questions.js';

/** Honest status contract returned to the planner. */
export type DecideStatus =
  | 'done'
  | 'likely_done'
  | 'needs_confirmation'
  | 'error'
  | 'stuck'
  | 'ambiguous'
  | 'blocked'
  | 'max_actions';

/**
 * One inner-loop action. The host maps this onto its backend
 * (Electron desktop backend via the existing approval pipeline).
 */
export interface DecideAction {
  kind: 'click' | 'type' | 'set_value' | 'key' | 'scroll';
  /** SOM element index (1-based) for click / type / set_value targets. */
  element?: number;
  /** Text for type / set_value (always a caller-provided candidate value). */
  text?: string;
  key?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
}

export interface DecideActResult {
  ok: boolean;
  /** Backend verdict effect when the host surfaces one ("confirmed" | ...). */
  verdictEffect?: string;
  /** Error code/message when ok is false (USER_REJECTED, TIMEOUT, ...). */
  error?: string;
}

export interface DecideLoopPorts {
  /** Wait for the UI to settle. Code owns timing — never the model. */
  settle(): Promise<void>;
  /** SOM-mode capture of the current screen. */
  capture(): Promise<CaptureResult>;
  /** Execute one action through the host backend (approval pipeline included). */
  act(action: DecideAction): Promise<DecideActResult>;
  /** One request, many questions (DecisionClient.decide). */
  ask(state: unknown, questions: Record<string, Question>): Promise<DecisionResponse>;
  /**
   * Execute-with-confirmation for the irreversible gate. Resolves true
   * when the user approved AND the action was executed (the host's
   * approval card pops inside the dispatch); false on deny/timeout.
   * Absent → irreversible actions surface as `needs_confirmation`.
   */
  confirm?(action: DecideAction): Promise<boolean>;
  /** Per-round trace hook (calibration / debugging). */
  onRound?(trace: DecideRoundTrace): void;
}

/**
 * Thresholds, structurally compatible with @duya/agent's DecisionPolicy
 * (plan 551 Phase 2) so hosts can pass their configured policy directly.
 */
export interface DecideLoopPolicy {
  doneAt: number;
  rejectAt: number;
  irreversibleAt: number;
  minTargetConfidence: number;
}

export const DEFAULT_DECIDE_LOOP_POLICY: DecideLoopPolicy = {
  doneAt: 0.85,
  rejectAt: 0.45,
  irreversibleAt: 0.6,
  minTargetConfidence: 0.8,
};

export interface DecideLoopOptions {
  task: string;
  /** Candidate values the planner provides (rule #1: Jev never generates). */
  values?: readonly string[];
  maxActions?: number;
  policy?: DecideLoopPolicy;
}

export interface DecideRoundTrace {
  round: number;
  actions: number;
  /** noul probabilities of the fan-out, by question id. */
  probabilities: Record<string, number>;
  target?: string;
  targetConfidence?: number;
}

export interface DecideLoopResult {
  status: DecideStatus;
  rounds: number;
  actions: number;
  reason?: string;
  /** Top candidates when status === 'ambiguous' (distribution, not a guess). */
  candidates?: Array<{ option: string; p: number }>;
  lastState?: PageState;
}

export const DEFAULT_MAX_ACTIONS = 12;

function noul(res: DecisionResponse, id: string): number | undefined {
  const answer = res.answers[id];
  return answer && answer.kind === 'noul' ? answer.p : undefined;
}

function choiceConfidence(res: DecisionResponse, id: string): { value: string; confidence: number } | undefined {
  const answer = res.answers[id];
  if (!answer || answer.kind !== 'choice') return undefined;
  const values = Object.values(answer.distribution);
  const max = values.length > 0 ? Math.max(...values) : (answer.confidence ?? 0);
  return { value: answer.value, confidence: max };
}

/** Extract the SOM index back out of an element option label ("#12 [...]"). */
export function parseElementIndex(option: string): number | undefined {
  const m = option.match(/^#(\d+)\s/);
  return m ? Number(m[1]) : undefined;
}

/** Map a target (and optional value) onto the concrete next action. */
export function actionForTarget(
  targetIndex: number,
  targetOption: string,
  value?: string,
): DecideAction {
  // Fill-in targets (input-like kinds) receive text when a value exists.
  if (value !== undefined && /Input|Edit|ComboBox|Document/.test(targetOption)) {
    return { kind: 'type', element: targetIndex, text: value };
  }
  return { kind: 'click', element: targetIndex };
}

/**
 * Run the decide loop until an honest terminal status is reached.
 * Never throws — every failure surfaces through the status contract.
 */
export async function runDecideLoop(
  ports: DecideLoopPorts,
  options: DecideLoopOptions,
): Promise<DecideLoopResult> {
  const policy = options.policy ?? DEFAULT_DECIDE_LOOP_POLICY;
  const maxActions = options.maxActions ?? DEFAULT_MAX_ACTIONS;
  let prev: PageState | undefined;
  let actions = 0;
  let rounds = 0;
  const ring = new Map<string, number>();

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await ports.settle();
      const capture = await ports.capture();
      const page = describePage(capture, prev);
      rounds++;
      const questions = buildRoundQuestions({
        task: options.task,
        page,
        values: options.values,
        hasPriorRound: rounds > 1,
      });
      const res = await ports.ask(pageStateToDecisionState(options.task, page, options.values), questions);

      const pDone = noul(res, 'done') ?? 0;
      const pError = noul(res, 'error') ?? 0;
      const pBlocked = noul(res, 'blocked') ?? 0;
      const pIrreversible = noul(res, 'irreversible') ?? 0;
      const target = choiceConfidence(res, 'target');

      ports.onRound?.({
        round: rounds,
        actions,
        probabilities: { done: pDone, error: pError, blocked: pBlocked, irreversible: pIrreversible },
        target: target?.value,
        targetConfidence: target?.confidence,
      });

      if (pError >= policy.doneAt) {
        return { status: 'error', rounds, actions, reason: `error state visible (p=${pError.toFixed(2)})`, lastState: page };
      }
      if (pBlocked >= policy.doneAt) {
        return { status: 'blocked', rounds, actions, reason: `progress blocked (p=${pBlocked.toFixed(2)})`, lastState: page };
      }

      // No actionable elements: done when the evidence is strong, else stuck.
      if (!target) {
        if (pDone >= policy.doneAt) {
          return { status: 'done', rounds, actions, lastState: page };
        }
        return { status: 'stuck', rounds, actions, reason: 'no actionable elements on screen', lastState: page };
      }

      // Rule #6: return the distribution, not a guess.
      if (target.confidence < policy.minTargetConfidence) {
        const answer = res.answers.target;
        const distribution =
          answer && answer.kind === 'choice'
            ? Object.entries(answer.distribution).map(([option, p]) => ({ option, p }))
            : [];
        distribution.sort((a, b) => b.p - a.p);
        return {
          status: 'ambiguous',
          rounds,
          actions,
          candidates: distribution.slice(0, 3),
          reason: `target confidence ${target.confidence.toFixed(2)} below ${policy.minTargetConfidence}`,
          lastState: page,
        };
      }

      const targetIndex = parseElementIndex(target.value);
      if (targetIndex === undefined) {
        return { status: 'ambiguous', rounds, actions, reason: `unparseable target "${target.value}"`, lastState: page };
      }

      // Rule #9: gray band on done → strict confirmation re-ask (rule #8's
      // inconsistency check). A mid-confidence done WITH an action proposal
      // is exactly the shape that produced jev-browser's false-dones.
      if (pDone >= policy.doneAt) {
        return { status: 'done', rounds, actions, lastState: page };
      }
      if (pDone > policy.rejectAt) {
        const strict = await ports.ask(
          pageStateToDecisionState(options.task, page, options.values),
          buildStrictConfirmationQuestion(options.task),
        );
        const pStrict = noul(strict, 'done_confirm') ?? 0;
        if (pStrict >= policy.doneAt) {
          return { status: 'done', rounds, actions, lastState: page };
        }
        if (pStrict > policy.rejectAt) {
          // Gray persists under strict re-check → hand up for review.
          return { status: 'likely_done', rounds, actions, reason: `done gray band (p=${pDone.toFixed(2)}, strict=${pStrict.toFixed(2)})`, lastState: page };
        }
        // Strict re-check says NOT done → keep acting.
      }

      // Rule #7: risk question rode the same fan-out; the gate lives here.
      const action = actionForTarget(
        targetIndex,
        target.value,
        res.answers.value && res.answers.value.kind === 'choice' ? res.answers.value.value : undefined,
      );

      // Loop safety — every path that executes an action is bounded.
      const ringKey = `${action.kind}:${targetIndex}`;
      const seen = (ring.get(ringKey) ?? 0) + 1;
      ring.set(ringKey, seen);
      if (seen > 2) {
        return { status: 'stuck', rounds, actions, reason: `repeated ${action.kind} on #${targetIndex} without progress`, lastState: page };
      }
      if (actions >= maxActions) {
        return { status: 'max_actions', rounds, actions, reason: `action cap ${maxActions} reached`, lastState: page };
      }

      if (pIrreversible >= policy.irreversibleAt) {
        if (!ports.confirm) {
          return { status: 'needs_confirmation', rounds, actions, reason: `irreversible (p=${pIrreversible.toFixed(2)}) and no confirm gate configured`, lastState: page };
        }
        const approved = await ports.confirm(action);
        if (!approved) {
          return { status: 'needs_confirmation', rounds, actions, reason: 'user denied the irreversible action', lastState: page };
        }
        // confirm() executed the action as part of the approval pipeline.
        actions++;
        prev = page;
        continue;
      }

      const result = await ports.act(action);
      actions++;
      prev = page;
      if (!result.ok) {
        const userDeclined = /USER_REJECTED|APPROVAL_TIMEOUT/i.test(result.error ?? '');
        return userDeclined
          ? { status: 'needs_confirmation', rounds, actions, reason: result.error ?? 'user declined the action', lastState: page }
          : { status: 'error', rounds, actions, reason: result.error ?? 'action failed', lastState: page };
      }
    }
  } catch (err) {
    return {
      status: 'error',
      rounds,
      actions,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
