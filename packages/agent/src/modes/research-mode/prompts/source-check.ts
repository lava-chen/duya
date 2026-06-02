export const SOURCE_CHECK_VERSION = '1.0.0';

export interface SourceCheckInput {
  url: string;
  contentExcerpt: string;
}

export interface SourceCheckOutput {
  summary: string;
  reliability: string;
  relevance: number;
  authorityLevel?: string;
  freshness?: string;
  bias?: string;
}

export function buildPrompt(input: SourceCheckInput): string {
  return `
Evaluate the reliability and relevance of the following web source.

URL: ${input.url}

Content Excerpt:
${input.contentExcerpt}

Assess:
- summary: A brief summary of what this source contains (1-2 sentences)
- reliability: "high", "medium", "low", or "unverified"
- relevance: 0.0-1.0 score for the research topic
- authorityLevel: "high", "medium", or "low" based on source authority
- freshness: "current", "outdated", or "timeless"
- bias: "neutral", "slight", or "strong"

Return JSON:
{
  "summary": "...",
  "reliability": "medium",
  "relevance": 0.7,
  "authorityLevel": "medium",
  "freshness": "current",
  "bias": "neutral"
}
`.trim();
}

export function parseResponse(raw: string): SourceCheckOutput {
  const parsed = safeParseJSON(raw);
  return {
    summary: (parsed?.summary as string) || '',
    reliability: (parsed?.reliability as string) || 'unverified',
    relevance: typeof parsed?.relevance === 'number' ? parsed.relevance : 0.5,
    authorityLevel: parsed?.authorityLevel as string | undefined,
    freshness: parsed?.freshness as string | undefined,
    bias: parsed?.bias as string | undefined,
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

export const sourceCheck = {
  buildPrompt,
  parseResponse,
  version: SOURCE_CHECK_VERSION,
};