import type { ResearchFinding, SearchStrategy } from '../types.js';
import { computeSourceReliability, sourceTypeFromQueryType, authorityLevelFromReliability } from '../utils.js';

export const EXTRACT_FINDINGS_VERSION = '1.0.0';

export interface ExtractFindingsInput {
  toolName: string;
  result: string;
  strategies: SearchStrategy[];
  iteration: number;
  existingFindingsSummary: string;
  questionTexts: string;
}

export function buildPrompt(input: ExtractFindingsInput): string {
  const { toolName, result, existingFindingsSummary, questionTexts } = input;

  return `
Extract discrete findings from this search result.

Source: ${toolName}

Result:
${result}

Research questions being investigated:
${questionTexts || '(none)'}

Existing findings to avoid duplication:
${existingFindingsSummary || '(none)'}

For each finding extract:
- claim: A concise factual statement (1-2 sentences)
- evidence: The specific supporting data or quote
- content: Same as claim (for compatibility)
- stance: "supports", "contradicts", or "neutral" relative to the research question
- sourceReliability: "high", "medium", "low", or "unverified"
- confidence: 0.0-1.0
- limitations: Any known limitations of this finding
- answersQuestionId: Which specific research question this finding answers (use the question ID from the list)
- hypothesisLink: Which hypothesis this supports or contradicts
- evidenceType: "empirical", "theoretical", "anecdotal", or "expert-opinion"
- replicationStatus: "replicated", "single-study", "preprint-only", or "unknown"
- conflictsWith: Array of finding IDs this conflicts with (use IDs from existing findings list)

Return JSON:
{"findings": [
  {
    "claim": "...",
    "evidence": "...",
    "stance": "supports",
    "sourceReliability": "high",
    "confidence": 0.9,
    "title": "...",
    "author": "...",
    "publishedAt": "...",
    "limitations": ["limitation 1"],
    "answersQuestionId": "q0",
    "hypothesisLink": "...",
    "evidenceType": "empirical",
    "replicationStatus": "single-study",
    "conflictsWith": []
  },
  ...
]}
`.trim();
}

export interface FindingItem {
  claim: string;
  evidence: string;
  content?: string;
  stance: string;
  sourceReliability: string;
  confidence: number;
  title?: string;
  author?: string;
  publishedAt?: string;
  limitations?: string[];
  answersQuestionId?: string;
  hypothesisLink?: string;
  evidenceType?: string;
  replicationStatus?: string;
  conflictsWith?: string[];
}

export function parseResponse(
  raw: string,
  strategies: SearchStrategy[],
  toolName: string,
  iteration: number,
): ResearchFinding[] {
  const parsed = safeParseJSON(raw);

  if (parsed?.findings && Array.isArray(parsed.findings)) {
    const findings: ResearchFinding[] = [];
    let idx = 0;

    for (const item of parsed.findings as FindingItem[]) {
      if (!item.claim && !item.content) continue;

      const questionIds = strategies.map((s) => s.questionId);
      const queryType = strategies[0]?.queryType ?? 'en_resources';
      const reliability = (item.sourceReliability as ResearchFinding['sourceReliability'])
        || computeSourceReliability(queryType);

      const claimText = item.claim || item.content || '';
      const evidenceText = item.evidence || claimText;

      findings.push({
        id: `f_${Date.now()}_${idx++}`,
        questionId: item.answersQuestionId || strategies[0]?.questionId || '',
        type: 'web',
        claim: claimText,
        evidence: evidenceText,
        content: claimText,
        source: toolName,
        sourceId: `src_${Date.now()}_${idx}`,
        sourceType: sourceTypeFromQueryType(queryType),
        title: item.title,
        author: item.author,
        publishedAt: item.publishedAt,
        accessedAt: new Date().toISOString(),
        snippet: claimText.slice(0, 150),
        rawExcerpt: claimText.slice(0, 500),
        sourceReliability: reliability,
        authorityLevel: authorityLevelFromReliability(reliability),
        citationId: `[${idx}]`,
        stance: (item.stance as ResearchFinding['stance']) || 'neutral',
        confidence: Math.min(1, Math.max(0, item.confidence || 0.7)),
        relevance: 0.7,
        relatedQuestionIds: questionIds,
        supports: [],
        contradicts: [],
        limitations: Array.isArray(item.limitations) ? item.limitations as string[] : [],
        extractedEntities: [],
        iteration,
        evidenceType: (item.evidenceType as ResearchFinding['evidenceType']),
        replicationStatus: (item.replicationStatus as ResearchFinding['replicationStatus']),
        conflictsWith: Array.isArray(item.conflictsWith) ? item.conflictsWith as string[] : undefined,
        hypothesisLink: item.hypothesisLink,
      });
    }

    return findings;
  }

  return [];
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

export const extractFindings = { buildPrompt, parseResponse, version: EXTRACT_FINDINGS_VERSION };