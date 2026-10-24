import type { DecisionNodeSpec } from './schema.js';

export interface DecisionAnswerOut {
  kind: 'choice' | 'noul' | 'score';
  value: string | number;
  p?: number;
  confidence?: number;
  verdict: 'yes' | 'no' | 'confident' | 'uncertain';
  defaulted?: boolean;
}

export interface DecisionRunOutcome {
  answers: Record<string, DecisionAnswerOut>;
  output: Record<string, string | number>;
  lowConfidence: string[];
  source: 'decision' | 'unavailable';
}

export interface WorkflowDecisionPort {
  run(node: DecisionNodeSpec, state: unknown): Promise<DecisionRunOutcome>;
  isUnavailable(error: unknown): boolean;
}

export function uncertainOutcomeFor(node: DecisionNodeSpec): DecisionRunOutcome {
  const answers: Record<string, DecisionAnswerOut> = {};
  const output: Record<string, string | number> = {};
  const lowConfidence: string[] = [];
  const fallbackDefault = typeof node.on_low_confidence === 'object' ? node.on_low_confidence.default : undefined;
  for (const id of Object.keys(node.questions)) {
    const question = node.questions[id];
    if (!question) continue;
    if (fallbackDefault !== undefined && typeof fallbackDefault !== 'boolean') {
      answers[id] = { kind: question.type, value: fallbackDefault as string | number, verdict: 'uncertain', defaulted: true };
      output[id] = fallbackDefault as string | number;
    } else {
      lowConfidence.push(id);
    }
  }
  return { answers, output, lowConfidence, source: 'unavailable' };
}
