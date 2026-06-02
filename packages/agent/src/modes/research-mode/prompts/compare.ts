import type { CompareAction } from '../types.js';

export const COMPARE_VERSION = '1.0.0';

export interface CompareInput {
  action: CompareAction;
  contextText: string;
}

export interface CompareOutput {
  agreement: 'agree' | 'disagree' | 'complement' | 'unrelated';
  commonPoints: string[];
  differingPoints: Array<{
    aspect: string;
    view1: string;
    view2: string;
    verdict: 'text1_preferred' | 'text2_preferred' | 'both_valid' | 'needs_clarification';
  }>;
  synthesis: string;
}

export function buildPrompt(input: CompareInput): string {
  const { action, contextText } = input;

  return `
You are performing a comparison analysis for a deep research agent.

Comparison type: ${action.comparisonType}
Goal: ${action.comparisonGoal}

Compare the following sources:
${action.sourceIds.slice(0, 5).map((sid, i) => `Source ${i + 1}: id=${sid}`).join('\n')}

Research context:
${contextText.slice(0, 3000)}

Identify:
1. Common ground across sources
2. Key differences or disagreements
3. Which source is most reliable for each differing point
4. A synthesized interpretation

Return JSON:
{
  "agreement": "agree"|"disagree"|"complement"|"unrelated",
  "commonPoints": ["point 1", "point 2"],
  "differingPoints": [
    {"aspect": "aspect name", "view1": "...", "view2": "...", "verdict": "text1_preferred"|"text2_preferred"|"both_valid"|"needs_clarification"}
  ],
  "synthesis": "synthesized conclusion"
}
`.trim();
}

export function parseResponse(raw: string): CompareOutput {
  const parsed = safeParseJSON(raw);
  return {
    agreement: (parsed?.agreement as CompareOutput['agreement']) || 'unrelated',
    commonPoints: Array.isArray(parsed?.commonPoints) ? (parsed.commonPoints as string[]) : [],
    differingPoints: Array.isArray(parsed?.differingPoints)
      ? (parsed.differingPoints as CompareOutput['differingPoints'])
      : [],
    synthesis: (parsed?.synthesis as string) || '',
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

export const compare = { buildPrompt, parseResponse, version: COMPARE_VERSION };