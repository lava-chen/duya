import type { QueryComplexity } from '../types.js';

export const CLASSIFY_QUERY_VERSION = '1.0.0';

export interface ClassifyQueryInput {
  query: string;
}

export interface ClassifyQueryOutput {
  complexity: QueryComplexity;
  freshness: 'stable' | 'recent' | 'latest';
  sourceDepth: 'light' | 'standard' | 'deep';
  riskLevel: 'low' | 'medium' | 'high';
  needsTools: string[];
}

export function buildPrompt(input: ClassifyQueryInput): string {
  return `
Classify the following research query. Determine its complexity and metadata.

Query: "${input.query}"

Complexity levels:
- factual: Simple fact lookup (e.g., "What is X?")
- conceptual: Understanding a concept (e.g., "How does X work?")
- comparative: Comparing multiple things (e.g., "X vs Y")
- analytical: Deep analysis required (e.g., "Why did X happen?")
- literature_review: Requires surveying multiple sources
- technical_design: Requires understanding technical architecture
- unknown: Cannot determine

Return JSON:
{
  "complexity": "conceptual",
  "freshness": "recent",
  "sourceDepth": "standard",
  "riskLevel": "low",
  "needsTools": ["browser"]
}
`.trim();
}

export function parseResponse(raw: string): ClassifyQueryOutput {
  const parsed = safeParseJSON(raw);
  return {
    complexity: (parsed?.complexity as QueryComplexity) || 'unknown',
    freshness: (parsed?.freshness as ClassifyQueryOutput['freshness']) || 'recent',
    sourceDepth: (parsed?.sourceDepth as ClassifyQueryOutput['sourceDepth']) || 'standard',
    riskLevel: (parsed?.riskLevel as ClassifyQueryOutput['riskLevel']) || 'medium',
    needsTools: Array.isArray(parsed?.needsTools) ? parsed.needsTools as string[] : ['browser'],
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

export const classifyQuery = {
  buildPrompt,
  parseResponse,
  version: CLASSIFY_QUERY_VERSION,
};