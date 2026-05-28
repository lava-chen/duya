import type { ResearchFinding } from './types.js';

export function computeSourceReliability(
  queryType: string
): 'high' | 'medium' | 'low' | 'unverified' {
  if (queryType === 'official_doc' || queryType === 'paper') return 'high';
  if (queryType === 'oss' || queryType === 'en_resources') return 'medium';
  if (queryType === 'news' || queryType === 'cn_resources') return 'low';
  return 'unverified';
}

export function sourceTypeFromQueryType(
  queryType: string
): ResearchFinding['sourceType'] {
  switch (queryType) {
    case 'official_doc': return 'official';
    case 'paper': return 'paper';
    case 'news': return 'news';
    case 'oss': return 'code';
    case 'cn_resources':
    case 'en_resources': return 'blog';
    default: return 'blog';
  }
}

export function authorityLevelFromReliability(
  reliability: 'high' | 'medium' | 'low' | 'unverified'
): 'high' | 'medium' | 'low' {
  if (reliability === 'high') return 'high';
  if (reliability === 'medium') return 'medium';
  return 'low';
}

export function truncateResult(result: string, maxChars = 8000): string {
  if (result.length <= maxChars) return result;
  return result.slice(0, maxChars) + '\n\n[... truncated, omitted ' + (result.length - maxChars) + ' chars]';
}

export function safeParseJSON(response: string): Record<string, unknown> | null {
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