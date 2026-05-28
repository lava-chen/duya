import type { ResearchQuestion } from '../types.js';

export const CONTINUE_RESEARCH_VERSION = '1.0.0';

export interface ContinueResearchInput {
  additionalQuery: string;
  existingQuestions: string;
}

export interface ContinueResearchOutput {
  questions: Array<{ text: string; purpose?: string; priority: number }>;
}

export function buildPrompt(input: ContinueResearchInput): string {
  return `
Additional research query: ${input.additionalQuery}

Existing questions:
${input.existingQuestions}

Generate 1-3 new research questions to extend this research. Return JSON:
{"questions": [{"text": "...", "purpose": "evidence", "priority": 1}, ...]}
`.trim();
}

export function parseResponse(raw: string): ContinueResearchOutput {
  const parsed = safeParseJSON(raw);
  if (parsed?.questions && Array.isArray(parsed.questions)) {
    return {
      questions: parsed.questions as Array<{ text: string; purpose?: string; priority: number }>,
    };
  }
  return { questions: [] };
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