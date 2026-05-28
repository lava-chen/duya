import type { ClarificationQuestion } from '../../types.js';

export const GENERATE_CLARIFICATION_VERSION = '1.0.0';

export interface GenerateClarificationInput {
  query: string;
}

export interface GenerateClarificationOutput {
  questions: ClarificationQuestion[];
}

export function buildPrompt(input: GenerateClarificationInput): string {
  return `
Analyze this research query and generate clarification questions. Only ask questions where the answer would fundamentally change the research direction.

Query: "${input.query}"

Rules:
- Only generate questions for hard blockers (research cannot continue without the answer)
- Do not ask about scope preferences that can be reasonably assumed
- Maximum 2 questions

Return JSON:
{"questions": [{"id": "q1", "question": "...", "type": "single_choice", "options": ["A", "B", "C"]}, ...]}
`.trim();
}

export function parseResponse(raw: string): GenerateClarificationOutput {
  const parsed = safeParseJSON(raw);
  const questions: ClarificationQuestion[] = [];
  if (parsed?.questions && Array.isArray(parsed.questions)) {
    for (const q of parsed.questions as Array<{
      id?: string;
      question: string;
      type: string;
      options?: string[];
    }>) {
      questions.push({
        id: q.id || `cq_${questions.length}`,
        question: q.question || '',
        type: (q.type === 'single_choice' || q.type === 'free_text') ? q.type : 'single_choice',
        options: q.options || [],
      });
    }
  }
  return { questions };
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