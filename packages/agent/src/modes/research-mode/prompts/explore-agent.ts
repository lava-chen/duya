import type { ResearchQuestion, ResearchPlan, ResearchFinding, ResearchState } from '../types.js';

export const EXPLORE_AGENT_VERSION = '1.0.0';

export const EXPLORE_AGENT_SYSTEM_PROMPT = `You are an autonomous web research agent with full access to a real browser. Your job is to investigate research questions by directly visiting authoritative sources on the web.

You have THREE browser operations. Use them in THIS priority order:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 STEP 1 — parallel_fetch (ALWAYS FIRST)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Operation: "parallel_fetch"
Input: { "operation": "parallel_fetch", "urls": ["url1", "url2", ...] }

This is your PRIMARY tool. You have world knowledge — you already know which websites
are relevant. Use parallel_fetch to open 5-15 URLs simultaneously.

Target these source types based on the question:
- Official docs: docs.python.org, nodejs.org/docs, react.dev, kubernetes.io/docs, ...
- Wikipedia: en.wikipedia.org/wiki/<Topic>
- Academic papers: arxiv.org/abs/<id>, scholar.google.com, semanticscholar.org
- GitHub repos & issues: github.com/<org>/<repo>
- Technical blogs: medium.com, dev.to, specific tech blogs
- MDN: developer.mozilla.org for web topics
- Stack Overflow: stackoverflow.com/questions/<id>
- Government/Standards: w3.org, ietf.org, specific gov sites
- News: reuters.com, arstechnica.com, theverge.com, specific news sites
- Documentation sites for ANY technology mentioned

RULES for parallel_fetch:
- Include AT LEAST 5 URLs, aim for 10-15
- Mix source types: official docs + community + academic + news
- Include counter-view sources deliberately
- Include recent/dated sources when freshness matters
- NEVER open the same domain twice in one batch — diversify

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟡 STEP 2 — navigate (deep-dive into best pages)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Operation: "navigate"
Input: { "operation": "navigate", "url": "https://..." }

After reviewing parallel_fetch results, navigate to the MOST PROMISING pages for
detailed reading. The browser returns a compact snapshot automatically.
Use "snapshot" afterwards if you need the full page content.

- Navigate to 2-5 specific pages that looked most valuable from parallel_fetch
- Navigate to sub-pages, specific sections, or linked references
- Navigate to sources that contradict or qualify earlier findings

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟢 STEP 3 — snapshot (get full page content)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Operation: "snapshot"
Input: { "operation": "snapshot" }

Use snapshot when the compact navigate result is truncated or when you need to
see the complete page structure. Only use after navigate.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚪ FALLBACK — DuckDuckGo search (LAST RESORT)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
If — and ONLY if — after using parallel_fetch and navigate you still have
unanswered questions and don't know specific URLs, use:
Operation: "navigate"
Input: { "operation": "navigate", "url": "https://html.duckduckgo.com/html/?q=YOUR+QUERY" }

But prefer direct sources. You know the web. Use your knowledge.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL RULES:
- parallel_fetch MUST be your first tool call every time. Do not skip it.
- Do NOT waste turns on DuckDuckGo when you can go directly to known sources.
- Each tool call counts against your budget — make every call count.
- Always look for counter-evidence and limitations, not just supporting views.
- If you find conflicting information, flag it in your findings.
- Extract SPECIFIC facts, quotes, data points — not vague summaries.
- Cite the source URL for every finding.

After completing all steps, return ONLY this JSON (no other text):

{"findings": [
  {
    "claim": "Concise factual statement with specific details",
    "evidence": "Direct quote or specific data from the source",
    "stance": "supports|contradicts|neutral",
    "questionIndex": 0,
    "sourceTitle": "Actual page title",
    "sourceUrl": "https://...",
    "confidence": 0.9,
    "evidenceType": "empirical|theoretical|anecdotal|expert-opinion",
    "limitations": ["any caveats about this source or claim"]
  }
],
"questionsAnswered": [0, 2],
"questionsPartiallyAnswered": [1],
"gapsIdentified": ["specific knowledge gaps that remain"],
"nextSuggestedQueries": ["specific URLs or search queries for next iteration"],
"hypothesisUpdates": [
  {"statement": "Hypothesis text", "verdict": "supported|refuted|inconclusive|partially-supported", "evidence": "reason"}
]}`;

export interface ExploreAgentInput {
  questions: ResearchQuestion[];
  plan: ResearchPlan | null;
  existingFindings: ResearchFinding[];
  researchState: ResearchState;
  iteration: number;
  maxIterations: number;
  query: string;
}

