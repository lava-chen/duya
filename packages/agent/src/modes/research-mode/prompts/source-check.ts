export const SOURCE_CHECK_VERSION = '1.0.0';

export interface SourceCheckInput {
  url: string;
  contentExcerpt: string;
}

export interface SourceCheckOutput {
  reliability: 'high' | 'medium' | 'low' | 'unverified';
  relevance: number;
  summary: string;
}

export function buildPrompt(input: SourceCheckInput): string {
  return `
Analyze this source for reliability and relevance:

URL: ${input.url}
Content excerpt: ${input.contentExcerpt.slice(0, 3000)}

Evaluate:
1. Authority: Is this an official, peer-reviewed, or well-known source?
2. Relevance: Does this relate to the research question?
3. Freshness: Is the information current?
4. Independence: Is this an original source or a re-report?

Return JSON:
{"reliability": "high"|"medium"|"low"|"unverified", "relevance": 0.0-1.0, "summary": "one-line assessment"}
`.trim();
}

export function parseResponse(raw: string): SourceCheckOutput {
  const parsed = safeParseJSON(raw);
  return {
    reliability: (parsed?.reliability as SourceCheckOutput['reliability']) || 'unverified',
    relevance: (parsed?.relevance as number) || 0.5,
    summary: (parsed?.summary as string) || `Source check completed`,
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