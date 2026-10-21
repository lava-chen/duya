/**
 * decide/questions.ts — per-round fan-out template (plan 551 Phase 3).
 *
 * jev-browser rule #2: one request per round, MANY questions. The
 * independent per-round judgments — which element to act on, which
 * value to enter, whether we are done, whether an error/blocked state
 * is visible, whether the next action would be irreversible — all ride
 * ONE request; adding questions costs tokens, not latency. Risk
 * assessment is part of the same fan-out, gated in code (rule #7).
 */

import type { Question } from '@duya/ai';
import type { DescribedElement, PageState } from './describe.js';

/** Question ids of the fixed per-round fan-out. */
export const ROUND_QUESTION_IDS = [
  'target',
  'value',
  'done',
  'done_change',
  'error',
  'blocked',
  'irreversible',
] as const;

export type RoundQuestionId = (typeof ROUND_QUESTION_IDS)[number];

export interface RoundQuestionInput {
  /** The planner's outcome for this delegation (rule #1: Jev decides, never generates). */
  task: string;
  page: PageState;
  /**
   * Candidate values (free text the PLANNER supplied) for fill-in
   * fields. Absent → no `value` question this round.
   */
  values?: readonly string[];
  /** True from the second round — enables the `done_change` question. */
  hasPriorRound?: boolean;
}

/** Human-visible option label for an element ("#3 [Button] Submit"). */
export function elementOption(el: DescribedElement): string {
  return `#${el.index} [${el.kind ?? 'Unknown'}] "${el.label}"`;
}

/**
 * Build the fixed fan-out. Questions with no meaningful subject this
 * round (no elements → no target; no values → no value; first round →
 * no done_change) are simply absent from the request.
 */
export function buildRoundQuestions(input: RoundQuestionInput): Record<string, Question> {
  const { task, page, values, hasPriorRound } = input;
  const questions: Record<string, Question> = {};

  if (page.elements.length > 0) {
    questions.target = {
      kind: 'choice',
      instructions:
        `Task: "${task}". Which SINGLE element should be acted on next to advance the task? ` +
        'Pick by index from the candidate list. If the task does not need another action, ' +
        'pick the option that best matches the element most relevant to the task. ' +
        'If no candidate is usable, pick the first one and mark the round ambiguous via confidence.',
      options: page.elements.map(elementOption),
    };
  }

  if (values && values.length > 0) {
    questions.value = {
      kind: 'choice',
      instructions:
        `Task: "${task}". Which of the provided values should be entered into the target ` +
        'element this round? Pick exactly one.',
      options: [...values],
    };
  }

  questions.done = {
    kind: 'noul',
    instructions:
      `Task: "${task}". Judging ONLY from the state provided: is the task fully completed ` +
      'right now? Answer no when any required step has not visibly happened.',
  };

  if (hasPriorRound && page.lastChange) {
    questions.done_change = {
      kind: 'noul',
      instructions:
        `Task: "${task}". Did the screen change since the previous round bring the task ` +
        'visibly closer to completion?',
    };
  }

  questions.error = {
    kind: 'noul',
    instructions:
      `Task: "${task}". Does the state show an error or failure condition (error message, ` +
      'red validation, crash dialog, disabled controls after a failed attempt)?',
  };

  questions.blocked = {
    kind: 'noul',
    instructions:
      `Task: "${task}". Is progress impossible from this state without outside help ` +
      '(login wall, captcha, permission dialog, missing prerequisite)?',
  };

  questions.irreversible = {
    kind: 'noul',
    instructions:
      `Task: "${task}". Considering the action you would propose this round: would taking it ` +
      'now be hard or impossible to undo (purchase, payment, send, delete, overwrite data ' +
      'outside this session)? Ordinary clicks, typing and navigation are not irreversible.',
  };

  return questions;
}

/**
 * Stricter follow-up for the inconsistency signal (rule #8): `done` is
 * mid-confidence but an action was still proposed. One extra noul, same
 * state — this is the check that killed jev-browser's false-dones.
 */
export function buildStrictConfirmationQuestion(task: string): Record<string, Question> {
  return {
    done_confirm: {
      kind: 'noul',
      instructions:
        `Task: "${task}". STRICT re-check: is there DIRECT visible evidence in the state that ` +
        'the task is fully completed (success message, expected result present, requested ' +
        'state reached)? If the evidence is partial or you are inferring, answer no.',
    },
  };
}
