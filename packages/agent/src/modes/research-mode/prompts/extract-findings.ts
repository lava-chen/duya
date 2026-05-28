import type { ResearchFinding, SearchStrategy } from '../types.js';
import { computeSourceReliability, sourceTypeFromQueryType, authorityLevelFromReliability } from '../Orchestrator.js';

export const EXTRACT_FINDINGS_VERSION = '1.0.0';

export interface ExtractFindingsInput {
  toolName: string;
  result: string;
  strategies: SearchStrategy[];
  iteration: number;
  existingFindingsSummary: string;
}

export function buildPrompt(input: ExtractFindingsInput): string {
  const { toolName, result, existingFindingsSummary } = input;

  return `
Extract discrete findings from this search result.

Source: ${toolName}

Result:
${result}

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
    "limitations": ["limitation 1"]
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
        questionId: strategies[0]?.questionId || '',
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
        confidence: Math.min(1, Math.max(