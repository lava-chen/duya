/**
 * decision-adapter.ts — the workflow-side adapter over 551's
 * DecisionService (plan 552 §5; NO new decision module lives here —
 * `packages/agent/src/decisions/` stays the only channel).
 *
 * Responsibilities for decision nodes:
 *   - compose 551 Question shapes from node specs (choice criteria →
 *     labeled options; noul/score pass through),
 *   - resolve probabilities through per-question threshold overrides
 *     on top of the 551 policy (gray band → 'uncertain', never a guess),
 *   - emit TYPED answers (choice → string, noul/score → number) that
 *     enter the `when` expression scope (§4.2: decide 原语进 when),
 *   - surface low-confidence questions to the runner's
 *     `on_low_confidence` behavior (ask → human / skip / default),
 *     and record `unconfirmed` on defaulted answers (fresh eyes).
 *
 * Degradation chain is unchanged (551 §2 rule 10): no backend →
 * DecisionUnavailableError → runner treats every question as
 * uncertain → workflow behavior is zero-broken without Jev.
 */

import type { Question } from '@duya/ai';
import {
  type DecisionService,
  type DecisionPolicy,
  DEFAULT_DECISION_POLICY,
  evaluateNoul,
  DecisionUnavailableError,
} from '../../decisions/index.js';
import type { DecisionNodeSpec, DecisionQuestionSpec } from './schema.js';

export interface DecisionAnswerOut {
  kind: 'choice' | 'noul' | 'score';
  /** Typed value entering the when scope (choice → option, noul/score → number). */
  value: string | number;
  p?: number;
  confidence?: number;
  /** 'yes' | 'no' | 'uncertain' for noul; 'confident' | 'uncertain' otherwise. */
  verdict: 'yes' | 'no' | 'confident' | 'uncertain';
  /** True when the value came from on_low_confidence.default, not the model. */
  defaulted?: boolean;
}

export interface DecisionRunOutcome {
  /** Question id → resolved answer. */
  answers: Record<string, DecisionAnswerOut>;
  /** Typed values only — the node output riding the scope. */
  output: Record<string, string | number>;
  /** Question ids that landed in the gray band (runner escalates). */
  lowConfidence: string[];
  source: 'decision' | 'unavailable';
}

function composeChoiceInstructions(q: Extract<DecisionQuestionSpec, { type: 'choice' }>): string {
  const optionLines = Object.entries(q.criteria).map(([option, desc]) => `- ${option}: ${desc}`);
  const parts = ['Pick exactly one option from the list.', ...(q.instructions ? [q.instructions] : []), ...optionLines];
  return parts.join('\n');
}

/** Everything uncertain — the no-backend path (rule + llm tier absent). */
export function uncertainOutcomeFor(node: DecisionNodeSpec): DecisionRunOutcome {
  const answers: Record<string, DecisionAnswerOut> = {};
  const output: Record<string, string | number> = {};
  const lowConfidence: string[] = [];
  const fallbackDefault =
    node.on_low_confidence && typeof node.on_low_confidence === 'object'
      ? node.on_low_confidence.default
      : undefined;
  for (const id of Object.keys(node.questions)) {
    const q = node.questions[id];
    if (fallbackDefault !== undefined && typeof fallbackDefault !== 'boolean') {
      answers[id] = { kind: q.type, value: fallbackDefault as string | number, verdict: 'uncertain', defaulted: true };
      output[id] = fallbackDefault as string | number;
    } else {
      lowConfidence.push(id);
    }
  }
  return { answers, output, lowConfidence, source: 'unavailable' };
}

export class WorkflowDecisionAdapter {
  constructor(
    private readonly service: DecisionService,
    private readonly policy: DecisionPolicy = DEFAULT_DECISION_POLICY,
  ) {}

  /** Whether the decision backend chain is usable at all. */
  get available(): boolean {
    return this.service.available;
  }

  /** Build 551 Question shapes from the node spec. */
  buildQuestions(node: DecisionNodeSpec): Record<string, Question> {
    const questions: Record<string, Question> = {};
    for (const [id, q] of Object.entries(node.questions)) {
      if (q.type === 'choice') {
        questions[id] = {
          kind: 'choice',
          instructions: composeChoiceInstructions(q),
          options: Object.keys(q.criteria),
        };
      } else if (q.type === 'noul') {
        questions[id] = { kind: 'noul', instructions: q.instructions };
      } else {
        questions[id] = { kind: 'score', instructions: q.instructions, levels: q.levels };
      }
    }
    return questions;
  }

  /**
   * Run one decision node: one ask() over all questions (fan-out
   * dividend, §5 落点②), then resolve each answer against the merged
   * policy (node threshold overrides doneAt/minTargetConfidence).
   * Throws DecisionUnavailableError when no backend — callers treat
   * every question as low-confidence.
   */
  async run(node: DecisionNodeSpec, state: unknown): Promise<DecisionRunOutcome> {
    const questions = this.buildQuestions(node);
    const response = await this.service.ask(state, questions);
    return this.resolve(node, questions, response);
  }

  /** Resolve a response (pure) — separated so the unavailable path can share it. */
  resolve(
    node: DecisionNodeSpec,
    questions: Record<string, Question>,
    response: Awaited<ReturnType<DecisionService['ask']>>,
  ): DecisionRunOutcome {
    const answers: Record<string, DecisionAnswerOut> = {};
    const output: Record<string, string | number> = {};
    const lowConfidence: string[] = [];

    for (const [id, question] of Object.entries(questions)) {
      const answer = response.answers[id];
      const threshold = node.thresholds?.[id];
      if (!answer) {
        lowConfidence.push(id);
        continue;
      }
      if (answer.kind === 'noul') {
        const merged: DecisionPolicy = threshold !== undefined ? { ...this.policy, doneAt: threshold } : this.policy;
        const verdict = evaluateNoul(answer.p, merged);
        answers[id] = { kind: 'noul', value: answer.p, p: answer.p, verdict };
        output[id] = answer.p;
        if (verdict === 'uncertain') lowConfidence.push(id);
        continue;
      }
      if (answer.kind === 'choice') {
        const conf = answer.confidence ?? Object.values(answer.distribution)[0] ?? 0;
        const line = threshold ?? this.policy.minTargetConfidence;
        const verdict = conf >= line ? 'confident' : 'uncertain';
        answers[id] = { kind: 'choice', value: answer.value, confidence: conf, verdict };
        output[id] = answer.value;
        if (verdict === 'uncertain') lowConfidence.push(id);
        continue;
      }
      // score
      const conf = answer.confidence ?? 1;
      const line = threshold ?? this.policy.minTargetConfidence;
      const verdict = conf >= line ? 'confident' : 'uncertain';
      answers[id] = { kind: 'score', value: answer.value, confidence: conf, verdict };
      output[id] = answer.value;
      if (verdict === 'uncertain') lowConfidence.push(id);
    }
    void questions;
    return { answers, output, lowConfidence, source: 'decision' };
  }

  /** Everything uncertain — the no-backend path (rule + llm tier absent). */
  allUncertain(node: DecisionNodeSpec): DecisionRunOutcome {
    return uncertainOutcomeFor(node);
  }

  /** Expose DecisionUnavailableError identity without importing it everywhere. */
  static isUnavailableError(err: unknown): err is DecisionUnavailableError {
    return err instanceof DecisionUnavailableError;
  }
}
