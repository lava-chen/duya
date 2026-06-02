import type { ResearchPlan, ResearchQuestion, ResearchFinding, QuestionCoverageStatus, HypothesisStatus, EvidenceConflict } from '../types.js';

export const CONTINUE_RESEARCH_VERSION = '2.0.0';

export interface ContinueResearchInput {
  additionalQuery?: string;
  existingQuestions: string;
  plan?: ResearchPlan | null;
  researchStateSummary?: string;
  newFindingsSummary?: string;
  iteration: number;
  maxIterations: number;
  isLoopEvaluation: boolean;
}

export interface ContinueResearchOutput {
  shouldContinue: boolean;
  reason: string;
  nextFocus: string;

  updatedCoverage: Array<{
    questionId: string;
    questionLayer: string;
    status: 'pending' | 'partial' | 'covered' | 'saturated' | 'blocked';
    anchorFindings: string[];
    coverageScore: number;
    blockedReason?: string;
  }>;

  updatedHypotheses: Array<{
    statement: string;
    verdict: 'unexamined' | 'supported' | 'refuted' | 'inconclusive' | 'partially-supported';
    supportingFindings: string[];
    contradictingFindings: string[];
    confidenceLevel: 'high' | 'medium' | 'low' | 'insufficient-evidence';
  }>;

  newConflicts: Array<{
    topic: string;
    positionA: string;
    positionB: string;
    findingIds: string[];
    resolved: boolean;
    resolution?: string;
  }>;

  saturationSignals: string[];
  overallCoverageScore: number;

  triggerReplan: boolean;
  replanReason?: 'hypothesis-refuted' | 'unexpected-finding' | 'scope-change' | 'evidence-gap';

  questions: Array<{ text: string; purpose?: string; priority: number }>;
}

export function buildPrompt(input: ContinueResearchInput): string {
  const {
    additionalQuery,
    existingQuestions,
    plan,
    researchStateSummary,
    newFindingsSummary,
    iteration,
    maxIterations,
    isLoopEvaluation,
  } = input;

  if (isLoopEvaluation) {
    return buildLoopEvaluationPrompt(input);
  }

  return `
Additional research query: ${additionalQuery || ''}

Existing questions:
${existingQuestions}

Generate 1-3 new research questions to extend this research. Return JSON:
{"questions": [{"text": "...", "purpose": "evidence", "priority": 1}, ...]}
`.trim();
}

function buildLoopEvaluationPrompt(input: ContinueResearchInput): string {
  const { existingQuestions, plan, researchStateSummary, newFindingsSummary, iteration, maxIterations } = input;

  const hypotheses = plan?.hypotheses;
  const hypothesisLines = hypotheses && hypotheses.length > 0
    ? hypotheses.map((h, i) => `  H${i}: "${h.statement}" [${h.type}]`).join('\n')
    : '(no hypotheses defined)';

  return `
You are the research coverage evaluator. Your job is to assess the current state of research after iteration ${iteration}/${maxIterations} and decide whether to continue, replan, or terminate.

Research Questions:
${existingQuestions}

${hypotheses && hypotheses.length > 0 ? `Hypotheses to test:\n${hypothesisLines}\n` : ''}

New Findings This Iteration:
${newFindingsSummary || '(none)'}

Previous Research State:
${researchStateSummary || '(initial state)'}

Instructions:
1. For each research question, assess its coverage status based on the findings:
   - pending: no findings yet
   - partial: some evidence but gaps remain
   - covered: sufficient evidence with authoritative sources
   - saturated: evidence is redundant, no need for more
   - blocked: cannot find evidence despite attempts (explain why)

2. For each hypothesis, assess its verification status:
   - unexamined: no findings relate to it
   - supported: evidence consistently supports it
   - refuted: evidence consistently contradicts it
   - inconclusive: mixed or insufficient evidence
   - partially-supported: some aspects supported, some not

3. Detect evidence conflicts: when two findings make contradictory claims on the same topic.

4. Identify saturation signals: directions that have produced sufficient or redundant evidence.

5. Decide whether to:
   - continue: gaps remain, more research needed (set nextFocus)
   - trigger replan: hypothesis refuted, unexpected findings, or evidence gaps require plan adjustment
   - terminate: all critical questions covered, hypotheses resolved

6. Calculate overall coverage score (0-1).

Return JSON:
{
  "shouldContinue": true,
  "reason": "3 of 7 questions still lack authoritative sources",
  "nextFocus": "q2 - needs primary source verification",

  "updatedCoverage": [
    {
      "questionId": "q0",
      "questionLayer": "foundational",
      "status": "covered",
      "anchorFindings": ["f_xxx", "f_yyy"],
      "coverageScore": 0.9
    }
  ],

  "updatedHypotheses": [
    {
      "statement": "original hypothesis text",
      "verdict": "supported",
      "supportingFindings": ["f_xxx"],
      "contradictingFindings": [],
      "confidenceLevel": "high"
    }
  ],

  "newConflicts": [
    {
      "topic": "topic where conflict exists",
      "positionA": "viewpoint from finding A",
      "positionB": "viewpoint from finding B",
      "findingIds": ["f_a", "f_b"],
      "resolved": false
    }
  ],

  "saturationSignals": ["q0 has 5+ authoritative sources, no new angles to explore"],
  "overallCoverageScore": 0.65,

  "triggerReplan": false,
  "replanReason": null,

  "questions": []
}
`.trim();
}