export function buildExplorePrompt(input: ExploreAgentInput): string {
  const { questions, plan, existingFindings, researchState, iteration, maxIterations } = input;

  const questionsText = questions.map((q, i) => {
    const coverage = researchState.questionCoverage.find(c => c.questionId === q.id);
    const sourceHint = q.sources && q.sources.length > 0 ? `, sources=${q.sources.join(', ')}` : '';
    return `${i}. [${q.id}] (pri=${q.priority}, layer=${q.questionLayer || 'analytical'}, purpose=${q.purpose}, status=${coverage?.status || q.status}${sourceHint}) ${q.text}`;
  }).join('\n');

  const existingSummary = existingFindings.length > 0
    ? existingFindings.map(f => `- [${f.id}] ${f.claim.slice(0, 150)} (src: ${f.source}, stance: ${f.stance})`).join('\n')
    : '(none)';

  const coverageSummary = researchState.questionCoverage
    .filter(qc => qc.status === 'blocked' || qc.status === 'pending')
    .map(qc => `${qc.questionId}: ${qc.status}${qc.blockedReason ? ` (${qc.blockedReason})` : ''}`)
    .join('\n');

  const conflictSummary = researchState.conflicts
    .filter(c => !c.resolved)
    .map(c => `- "${c.topic}": ${c.positionA} vs ${c.positionB}`)
    .join('\n');

  const hypothesisSummary = researchState.hypothesisStatuses
    .filter(h => h.verdict !== 'supported')
    .map(h => `- "${h.statement}": ${h.verdict} (confidence: ${h.confidenceLevel})`)
    .join('\n');

  return `RESEARCH ITERATION ${iteration}/${maxIterations}

ORIGINAL QUERY: ${input.query}

PLAN:
${plan ? `- Task: ${plan.intent.taskType}
- Goal: ${plan.intent.userGoal}
- Included scope: ${plan.scope.included.join('; ') || 'not specified'}
- Excluded scope: ${plan.scope.excluded.join('; ') || 'not specified'}
- Source domains to prioritize: ${plan.scope.domains.join(', ') || 'not specified'}
- Must find primary sources: ${plan.evidenceStrategy.mustFindPrimarySources}
- Must find counter evidence: ${plan.evidenceStrategy.mustFindCounterEvidence}
- Source priority order: ${plan.searchStrategy.priorityOrder.join(', ') || 'not specified'}
- Seed queries: ${plan.searchStrategy.seedQueries.join(', ')}
- Hypotheses: ${(plan.hypotheses || []).map(h => h.statement).join('; ') || 'none'}` : 'No plan'}

QUESTIONS TO INVESTIGATE:
${questionsText}

CURRENT COVERAGE GAPS:
${coverageSummary || '(all covered)'}

UNRESOLVED CONFLICTS:
${conflictSummary || '(none)'}

HYPOTHESES NEEDING VERIFICATION:
${hypothesisSummary || '(all verified)'}

EXISTING FINDINGS (avoid duplication):
${existingSummary}

SATURATION SIGNALS: ${researchState.saturationSignals.join(', ') || 'none'}

INSTRUCTIONS:
1. THINK: Based on your knowledge, list 5-15 specific URLs relevant to these questions.
   Cover: official docs, Wikipedia, academic papers, GitHub, tech blogs, news, forums.
   If Source domains to prioritize is specified, include those domains early unless they are clearly irrelevant.
2. parallel_fetch: Open ALL of them at once. This MUST be your first tool call.
3. REVIEW: Read what came back. Identify the most valuable pages.
4. navigate: Deep-dive into the 2-5 best pages to extract detailed information.
5. snapshot: Get full content if compact view was truncated.
6. DuckDuckGo ONLY as last resort if you truly don't know relevant URLs.
7. Return your findings as JSON using the format from the system prompt.
8. IMPORTANT: parallel_fetch FIRST. Always. Never skip it.`;
}

export interface ExploreAgentOutput {
  findings: Array<{
    claim: string;
    evidence: string;
    stance: 'supports' | 'contradicts' | 'neutral';
    questionIndex: number;
    sourceTitle?: string;
    sourceUrl?: string;
    confidence: number;
    evidenceType?: 'empirical' | 'theoretical' | 'anecdotal' | 'expert-opinion';
    limitations?: string[];
  }>;
  questionsAnswered: number[];
  questionsPartiallyAnswered: number[];
  gapsIdentified: string[];
  nextSuggestedQueries: string[];
  hypothesisUpdates: Array<{
    statement: string;
    verdict: 'supported' | 'refuted' | 'inconclusive' | 'partially-supported';
    evidence: string;
  }>;
}

export function parseExploreResponse(raw: string): ExploreAgentOutput {
  const defaultOutput: ExploreAgentOutput = {
    findings: [],
    questionsAnswered: [],
    questionsPartiallyAnswered: [],
    gapsIdentified: [],
    nextSuggestedQueries: [],
    hypothesisUpdates: [],
  };

  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/im, '');
  cleaned = cleaned.replace(/\s*```\s*$/im, '');
  cleaned = cleaned.replace(/\/\/.*$/gm, '');
  cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');

  try {
    const parsed = JSON.parse(cleaned);
    return {
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      questionsAnswered: Array.isArray(parsed.questionsAnswered) ? parsed.questionsAnswered : [],
      questionsPartiallyAnswered: Array.isArray(parsed.questionsPartiallyAnswered) ? parsed.questionsPartiallyAnswered : [],
      gapsIdentified: Array.isArray(parsed.gapsIdentified) ? parsed.gapsIdentified : [],
      nextSuggestedQueries: Array.isArray(parsed.nextSuggestedQueries) ? parsed.nextSuggestedQueries : [],
      hypothesisUpdates: Array.isArray(parsed.hypothesisUpdates) ? parsed.hypothesisUpdates : [],
    };
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return {
          findings: Array.isArray(parsed.findings) ? parsed.findings : [],
          questionsAnswered: Array.isArray(parsed.questionsAnswered) ? parsed.questionsAnswered : [],
          questionsPartiallyAnswered: Array.isArray(parsed.questionsPartiallyAnswered) ? parsed.questionsPartiallyAnswered : [],
          gapsIdentified: Array.isArray(parsed.gapsIdentified) ? parsed.gapsIdentified : [],
          nextSuggestedQueries: Array.isArray(parsed.nextSuggestedQueries) ? parsed.nextSuggestedQueries : [],
          hypothesisUpdates: Array.isArray(parsed.hypothesisUpdates) ? parsed.hypothesisUpdates : [],
        };
      } catch {
        return defaultOutput;
      }
    }
  }

  return defaultOutput;
}

export const exploreAgent = {
  EXPLORE_AGENT_SYSTEM_PROMPT,
  buildPrompt: buildExplorePrompt,
  parseResponse: parseExploreResponse,
  version: EXPLORE_AGENT_VERSION,
};
