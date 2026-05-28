import type { ResearchClassification, QueryComplexity } from '../types.js';

export const CLASSIFY_QUERY_VERSION = '1.0.0';

export interface ClassifyQueryInput {
  query: string;
}

export interface ClassifyQueryOutput {
  complexity: QueryComplexity;
  freshness: ResearchClassification['freshness'];
  sourceDepth: ResearchClassification['sourceDepth'];
  riskLevel: ResearchClassification['riskLevel'];
  needsTools: string[];
}

export function buildPrompt(input: ClassifyQueryInput): string {
  return `
Classify this research query along multiple dimensions.

Query: "${input.query}"

Categories for complexity:
- factual: Simple fact lookup, quick answer expected
- conceptual: Explaining concepts, moderate depth needed
- comparative: Comparing multiple things, need side-by-side sources
- analytical: Deep analysis, multiple perspectives required
- literature_review: Survey of academic literature or field progress
- technical_design: Implementation, architecture, or engineering approach
- unknown: Cannot determine

Freshness requirements:
- stable: Doesn't change (e.g., math concepts, fundamental physics)
- recent: 1-3 year window (e.g., current best practices, recent research)
- latest: Very time-sensitive (e.g., latest releases, breaking news)

Source depth:
- light: 1-2 searches per question
- standard: 2-4 searches per question
- deep: 4+ searches, must include primary sources

Return JSON:
{
  "complexity": "analytical",
  "freshness": "recent",
  "sourceDepth": "deep",
  "riskLevel": "medium",
  "needsTools": ["browser"],
  "reason": "..."
}
`.trim();
}

export function parseResponse(raw: string): ClassifyQueryOutput {
  const parsed = safeParseJSON(raw);
  return {
    complexity: (parsed?.complexity as QueryComplexity) ?? 'unknown',
    freshness: (parsed?.freshness as ResearchClassification['freshness']) ?? 'recent',
    sourceDepth: (parsed?.sourceDepth as ResearchClassification['sourceDepth']) ?? 'standard',
    riskLevel: (parsed?.riskLevel as ResearchClassification['riskLevel']) ?? 'medium',
    needsTools: Array.isArray(parsed?.needsTools) ? (parsed.needsTools as string[]) : ['browser'],
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