export function parseResponse(raw: string): ContinueResearchOutput {
  const parsed = safeParseJSON(raw);

  const defaultOutput: ContinueResearchOutput = {
    shouldContinue: false,
    reason: '',
    nextFocus: '',
    updatedCoverage: [],
    updatedHypotheses: [],
    newConflicts: [],
    saturationSignals: [],
    overallCoverageScore: 0,
    triggerReplan: false,
    questions: [],
  };

  if (!parsed) return defaultOutput;

  return {
    shouldContinue: typeof parsed.shouldContinue === 'boolean' ? parsed.shouldContinue : false,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    nextFocus: typeof parsed.nextFocus === 'string' ? parsed.nextFocus : '',

    updatedCoverage: Array.isArray(parsed.updatedCoverage)
      ? (parsed.updatedCoverage as ContinueResearchOutput['updatedCoverage'])
      : [],

    updatedHypotheses: Array.isArray(parsed.updatedHypotheses)
      ? (parsed.updatedHypotheses as ContinueResearchOutput['updatedHypotheses'])
      : [],

    newConflicts: Array.isArray(parsed.newConflicts)
      ? (parsed.newConflicts as ContinueResearchOutput['newConflicts'])
      : [],

    saturationSignals: Array.isArray(parsed.saturationSignals)
      ? (parsed.saturationSignals as string[])
      : [],

    overallCoverageScore: typeof parsed.overallCoverageScore === 'number'
      ? parsed.overallCoverageScore
      : 0,

    triggerReplan: typeof parsed.triggerReplan === 'boolean' ? parsed.triggerReplan : false,

    replanReason: typeof parsed.replanReason === 'string' && (['hypothesis-refuted', 'unexpected-finding', 'scope-change', 'evidence-gap'] as string[]).includes(parsed.replanReason)
      ? (parsed.replanReason as ContinueResearchOutput['replanReason'])
      : undefined,

    questions: Array.isArray(parsed.questions)
      ? (parsed.questions as Array<{ text: string; purpose?: string; priority: number }>)
      : [],
  };
}

function safeParseJSON(response: string): Record<string, unknown> | null {
  let cleaned = response.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/im, '');
  cleaned = cleaned.replace(/\s*```\s*$/im, '');
  cleaned = cleaned.replace(/\/\/.*$/gm, '');
  cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { return null; }
    }
    return null;
  }
}

export const continueResearch = { buildPrompt, parseResponse, version: CONTINUE_RESEARCH_VERSION };