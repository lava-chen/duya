import type {
  ResearchAction,
  ResearchActionType,
  ResearchQuestion,
  QualityReport,
  ResearchPlan,
} from '../types.js';

export const SELECT_ACTIONS_VERSION = '1.0.0';

export interface SelectActionsInput {
  questions: ResearchQuestion[];
  qualityReport: QualityReport;
  plan: ResearchPlan | null;
  contextText: string;
  concurrencyLimit: number;
}

export function buildPrompt(input: SelectActionsInput): string {
  const { questions, qualityReport, plan, contextText, concurrencyLimit } = input;

  return `
You are the research loop controller for a deep research agent.

You are given:
- The original query
- The approved research plan
- Current findings and quality report
- Remaining iteration budget

Your task is to decide the next best research actions. You can choose from multiple action types:

Action types:
- search: Execute a web search query (most common)
- source_check: Evaluate a specific source's reliability, originality, date, author
- claim_verify: Verify whether a claim is supported by other sources
- fetch: Fetch page content for detailed analysis (provides URL)
- compare: Compare multiple sources on a specific dimension
- backtrack: Revisit a previously skipped question
- stop_question: Mark a question as no longer actionable
- conflict_resolve: Investigate a specific evidence conflict to determine which position is more reliable
- gap_probe: Search for "X remains unsolved/unknown" queries to probe research gaps
- replan: Signal that the plan needs restructuring (hypothesis refuted, unexpected scope)
- terminate: Signal that research is complete and ready for synthesis

Rules:
- Be exhaustive: fill as many actions as possible (close to ${concurrencyLimit}), preferring search over other types
- The vast majority of actions should be "search" — use other types only when genuinely needed
- Use diverse search queries for the same question: different angles, different keywords, different phrasings
- If authoritative sources are missing, search for primary sources first
- If only supporting evidence exists, search for counter-evidence or limitations
- If findings conflict, search for adjudicating sources
- For analytical/critique questions, always include counter-view searches
- Do NOT repeat searches that have already produced sufficient evidence
- Limit total actions to ${concurrencyLimit}

Quality Report:
- Score: ${(qualityReport.score * 100).toFixed(0)}%
- Ready: ${qualityReport.readyForSynthesis}
- Blockers: ${qualityReport.blockers.join('; ') || 'none'}
- Next Actions: ${qualityReport.nextActions.join('; ') || 'none'}

Plan:
${plan ? `- Source strategy: ${JSON.stringify(plan.evidenceStrategy)}
- Must find primary sources: ${plan.evidenceStrategy.mustFindPrimarySources}
- Must find counter evidence: ${plan.evidenceStrategy.mustFindCounterEvidence}
- Seed queries: ${plan.searchStrategy.seedQueries.join(', ')}` : 'No plan available'}

Context:
${contextText}

Questions (max ${concurrencyLimit} actions total):
${questions.map((q) => `- [${q.id}] (${q.purpose}) ${q.text} → searchQueries: ${q.searchQueries.join('; ') || 'none'}`).join('\n')}

Return JSON:
{"actions": [
  {"type": "search", "targetQuestionId": "q0", "params": {"query": "specific search query"}, "priority": 1, "reason": "need official docs", "expectedOutcome": "find official documentation"},
  {"type": "source_check", "targetQuestionId": "q1", "params": {"url": "https://...", "sourceId": "src_xxx"}, "priority": 2, "reason": "verify source quality", "expectedOutcome": "assess reliability"},
  {"type": "compare", "targetQuestionId": "q2", "params": {"compareItems": ["src_a", "src_b"]}, "priority": 2, "reason": "reconcile conflicting sources", "expectedOutcome": "resolve contradiction"}
]}
`.trim();
}

export function parseResponse(
  raw: string,
  questions: ResearchQuestion[],
  concurrencyLimit: number,
): ResearchAction[] {
  const parsed = safeParseJSON(raw);
  const validTypes = [
    'search', 'source_check', 'claim_verify', 'fetch',
    'compare', 'backtrack', 'stop_question',
    'conflict_resolve', 'gap_probe', 'replan', 'terminate',
  ];

  if (parsed?.actions && Array.isArray(parsed.actions)) {
    return (parsed.actions as Array<{
      type: string;
      targetQuestionId: string;
      params?: { query?: string; url?: string; sourceId?: string; compareItems?: string[] };
      priority?: number;
      reason?: string;
      expectedOutcome?: string;
    }>).map((a, idx) => ({
      id: `action_${Date.now()}_${idx}`,
      type: (validTypes.includes(a.type) ? a.type : 'search') as ResearchActionType,
      targetQuestionId: a.targetQuestionId || '',
      params: a.params || {},
      priority: a.priority || 2,
      reason: a.reason || '',
      expectedOutcome: a.expectedOutcome || '',
    }));
  }

  return questions.slice(0, concurrencyLimit).map((q, idx) => ({
    id: `action_fb_${Date.now()}_${idx}`,
    type: 'search' as const,
    targetQuestionId: q.id,
    params: { query: q.searchQueries[0] || q.text },
    priority: q.priority,
    reason: `Research: ${q.text.slice(0, 60)}`,
    expectedOutcome: `Evidence for: ${q.text.slice(0, 60)}`,
  }));
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

export const selectActions = { buildPrompt, parseResponse, version: SELECT_ACTIONS_VERSION };